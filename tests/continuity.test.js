import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { loadPlaylist, downloadMedia, createDownloadState } from '../lib/downloader.js';
import { parsePlaylist } from '../lib/hls.js';
import { findReplacementPlaylist } from '../lib/continuity.js';

const packet = (value) => { const bytes = new Uint8Array(376).fill(value); bytes[0] = bytes[188] = 0x47; return bytes; };
const first = packet(1);
const second = packet(2);
const init = Buffer.from([0, 0, 0, 8, ...Buffer.from('ftyp')]);
const fragment = Buffer.from([0, 0, 0, 8, ...Buffer.from('moof')]);
let oldServer;
let newServer;
let oldBase;
let newBase;
let mode = 'same';
const signed = (base, date, name, token) => `${base}/${date}/asset/${name}?token=${token}&expires=9999999999&token_path=%2Fasset%2F`;
const playlist = (reversed = false, differentQuery = false) => `#EXTM3U\n#EXTINF:2,\n${reversed ? 'second.ts' : 'first.ts'}\n#EXTINF:2,\n${reversed ? 'first.ts' : `second.ts${differentQuery ? '?clip=other' : ''}`}\n#EXT-X-ENDLIST`;

function serve(isNew) {
  return http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    if (path.endsWith('/master.m3u8')) {
      response.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n720p/video.m3u8${mode === 'quality' && isNew ? '' : '\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n1080p/video.m3u8'}`);
    } else if (path.endsWith('/video.m3u8')) response.end(isNew && mode === 'fmp4'
      ? '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\none.m4s\n#EXT-X-ENDLIST'
      : playlist(isNew && mode === 'reordered', isNew && mode === 'query'));
    else if (path.endsWith('/init.mp4')) response.end(init);
    else if (path.endsWith('/one.m4s')) response.end(fragment);
    else if (path.endsWith('/first.ts')) response.end(isNew && mode === 'changed' ? packet(9) : first);
    else if (path.endsWith('/second.ts')) response.end(second);
    else response.writeHead(404).end();
  });
}

before(async () => {
  oldServer = serve(false);
  newServer = serve(true);
  oldServer.listen(0, '127.0.0.1');
  newServer.listen(0, '127.0.0.1');
  await Promise.all([once(oldServer, 'listening'), once(newServer, 'listening')]);
  oldBase = `http://127.0.0.1:${oldServer.address().port}`;
  newBase = `http://127.0.0.1:${newServer.address().port}`;
});
after(() => { oldServer.closeAllConnections(); oldServer.close(); newServer.closeAllConnections(); newServer.close(); });

async function pausedJob() {
  const original = await loadPlaylist(signed(oldBase, '20261007', '1080p/video.m3u8', 'old'));
  const writes = [];
  const state = createDownloadState(original, { async write(bytes) { writes.push(new Uint8Array(bytes)); } });
  const controller = new AbortController();
  await assert.rejects(downloadMedia(original, { state, concurrency: 1, signal: controller.signal,
    onProgress: ({ completed }) => { if (completed === 1) controller.abort(); } }), { name: 'AbortError' });
  assert.equal(state.completed, 1);
  return { original, state, writes };
}

test('a changed CDN and date directory can resume only with matching quality and committed bytes', async () => {
  mode = 'same';
  const { original, state, writes } = await pausedJob();
  const next = await findReplacementPlaylist(original, state, [signed(newBase, '20261014', 'master.m3u8', 'new')]);
  assert.equal(next.url, signed(newBase, '20261014', '1080p/video.m3u8', 'new'));
  assert.equal(new URL(next.segments[1].url).origin, newBase);
  assert.equal(state.completed, 1);
  state.pending.clear();
  state.playlist = next;
  await downloadMedia(next, { state, concurrency: 1 });
  assert.equal(state.completed, 2);
  assert.deepEqual(Buffer.concat(writes), Buffer.concat([first, second]));
});

test('a master without the original quality cannot silently switch to 720p', async () => {
  mode = 'quality';
  const { original, state } = await pausedJob();
  await assert.rejects(findReplacementPlaylist(original, state,
    [signed(newBase, '20261014', 'master.m3u8', 'new')]), /原清晰度/);
});

test('reordered segments and a different asset scope are rejected', async () => {
  mode = 'reordered';
  const { original, state } = await pausedJob();
  await assert.rejects(findReplacementPlaylist(original, state,
    [signed(newBase, '20261014', 'master.m3u8', 'new')]), /分片|相同视频/);
  mode = 'same';
  await assert.rejects(findReplacementPlaylist(original, state,
    [signed(newBase, '20261014', 'master.m3u8', 'new').replaceAll('asset', 'other')]), /相同视频|资产目录/);
});

test('matching playlist names cannot hide changed media bytes', async () => {
  mode = 'changed';
  const { original, state } = await pausedJob();
  await assert.rejects(findReplacementPlaylist(original, state,
    [signed(newBase, '20261014', 'master.m3u8', 'new')]), /内容不一致/);
});

test('changed non-signature segment queries cannot silently select other bytes', async () => {
  mode = 'query';
  const { original, state } = await pausedJob();
  await assert.rejects(findReplacementPlaylist(original, state,
    [signed(newBase, '20261014', 'master.m3u8', 'new')]), /分片|相同视频/);
});

test('a changed first segment is rejected even if the last committed segment matches', async () => {
  mode = 'same';
  const original = await loadPlaylist(signed(oldBase, '20261007', '1080p/video.m3u8', 'old'));
  const state = createDownloadState(original, { async write() {} });
  await downloadMedia(original, { state, concurrency: 1 });
  mode = 'changed';
  await assert.rejects(findReplacementPlaylist(original, state,
    [signed(newBase, '20261014', 'master.m3u8', 'new')]), /内容不一致/);
});

test('an empty task has no committed bytes to prove continuity', async () => {
  mode = 'same';
  const original = await loadPlaylist(signed(oldBase, '20261007', '1080p/video.m3u8', 'old'));
  const state = createDownloadState(original, { async write() {} });
  await assert.rejects(findReplacementPlaylist(original, state,
    [signed(newBase, '20261014', 'master.m3u8', 'new')]), /尚无已下载媒体分片/);
  assert.equal(state.playlist, original);
});

test('an fMP4 init map alone is not proof that media segments match', async () => {
  mode = 'fmp4';
  const url = signed(oldBase, '20261007', '1080p/video.m3u8', 'old');
  const original = { ...parsePlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\none.m4s\n#EXT-X-ENDLIST', url), url };
  const state = createDownloadState(original, { async write() {} });
  state.initDone = true;
  state.initProof = createHash('sha256').update(init).digest('hex');
  await assert.rejects(findReplacementPlaylist(original, state,
    [signed(newBase, '20261014', 'master.m3u8', 'new')]), /尚无已下载媒体分片/);
});
