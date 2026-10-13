import { blogApi } from '../api'
import type { BlogPostDetail } from '@shared/blog/types'
import { BlogMarkdown } from '../components/markdown'
import { CommentsSection } from '../components/comments'
import { InteractBar } from '../components/reactions'
import { TableOfContents } from '../components/toc'
import LoginPage from './login'
import { useBlogQuery } from './use-blog-query'
import { visibleTags } from '../filter-tags'
import { t } from '../../lib/i18n'
import { fullTime } from '../../lib/time'
import { countText, readingMinutes } from '@shared/markdown-utils'
import { useCallback, useState } from 'react'

function AuthorAvatar({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false)
  if (src && !failed) {
    return <img src={src} alt="" width={18} height={18} onError={() => setFailed(true)} className="blog-author-avatar" />
  }
  return <span className="blog-author-avatar blog-author-avatar--fallback" aria-hidden>{(name.trim()[0] ?? '?').toUpperCase()}</span>
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export default function PostPage({ username, slug, hiddenTags }: {
  username: string
  slug: string
  hiddenTags?: string[]
}) {
  const decodedSlug = safeDecodeURIComponent(slug)
  const scrollToComments = useCallback(() => {
    document.getElementById('blog-post-comments')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])
  const { status, data } = useBlogQuery<BlogPostDetail>(
    () => blogApi.post(username, decodedSlug),
    [username, decodedSlug],
  )
  const { data: meta } = useBlogQuery(
    () => blogApi.meta(username),
    [username],
  )

  if (status === 'auth')
    return <LoginPage username={username} />
  if (status === 'loading')
    return <div className="blog-loading">{t('blog.loading')}</div>
  if (status === 'error' || !data)
    return (
      <div className="blog-error-card">
        <p>{t('blog.post_load_error')}</p>
      </div>
    )

  const base = `/blog/${encodeURIComponent(username)}`
  const tags = visibleTags(data.tags, hiddenTags)
  const authorName = meta?.authorName || username
  const words = countText(data.content).words
  return (
    <div className="blog-post-page">
      <div className="blog-post-content">
        <article className="blog-post">
          <header className="blog-post-header">
            <h1 className="blog-post-title">{data.title}</h1>
            <div className="blog-post-meta">
              <span className="blog-author">
                <AuthorAvatar src={meta?.authorAvatarUrl ?? ''} name={authorName} />
                {authorName}
              </span>
              <span>·</span>
              <time dateTime={new Date(data.updated_at).toISOString()}>{fullTime(data.updated_at)}</time>
              <span>·</span>
              <span>{words}{t('common.words')}</span>
              <span>·</span>
              <span>{t('common.about')}{readingMinutes(words)}{t('common.min')}</span>
              <span>·</span>
              <span>{t('blog.views', { count: data.views })}</span>
            </div>
            {tags.length > 0 && (
              <div className="blog-post-tags">
                {tags.map((tag) => (
                  <a key={tag} className="blog-chip blog-chip--sm" href={`${base}/tags/${encodeURIComponent(tag)}`}>
                    {tag}
                  </a>
                ))}
              </div>
            )}
          </header>
          <BlogMarkdown content={data.content} slug={data.slug} />
          <InteractBar username={username} slug={decodedSlug} onComment={scrollToComments} />
          <CommentsSection username={username} slug={decodedSlug} sectionId="blog-post-comments" />
          {(data.previous || data.next) && (
            <nav className="blog-post-nav" aria-label={t('blog.post_navigation')}>
              {data.previous && (
                <a className="blog-post-nav-link blog-post-nav-previous" href={`${base}/posts/${encodeURIComponent(data.previous.slug)}`}>
                  <span className="blog-post-nav-label">{t('blog.previous_post')}</span>
                  <span className="blog-post-nav-title">{data.previous.title}</span>
                </a>
              )}
              {data.next && (
                <a className="blog-post-nav-link blog-post-nav-next" href={`${base}/posts/${encodeURIComponent(data.next.slug)}`}>
                  <span className="blog-post-nav-label">{t('blog.next_post')}</span>
                  <span className="blog-post-nav-title">{data.next.title}</span>
                </a>
              )}
            </nav>
          )}
        </article>
      </div>
      <aside className="blog-toc-aside">
        <TableOfContents content={data.content} />
      </aside>
    </div>
  )
}
