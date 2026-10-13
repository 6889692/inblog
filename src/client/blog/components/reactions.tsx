import { useCallback, useEffect, useState } from 'react'
import { blogApi, BlogApiError } from '../api'
import { loadGuest, saveGuest } from '../guest'
import { BLOG_REACTION_EMOJIS } from '@shared/blog/types'
import { t } from '../../lib/i18n'

interface ReactionState {
  counts: Record<string, number>
  mine: string[]
}

export function InteractBar({ username, slug, onComment }: {
  username: string
  slug: string
  onComment: () => void
}) {
  const [state, setState] = useState<ReactionState>({ counts: {}, mine: [] })
  const [expanded, setExpanded] = useState(false)
  const [needEmail, setNeedEmail] = useState(false)
  const [needEmoji, setNeedEmoji] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const stored = loadGuest()
      const data = await blogApi.reactions(username, slug, stored.email || undefined)
      setState({ counts: data.counts, mine: data.mine })
    } catch {
      return
    }
  }, [username, slug])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = useCallback(async (emoji: string, withEmail?: string) => {
    const stored = loadGuest()
    const useEmail = withEmail ?? stored.email
    setPending(emoji)
    try {
      const res = await blogApi.toggleReaction(username, slug, useEmail ? { emoji, email: useEmail } : { emoji })
      setState((prev) => {
        const counts = { ...prev.counts }
        const mine = new Set(prev.mine)
        if (res.active) {
          counts[emoji] = (counts[emoji] ?? 0) + 1
          mine.add(emoji)
        } else {
          counts[emoji] = Math.max(0, (counts[emoji] ?? 1) - 1)
          mine.delete(emoji)
        }
        return { counts, mine: [...mine] }
      })
      setNeedEmail(false)
    } catch (err) {
      if (err instanceof BlogApiError && err.code === 'guest_info_required') {
        setEmail(useEmail)
        setNeedEmoji(emoji)
        setNeedEmail(true)
        return
      }
    } finally {
      setPending(null)
    }
  }, [username, slug])

  const submitEmail = useCallback(() => {
    if (!needEmoji) return
    const value = email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return
    const stored = loadGuest()
    saveGuest({ nickname: stored.nickname, email: value })
    void toggle(needEmoji, value)
  }, [email, needEmoji, toggle])

  const reacted = BLOG_REACTION_EMOJIS.filter((emoji) => (state.counts[emoji] ?? 0) > 0)

  return (
    <div className="blog-interact">
      <div className="blog-interact-main">
        {reacted.length > 0 && (
          <div className="blog-interact-summary">
            {reacted.map((emoji) => {
              const active = state.mine.includes(emoji)
              return (
                <button
                  key={emoji}
                  type="button"
                  disabled={pending === emoji}
                  onClick={() => void toggle(emoji)}
                  className={active ? 'blog-interact-chip blog-interact-chip--active' : 'blog-interact-chip'}
                  aria-pressed={active}
                >
                  <span aria-hidden>{emoji}</span>
                  <span className="blog-interact-count">{state.counts[emoji]}</span>
                </button>
              )
            })}
          </div>
        )}
        <button
          type="button"
          className="blog-interact-more"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-label={t('common.more_actions')}
        >
          <span aria-hidden>•••</span>
        </button>
      </div>
      {expanded && (
        <div className="blog-interact-picker">
          {BLOG_REACTION_EMOJIS.map((emoji) => {
            const active = state.mine.includes(emoji)
            return (
              <button
                key={emoji}
                type="button"
                disabled={pending === emoji}
                onClick={() => void toggle(emoji)}
                className={active ? 'blog-interact-pick blog-interact-pick--active' : 'blog-interact-pick'}
                aria-pressed={active}
                aria-label={emoji}
              >
                <span aria-hidden>{emoji}</span>
              </button>
            )
          })}
          <button type="button" className="blog-interact-comment" onClick={onComment}>
            {t('blog.comments')}
          </button>
        </div>
      )}
      {needEmail && (
        <div className="blog-interact-guest">
          <span>{t('blog.comments_guest_info_required')}</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('blog.comments_email_placeholder')}
            aria-label={t('blog.comments_email')}
          />
          <button type="button" onClick={submitEmail}>
            {t('blog.comments_submit')}
          </button>
        </div>
      )}
    </div>
  )
}
