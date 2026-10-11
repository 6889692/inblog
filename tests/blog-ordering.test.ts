// @vitest-environment node
// Real-SQLite ordering tests: mock DBs return canned rows, so ORDER BY can
// only be proven against a real engine.
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { listBlogPosts } from '../src/worker/blog/queries'

function realDb(): D1Database {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE TABLE tags (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE note_tags (note_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (note_id, tag_id));
    CREATE TABLE blog_posts (
      user_id TEXT NOT NULL, note_id TEXT NOT NULL, slug TEXT NOT NULL,
      visibility TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'article',
      is_pinned INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0,
      published_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, note_id)
    );
  `)
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql)
      let values: unknown[] = []
      const args = () => /\?\d+/.test(sql)
        ? [Object.fromEntries(values.map((value, index) => [String(index + 1), value]))]
        : values
      const prepared = {
        bind(...bound: unknown[]) { values = bound; return prepared },
        async first() { return (statement.get(...args() as never[]) as unknown) ?? null },
        async all() { return { results: statement.all(...args() as never[]) as unknown[] } },
        async run() {
          const r = statement.run(...args() as never[])
          return { success: true, meta: { changes: Number(r.changes) } }
        },
      }
      return prepared
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const results = []
      for (const s of statements) results.push(await s.run())
      return results
    },
  } as unknown as D1Database
  return db
}

async function seedPost(
  db: D1Database,
  row: { note: string; slug: string; visibility?: string; pinned?: boolean; published: number; updated: number },
): Promise<void> {
  const d1 = db as unknown as {
    prepare(sql: string): { bind(...a: unknown[]): { run(): Promise<unknown> } }
  }
  await d1.prepare(`INSERT INTO notes (id, user_id, title, content, excerpt, created_at, updated_at, deleted_at)
    VALUES (?1, 'u1', ?2, '', '', ?3, ?4, NULL)`)
    .bind(row.note, `title ${row.note}`, row.published, row.updated).run()
  await d1.prepare(`INSERT INTO blog_posts
    (user_id, note_id, slug, visibility, kind, is_pinned, views, published_at, created_at, updated_at)
    VALUES ('u1', ?1, ?2, ?3, 'article', ?4, 0, ?5, ?5, ?5)`)
    .bind(row.note, row.slug, row.visibility ?? 'public', row.pinned ? 1 : 0, row.published).run()
}

describe('feed ordering with real SQLite', () => {
  it('orders unpinned posts by published_at even when updated_at disagrees', async () => {
    const db = realDb()
    // A was published earlier but edited just now; B is newer and untouched.
    await seedPost(db, { note: 'a', slug: 'a', published: 1_000, updated: 9_000 })
    await seedPost(db, { note: 'b', slug: 'b', published: 5_000, updated: 2_000 })
    const { posts } = await listBlogPosts(db, 'u1', 'all', 1, 10)
    expect(posts.map((p) => p.id)).toEqual(['b', 'a'])
  })

  it('keeps pinned posts on top sorted by published_at like the rest', async () => {
    const db = realDb()
    await seedPost(db, { note: 'old', slug: 'old', published: 9_000, updated: 1_000 })
    await seedPost(db, { note: 'pinned-old', slug: 'pinned-old', pinned: true, published: 1_000, updated: 8_000 })
    await seedPost(db, { note: 'pinned-new', slug: 'pinned-new', pinned: true, published: 2_000, updated: 3_000 })
    const { posts } = await listBlogPosts(db, 'u1', 'all', 1, 10)
    expect(posts.map((p) => p.id)).toEqual(['pinned-new', 'pinned-old', 'old'])
  })

  it('manual front-matter dates drive position after resync', async () => {
    const db = realDb()
    await seedPost(db, { note: 'new', slug: 'new', published: 9_000, updated: 9_000 })
    await seedPost(db, { note: 'backdated', slug: 'backdated', published: 1_000, updated: 9_500 })
    const { posts } = await listBlogPosts(db, 'u1', 'all', 1, 10)
    expect(posts.map((p) => p.id)).toEqual(['new', 'backdated'])
  })
})
