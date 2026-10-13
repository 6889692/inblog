import type {
  BlogPostsResponse, BlogPostDetail, BlogMomentsResponse, BlogTag,
  BlogTimelineResponse, BlogTagPost, BlogCommentsResponse, BlogReactionsResponse,
} from '@shared/blog/types'
import { CLIENT_HEADER } from '@shared/constants'

const BLOG_API = '/api/blog'

export class BlogApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Blog API error: ${status} (${code})`)
  }
}

export class BlogAuthError extends BlogApiError {
  constructor(code = 'blog_auth_required') {
    super(401, code)
  }
}

async function blogFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BLOG_API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', [CLIENT_HEADER]: '1', ...init?.headers },
  })
  if (res.status === 401) throw new BlogAuthError(await readErrorCode(res))
  if (!res.ok) throw new BlogApiError(res.status, await readErrorCode(res))
  return res.json() as Promise<T>
}

async function readErrorCode(res: Response): Promise<string> {
  try {
    return blogErrorCodeOf(await res.clone().json())
  } catch {
    return 'unknown'
  }
}

export function blogErrorCodeOf(body: unknown): string {
  if (!body || typeof body !== 'object') return 'unknown'
  const error = (body as { error?: unknown }).error
  if (!error || typeof error !== 'object') return 'unknown'
  const details = (error as { details?: unknown }).details
  if (details && typeof details === 'object') {
    const nested = (details as { code?: unknown }).code
    if (typeof nested === 'string' && nested) return nested
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code ? code : 'unknown'
}

export async function blogLogin(username: string, password: string): Promise<boolean> {
  const res = await fetch(`${BLOG_API}/${encodeURIComponent(username)}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [CLIENT_HEADER]: '1' },
    body: JSON.stringify({ password }),
  })
  return res.ok
}

export interface BlogMeta {
  username: string
  title: string | null
  description: string | null
  publicTag: string
  privateTag: string
  momentsTag: string
  pinnedTag: string
  authorName: string
  authorAvatarUrl: string
  accent: string
}

export interface BlogSettings {
  hasCustomPassword: boolean
  title: string | null
  description: string | null
  publicTag: string
  privateTag: string
  momentsTag: string
  pinnedTag: string
}

export const blogApi = {
  auth: blogLogin,
  session: (username: string) =>
    blogFetch<{ authed: boolean }>(`/${encodeURIComponent(username)}/session`),
  logout: (username: string) =>
    blogFetch<{ ok: true }>(`/${encodeURIComponent(username)}/logout`, { method: 'POST' }),
  meta: (username: string) =>
    blogFetch<BlogMeta>(`/${encodeURIComponent(username)}/meta`),
  posts: (username: string, page = 1, limit = 10) =>
    blogFetch<BlogPostsResponse>(`/${encodeURIComponent(username)}/posts?page=${page}&limit=${limit}`),
  post: (username: string, slug: string) =>
    blogFetch<BlogPostDetail>(`/${encodeURIComponent(username)}/posts/${encodeURIComponent(slug)}`),
  moments: (username: string, page = 1, limit = 20) =>
    blogFetch<BlogMomentsResponse>(`/${encodeURIComponent(username)}/moments?page=${page}&limit=${limit}`),
  timeline: (username: string, page = 1, limit = 20) =>
    blogFetch<BlogTimelineResponse>(`/${encodeURIComponent(username)}/timeline?page=${page}&limit=${limit}`),
  tags: (username: string) =>
    blogFetch<{ tags: BlogTag[] }>(`/${encodeURIComponent(username)}/tags`),
  tag: (username: string, name: string) =>
    blogFetch<{ name: string; posts: BlogTagPost[] }>(`/${encodeURIComponent(username)}/tags/${encodeURIComponent(name)}`),
  comments: (username: string, slug: string) =>
    blogFetch<BlogCommentsResponse>(`/${encodeURIComponent(username)}/posts/${encodeURIComponent(slug)}/comments`),
  postComment: (username: string, slug: string, body: { content: string; parentId?: string; nickname?: string; email?: string }) =>
    blogFetch<{ ok: true; id: string }>(`/${encodeURIComponent(username)}/posts/${encodeURIComponent(slug)}/comments`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteComment: (username: string, id: string) =>
    blogFetch<{ ok: true }>(`/${encodeURIComponent(username)}/comments/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  reactions: (username: string, slug: string, email?: string) =>
    blogFetch<BlogReactionsResponse>(
      `/${encodeURIComponent(username)}/posts/${encodeURIComponent(slug)}/reactions${email ? `?email=${encodeURIComponent(email)}` : ''}`,
    ),
  toggleReaction: (username: string, slug: string, body: { emoji: string; email?: string }) =>
    blogFetch<{ ok: true; active: boolean }>(`/${encodeURIComponent(username)}/posts/${encodeURIComponent(slug)}/reactions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  settings: () =>
    blogFetch<BlogSettings>('/settings'),
  updateSettings: (body: { password?: string | null; title?: string; description?: string | null; publicTag?: string; privateTag?: string; momentsTag?: string; pinnedTag?: string }) =>
    blogFetch<{ ok: true }>('/settings', { method: 'PUT', body: JSON.stringify(body) }),
}
