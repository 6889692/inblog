import { useCallback, useEffect, useMemo, useState } from 'react'
import { blogApi, BlogApiError } from '../api'
import { loadGuest, saveGuest } from '../guest'
import type { BlogComment } from '@shared/blog/types'
import { t } from '../../lib/i18n'

function formatTime(ts: number): string {
  if (!Number.isFinite(ts) || !ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function CommentAvatar({ src, name }: { src: string; name: string }) {
  if (src) return <img src={src} alt="" width={24} height={24} className="blog-comment-avatar" />
  return (
    <span className="blog-comment-avatar blog-comment-avatar--fallback" aria-hidden>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

type PublishOutcome = 'posted' | 'need-login'

export function CommentsSection({ username, slug, showTitle = true, sectionId }: {
  username: string
  slug: string
  showTitle?: boolean
  sectionId?: string
}) {
  const [comments, setComments] = useState<BlogComment[]>([])
  const [canManage, setCanManage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [content, setContent] = useState('')
  const [nickname, setNickname] = useState('')
  const [email, setEmail] = useState('')
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyName, setReplyName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState('')

  const reload = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const data = await blogApi.comments(username, slug)
      setComments(data.comments)
      setCanManage(data.canManage)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [username, slug])

  useEffect(() => {
    const stored = loadGuest()
    setNickname(stored.nickname)
    setEmail(stored.email)
    void reload()
  }, [reload])

  const threads = useMemo(() => {
    const tops = comments.filter((c) => c.parent_id === null)
    const replies = new Map<string, BlogComment[]>()
    for (const c of comments) {
      if (c.parent_id === null) continue
      const list = replies.get(c.parent_id) ?? []
      list.push(c)
      replies.set(c.parent_id, list)
    }
    return tops.map((top) => ({ top, replies: replies.get(top.id) ?? [] }))
  }, [comments])

  const publish = useCallback(async (identity?: { nickname: string; email: string }): Promise<PublishOutcome> => {
    const body = content.trim()
    if (!body || submitting) return 'posted'
    setSubmitting(true)
    setNotice('')
    try {
      await blogApi.postComment(username, slug, {
        content: body,
        ...(replyTo ? { parentId: replyTo } : {}),
        ...(identity ? { nickname: identity.nickname, email: identity.email } : {}),
      })
      if (identity) saveGuest(identity)
      setContent('')
      setReplyTo(null)
      setReplyName('')
      setLoginOpen(false)
      await reload()
      return 'posted'
    } catch (err) {
      if (err instanceof BlogApiError && err.status === 401 && err.code === 'guest_info_required') {
        return 'need-login'
      }
      if (err instanceof BlogApiError && err.status === 429) {
        setNotice(t('blog.comments_too_many'))
        return 'posted'
      }
      setNotice(t('blog.something_went_wrong'))
      return 'posted'
    } finally {
      setSubmitting(false)
    }
  }, [content, replyTo, submitting, username, slug, reload])

  const submitMain = useCallback(async () => {
    if (!content.trim() || submitting) return
    const stored = loadGuest()
    const identity = stored.nickname && stored.email
      ? { nickname: stored.nickname, email: stored.email }
      : undefined
    if ((await publish(identity)) === 'need-login') {
      setLoginError('')
      setLoginOpen(true)
    }
  }, [content, submitting, publish])

  const submitWithEmail = useCallback(async () => {
    const name = nickname.trim()
    const mail = email.trim().toLowerCase()
    if (!name || !mail) {
      setLoginError(t('blog.comments_guest_info_required'))
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      setLoginError(t('blog.comments_invalid_email'))
      return
    }
    setLoginError('')
    if ((await publish({ nickname: name, email: mail })) === 'need-login') {
      setLoginError(t('blog.comments_guest_info_required'))
    }
  }, [nickname, email, publish])

  const continueAfterAccountLogin = useCallback(async () => {
    if ((await publish()) === 'need-login') {
      setLoginError(t('blog.comments_guest_info_required'))
    }
  }, [publish])

  const remove = useCallback(async (id: string) => {
    if (!window.confirm(t('blog.comments_delete_confirm'))) return
    try {
      await blogApi.deleteComment(username, id)
      await reload()
    } catch {
      setNotice(t('blog.something_went_wrong'))
    }
  }, [username, reload])

  const startReply = useCallback((id: string, name: string) => {
    setReplyTo(id)
    setReplyName(name)
  }, [])

  return (
    <section className="blog-comments" aria-label={t('blog.comments')} id={sectionId}>
      {showTitle && (
        <h2 className="blog-comments-title">
          {t('blog.comments')} · {t('blog.comments_count', { count: comments.length })}
        </h2>
      )}
      {loading && <p className="blog-comments-status">{t('blog.loading')}</p>}
      {!loading && failed && <p className="blog-comments-status">{t('blog.comments_load_error')}</p>}
      {!loading && !failed && comments.length === 0 && (
        <p className="blog-comments-status">{t('blog.comments_empty')}</p>
      )}
      <div className="blog-comments-list">
        {threads.map(({ top, replies }) => (
          <div key={top.id} className="blog-comment-thread">
            <CommentNode
              comment={top}
              canManage={canManage}
              onReply={startReply}
              onDelete={remove}
            />
            {replies.length > 0 && (
              <div className="blog-comment-replies">
                {replies.map((reply) => (
                  <CommentNode
                    key={reply.id}
                    comment={reply}
                    canManage={canManage}
                    onReply={undefined}
                    onDelete={remove}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="blog-comment-form">
        {replyTo && (
          <div className="blog-comment-replying">
            <span>{t('blog.comments_replying_to', { name: replyName })}</span>
            <button type="button" onClick={() => { setReplyTo(null); setReplyName('') }}>
              {t('blog.comments_cancel_reply')}
            </button>
          </div>
        )}
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t('blog.comments_content_placeholder')}
          rows={3}
          maxLength={2000}
          aria-label={t('blog.comments')}
        />
        {notice && <p className="blog-comment-notice" role="alert">{notice}</p>}
        <button type="button" disabled={submitting || !content.trim()} onClick={() => void submitMain()}>
          {submitting ? t('blog.comments_submitting') : t('blog.comments_submit')}
        </button>
      </div>
      {loginOpen && (
        <div className="blog-login-overlay" onClick={() => setLoginOpen(false)}>
          <div
            className="blog-login-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('blog.comments_login_title')}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="blog-login-title">{t('blog.comments_login_title')}</h3>
            <div className="blog-login-option">
              <a className="blog-login-account" href="/" target="_blank" rel="noreferrer">
                {t('blog.comments_login_account')}
              </a>
              <button type="button" className="blog-login-continue" onClick={() => void continueAfterAccountLogin()}>
                {t('blog.comments_logged_in_continue')}
              </button>
            </div>
            <div className="blog-login-option">
              <label>
                <span>{t('blog.comments_nickname')}</span>
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder={t('blog.comments_nickname_placeholder')}
                  maxLength={50}
                  autoComplete="nickname"
                />
              </label>
              <label>
                <span>{t('blog.comments_email')}</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('blog.comments_email_placeholder')}
                  maxLength={254}
                  autoComplete="email"
                />
              </label>
              {loginError && <p className="blog-comment-notice" role="alert">{loginError}</p>}
              <button type="button" className="blog-login-email" onClick={() => void submitWithEmail()}>
                {t('blog.comments_login_email')}
              </button>
            </div>
            <button type="button" className="blog-login-cancel" onClick={() => setLoginOpen(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function CommentNode({ comment, canManage, onReply, onDelete }: {
  comment: BlogComment
  canManage: boolean
  onReply?: (id: string, name: string) => void
  onDelete: (id: string) => void
}) {
  if (comment.is_deleted) {
    return (
      <div className="blog-comment blog-comment--deleted">
        <p>{t('blog.comments_deleted')}</p>
      </div>
    )
  }
  return (
    <div className="blog-comment">
      <CommentAvatar src={comment.author_avatar} name={comment.author_name} />
      <div className="blog-comment-body">
        <div className="blog-comment-head">
          <span className="blog-comment-author">{comment.author_name}</span>
          {comment.is_owner && <span className="blog-comment-badge">{t('blog.comments_owner')}</span>}
          <time dateTime={new Date(comment.created_at).toISOString()}>{formatTime(comment.created_at)}</time>
        </div>
        <p className="blog-comment-text">{comment.content}</p>
        <div className="blog-comment-actions">
          {onReply && (
            <button type="button" onClick={() => onReply(comment.id, comment.author_name)}>
              {t('blog.comments_reply')}
            </button>
          )}
          {canManage && (
            <button type="button" onClick={() => void onDelete(comment.id)}>
              {t('blog.comments_delete')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
