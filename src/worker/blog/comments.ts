import type { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { readJson, requestClientIp } from '../lib/request'
import { consumeAttemptBudget, ThrottleError } from '../lib/throttle'
import { requireAuth } from '../middleware/auth'
import type { BlogComment } from '@shared/blog/types'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const NICKNAME_MAX = 50
const EMAIL_MAX = 254
const CONTENT_MAX = 2000

interface CommentPost {
  note_id: string
}

interface CommentRow {
  id: string
  parent_id: string | null
  author_type: string
  author_name: string
  author_avatar: string
  is_owner: number
  is_deleted: number
  content: string
  created_at: number
}

function appUserIdOf(c: Context<AppBindings>): string | undefined {
  const value = (c.var as Record<string, unknown>).userId
  return typeof value === 'string' && value ? value : undefined
}

function tierOf(c: Context<AppBindings>): 'public' | 'all' {
  return c.get('blogAuthed') ? 'all' : 'public'
}

async function resolvePost(
  db: D1Database,
  ownerId: string,
  slug: string,
  tier: 'public' | 'all',
): Promise<CommentPost | null> {
  const visibility = tier === 'public' ? `bp.visibility = 'public'` : `bp.visibility IN ('public', 'private')`
  const row = await db
    .prepare(
      `SELECT bp.note_id AS note_id FROM blog_posts bp JOIN notes n
         ON n.id = bp.note_id AND n.user_id = bp.user_id
       WHERE bp.user_id = ?1 AND bp.slug = ?2 AND ${visibility} AND n.deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(ownerId, slug)
    .first<CommentPost>()
  return row ?? null
}

function toBlogComment(row: CommentRow): BlogComment {
  return {
    id: row.id,
    parent_id: row.parent_id,
    author_type: row.author_type === 'account' ? 'account' : 'guest',
    author_name: row.author_name,
    author_avatar: row.author_avatar,
    is_owner: row.is_owner === 1,
    is_deleted: row.is_deleted === 1,
    content: row.is_deleted === 1 ? '' : row.content,
    created_at: row.created_at,
  }
}

export async function listBlogComments(
  db: D1Database,
  ownerId: string,
  noteId: string,
): Promise<BlogComment[]> {
  const { results } = await db
    .prepare(
      `SELECT id, parent_id, author_type, author_name, author_avatar, is_owner, is_deleted, content, created_at
         FROM blog_comments
        WHERE owner_id = ?1 AND note_id = ?2
        ORDER BY created_at ASC, id ASC
        LIMIT 500`,
    )
    .bind(ownerId, noteId)
    .all<CommentRow>()
  return results.map(toBlogComment)
}

interface ResolvedAuthor {
  type: 'account' | 'guest'
  userId?: string
  name: string
  email: string
  avatar: string
  isOwner: boolean
}

async function resolveAuthor(
  c: Context<AppBindings>,
  ownerId: string,
  nickname: unknown,
  email: unknown,
): Promise<ResolvedAuthor> {
  const appUserId = appUserIdOf(c)
  if (appUserId) {
    const row = await c.env.DB.prepare(`SELECT name, avatar_url FROM users WHERE id = ?1`)
      .bind(appUserId)
      .first<{ name: string | null; avatar_url: string | null }>()
    return {
      type: 'account',
      userId: appUserId,
      name: row?.name?.trim() || 'Inkstone user',
      email: '',
      avatar: row?.avatar_url ?? '',
      isOwner: appUserId === ownerId,
    }
  }
  const name = typeof nickname === 'string' ? nickname.trim() : ''
  const mail = typeof email === 'string' ? email.trim().toLowerCase() : ''
  if (!name || !mail) {
    throw new ApiError(401, 'unauthenticated', 'Guest nickname and email are required', {
      code: 'guest_info_required',
    })
  }
  if (name.length > NICKNAME_MAX || mail.length > EMAIL_MAX || !EMAIL_RE.test(mail)) {
    throw ApiError.badRequest('Invalid nickname or email')
  }
  return { type: 'guest', name, email: mail, avatar: '', isOwner: false }
}

async function consumeCommentBudget(c: Context<AppBindings>, username: string, slug: string): Promise<void> {
  try {
    await consumeAttemptBudget(c.env.DB, [
      { key: `blog-comment:${username}:ip:${requestClientIp(c)}`, maxAttempts: 8, windowMs: 10 * 60 * 1000 },
      { key: `blog-comment:${username}:post:${slug}`, maxAttempts: 60, windowMs: 10 * 60 * 1000 },
    ])
  } catch (err) {
    if (err instanceof ThrottleError) {
      throw new ApiError(429, 'too_many_attempts', 'Too many attempts. Try again later')
    }
    throw err
  }
}

export function registerBlogCommentRoutes(blogRoutes: Hono<AppBindings>): void {
  blogRoutes.get('/:username/posts/:slug/comments', async (c) => {
    const ownerId = c.get('blogOwnerId')!
    const post = await resolvePost(c.env.DB, ownerId, c.req.param('slug'), tierOf(c))
    if (!post) return c.json({ error: { code: 'not_found', message: 'Post not found' } }, 404)
    return c.json({
      comments: await listBlogComments(c.env.DB, ownerId, post.note_id),
      canManage: appUserIdOf(c) === ownerId,
    })
  })

  blogRoutes.post('/:username/posts/:slug/comments', async (c) => {
    const ownerId = c.get('blogOwnerId')!
    const username = c.req.param('username')
    const slug = c.req.param('slug')
    await consumeCommentBudget(c, username, slug)
    const post = await resolvePost(c.env.DB, ownerId, slug, tierOf(c))
    if (!post) return c.json({ error: { code: 'not_found', message: 'Post not found' } }, 404)
    const body = await readJson<{ content?: unknown; parentId?: unknown; nickname?: unknown; email?: unknown }>(
      c,
      8192,
    )
    const content = typeof body.content === 'string' ? body.content.trim() : ''
    if (!content || content.length > CONTENT_MAX) {
      throw ApiError.badRequest('Comment content must be 1-2000 characters')
    }
    let parentId: string | null = null
    if (body.parentId !== undefined && body.parentId !== null) {
      if (typeof body.parentId !== 'string' || !body.parentId) {
        throw ApiError.badRequest('Invalid parent comment')
      }
      const parent = await c.env.DB
        .prepare(
          `SELECT id, parent_id, is_deleted FROM blog_comments WHERE id = ?1 AND owner_id = ?2 AND note_id = ?3`,
        )
        .bind(body.parentId, ownerId, post.note_id)
        .first<{ id: string; parent_id: string | null; is_deleted: number }>()
      if (!parent || parent.parent_id !== null || parent.is_deleted === 1) {
        throw ApiError.badRequest('Can only reply to a top-level comment')
      }
      parentId = parent.id
    }
    const author = await resolveAuthor(c, ownerId, body.nickname, body.email)
    const id = newId()
    const now = Date.now()
    await c.env.DB
      .prepare(
        `INSERT INTO blog_comments
           (id, owner_id, note_id, parent_id, author_type, author_user_id, author_name, author_email, author_avatar, content, is_owner, is_deleted, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12)`,
      )
      .bind(
        id,
        ownerId,
        post.note_id,
        parentId,
        author.type,
        author.userId ?? null,
        author.name,
        author.email,
        author.avatar,
        content,
        author.isOwner ? 1 : 0,
        now,
      )
      .run()
    return c.json({ ok: true, id })
  })

  blogRoutes.delete('/:username/comments/:id', requireAuth, async (c) => {
    const ownerId = c.get('blogOwnerId')!
    if (appUserIdOf(c) !== ownerId) throw ApiError.forbidden()
    const row = await c.env.DB
      .prepare(`SELECT id FROM blog_comments WHERE id = ?1 AND owner_id = ?2`)
      .bind(c.req.param('id'), ownerId)
      .first<{ id: string }>()
    if (!row) throw ApiError.notFound('Comment not found')
    await c.env.DB
      .prepare(`UPDATE blog_comments SET is_deleted = 1, content = '' WHERE id = ?1 AND owner_id = ?2`)
      .bind(c.req.param('id'), ownerId)
      .run()
    return c.json({ ok: true })
  })
}
