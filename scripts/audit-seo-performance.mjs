import { chromium } from 'playwright-core'

const BASE_URL = 'https://clip.foo.ng'
const routes = ['/', '/about', '/live', '/beam']

async function runAudit() {
  console.log(`Starting Comprehensive Browser & SEO Audit on ${BASE_URL}...\n`)

  // Locate Chrome / Edge on system
  const browser = await chromium.launch({
    headless: true,
    channel: 'msedge',
  }).catch(() => chromium.launch({
    headless: true,
    channel: 'chrome',
  }))

  const results = []

  for (const route of routes) {
    const pageUrl = `${BASE_URL}${route}`
    console.log(`\n==================================================`)
    console.log(`Auditing: ${pageUrl}`)
    console.log(`==================================================`)

    const page = await browser.newPage()
    const consoleErrors = []
    const failedRequests = []

    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('requestfailed', req => {
      failedRequests.push(`${req.method()} ${req.url()} - ${req.failure()?.errorText}`)
    })

    const startTime = Date.now()
    const response = await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30000 })
    const loadTimeMs = Date.now() - startTime

    const status = response ? response.status() : 0
    const title = await page.title()
    const description = await page.$eval('meta[name="description"]', el => el.getAttribute('content')).catch(() => null)
    const canonical = await page.$eval('link[rel="canonical"]', el => el.getAttribute('href')).catch(() => null)
    const h1Elements = await page.$$eval('h1', els => els.map(e => e.textContent.trim()))
    const jsonLdBlocks = await page.$$eval('script[type="application/ld+json"]', els => els.length)
    const ogTitle = await page.$eval('meta[property="og:title"]', el => el.getAttribute('content')).catch(() => null)
    const ogImage = await page.$eval('meta[property="og:image"]', el => el.getAttribute('content')).catch(() => null)

    // Performance Timing Metrics from browser
    const performanceTiming = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0]
      const paint = performance.getEntriesByType('paint')
      const fcp = paint.find(p => p.name === 'first-contentful-paint')?.startTime || 0
      return {
        ttfbMs: nav ? Math.round(nav.responseStart - nav.requestStart) : 0,
        domLoadMs: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : 0,
        fcpMs: Math.round(fcp),
      }
    })

    const audit = {
      route,
      url: pageUrl,
      status,
      loadTimeMs,
      performanceTiming,
      seo: {
        title,
        titleLength: title.length,
        description,
        descLength: description ? description.length : 0,
        canonical,
        h1Count: h1Elements.length,
        h1Texts: h1Elements,
        jsonLdBlocks,
        ogTitle,
        ogImage,
      },
      errors: {
        consoleErrorCount: consoleErrors.length,
        failedRequestCount: failedRequests.length,
      }
    }

    results.push(audit)

    console.log(`HTTP Status: ${status} (${loadTimeMs}ms)`)
    console.log(`TTFB: ${performanceTiming.ttfbMs}ms | FCP: ${performanceTiming.fcpMs}ms | DOM Load: ${performanceTiming.domLoadMs}ms`)
    console.log(`Title (${title.length} chars): ${title}`)
    console.log(`Canonical: ${canonical}`)
    console.log(`Description (${description ? description.length : 0} chars): ${description || 'MISSING'}`)
    console.log(`H1 Count: ${h1Elements.length} -> [${h1Elements.join(', ')}]`)
    console.log(`JSON-LD Schema Blocks: ${jsonLdBlocks}`)
    console.log(`Console Errors: ${consoleErrors.length}`)
    console.log(`Failed Requests: ${failedRequests.length}`)

    await page.close()
  }

  await browser.close()
  console.log(`\n==================================================`)
  console.log(`AUDIT COMPLETE: All ${routes.length} routes audited successfully.`)
  console.log(`==================================================\n`)
}

runAudit().catch(err => {
  console.error('Audit failed:', err)
  process.exit(1)
})
