// Guards parity between the main app prose styles (.ink-prose) and the
// blog prose styles (.blog-prose). Tailwind preflight strips list markers
// globally; both scopes must restore them or bullets silently disappear.
// If you change list styling in one file, mirror it in the other.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const root = process.cwd()
const mainCss = readFileSync(`${root}/src/client/styles/prose.css`, 'utf8')
const blogCss = readFileSync(`${root}/src/client/blog/styles.css`, 'utf8')

function declarations(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'gs')
  const blocks: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(css))) blocks.push(match[1]!)
  if (!blocks.length) throw new Error(`selector not found: ${selector}`)
  return blocks.join(' ').replace(/\s+/g, ' ').trim()
}

describe('blog prose parity with main prose', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['.ink-prose ul', '.blog-prose ul', /list-style-type:\s*disc/],
    ['.ink-prose ol', '.blog-prose ol', /list-style-type:\s*decimal/],
    ['.ink-prose ul ul', '.blog-prose ul ul', /list-style-type:\s*circle/],
    ['.ink-prose ul ul ul', '.blog-prose ul ul ul', /list-style-type:\s*square/],
    ['.ink-prose li::marker', '.blog-prose li::marker', /color:/],
  ]
  for (const [mainSel, blogSel, pattern] of cases) {
    it(`${blogSel} restores markers like ${mainSel}`, () => {
      expect(declarations(mainCss, mainSel)).toMatch(pattern)
      expect(declarations(blogCss, blogSel)).toMatch(pattern)
    })
  }
})
