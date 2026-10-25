# Clip: search visibility plan

What is already in the code, what only you can do, and what to expect. Nothing here needs a paid tool.

## Already done in the repo

- Each public page has its own title, description, canonical, Open Graph and Twitter tags: `/`, `/about`, `/live`, `/beam`.
- `/about`, `/live` and `/beam` are pre-rendered at build time (`scripts/generate-seo-pages.mjs`), so crawlers get real HTML and text before any JavaScript runs.
- The `/about` landing page carries the full FAQ (general questions plus six about Clip Beam). The text lives in `frontend/src/lib/faq.json` and feeds the page, the pre-rendered HTML and the FAQ structured data, so they always match. `/beam` stays a clean tool page.
- Structured data: `WebSite` everywhere, `WebApplication` on the home page, `WebApplication` + `BreadcrumbList` on `/beam`, `FAQPage` on `/about` only (markup must match visible text, and FAQ rich results are limited to government and health sites anyway).
- The crawler text inside the page shell is visually hidden so it never flashes before the app loads; visitors without JavaScript still see it.
- Private and temporary pages are kept out of results: view pages (`/:slug`), edit pages, the not-found page get `noindex`. Live Pad rooms all point their canonical at `/live`. `robots.txt` blocks `/api`, `/admin`, `/r`, `/f`, `/z`.
- `sitemap.xml`, `llms.txt`, IndexNow key file.
- Claims are accurate: Beam does not say "any size" any more (Chrome and Edge stream to disk, Firefox and Safari about 2 GB, both people online). Wrong claims in structured data can get rich results removed.
- Dim text contrast raised so Lighthouse accessibility stops flagging it.

After you deploy, run `npm run audit:seo`. It audits the live site, so it only shows the new titles once they are published.

## Do these once (about 30 minutes)

1. **Google Search Console**: you already have a verification file (`googlec154a74745b36d13.html`). Add the property, submit `https://clip.foo.ng/sitemap.xml`, then use URL Inspection → Request indexing for `/`, `/beam`, `/live`, `/about`.
2. **Bing Webmaster Tools**: import the site from Search Console, submit the sitemap. This also feeds DuckDuckGo, Ecosia and, in part, ChatGPT search.
3. **IndexNow**: after each deploy, ping `https://api.indexnow.org/indexnow?url=https://clip.foo.ng/beam&key=8e49f2b1c7a54e90812b9d3c5f6a1e7b` for changed pages.
4. **Social preview**: paste the home and `/beam` links into the LinkedIn Post Inspector and the Facebook Sharing Debugger once so they cache the image.

## Where the visibility actually comes from: links

On-page work only makes you eligible. Ranking comes from other sites linking to you. In order of effort versus payoff:

| Where | What to do |
|---|---|
| GitHub | Add topics to the repo: `file-sharing`, `pastebin`, `webrtc`, `p2p`, `file-transfer`, `snapdrop-alternative`, `cloudflare-workers`. Put the live link in the repo "Website" field. Pin the repo on your profile. |
| AlternativeTo | List Clip as an alternative to WeTransfer, Pastebin, Rentry, PairDrop and Snapdrop. These pages rank well for "X alternative" searches. |
| Product Hunt | Launch Clip Beam on its own as "browser-to-browser large file transfer with resume". |
| Hacker News | "Show HN: Clip Beam, send big files browser to browser with resume". Lead with how resume and the multi-receiver session work, that is the interesting part. |
| Reddit | r/webdev, r/SideProject and r/DataHoarder (large file transfer). Read each sub's self-promotion rules first and post as a person sharing a project, not an ad. |
| Dev.to / Hashnode | Write "How I built resumable WebRTC file transfer on Cloudflare Durable Objects". Technical posts get links and show up for long-tail searches. Link to `/beam`. |
| Directories | Free indie tool directories such as Uneed, SaaSHub, BetaList and Indie Hackers. |

Keep every link pointing at `https://clip.foo.ng/` or `https://clip.foo.ng/beam` (no trailing variations) so link value lands on the canonical URLs.

## Searches worth targeting

You will not beat WeTransfer or Pastebin for their own names. Realistic targets are long-tail:

- "send large file browser to browser", "p2p file transfer online", "send file without uploading"
- "snapdrop alternative", "pairdrop alternative", "wetransfer alternative no account"
- "pastebin alternative with encryption", "rentry alternative", "temporary file sharing no signup"
- "real time collaborative notepad online no login"

The `/beam` page and its FAQ already use these phrases naturally. The next content to build, in order:

1. `/snapdrop-alternative` and `/wetransfer-alternative` comparison pages (honest tables, one H1 each, linked from the footer and `/about`).
2. `/send-large-files` guide page.
3. A short blog or changelog page for fresh content (Beam resume, multi-receiver). Pages like this earn the "recently updated" signal.

Each new page needs a React route, an entry in `generate-seo-pages.mjs`, a line in `sitemap.xml` and a link from existing pages. Ask and I will build them.

## Things to know

- **`clip.foo.ng` is a subdomain of `foo.ng`.** Google treats subdomains as somewhat separate sites, but a new subdomain on a shared parent starts with little trust and the parent's reputation is out of your hands. A dedicated short domain with a 301 redirect from the old address would help over the long term. Do this early, not after links have piled up on the old address.
- **Single-page app.** Only the pre-rendered routes carry full content before JavaScript. Google does render JavaScript, but slowly. This is why the extra pages above should be pre-rendered too.
- **Timeline.** New sites usually take 2 to 8 weeks to be indexed properly and months to rank for anything competitive. Nobody can promise a position; check Search Console's Performance report weekly.
- **Do not** buy backlinks, post the link in comment spam, or generate hundreds of thin pages. All of that gets sites demoted.
