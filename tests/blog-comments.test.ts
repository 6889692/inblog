import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { blogRoutes } from '../src/worker/blog/routes'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'

interface MockStatement {
  all<T = unknown>(): Promise<{ results: T[] }>
  first<T = unknown>(): Promise<T | null>
  run(): Promise<{ success: boolean }>
}

interface MockDb {
  prepare(sql: string): { bind(...args: unknown[]): MockStatement }
  batch(statements: MockStatement[]): Promise<unknown[]>
}

interface CommentFixture {
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

interface DbOptions {
  noteId?: string | null
  privateSlugs?: string[]
  comments?: CommentFixture[]
  parent?: { id: string; parent_id: string | null; is_deleted: number } | null
  deletable?: boolean
  profile?: { name: string; avatar_url: string }
  locked?: boolean
}

function makeDb(options: DbOptions = {}): MockDb & { writes: string[] } {
  const writes: string[] = []
  const comments = options.comments ?? []
  return {
    writes,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all<T = unknown>() {
              if (sql.includes('SELECT locked_until FROM login_attempts')) {
                if (options.locked) return { results: [{ locked_until: Date.now() + 60_000 }] as T[] }
                return { results: [] as T[] }
              }
              if (sql.includes('FROM blog_comments') && sql.includes('ORDER BY created_at')) {
                return { results: comments as T[] }
              }
              return { results: [] as T[] }
            },
            async first<T = unknown>() {
              if (sql.includes('SELECT id FROM users WHERE username')) {
                return ({ id: 'u1' }) as T | null
              }
              if (sql.includes('SELECT bp.note_id AS note_id')) {
                if (sql.includes("bp.visibility = 'public'") && (options.privateSlugs ?? []).includes(String(args[1]))) {
                  return null as T | null
                }
                const noteId = options.noteId === undefined ? 'n1' : options.noteId
                return (noteId ? { note_id: noteId } : null) as T | null
              }
              if (sql.includes('SELECT id, parent_id, is_deleted FROM blog_comments')) {
                return (options.parent === undefined ? null : options.parent) as T | null
              }
              if (sql.includes('SELECT name, avatar_url FROM users')) {
                return (options.profile ?? { name: 'Member', avatar_url: '' }) as T | null
              }
              if (sql.includes('SELECT id FROM blog_comments WHERE id = ?1 AND owner_id')) {
                return (options.deletable === false ? null : { id: String(args[0]) }) as T | null
              }
              if (sql.includes('SELECT expires_at FROM blog_sessions')) return null as T | null
              if (sql.includes('SELECT value FROM app_meta')) return null as T | null
              return null as T | null
            },
            async run() {
              writes.push(sql)
              return { success: true }
            },
          }
        },
      }
    },
    async batch(statements: MockStatement[]) {
      for (const statement of statements) await statement.run()
      return []
    },
  }
}

function makeApp(appUserId?: string) {
  const app = new Hono<AppBindings>()
  if (appUserId) {
    app.use('*', async (c, next) => {
      c.set('userId', appUserId)
      await next()
    })
  }
  app.onError((err, c) => errorResponse(c, err))
  app.route('/', blogRoutes)
  return app
}

function env(db: MockDb): AppBindings['Bindings'] {
  return { DB: db } as unknown as AppBindings['Bindings']
}

const topComment: CommentFixture = {
  id: 'c1',
  parent_id: null,
  author_type: 'guest',
  author_name: 'Guest',
  author_avatar: '',
  is_owner: 0,
  is_deleted: 0,
  content: 'hello',
  created_at: 1_700_000_000_000,
}

const replyComment: CommentFixture = {
  id: 'c2',
  parent_id: 'c1',
  author_type: 'account',
  author_name: 'Member',
  author_avatar: '',
  is_owner: 0,
  is_deleted: 0,
  content: 'reply',
  created_at: 1_700_000_000_001,
}

describe('blog comments', () => {
  it('lists comments oldest-first with canManage false for visitors', async () => {
    const app = makeApp()
    const res = await app.request('/alice/posts/hello/comments', {}, env(makeDb({ comments: [topComment, replyComment] })))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.comments.map((c: { id: string }) => c.id)).toEqual(['c1', 'c2'])
    expect(body.comments[1].parent_id).toBe('c1')
    expect(body.canManage).toBe(false)
  })

  it('reports canManage true when the blog owner reads with an app session', async () => {
    const app = makeApp('u1')
    const res = await app.request('/alice/posts/hello/comments', {}, env(makeDb({ comments: [] })))
    expect(res.status).toBe(200)
    expect((await res.json()).canManage).toBe(true)
  })

  it('returns 404 for an unknown slug', async () => {
    const app = makeApp()
    const res = await app.request('/alice/posts/missing/comments', {}, env(makeDb({ noteId: null })))
    expect(res.status).toBe(404)
  })

  it('returns 404 for a private post without a blog session', async () => {
    const app = makeApp()
    const res = await app.request('/alice/posts/secret/comments', {}, env(makeDb({ privateSlugs: ['secret'] })))
    expect(res.status).toBe(404)
  })

  it('accepts a guest comment with nickname and email', async () => {
    const db = makeDb({})
    const app = makeApp()
    const res = await app.request('/alice/posts/hello/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'nice post', nickname: 'Guest', email: 'Guest@Example.com' }),
    }, env(db))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(db.writes.some((s) => s.includes('INSERT INTO blog_comments'))).toBe(true)
  })

  it('requires nickname and email for visitors without an app session', async () => {
    const app = makeApp()
    const res = await app.request('/alice/posts/hello/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'nice post' }),
    }, env(makeDb({})))
    expect(res.status).toBe(401)
    expect((await res.json()).error.details).toEqual({ code: 'guest_info_required' })
  })

  it('lets a signed-in app user comment without guest fields', async () => {
    const db = makeDb({})
    const app = makeApp('u2')
    const res = await app.request('/alice/posts/hello/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'from the app' }),
    }, env(db))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(db.writes.some((s) => s.includes('INSERT INTO blog_comments'))).toBe(true)
  })

  it('rejects an invalid guest email', async () => {
    const app = makeApp()
    const res = await app.request('/alice/posts/hello/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi', nickname: 'Guest', email: 'not-an-email' }),
    }, env(makeDb({})))
    expect(res.status).toBe(400)
  })

  it('rejects empty content', async () => {
    const app = makeApp('u2')
    const res = await app.request('/alice/posts/hello/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '   ' }),
    }, env(makeDb({})))
    expect(res.status).toBe(400)
  })

  it('accepts a reply to a top-level comment', async () => {
    const db = makeDb({ parent: { id: 'c1', parent_id: null, is_deleted: 0 } })
    const app = makeApp('u2')
    const res = await app.request('/alice/posts/hello/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'agreed', parentId: 'c1' }),
    }, env(db))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('rejects a reply to a reply, keeping threads single-level', async () => {
    const app = makeApp('u2')
    const res = await app.request('/alice/posts/hello/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'too deep', parentId: 'c2' }),
    }, env(makeDb({ parent: { id: 'c2', parent_id: 'c1', is_deleted: 0 } })))
    expect(res.status).toBe(400)
  })

  it('rejects a reply to a missing comment', async () => {
    const app = makeApp('u2')
    const res = await app.request('/alice/posts/hello/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'ghost', parentId: 'nope' }),
    }, env(makeDb({ parent: null })))
    expect(res.status).toBe(400)
  })

  it('rate-limits comment posting with 429', async () => {
    const app = makeApp('u2')
    const res = await app.request('/alice/posts/hello/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'spam' }),
    }, env(makeDb({ locked: true })))
    expect(res.status).toBe(429)
  })

  it('lets the blog owner soft-delete a comment', async () => {
    const db = makeDb({})
    const app = makeApp('u1')
    const res = await app.request('/alice/comments/c1', { method: 'DELETE' }, env(db))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(db.writes.some((s) => s.includes('UPDATE blog_comments SET is_deleted = 1'))).toBe(true)
  })

  it('forbids deletion by anyone but the owner', async () => {
    const app = makeApp('u2')
    const res = await app.request('/alice/comments/c1', { method: 'DELETE' }, env(makeDb({})))
    expect(res.status).toBe(403)
  })

  it('requires an app session to delete', async () => {
    const app = makeApp()
    const res = await app.request('/alice/comments/c1', { method: 'DELETE' }, env(makeDb({})))
    expect(res.status).toBe(401)
  })

  it('returns 404 when deleting a comment from another blog', async () => {
    const app = makeApp('u1')
    const res = await app.request('/alice/comments/c9', { method: 'DELETE' }, env(makeDb({ deletable: false })))
    expect(res.status).toBe(404)
  })
})
