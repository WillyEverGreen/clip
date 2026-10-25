/**
 * BigUploadStore — Cloudflare Durable Object
 *
 * One instance per file-bucket upload, holding its record (files, sizes, token hash, expiry). Workers KV is eventually
 * consistent, so a record written when an upload finishes could still read as "uploading" from another location for up
 * to a minute; a Durable Object always returns the latest write. KV keeps only a small index for listing.
 */
import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../lib/types'

export class BigUploadStore extends DurableObject<Env> {
  async getRec(): Promise<unknown> {
    return (await this.ctx.storage.get('rec')) ?? null
  }

  async putRec(rec: unknown): Promise<void> {
    await this.ctx.storage.put('rec', rec)
  }

  async deleteRec(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }
}
