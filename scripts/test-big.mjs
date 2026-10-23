/**
 * File-bucket logic tests (no network): SigV4 signing checked against AWS's published example, MD5 for multi-delete,
 * and the rules for sizes, names, parts, expiry and the storage XML. Run with: node scripts/test-big.mjs (part of `npm test`)
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { presignParts, presign, uriEncode, objectPath } from '../worker/src/lib/s3sign.ts'
import { md5Base64 } from '../worker/src/lib/md5.ts'
import {
  MB, BIG_MAX_BYTES, BIG_MAX_FILES, SINGLE_PUT_MAX, PART_SIZE, FILE_TTL_SECONDS, UPLOAD_GRACE_MS,
  cleanFileName, parseStartRequest, planUpload, makeSlug, makeManageToken, hashToken, makeObjectKey, folderOf, normalizeRecord,
  isExpired, publicView, attachmentDisposition, parseParts, parseCompleteRequest, completeMultipartXml, parseUploadId,
  parseVersions, deleteObjectsXml,
} from '../worker/src/lib/big.ts'
import { pruneExpiredBundles, bundleTotals, bundleFromRecord } from '../worker/src/lib/bundles.ts'

let passed = 0
let failed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  catch (err) { failed++; console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.stack || err}`) }
}

console.log('\nFile bucket: signing')

await test('SigV4 presigned URL matches the example published in the AWS documentation', async () => {
  const url = await presignParts({
    host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', method: 'GET',
    keyId: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1', expires: 86400, now: new Date('2013-05-24T00:00:00Z'),
  })
  assert.ok(url.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'), url)
})

await test('uriEncode escapes the characters encodeURIComponent leaves alone; the bucket itself is a bare path', () => {
  assert.equal(uriEncode("a b!'()*~"), 'a%20b%21%27%28%29%2A~')
  assert.equal(uriEncode('big/x y', true), 'big/x%20y')
  assert.equal(objectPath({ bucket: 'b' }, ''), '/b')
  assert.equal(objectPath({ bucket: 'b' }, 'a/b c'), '/b/a/b%20c')
})

await test('a presigned URL targets the bucket path and carries the extra query values in sorted order', async () => {
  const cfg = { endpoint: 'https://s3.us-east-005.backblazeb2.com', region: 'us-east-005', bucket: 'my-bucket', keyId: 'k', secret: 's' }
  const url = await presign(cfg, 'PUT', 'big/abc/x y.zip', { uploadId: 'U1', partNumber: '2' }, 600, new Date('2026-01-01T00:00:00Z'))
  assert.ok(url.startsWith('https://s3.us-east-005.backblazeb2.com/my-bucket/big/abc/x%20y.zip?'), url)
  assert.ok(url.indexOf('partNumber=2') < url.indexOf('uploadId=U1'), 'query not sorted')
  assert.match(url, /X-Amz-Expires=600/)
})

await test('MD5 (needed for the multi-delete request) matches Node for ASCII, Unicode and long input', () => {
  for (const s of ['', 'abc', 'x'.repeat(5000), deleteObjectsXml([{ key: 'big/a/1-é.bin', versionId: 'v&1' }])]) {
    assert.equal(md5Base64(s), createHash('md5').update(s).digest('base64'))
  }
})

console.log('\nFile bucket: rules')

await test('an upload is a list of files: empty, too many, too big in total or malformed is refused', () => {
  assert.equal(parseStartRequest({ files: [] }).error, 'empty')
  assert.equal(parseStartRequest({ files: Array.from({ length: BIG_MAX_FILES + 1 }, () => ({ name: 'a', size: 1 })) }).error, 'too_many')
  assert.equal(parseStartRequest({ files: [{ name: 'a', size: 300 * MB }, { name: 'b', size: 201 * MB }] }).error, 'too_large')
  assert.equal(parseStartRequest({ files: [{ name: 'a', size: 0 }] }).error, 'invalid_request')
  assert.equal(parseStartRequest({ files: [{ name: 'a', size: 1.5 }] }).error, 'invalid_request')
  assert.equal(parseStartRequest({ files: ['x'] }).error, 'invalid_request')
  assert.equal(parseStartRequest(null).error, 'invalid_request')
  const ok = parseStartRequest({ files: [{ name: 'a.mp4', size: 400 * MB, type: 'video/mp4' }, { name: '../b.txt', size: 1, type: '<script>' }] })
  assert.ok(ok.ok)
  assert.equal(ok.files[1].name, 'b.txt')
  assert.equal(ok.files[1].type, '', 'odd content types are dropped')
  assert.ok(parseStartRequest({ name: 'old.bin', size: 30 * MB, type: '' }).ok, 'older single-file requests still work')
  assert.ok(parseStartRequest({ files: [{ name: 'x', size: BIG_MAX_BYTES }] }).ok)
})

await test('file names lose paths, control characters and leading dots, and stay short', () => {
  assert.equal(cleanFileName('C:\\Users\\me\\report.pdf'), 'report.pdf')
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd')
  assert.equal(cleanFileName('..hidden'), 'hidden')
  assert.equal(cleanFileName('a\u0000b\nc.txt'), 'abc.txt')
  assert.equal(cleanFileName(''), 'file')
  assert.ok(cleanFileName('x'.repeat(500)).length <= 150)
})

await test('a file up to 100 MB is one PUT; bigger files go in 64 MB parts', () => {
  assert.deepEqual(planUpload(30 * MB), { mode: 'single', partSize: 30 * MB, partCount: 1 })
  assert.equal(planUpload(SINGLE_PUT_MAX).mode, 'single')
  const p = planUpload(SINGLE_PUT_MAX + 1)
  assert.equal(p.mode, 'multipart'); assert.equal(p.partSize, PART_SIZE); assert.equal(p.partCount, 2)
  assert.ok(PART_SIZE >= 5 * MB, 'parts must be at least 5 MB for S3')
})

await test('ids and tokens are random and safe; every file of an upload sits in its own folder', async () => {
  const ids = new Set(Array.from({ length: 500 }, makeSlug))
  assert.equal(ids.size, 500)
  for (const s of ids) assert.match(s, /^[a-z2-9]{10}$/)
  assert.match(makeManageToken(), /^[A-Za-z0-9]{32}$/)
  assert.equal((await hashToken('abc')).length, 64)
  const k = makeObjectKey('abcde23456', 3, 'Ünïcode / ../name with spaces!.zip')
  assert.ok(k.startsWith(folderOf('abcde23456')), k)
  assert.match(k, /^big\/abcde23456\/3-[\w.\-]+$/)
  assert.ok(!k.includes('..') && k.split('/').length === 3, k)
  assert.notEqual(makeObjectKey('a', 1, 'x'), makeObjectKey('a', 2, 'x'))
})

await test('records from before multi-file uploads are read as a one-file upload', () => {
  const rec = normalizeRecord({ slug: 'abcde23456', key: 'big/abcde23456/zz-a.bin', name: 'a.bin', size: 120 * MB, type: 't', status: 'ready', ttl: 3600, createdAt: 1, expiresAt: 2, uploadId: null, versionId: 'v', tokenHash: 'h' })
  assert.equal(rec.files.length, 1)
  assert.equal(rec.files[0].key, 'big/abcde23456/zz-a.bin')
  assert.equal(rec.files[0].partCount, 2)
  assert.equal(normalizeRecord(null), null)
  assert.equal(normalizeRecord({ slug: 'x' }), null)
})

await test('expiry: files live 2 hours after upload; an unfinished upload is dropped after the grace period', () => {
  assert.equal(FILE_TTL_SECONDS, 7200)
  const now = 1_000_000_000_000
  assert.equal(isExpired({ status: 'ready', expiresAt: now + 1, createdAt: now - 5 }, now), false)
  assert.equal(isExpired({ status: 'ready', expiresAt: now, createdAt: now - 5 }, now), true)
  assert.equal(isExpired({ status: 'uploading', expiresAt: null, createdAt: now - UPLOAD_GRACE_MS + 1 }, now), false)
  assert.equal(isExpired({ status: 'uploading', expiresAt: null, createdAt: now - UPLOAD_GRACE_MS }, now), true)
})

await test('the public view lists names and sizes but never storage keys, upload ids or the token hash', () => {
  const rec = { slug: 's', status: 'ready', size: 3, createdAt: 1, expiresAt: 2, tokenHash: 'SECRETHASH', files: [
    { n: 1, name: 'a', size: 1, type: 't', key: 'big/s/1-a', uploadId: 'UPID', partCount: 1 },
    { n: 2, name: 'b', size: 2, type: '', key: 'big/s/2-b', uploadId: null, partCount: 1 },
  ] }
  const v = publicView(rec)
  assert.deepEqual(v.files.map((f) => f.name), ['a', 'b'])
  assert.equal(v.name, '2 files')
  const text = JSON.stringify(v)
  for (const leak of ['big/s/', 'UPID', 'SECRETHASH']) assert.ok(!text.includes(leak), leak)
})

await test('downloads are forced to save as a file, and odd names cannot break the header', () => {
  const d = attachmentDisposition('Rép";ort \u2603.pdf')
  assert.ok(d.startsWith('attachment; filename="'), d)
  assert.ok(!/[\r\n]/.test(d))
  assert.match(d, /filename\*=UTF-8''R%C3%A9p%22%3Bort%20%E2%98%83\.pdf$/)
})

await test('finishing: every file still in parts needs its complete, ordered ETag list', () => {
  const rec = { files: [
    { n: 1, uploadId: null, partCount: 1 },
    { n: 2, uploadId: 'U2', partCount: 2 },
  ] }
  assert.equal(parseCompleteRequest({ files: [] }, rec), null)
  assert.equal(parseCompleteRequest({ files: [{ n: 2, parts: [{ n: 1, etag: '"a"' }] }] }, rec), null)
  const ok = parseCompleteRequest({ files: [{ n: 2, parts: [{ n: 1, etag: '"a"' }, { n: 2, etag: '"b"' }] }] }, rec)
  assert.equal(ok.get(2).length, 2)
  assert.equal(parseCompleteRequest(undefined, { files: [{ n: 1, uploadId: null, partCount: 1 }] }).size, 0, 'nothing in parts needs no body')
  assert.equal(parseParts([{ n: 2, etag: 'x' }, { n: 1, etag: 'y' }], 2), null)
  assert.equal(completeMultipartXml([{ n: 1, etag: '"a&b"' }]), '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;a&amp;b&quot;</ETag></Part></CompleteMultipartUpload>')
  assert.equal(parseUploadId('<InitiateMultipartUploadResult><UploadId>4_zabc</UploadId></InitiateMultipartUploadResult>'), '4_zabc')
})

await test('version listings are read in full (versions and delete markers, paging) and the delete XML escapes keys', () => {
  const xml = `<ListVersionsResult><IsTruncated>true</IsTruncated><NextKeyMarker>big/a/2-b</NextKeyMarker><NextVersionIdMarker>v9</NextVersionIdMarker>
    <Version><Key>big/a/1-x&amp;y</Key><VersionId>v1</VersionId><IsLatest>true</IsLatest><Size>42</Size></Version>
    <DeleteMarker><Key>big/a/2-b</Key><VersionId>v2</VersionId><IsLatest>true</IsLatest></DeleteMarker></ListVersionsResult>`
  const r = parseVersions(xml)
  assert.equal(r.versions.length, 2)
  assert.deepEqual(r.versions[0], { key: 'big/a/1-x&y', versionId: 'v1', size: 42, isLatest: true, deleteMarker: false })
  assert.equal(r.versions[1].deleteMarker, true)
  assert.equal(r.truncated, true); assert.equal(r.nextKey, 'big/a/2-b'); assert.equal(r.nextVersion, 'v9')
  assert.equal(deleteObjectsXml([{ key: 'a<b', versionId: '1' }]), '<Delete><Quiet>true</Quiet><Object><Key>a&lt;b</Key><VersionId>1</VersionId></Object></Delete>')
})

await test('clips drop uploads whose time is up, and count files and bytes across uploads', () => {
  const entry = { bundles: [
    { id: 'a', expiresAt: 10, files: [{ n: 1, name: 'x', size: 5, type: '' }] },
    { id: 'b', expiresAt: 30, files: [{ n: 1, name: 'y', size: 7, type: '' }, { n: 2, name: 'z', size: 1, type: '' }] },
  ] }
  assert.deepEqual(bundleTotals(entry.bundles), { files: 3, bytes: 13 })
  assert.deepEqual(pruneExpiredBundles(entry, 20), ['a'])
  assert.deepEqual(entry.bundles.map((b) => b.id), ['b'])
  assert.deepEqual(pruneExpiredBundles(entry, 40), ['b'])
  assert.equal(entry.bundles, undefined)
  const b = bundleFromRecord({ slug: 'q', files: [{ n: 1, name: 'f', size: 2, type: 't', key: 'secret', uploadId: null, partCount: 1 }] }, 99)
  assert.deepEqual(b, { id: 'q', expiresAt: 99, files: [{ n: 1, name: 'f', size: 2, type: 't' }] })
})

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed) process.exit(1)
