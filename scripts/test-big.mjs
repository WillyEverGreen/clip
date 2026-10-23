/**
 * Large-file logic tests (no network): SigV4 signing checked against AWS's published example, and the rules
 * for sizes, names, parts and expiry. Run with: node scripts/test-big.mjs   (also part of `npm test`)
 */
import assert from 'node:assert/strict'
import { presignParts, presign, uriEncode, objectPath } from '../worker/src/lib/s3sign.ts'
import {
  MB, BIG_MIN_BYTES, BIG_MAX_BYTES, SINGLE_PUT_MAX, PART_SIZE, TTL_CHOICES, DEFAULT_TTL, UPLOAD_GRACE_MS,
  cleanFileName, parseStartRequest, planUpload, makeSlug, makeManageToken, hashToken, makeObjectKey, isExpired,
  publicView, attachmentDisposition, parseParts, completeMultipartXml, parseUploadId,
} from '../worker/src/lib/big.ts'

let passed = 0
let failed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  catch (err) { failed++; console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.stack || err}`) }
}

console.log('\nLarge files: signing')

await test('SigV4 presigned URL matches the example published in the AWS documentation', async () => {
  const url = await presignParts({
    host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', method: 'GET',
    keyId: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1', expires: 86400, now: new Date('2013-05-24T00:00:00Z'),
  })
  assert.ok(url.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'), url)
})

await test('uriEncode escapes the characters encodeURIComponent leaves alone', () => {
  assert.equal(uriEncode("a b!'()*~"), 'a%20b%21%27%28%29%2A~')
  assert.equal(uriEncode('big/x y', true), 'big/x%20y')
})

await test('a presigned URL targets the bucket path and carries the extra query values in sorted order', async () => {
  const cfg = { endpoint: 'https://s3.us-east-005.backblazeb2.com', region: 'us-east-005', bucket: 'my-bucket', keyId: 'k', secret: 's' }
  const url = await presign(cfg, 'PUT', 'big/abc/x y.zip', { uploadId: 'U1', partNumber: '2' }, 600, new Date('2026-01-01T00:00:00Z'))
  assert.ok(url.startsWith('https://s3.us-east-005.backblazeb2.com/my-bucket/big/abc/x%20y.zip?'), url)
  assert.ok(url.indexOf('partNumber=2') < url.indexOf('uploadId=U1'), 'query not sorted')
  assert.match(url, /X-Amz-Expires=600/)
  assert.equal(objectPath(cfg, 'a/b c'), '/my-bucket/a/b%20c')
})

console.log('\nLarge files: rules')

await test('only files above 25 MB and up to 500 MB are accepted, with a known expiry', () => {
  assert.equal(parseStartRequest({ name: 'a', size: BIG_MIN_BYTES }).error, 'too_small')
  assert.equal(parseStartRequest({ name: 'a', size: BIG_MAX_BYTES + 1 }).error, 'too_large')
  assert.equal(parseStartRequest({ name: 'a', size: -5 }).error, 'invalid_request')
  assert.equal(parseStartRequest({ name: 'a', size: 47185920.5 }).error, 'invalid_request') // not an integer
  assert.equal(parseStartRequest(null).error, 'invalid_request')
  assert.equal(parseStartRequest({ name: 'a', size: 100 * MB, ttl: 999 }).error, 'bad_ttl')
  const ok = parseStartRequest({ name: 'movie.mp4', size: 300 * MB, type: 'video/mp4' })
  assert.ok(ok.ok); assert.equal(ok.value.ttl, DEFAULT_TTL)
  for (const t of TTL_CHOICES) assert.ok(parseStartRequest({ name: 'a', size: 100 * MB, ttl: t }).ok)
})

await test('file names lose paths, control characters and leading dots, and stay short', () => {
  assert.equal(cleanFileName('C:\\Users\\me\\report.pdf'), 'report.pdf')
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd')
  assert.equal(cleanFileName('..hidden'), 'hidden')
  assert.equal(cleanFileName('a\u0000b\nc.txt'), 'abc.txt')
  assert.equal(cleanFileName(''), 'file')
  assert.equal(cleanFileName(42), 'file')
  assert.ok(cleanFileName('x'.repeat(500)).length <= 150)
})

await test('a file up to 100 MB is one PUT; bigger files go in 64 MB parts', () => {
  assert.deepEqual(planUpload(30 * MB), { mode: 'single', partSize: 30 * MB, partCount: 1 })
  assert.equal(planUpload(SINGLE_PUT_MAX).mode, 'single')
  const p = planUpload(SINGLE_PUT_MAX + 1)
  assert.equal(p.mode, 'multipart'); assert.equal(p.partSize, PART_SIZE); assert.equal(p.partCount, 2)
  assert.equal(planUpload(BIG_MAX_BYTES).partCount, Math.ceil((500 * MB) / PART_SIZE))
  assert.ok(PART_SIZE >= 5 * MB, 'parts must be at least 5 MB for S3')
})

await test('slugs and tokens are random, the right length, and use only safe characters', async () => {
  const slugs = new Set(Array.from({ length: 500 }, makeSlug))
  assert.equal(slugs.size, 500)
  for (const s of slugs) assert.match(s, /^[a-z2-9]{10}$/)
  assert.match(makeManageToken(), /^[A-Za-z0-9]{32}$/)
  assert.equal((await hashToken('abc')).length, 64)
  assert.notEqual(await hashToken('a'), await hashToken('b'))
})

await test('object keys stay under the slug folder and never carry a path from the name', () => {
  const k = makeObjectKey('abcde23456', 'Ünïcode / ../name with spaces!.zip')
  assert.match(k, /^big\/abcde23456\/[a-z2-9]{8}-[\w.\-]+$/)
  assert.ok(!k.includes('..') && k.split('/').length === 3, k)
  assert.notEqual(makeObjectKey('s', 'a.zip'), makeObjectKey('s', 'a.zip'))
})

await test('expiry: a finished file lives until its time; an unfinished upload is dropped after the grace period', () => {
  const now = 1_000_000_000_000
  assert.equal(isExpired({ status: 'ready', expiresAt: now + 1, createdAt: now - 5 }, now), false)
  assert.equal(isExpired({ status: 'ready', expiresAt: now, createdAt: now - 5 }, now), true)
  assert.equal(isExpired({ status: 'uploading', expiresAt: null, createdAt: now - UPLOAD_GRACE_MS + 1 }, now), false)
  assert.equal(isExpired({ status: 'uploading', expiresAt: null, createdAt: now - UPLOAD_GRACE_MS }, now), true)
})

await test('the public view never exposes the storage key, the upload id or the token hash', () => {
  const v = publicView({ slug: 's', key: 'big/s/secret', name: 'n', size: 1, type: 't', status: 'ready', ttl: 3600, createdAt: 1, expiresAt: 2, uploadId: 'U', versionId: 'V', tokenHash: 'H' })
  const text = JSON.stringify(v)
  for (const leak of ['big/s/secret', '"U"', '"V"', '"H"']) assert.ok(!text.includes(leak), leak)
})

await test('downloads are forced to save as a file, and odd names cannot break the header', () => {
  const d = attachmentDisposition('Rép";ort \u2603.pdf')
  assert.ok(d.startsWith('attachment; filename="'), d)
  assert.ok(!/[\r\n]/.test(d))
  assert.match(d, /filename\*=UTF-8''R%C3%A9p%22%3Bort%20%E2%98%83\.pdf$/)
  assert.equal(attachmentDisposition('\u2603').startsWith('attachment; filename="file"'), true)
})

await test('part lists must be complete, in order, and carry an ETag; the XML is escaped', () => {
  assert.equal(parseParts([{ n: 1, etag: '"a"' }], 2), null)
  assert.equal(parseParts([{ n: 2, etag: '"a"' }, { n: 1, etag: '"b"' }], 2), null)
  assert.equal(parseParts([{ n: 1, etag: '' }], 1), null)
  assert.equal(parseParts('nope', 1), null)
  const parts = parseParts([{ n: 1, etag: '"a&b"' }, { n: 2, etag: '"c"' }], 2)
  assert.ok(parts)
  assert.equal(completeMultipartXml(parts), '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;a&amp;b&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;c&quot;</ETag></Part></CompleteMultipartUpload>')
})

await test('the upload id is read out of the multipart-start response', () => {
  assert.equal(parseUploadId('<InitiateMultipartUploadResult><UploadId>4_zabc</UploadId></InitiateMultipartUploadResult>'), '4_zabc')
  assert.equal(parseUploadId('<Error/>'), null)
})

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed) process.exit(1)
