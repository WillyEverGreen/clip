/**
 * AnalyticsStore — Cloudflare Durable Object (SQLite)
 *
 * Privacy-preserving, edge-native user analytics store for Clip.
 * Persists raw views for rolling 30-day windows and daily rollups for historical retention.
 */
import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../lib/types'

export interface AnalyticsEvent {
  date?: string
  timestamp?: number
  path: string
  referrer?: string
  country?: string
  device?: string
  visitor_hash?: string
  visitorHash?: string
}

export interface AnalyticsSummary {
  range: 'today' | '7d' | '30d' | string
  totalViews: number
  uniqueVisitors: number
  topPaths: Array<{ path: string; count: number }>
  topReferrers: Array<{ referrer: string; count: number }>
  topCountries: Array<{ country: string; count: number }>
  devices: Array<{ device: string; count: number }>
  deviceBreakdown?: Record<string, number>
}

export interface SqlStorageCursor<T = Record<string, unknown>> extends Iterable<T> {
  toArray(): T[]
  rowsWritten?: number
  rowsRead?: number
}

export interface SqlRunner {
  exec<T = Record<string, unknown>>(query: string, ...params: unknown[]): SqlStorageCursor<T>
}

export class AnalyticsStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.initSchema()
  }

  private get sql(): SqlRunner {
    return (this.ctx.storage as unknown as { sql: SqlRunner }).sql
  }

  private initSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      path TEXT NOT NULL,
      referrer TEXT NOT NULL,
      country TEXT NOT NULL,
      device TEXT NOT NULL,
      visitor_hash TEXT NOT NULL
    )`)
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_views_date ON views(date)`)
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_views_hash ON views(visitor_hash)`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS daily_rollups (
      date TEXT PRIMARY KEY,
      total_views INTEGER NOT NULL,
      unique_visitors INTEGER NOT NULL,
      data_json TEXT NOT NULL
    )`)
  }

  async recordEvent(event: AnalyticsEvent): Promise<void> {
    const ts = typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? event.timestamp : Date.now()
    const d = event.date && /^\d{4}-\d{2}-\d{2}$/.test(event.date) ? event.date : new Date(ts).toISOString().slice(0, 10)
    const p = event.path || '/'
    const ref = event.referrer ?? 'direct'
    const country = event.country ?? 'XX'
    const device = event.device ?? 'desktop'
    const vh = event.visitor_hash ?? event.visitorHash ?? ''

    this.sql.exec(
      `INSERT INTO views (date, timestamp, path, referrer, country, device, visitor_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      d, ts, p, ref, country, device, vh
    )
  }

  async getStats(range: 'today' | '7d' | '30d' = 'today', now: Date = new Date()): Promise<AnalyticsSummary> {
    let startDate: string
    if (range === 'today') {
      startDate = now.toISOString().slice(0, 10)
    } else if (range === '7d') {
      startDate = new Date(now.getTime() - 7 * 86400 * 1000).toISOString().slice(0, 10)
    } else if (range === '30d') {
      startDate = new Date(now.getTime() - 30 * 86400 * 1000).toISOString().slice(0, 10)
    } else {
      startDate = now.toISOString().slice(0, 10)
    }

    // 1. Total views & unique visitors
    const totalsCursor = this.sql.exec<{ total_views: number; unique_visitors: number }>(
      `SELECT COUNT(*) as total_views, COUNT(DISTINCT visitor_hash) as unique_visitors
       FROM views
       WHERE date >= ?`,
      startDate
    )
    const totals = totalsCursor.toArray()[0]
    const totalViews = Number(totals?.total_views ?? 0)
    const uniqueVisitors = Number(totals?.unique_visitors ?? 0)

    // 2. Top paths
    const topPaths = this.sql.exec<{ path: string; count: number }>(
      `SELECT path, COUNT(*) as count
       FROM views
       WHERE date >= ?
       GROUP BY path
       ORDER BY count DESC
       LIMIT 10`,
      startDate
    ).toArray().map(r => ({ path: String(r.path), count: Number(r.count) }))

    // 3. Top referrers
    const topReferrers = this.sql.exec<{ referrer: string; count: number }>(
      `SELECT referrer, COUNT(*) as count
       FROM views
       WHERE date >= ?
       GROUP BY referrer
       ORDER BY count DESC
       LIMIT 10`,
      startDate
    ).toArray().map(r => ({ referrer: String(r.referrer), count: Number(r.count) }))

    // 4. Top countries
    const topCountries = this.sql.exec<{ country: string; count: number }>(
      `SELECT country, COUNT(*) as count
       FROM views
       WHERE date >= ?
       GROUP BY country
       ORDER BY count DESC
       LIMIT 10`,
      startDate
    ).toArray().map(r => ({ country: String(r.country), count: Number(r.count) }))

    // 5. Devices
    const devices = this.sql.exec<{ device: string; count: number }>(
      `SELECT device, COUNT(*) as count
       FROM views
       WHERE date >= ?
       GROUP BY device
       ORDER BY count DESC`,
      startDate
    ).toArray().map(r => ({ device: String(r.device), count: Number(r.count) }))

    const deviceBreakdown: Record<string, number> = {}
    for (const d of devices) {
      deviceBreakdown[d.device] = d.count
    }

    return {
      range,
      totalViews,
      uniqueVisitors,
      topPaths,
      topReferrers,
      topCountries,
      devices,
      deviceBreakdown,
    }
  }

  async rollup(date: string): Promise<void> {
    const totals = this.sql.exec<{ total_views: number; unique_visitors: number }>(
      `SELECT COUNT(*) as total_views, COUNT(DISTINCT visitor_hash) as unique_visitors
       FROM views
       WHERE date = ?`,
      date
    ).toArray()[0]

    const totalViews = Number(totals?.total_views ?? 0)
    const uniqueVisitors = Number(totals?.unique_visitors ?? 0)

    const paths = this.sql.exec<{ path: string; count: number }>(
      `SELECT path, COUNT(*) as count
       FROM views
       WHERE date = ?
       GROUP BY path
       ORDER BY count DESC
       LIMIT 10`,
      date
    ).toArray().map(r => ({ path: String(r.path), count: Number(r.count) }))

    const referrers = this.sql.exec<{ referrer: string; count: number }>(
      `SELECT referrer, COUNT(*) as count
       FROM views
       WHERE date = ?
       GROUP BY referrer
       ORDER BY count DESC
       LIMIT 10`,
      date
    ).toArray().map(r => ({ referrer: String(r.referrer), count: Number(r.count) }))

    const countries = this.sql.exec<{ country: string; count: number }>(
      `SELECT country, COUNT(*) as count
       FROM views
       WHERE date = ?
       GROUP BY country
       ORDER BY count DESC
       LIMIT 10`,
      date
    ).toArray().map(r => ({ country: String(r.country), count: Number(r.count) }))

    const devices = this.sql.exec<{ device: string; count: number }>(
      `SELECT device, COUNT(*) as count
       FROM views
       WHERE date = ?
       GROUP BY device
       ORDER BY count DESC`,
      date
    ).toArray().map(r => ({ device: String(r.device), count: Number(r.count) }))

    const dataJson = JSON.stringify({ paths, referrers, countries, devices })

    this.sql.exec(
      `INSERT OR REPLACE INTO daily_rollups (date, total_views, unique_visitors, data_json)
       VALUES (?, ?, ?, ?)`,
      date, totalViews, uniqueVisitors, dataJson
    )
  }

  async prune(olderThanDays = 30, now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - olderThanDays * 86400 * 1000).toISOString().slice(0, 10)
    const res = this.sql.exec(`DELETE FROM views WHERE date < ?`, cutoff)
    return res.rowsWritten ?? 0
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const pathname = url.pathname

    if (req.method === 'POST' && (pathname === '/event' || pathname === '/api/analytics/event')) {
      try {
        const body = (await req.json()) as AnalyticsEvent
        await this.recordEvent(body)
        return new Response(null, { status: 204 })
      } catch {
        return new Response(JSON.stringify({ error: 'invalid_json' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    if (req.method === 'GET' && (pathname === '/stats' || pathname === '/api/admin/analytics')) {
      const rawRange = url.searchParams.get('range') || 'today'
      const range = (rawRange === '7d' || rawRange === '30d' ? rawRange : 'today') as 'today' | '7d' | '30d'
      const stats = await this.getStats(range)
      return new Response(JSON.stringify(stats), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (req.method === 'POST' && pathname === '/rollup') {
      try {
        const body = (await req.json()) as { date?: string }
        if (body?.date) {
          await this.rollup(body.date)
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ error: 'missing_date' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      } catch {
        return new Response(JSON.stringify({ error: 'invalid_json' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    return new Response('Not found', { status: 404 })
  }
}
