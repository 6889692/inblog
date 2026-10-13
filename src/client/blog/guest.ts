const NICKNAME_KEY = 'blog_guest_nickname'
const EMAIL_KEY = 'blog_guest_email'

export interface GuestIdentity {
  nickname: string
  email: string
}

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

export function loadGuest(): GuestIdentity {
  return { nickname: read(NICKNAME_KEY), email: read(EMAIL_KEY) }
}

export function saveGuest(identity: GuestIdentity): void {
  try {
    localStorage.setItem(NICKNAME_KEY, identity.nickname)
    localStorage.setItem(EMAIL_KEY, identity.email)
  } catch {
    return
  }
}
