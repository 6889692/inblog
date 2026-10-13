import { describe, expect, it } from 'vitest'
import { blogErrorCodeOf } from '../src/client/blog/api'

describe('blogErrorCodeOf', () => {
  it('prefers the nested details code used for guest identity', () => {
    expect(blogErrorCodeOf({
      error: { code: 'unauthenticated', message: 'Guest nickname and email are required', details: { code: 'guest_info_required' } },
    })).toBe('guest_info_required')
  })

  it('falls back to the top-level code for direct error bodies', () => {
    expect(blogErrorCodeOf({ error: { code: 'blog_auth_required', message: 'Blog authentication required' } })).toBe('blog_auth_required')
  })

  it('returns unknown for malformed bodies', () => {
    expect(blogErrorCodeOf(null)).toBe('unknown')
    expect(blogErrorCodeOf({})).toBe('unknown')
    expect(blogErrorCodeOf({ error: { code: 42 } })).toBe('unknown')
    expect(blogErrorCodeOf({ error: { code: '', details: { code: '' } } })).toBe('unknown')
  })
})
