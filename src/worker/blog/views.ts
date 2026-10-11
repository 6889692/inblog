import { getMeta, setMeta } from '../db/metadata'

/** Same viewer + post counts at most once per window. */
export const BLOG_VIEW_WINDOW_MS = 10 * 60 * 1000

const BLOG_VIEW_PREFIX = 'blog_view:'

export const blogViewKey = (userId: string, slug: string, viewer: string): string =>
  `${BLOG_VIEW_PREFIX}${userId}:${slug}:${viewer}`

export async function shouldCountBlogView(db: D1Database, key: string, now = Date.now()): Promise<boolean> {
  const last = await getMeta(db, key)
  return !last || now - Number(last) >= BLOG_VIEW_WINDOW_MS
}

export async function recordBlogView(
  db: D1Database,
  key: string,
  userId: string,
  noteId: string,
  now = Date.now(),
): Promise<void> {
  await setMeta(db, key, String(now))
  await db
    .prepare(`UPDATE blog_posts SET views = views + 1 WHERE user_id = ?1 AND note_id = ?2`)
    .bind(userId, noteId)
    .run()
}
