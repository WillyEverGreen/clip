// Serves the product film with byte-range support, so the player can scrub the timeline.
// Cloudflare Pages serves plain static files without ranges, and a video that cannot be ranged cannot be seeked.
// The file itself lives at /film-src.mp4 (a normal static asset); this function is what /film.mp4 resolves to.
interface Env { ASSETS: { fetch(input: Request | URL | string): Promise<Response> } }

export const onRequest = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 })

  const asset = await env.ASSETS.fetch(new URL('/film-src.mp4', request.url))
  if (!asset.ok) return new Response('Not found', { status: 404 })
  const buf = await asset.arrayBuffer()
  const size = buf.byteLength

  const headers = new Headers({
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
  })

  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '')
  if (m && (m[1] !== '' || m[2] !== '')) {
    // "bytes=a-b", "bytes=a-" and the suffix form "bytes=-n"
    const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1])
    const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    headers.set('Content-Length', String(end - start + 1))
    return new Response(request.method === 'HEAD' ? null : buf.slice(start, end + 1), { status: 206, headers })
  }

  headers.set('Content-Length', String(size))
  return new Response(request.method === 'HEAD' ? null : buf, { status: 200, headers })
}
