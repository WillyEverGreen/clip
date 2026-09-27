import { useEffect } from 'react'

interface SeoProps {
  title: string
  description?: string
  canonicalUrl?: string
}

export function useSeo({ title, description, canonicalUrl }: SeoProps) {
  useEffect(() => {
    // 1. Update Title
    const fullTitle = title.includes('Clip') ? title : `${title} — Clip`
    document.title = fullTitle

    // 2. Helper to set or create meta tag
    const setMetaTag = (selector: string, attr: string, value: string) => {
      let el = document.querySelector(selector)
      if (!el) {
        el = document.createElement('meta')
        const [key, val] = selector.replace(/[\[\]]/g, '').split('=')
        if (key && val) {
          el.setAttribute(key, val.replace(/['"]/g, ''))
        }
        document.head.appendChild(el)
      }
      el.setAttribute(attr, value)
    }

    // 3. Update Description
    if (description) {
      setMetaTag('meta[name="description"]', 'content', description)
      setMetaTag('meta[property="og:description"]', 'content', description)
      setMetaTag('meta[name="twitter:description"]', 'content', description)
    }

    // 4. Update OpenGraph and Twitter Title
    setMetaTag('meta[property="og:title"]', 'content', fullTitle)
    setMetaTag('meta[name="twitter:title"]', 'content', fullTitle)

    // 5. Update Canonical link if provided
    if (canonicalUrl) {
      let link = document.querySelector('link[rel="canonical"]')
      if (!link) {
        link = document.createElement('link')
        link.setAttribute('rel', 'canonical')
        document.head.appendChild(link)
      }
      link.setAttribute('href', canonicalUrl)
    }
  }, [title, description, canonicalUrl])
}
