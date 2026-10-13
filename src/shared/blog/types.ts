export interface BlogPostSummary {
  id: string
  title: string
  excerpt: string
  created_at: number
  updated_at: number
  tags: string[]
  slug: string
  visibility: 'public' | 'private'
  views: number
  cover: string | null
}

export interface AdjacentPost {
  title: string
  slug: string
}

export interface BlogPostDetail extends BlogPostSummary {
  content: string
  previous: AdjacentPost | null
  next: AdjacentPost | null
}

export interface TimelineItem {
  id: string
  title: string
  created_at: number
  year: string
  slug: string
}

export interface BlogTag {
  name: string
  count: number
}

export type BlogTagPost =
  | ({ kind: 'article' } & BlogPostSummary)
  | ({ kind: 'moment' } & MomentItem)

export interface MomentItem {
  id: string
  content: string
  created_at: number
  tags: string[]
  slug: string
}

export interface BlogPostsResponse {
  posts: BlogPostSummary[]
  page: number
  hasMore: boolean
  totalPages: number
}

export interface BlogTimelineResponse {
  items: TimelineItem[]
  page: number
  hasMore: boolean
}

export interface BlogMomentsResponse {
  moments: MomentItem[]
  page: number
  hasMore: boolean
}

export const BLOG_REACTION_EMOJIS = ['❤️', '👍', '😄', '😕'] as const

export type BlogReactionEmoji = (typeof BLOG_REACTION_EMOJIS)[number]

export function isBlogReactionEmoji(value: unknown): value is BlogReactionEmoji {
  return typeof value === 'string' && (BLOG_REACTION_EMOJIS as readonly string[]).includes(value)
}

export interface BlogComment {
  id: string
  parent_id: string | null
  author_type: 'account' | 'guest'
  author_name: string
  author_avatar: string
  is_owner: boolean
  is_deleted: boolean
  content: string
  created_at: number
}

export interface BlogCommentsResponse {
  comments: BlogComment[]
  canManage: boolean
}

export interface BlogReactionsResponse {
  counts: Record<string, number>
  mine: string[]
}

