import fs from 'node:fs'
import path from 'node:path'

const pages = [
  { file: 'frontend/dist/index.html', expectedCanonical: 'https://clip.foo.ng/' },
  { file: 'frontend/dist/about/index.html', expectedCanonical: 'https://clip.foo.ng/about' },
  { file: 'frontend/dist/live/index.html', expectedCanonical: 'https://clip.foo.ng/live' },
  { file: 'frontend/dist/beam/index.html', expectedCanonical: 'https://clip.foo.ng/beam' },
]

let allPassed = true

for (const p of pages) {
  const content = fs.readFileSync(p.file, 'utf8')
  const titleMatch = content.match(/<title>(.*?)<\/title>/)
  const title = titleMatch ? titleMatch[1] : ''
  const descMatch = content.match(/<meta name="description" content="(.*?)"/)
  const desc = descMatch ? descMatch[1] : ''
  const canonMatch = content.match(/<link rel="canonical" href="(.*?)"/)
  const canon = canonMatch ? canonMatch[1] : ''
  const h1Match = content.match(/<h1[^>]*>(.*?)<\/h1>/)
  const h1 = h1Match ? h1Match[1] : ''

  console.log(`--- Checking ${p.file} ---`)
  console.log(`  Title: ${title}`)
  console.log(`  Canonical: ${canon} (Matches Expected: ${canon === p.expectedCanonical})`)
  console.log(`  Description (${desc.length} chars): ${desc}`)
  console.log(`  H1: ${h1}`)

  if (canon !== p.expectedCanonical || !title || !desc || !h1 || desc.length > 165) {
    console.error(`FAILED criteria on ${p.file}`)
    allPassed = false
  }
}

if (allPassed) {
  console.log('\nVERDICT: PASS')
} else {
  console.error('\nVERDICT: FAIL')
  process.exit(1)
}
