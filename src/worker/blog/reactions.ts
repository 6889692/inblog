import type { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readJson, requestClientIp } from '../lib/request'
import { consumeAttemptBudget, ThrottleError } from '../lib/throttle'
import { isBlogReactionEmoji } from '@shared/blog/types'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function appUserIdOf(c: Context<AppBindings>): string | undefined {
  const value = (c.var as Record<string, unknown>).userId
  return typeof value === 'string' && value ? value : undefined
}

function tierOf(c: Context<AppBindings>): 'public' | 'all' {
  return c.get('blogAuthed') ? 'all' : 'public'
}

async function resolveNoteId(
  db: D1Database,
  ownerId: string,
  slug: string,
  tier: 'public' | 'all',
): Promise<string | null> {
  const visibility = tier === 'public' ? `bp.visibility = 'public'` : `bp.visibility IN ('public', 'private')`
  const row = await db
    .prepare(
      `SELECT bp.note_id AS note_id FROM blog_posts bp JOIN notes n
         ON n.id = bp.note_id AND n.user_id = bp.user_id
       WHERE bp.user_id = ?1 AND bp.slug = ?2 AND ${visibility} AND n.deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(ownerId, slug)
    .first<{ note_id: string }>()
  return row?.note_id ?? null
}

function voterKeyOf(c: Context<AppBindings>, email: unknown): { type: 'account' | 'guest'; key: string } {
  const appUserId = appUserIdOf(c)
  if (appUserId) return { type: 'account', key: `u:${appUserId}` }
  const mail = typeof email === 'string' ? email.trim().toLowerCase() : ''
  if (!mail || mail.length > 254 || !EMAIL_RE.test(mail)) {
    throw new ApiError(401, 'unauthenticated', 'Sign in or provide an email to react', {
      code: 'guest_info_required',
    })
  }
  return { type: 'guest', key: `e:${mail}` }
}

async function readReactionState(
  db: D1Database,
  ownerId: string,
  noteId: string,
  mine: string | null,
): Promise<{ counts: Record<string, number>; mine: string[] }> {
  const { results } = await db
    .prepare(
      `SELECT emoji, voter_key FROM blog_reactions WHERE owner_id = ?1 AND note_id = ?2 LIMIT 2000`,
    )
    .bind(ownerId, noteId)
    .all<{ emoji: string; voter_key: string }>()
  const counts: Record<string, number> = {}
  const mineSet = new Set<string>()
  for (const row of results) {
    counts[row.emoji] = (counts[row.emoji] ?? 0) + 1
    if (mine && row.voter_key === mine) mineSet.add(row.emoji)
  }
  return { counts, mine: [...mineSet] }
}

export function registerBlogReactionRoutes(blogRoutes: Hono<AppBindings>): void {
  blogRoutes.get('/:username/posts/:slug/reactions', async (c) => {
    const ownerId = c.get('blogOwnerId')!
    const noteId = await resolveNoteId(c.env.DB, ownerId, c.req.param('slug'), tierOf(c))
    if (!noteId) return c.json({ error: { code: 'not_found', message: 'Post not found' } }, 404)
    const appUserId = appUserIdOf(c)
    let mine: string | null = null
    if (appUserId) {
      mine = `u:${appUserId}`
    } else {
      const mail = c.req.query('email')?.trim().toLowerCase() ?? ''
      if (mail && EMAIL_RE.test(mail)) mine = `e:${mail}`
    }
    return c.json(await readReactionState(c.env.DB, ownerId, noteId, mine))
  })

  blogRoutes.post('/:username/posts/:slug/reactions', async (c) => {
    const ownerId = c.get('blogOwnerId')!
    const username = c.req.param('username')
    try {
      await consumeAttemptBudget(c.env.DB, [
        { key: `blog-react:${username}:ip:${requestClientIp(c)}`, maxAttempts: 30, windowMs: 10 * 60 * 1000 },
      ])
    } catch (err) {
      if (err instanceof ThrottleError) {
        throw new ApiError(429, 'too_many_attempts', 'Too many attempts. Try again later')
      }
      throw err
    }
    const noteId = await resolveNoteId(c.env.DB, ownerId, c.req.param('slug'), tierOf(c))
    if (!noteId) return c.json({ error: { code: 'not_found', message: 'Post not found' } }, 404)
    const body = await readJson<{ emoji?: unknown; email?: unknown }>(c, 4096)
    if (!isBlogReactionEmoji(body.emoji)) throw ApiError.badRequest('Invalid reaction emoji')
    const voter = voterKeyOf(c, body.email)
    const existing = await c.env.DB
      .prepare(
        `SELECT emoji FROM blog_reactions WHERE owner_id = ?1 AND note_id = ?2 AND emoji = ?3 AND voter_key = ?4`,
      )
      .bind(ownerId, noteId, body.emoji, voter.key)
      .first<{ emoji: string }>()
    if (existing) {
      await c.env.DB
        .prepare(
          `DELETE FROM blog_reactions WHERE owner_id = ?1 AND note_id = ?2 AND emoji = ?3 AND voter_key = ?4`,
        )
        .bind(ownerId, noteId, body.emoji, voter.key)
        .run()
      return c.json({ ok: true, active: false })
    }
    await c.env.DB
      .prepare(
        `INSERT INTO blog_reactions (owner_id, note_id, emoji, voter_type, voter_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(ownerId, noteId, body.emoji, voter.type, voter.key, Date.now())
      .run()
    return c.json({ ok: true, active: true })
  })
}
