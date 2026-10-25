import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { parsePlaylist, sequenceIv } from '../lib/hls.js';
import { fetchBytes, loadPlaylist, downloadMedia, createDownloadState } from '../lib/downloader.js';
import { createAuthProvider } from '../lib/auth.js';

// Synthetic transport packets test byte fidelity, not video codec playback.
const packet = (value) => { const bytes = new Uint8Array(188 * 2).fill(value); bytes[0] = bytes[188] = 0x47; return bytes; };
const first = packet(1);
const second = packet(2);
const init = Buffer.from([0, 0, 0, 8, ...Buffer.from('ftyp')]);
const fragment = Buffer.from([0, 0, 0, 8, ...Buffer.from('moof')]);
let server;
let base;
let encrypted;
let retries = 0;
let keyRequests = 0;
const requestCounts = new Map();
const keyBytes = new Uint8Array(16).fill(7);
const list = (body) => `#EXTM3U\n${body}\n#EXT-X-ENDLIST`;

before(async () => {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
  encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: sequenceIv(9n) }, key, first));
  server = http.createServer((request, response) => {
    const path = request.url.split('?')[0];
    requestCounts.set(path, (requestCounts.get(path) || 0) + 1);
    if (path.startsWith('/rotate/')) {
      const token = new URL(request.url, 'http://localhost').searchParams.get('token');
      if (path.endsWith('/one.ts')) response.end(first);
      else if (token === 'new') response.end(second);
      else response.writeHead(403).end();
      return;
    }
    if (path.startsWith('/protected/')) {
      const params = new URL(request.url, 'http://localhost').searchParams;
      if (params.get('token') !== 'fixture-only' || params.get('expires') !== '9999999999' ||
          params.get('token_path') !== '/protected/') { response.writeHead(403).end(); return; }
      if (path === '/protected/master.m3u8') response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\n720p/video.m3u8');
      else if (path === '/protected/720p/video.m3u8') response.end(list('#EXTINF:2,\nsegment.ts'));
      else response.end(first);
      return;
    }
    if (path === '/redirect') { response.writeHead(302, { Location: '/nested/index.m3u8' }).end(); return; }
    if (path === '/nested/index.m3u8') { response.end(list('#EXTINF:2,\none.ts\n#EXTINF:2,\ntwo.ts')); return; }
    if (path === '/nested/one.ts') { setTimeout(() => response.end(first), 30); return; }
    if (path === '/nested/two.ts') { response.end(second); return; }
    if (path === '/encrypted') { response.end(encrypted); return; }
    if (path === '/key') { keyRequests += 1; response.end(keyBytes); return; }
    if (path === '/short-key') { response.end(keyBytes.subarray(0, 8)); return; }
    if (path === '/init') { response.end(init); return; }
    if (path === '/fragment') { response.end(fragment); return; }
    if (path === '/retry') { retries += 1; if (retries < 3) response.writeHead(503).end(); else response.end(first); return; }
    if (path === '/slow') { setTimeout(() => response.end(first), 300); return; }
    if (path === '/login') { response.end('<html>Login</html>'); return; }
    if (path === '/range' || path === '/bad-range') {
      const bytes = Buffer.concat([first, second]);
      const range = /bytes=(\d+)-(\d+)/.exec(request.headers.range || '');
      if (path === '/range' && range) {
        const start = Number(range[1]); const end = Number(range[2]);
        response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` });
        response.end(bytes.subarray(start, end + 1));
      } else response.end(bytes);
      return;
    }
    response.writeHead(403).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

test('redirect base is respected; concurrent segments merge in playlist order', async () => {
  const parsed = await loadPlaylist(`${base}/redirect`);
  assert.equal(parsed.segments[0].url, `${base}/nested/one.ts`);
  const progress = [];
  const blob = await downloadMedia(parsed, { onProgress: (value) => progress.push(value) });
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([...first, ...second]));
  assert.equal(progress.at(-1).completed, 2);
  assert.equal(progress.at(-1).bytes, first.length + second.length);
});
test('AES-CBC decryption removes padding and shares key requests', async () => {
  const parsed = parsePlaylist(list(`#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x09
#EXTINF:2,
encrypted
#EXTINF:2,
encrypted`), `${base}/index.m3u8`);
  const blob = await downloadMedia(parsed);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([...first, ...first]));
  assert.equal(keyRequests, 1);
});
test('invalid AES key size remains a clear authorization or playlist error', async () => {
  const parsed = parsePlaylist(list('#EXT-X-KEY:METHOD=AES-128,URI="short-key"\n#EXTINF:2,\nencrypted'), `${base}/index.m3u8`);
  await assert.rejects(downloadMedia(parsed), /AES-128 密钥必须为 16 字节/);
});
test('range downloads validate HTTP 206 and merge exactly once', async () => {
  const parsed = parsePlaylist(list(`#EXTINF:2,
#EXT-X-BYTERANGE:376@0
range
#EXTINF:2,
#EXT-X-BYTERANGE:376
range`), `${base}/index.m3u8`);
  const blob = await downloadMedia(parsed);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([...first, ...second]));
  await assert.rejects(fetchBytes(`${base}/bad-range`, { range: { offset: 0, length: 376 } }), /字节范围/);
});
test('fMP4 init is prepended once to ordered fragments', async () => {
  const parsed = parsePlaylist(list('#EXT-X-MAP:URI="init"\n#EXTINF:2,\nfragment\n#EXTINF:2,\nfragment'), `${base}/index.m3u8`);
  const blob = await downloadMedia(parsed);
  assert.equal(blob.type, 'video/mp4');
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), Buffer.concat([init, fragment, fragment]));
});
test('transient HTTP errors are retried up to three times', async () => {
  assert.deepEqual((await fetchBytes(`${base}/retry`)).bytes, first);
  assert.equal(retries, 3);
});
test('HTTP authorization errors, wrong media and memory limits stop the job', async () => {
  await assert.rejects(fetchBytes(`${base}/forbidden`), /HTTP 403/);
  await assert.rejects(downloadMedia(parsePlaylist(list('#EXTINF:2,\nlogin'), `${base}/list`)), /不是标准/);
  await assert.rejects(downloadMedia(parsePlaylist(list('#EXTINF:2,\nnested/one.ts'), `${base}/list`), { maxBytes: 100 }), /内存下载限制/);
  await assert.rejects(fetchBytes(`${base}/nested/one.ts`, { limit: 100 }), /大小限制/);
});
test('cancelling an active request and a pre-cancelled job does not produce a file', async () => {
  const controller = new AbortController();
  const promise = downloadMedia(parsePlaylist(list('#EXTINF:2,\nslow'), `${base}/list`), { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(promise, { name: 'AbortError' });
  await assert.rejects(downloadMedia(parsePlaylist(list('#EXTINF:2,\nslow'), `${base}/list`), { signal: controller.signal }), { name: 'AbortError' });
});

test('signed master -> relative variant -> segment remains authorized end to end', async () => {
  const master = await loadPlaylist(`${base}/protected/master.m3u8?token=fixture-only&expires=9999999999&token_path=%2Fprotected%2F`);
  const child = await loadPlaylist(master.variants[0].url);
  const blob = await downloadMedia(child);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), first);
});
test('403 with expired signed URL gives actionable refresh instructions', async () => {
  await assert.rejects(fetchBytes(`${base}/forbidden?token=fixture-only&expires=1`), /签名链接已过期.*刷新原视频页面/);
});

test('disk mode writes ordered bytes with bounded buffers and without the Blob size limit', async () => {
  const parsed = await loadPlaylist(`${base}/redirect`);
  const writes = [];
  const state = createDownloadState(parsed, { async write(bytes) { writes.push(new Uint8Array(bytes)); } });
  assert.equal(await downloadMedia(parsed, { state, maxBytes: 1, concurrency: 8 }), null);
  assert.deepEqual(Buffer.concat(writes), Buffer.concat([first, second]));
  assert.equal(state.parts.length, 0);
  assert.equal(state.pending.size, 0);
  assert.equal(state.completed, 2);
  assert.deepEqual(state.firstSegmentProof, { index: 0, digest: createHash('sha256').update(first).digest('hex') });
  assert.deepEqual(state.lastSegmentProof, { index: 1, digest: createHash('sha256').update(second).digest('hex') });
});
test('fMP4 disk mode records the committed initialization bytes for continuity checks', async () => {
  const parsed = parsePlaylist(list('#EXT-X-MAP:URI="init"\n#EXTINF:2,\nfragment'), `${base}/index.m3u8`);
  const state = createDownloadState(parsed, { async write() {} });
  await downloadMedia(parsed, { state });
  assert.equal(state.initProof, createHash('sha256').update(init).digest('hex'));
});
test('paused jobs resume without requesting or writing the completed prefix again', async () => {
  const parsed = await loadPlaylist(`${base}/redirect`);
  const writes = [];
  const state = createDownloadState(parsed, { async write(bytes) { writes.push(new Uint8Array(bytes)); } });
  const before = requestCounts.get('/nested/one.ts') || 0;
  const controller = new AbortController();
  await assert.rejects(downloadMedia(parsed, { state, concurrency: 1, signal: controller.signal,
    onProgress: ({ completed }) => { if (completed === 1) controller.abort(); } }), { name: 'AbortError' });
  assert.equal(state.completed, 1);
  await downloadMedia(parsed, { state, concurrency: 1 });
  assert.equal(requestCounts.get('/nested/one.ts') - before, 1);
  assert.deepEqual(Buffer.concat(writes), Buffer.concat([first, second]));
});
test('a failed window retains successful later segments and resumes without duplicating the prefix', async () => {
  const signed = `${base}/rotate/list?token=old&expires=9999999998&token_path=%2Frotate%2F`;
  const parsed = parsePlaylist(list('#EXTINF:2,\none.ts\n#EXTINF:2,\ntwo.ts\n#EXTINF:2,\none.ts'), signed);
  const state = createDownloadState(parsed);
  const before = requestCounts.get('/rotate/one.ts') || 0;
  await assert.rejects(downloadMedia(parsed, { state }), /403/);
  assert.equal(state.completed, 1);
  assert.equal(state.pending.has(2), true);
  const auth = createAuthProvider({ fetchLatest: async () => signed.replace('token=old', 'token=new').replace('9999999998', '9999999999'), pollMs: 2 });
  const blob = await downloadMedia(parsed, { state, ...auth });
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([...first, ...second, ...first]));
  assert.equal(requestCounts.get('/rotate/one.ts') - before, 2, 'both identical-URL playlist entries are fetched once each');
});
test('403 renews scoped credentials and continues automatically in the same task', async () => {
  const signed = `${base}/rotate/list?token=old&expires=9999999998&token_path=%2Frotate%2F`;
  const parsed = parsePlaylist(list('#EXTINF:2,\none.ts\n#EXTINF:2,\ntwo.ts'), signed);
  let refreshes = 0;
  let candidate;
  const auth = createAuthProvider({ fetchLatest: async () => candidate,
    refreshSource: async () => { refreshes += 1; candidate = signed.replace('token=old', 'token=new').replace('9999999998', '9999999999'); }, pollMs: 2 });
  const blob = await downloadMedia(parsed, { ...auth, concurrency: 1 });
  assert.equal(refreshes, 1);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([...first, ...second]));
});
test('a failed disk write makes the session non-resumable instead of duplicating file bytes', async () => {
  const parsed = await loadPlaylist(`${base}/redirect`);
  const state = createDownloadState(parsed, { async write() { throw new Error('disk full'); } });
  await assert.rejects(downloadMedia(parsed, { state }), /文件写入失败/);
  assert.equal(state.failedWrite, true);
  await assert.rejects(downloadMedia(parsed, { state }), /无法续传/);
});
