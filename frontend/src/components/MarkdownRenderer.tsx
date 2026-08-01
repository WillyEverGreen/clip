import { useMemo } from 'react'
import { marked, Renderer } from 'marked'
import DOMPurify from 'dompurify'

// ── Configure marked ──────────────────────────────────────────────────────────
const renderer = new Renderer()
// Strip all raw HTML blocks — never render user-supplied HTML
renderer.html = () => ''

marked.use({ renderer, breaks: true, gfm: true })

// ── DOMPurify config ──────────────────────────────────────────────────────────
const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS:  ['script', 'style', 'iframe', 'form', 'input', 'button', 'object', 'embed'],
  FORBID_ATTR:  ['onerror', 'onload', 'onclick', 'onmouseover', 'srcdoc', 'action'],
}

interface Props { content: string }

export default function MarkdownRenderer({ content }: Props) {
  const html = useMemo(() => {
    const raw = marked.parse(content) as string
    return DOMPurify.sanitize(raw, PURIFY_CONFIG)
  }, [content])

  return (
    <div
      className="markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
