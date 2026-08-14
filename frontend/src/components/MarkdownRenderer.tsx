import { useMemo } from 'react'
import { marked, Renderer } from 'marked'
import DOMPurify from 'dompurify'
import Prism from 'prismjs'

// Load common language grammars
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-markup'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-rust'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-c'
import 'prismjs/components/prism-cpp'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-toml'
import 'prismjs/components/prism-diff'

// ── Configure marked ──────────────────────────────────────────────────────────
const renderer = new Renderer()

// Strip all raw HTML blocks — never render user-supplied HTML
renderer.html = () => ''

// Syntax-highlight fenced code blocks
renderer.code = ({ text, lang }) => {
  const language = lang && Prism.languages[lang] ? lang : 'plaintext'
  const highlighted = language === 'plaintext'
    ? text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    : Prism.highlight(text, Prism.languages[language], language)
  return `<pre class="language-${language}"><code class="language-${language}">${highlighted}</code></pre>`
}

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
