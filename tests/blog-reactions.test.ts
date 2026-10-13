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

interface DbOptions {
  noteId?: string | null
  reactions?: Array<{ emoji: string; voter_key: string }>
  existing?: boolean
  locked?: boolean
}

function makeDb(options: DbOptions = {}): MockDb & { writes: string[] } {
  const writes: string[] = []
  const reactions = options.reactions ?? []
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
              if (sql.includes('SELECT emoji, voter_key FROM blog_reactions')) {
                return { results: reactions as T[] }
              }
              return { results: [] as T[] }
            },
            async first<T = unknown>() {
              if (sql.includes('SELECT id FROM users WHERE username')) {
                return ({ id: 'u1' }) as T | null
              }
              if (sql.includes('SELECT bp.note_id AS note_id')) {
                const noteId = options.noteId === undefined ? 'n1' : options.noteId
                return (noteId ? { note_id: noteId } : null) as T | null
              }
              if (sql.includes('SELECT emoji FROM blog_reactions WHERE owner_id')) {
                return (options.existing ? { emoji: String(args[2]) } : null) as T | null
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

describe('blog reactions', () => {
  it('returns counts with no mine for anonymous visitors', async () => {
    const app = makeApp()
    const res = await app.request('/alice/posts/hello/reactions', {}, env(makeDb({
      reactions: [
        { emoji: '👍', voter_key: 'u:u2' },
        { emoji: '👍', voter_key: 'e:a@x.com' },
        { emoji: '❤️', voter_key: 'u:u3' },
      ],
    })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ counts: { '👍': 2, '❤️': 1 }, mine: [] })
  })

  it('marks mine for a signed-in app user', async () => {
    const app = makeApp('u2')
    const res = await app.request('/alice/posts/hello/reactions', {}, env(makeDb({
      reactions: [
        { emoji: '👍', voter_key: 'u:u2' },
        { emoji: '❤️', voter_key: 'u:u3' },
      ],
    })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ counts: { '👍': 1, '❤️': 1 }, mine: ['👍'] })
  })

  it('marks mine for a guest email query', async () => {
    const app = makeApp()
    const res = await app.request('/alice/posts/hello/reactions?email=a%40x.com', {}, env(makeDb({
      reactions: [{ emoji: '🚀', voter_key: 'e:a@x.com' }],
    })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ counts: { '🚀': 1 }, mine: ['🚀'] })
  })

  it('returns 404 for an unknown slug', async () => {
    const app = makeApp()
    const res = await app.request('/alice/posts/missing/reactions', {}, env(makeDb({ noteId: null })))
    expect(res.status).toBe(404)
  })

  it('activates a reaction on first toggle', async () => {
    const db = makeDb({})
    const app = makeApp('u2')
    const res = await app.request('/alice/posts/hello/reactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '👍' }),
    }, env(db))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, active: true })
    expect(db.writes.some((s) => s.includes('INSERT INTO blog_reactions'))).toBe(true)
  })

  it('deactivates a reaction on second toggle', async () => {
    const db = makeDb({ existing: true })
    const app = makeApp('u2')
    const res = await app.request('/alice/posts/hello/reactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '👍' }),
    }, env(db))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, active: false })
    expect(db.writes.some((s) => s.includes('DELETE FROM blog_reactions'))).toBe(true)
  })

  it('lets guests react with an email', async () => {
    const db = makeDb({})
    const app = makeApp()
    const res = await app.request('/alice/posts/hello/reactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '😄', email: 'fan@example.com' }),
    }, env(db))
    expect(res.status).toBe(200)
    expect((await res.json()).active).toBe(true)
  })

  it('requires sign-in or email to react', async () => {
    const app = makeApp()
    const res = await app.request('/alice/posts/hello/reactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '👍' }),
    }, env(makeDb({})))
    expect(res.status).toBe(401)
    expect((await res.json()).error.details).toEqual({ code: 'guest_info_required' })
  })

  it('rejects an emoji outside the allowlist', async () => {
    const app = makeApp('u2')
    const res = await app.request('/alice/posts/hello/reactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '💩' }),
    }, env(makeDb({})))
    expect(res.status).toBe(400)
  })

  it('rejects retired emojis from the old set', async () => {
    const app = makeApp('u2')
    for (const emoji of ['🎉', '🚀', '👀', '👎']) {
      const res = await app.request('/alice/posts/hello/reactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      }, env(makeDb({})))
      expect(res.status).toBe(400)
    }
  })

  it('rate-limits reaction toggling with 429', async () => {
    const app = makeApp('u2')
    const res = await app.request('/alice/posts/hello/reactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '😕' }),
    }, env(makeDb({ locked: true })))
    expect(res.status).toBe(429)
  })
})
