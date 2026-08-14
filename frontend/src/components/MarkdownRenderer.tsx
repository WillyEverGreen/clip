import { useMemo } from 'react'
import { marked, Renderer } from 'marked'
import markedKatex from 'marked-katex-extension'
import DOMPurify from 'dompurify'
import Prism from 'prismjs'
import 'katex/dist/katex.min.css'

// ── Load Prism language grammars ─────────────────────────────────────────────
import 'prismjs/components/prism-clike'
import 'prismjs/components/prism-c'
import 'prismjs/components/prism-cpp'
import 'prismjs/components/prism-csharp'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-kotlin'
import 'prismjs/components/prism-swift'
import 'prismjs/components/prism-scala'
import 'prismjs/components/prism-dart'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-ruby'
import 'prismjs/components/prism-php'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-rust'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-markup'
import 'prismjs/components/prism-markup-templating'
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-scss'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-toml'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-powershell'
import 'prismjs/components/prism-batch'
import 'prismjs/components/prism-diff'
import 'prismjs/components/prism-docker'
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-latex'
import 'prismjs/components/prism-ini'

// ── Math normalization helper (handles LaTeX exports from ChatGPT/Claude/Obsidian) ──
function normalizeMathAndText(text: string): string {
  if (!text) return ''

  // Convert standard LaTeX \[ ... \] to $$ ... $$
  let res = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)

  // Convert standard LaTeX \( ... \) to $ ... $
  res = res.replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `$${m.trim()}$`)

  // Line-by-line bracket matcher for [ \n math \n ] (matrices, equations)
  const lines = res.split(/\r?\n/)
  const result: string[] = []
  let inBracketMath = false
  let bracketBuffer: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!inBracketMath && (trimmed === '[' || trimmed === '\\[')) {
      inBracketMath = true
      bracketBuffer = []
      continue
    }

    if (inBracketMath && (trimmed === ']' || trimmed === '\\]')) {
      inBracketMath = false
      const mathContent = bracketBuffer.join('\n').trim()
      // If it contains LaTeX commands or equation symbols, wrap in $$ ... $$
      if (
        mathContent.includes('\\') ||
        mathContent.includes('=') ||
        mathContent.includes('+') ||
        mathContent.includes('-') ||
        mathContent.includes('*') ||
        mathContent.includes('^')
      ) {
        result.push('\n$$\n' + mathContent + '\n$$\n')
      } else {
        result.push('[')
        result.push(...bracketBuffer)
        result.push(']')
      }
      bracketBuffer = []
      continue
    }

    if (inBracketMath) {
      bracketBuffer.push(line)
    } else {
      result.push(line)
    }
  }

  if (inBracketMath) {
    result.push('[')
    result.push(...bracketBuffer)
  }

  return result.join('\n')
}

// ── Configure custom renderer ────────────────────────────────────────────────
const renderer = new Renderer()

// Safely escape any stray raw HTML tags without deleting generic types (e.g. List<String>, <slug>)
renderer.html = ({ text }: { text: string }) => {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Syntax-highlight fenced code blocks with language badge
renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
  const normalizedLang = (lang || '').toLowerCase().trim()
  const language = (normalizedLang && Prism.languages[normalizedLang]) ? normalizedLang : 'plaintext'
  let highlighted = ''
  try {
    highlighted = language === 'plaintext'
      ? text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      : Prism.highlight(text, Prism.languages[language], language)
  } catch {
    highlighted = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  const langLabel = (normalizedLang || 'code').toUpperCase()

  return `<div class="code-block-container"><div class="code-block-header"><span class="code-block-lang">${langLabel}</span></div><pre class="language-${language}"><code class="language-${language}">${highlighted}</code></pre></div>`
}

marked.use(
  markedKatex({ throwOnError: false }),
  {
    renderer,
    breaks: false, // Standard GFM: double newline creates paragraph; prevents math and code breaks
    gfm: true,
  }
)

// ── DOMPurify config ──────────────────────────────────────────────────────────
const PURIFY_CONFIG = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  ADD_TAGS: [
    'math', 'semantics', 'mrow', 'mo', 'mi', 'mn', 'mtable', 'mtr', 'mtd',
    'annotation', 'annotation-xml', 'span', 'pre', 'code', 'div',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'ul', 'ol', 'li',
    'em', 'strong', 'del', 'ins', 'sub', 'sup', 'mark', 'kbd',
    'details', 'summary', 'br', 'img', 'svg', 'path'
  ],
  ADD_ATTR: [
    'class', 'style', 'aria-hidden', 'encoding', 'display', 'xmlns',
    'viewBox', 'd', 'fill', 'stroke', 'target', 'rel', 'href', 'src', 'alt', 'title'
  ],
  FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'input', 'button', 'object', 'embed'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'srcdoc', 'action'],
}

interface Props {
  content: string
}

export default function MarkdownRenderer({ content }: Props) {
  const html = useMemo(() => {
    try {
      const normalized = normalizeMathAndText(content)
      const raw = marked.parse(normalized) as string
      return DOMPurify.sanitize(raw, PURIFY_CONFIG)
    } catch {
      return DOMPurify.sanitize(content)
    }
  }, [content])

  return (
    <div
      className="markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

