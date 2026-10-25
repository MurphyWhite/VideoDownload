// Optional UI verification: uses a local fixture server and mocked Chrome APIs.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs BROWSER_PATH=/path/to/chrome node tests/ui-smoke.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const packet = (value) => { const bytes = new Uint8Array(376).fill(value); bytes[0] = bytes[188] = 0x47; return bytes; };
let segmentRequests = 0;
let slowRequests = 0;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const media = (lines) => `#EXTM3U\n${lines}\n#EXT-X-ENDLIST`;
  if (url.pathname === '/master.m3u8') {
    response.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nmedia.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,AUDIO="audio"\nunsupported.m3u8'); return;
  }
  if (url.pathname === '/media.m3u8' || url.pathname === '/slow.m3u8') {
    const segment = url.pathname === '/slow.m3u8' ? 'slow.ts' : 'one.ts';
    response.end(media(`#EXTINF:2,\n${segment}\n#EXTINF:2,\ntwo.ts`)); return;
  }
  if (url.pathname === '/signed.m3u8') {
    response.end(media('#EXTINF:2,\nrestricted.ts')); return;
  }
  if (url.pathname === '/restricted.ts') { response.writeHead(403).end(); return; }
  if (/\/(?:one|two|slow)\.ts$/.test(url.pathname)) {
    segmentRequests += 1;
    if (url.pathname === '/slow.ts') { slowRequests += 1; setTimeout(() => response.end(packet(1)), 300); }
    else response.end(packet(url.pathname === '/one.ts' ? 1 : 2));
    return;
  }
  if (url.pathname === '/invalid.m3u8') { response.writeHead(403).end(); return; }
  const target = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (!target.startsWith(root)) { response.writeHead(403).end(); return; }
  try {
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
    response.setHeader('Content-Type', types[path.extname(target)] || 'application/octet-stream');
    response.setHeader('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'none'");
    response.end(await readFile(target));
  } catch { response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 }, deviceScaleFactor: 1 });
  await context.addInitScript(({ origin }) => {
    const listeners = [];
    window.testSaveMode = 'complete';
    window.testDownloadCount = 0;
    window.testDiskWrites = [];
    window.showSaveFilePicker = new URLSearchParams(location.search).has('disk') ? async (options) => ({
      name: options.suggestedName,
      async createWritable() { return {
        async write(bytes) { window.testDiskWrites.push([...bytes]); },
        async close() { window.savedBytes = window.testDiskWrites.flat(); window.testDiskClosed = true; },
        async abort() { window.testDiskAborted = true; }
      }; }
    }) : undefined;
    window.chrome = {
      runtime: { async sendMessage(message) {
        if (message.type === 'OPEN_DOWNLOAD') { window.openedManager = message.url; return { ok: true }; }
        if (message.type === 'GET_AUTH') return { ok: true, url: message.url };
        if (message.type === 'RELOAD_SOURCE') { window.reloadedTab = message.tabId; return { ok: true }; }
        if (message.type === 'FOCUS_SOURCE') { window.focusedTab = message.tabId; return { ok: true }; }
        return { ok: true, items: [{ url: `${origin}/master.m3u8?token=hidden`, source: 'network' }] };
      } },
      tabs: { async query() { return [{ id: 1, title: '测试视频 · 清晰度选择', url: `${origin}/watch` }]; } },
      storage: { onChanged: { addListener() {} } },
      downloads: {
        onChanged: { addListener(fn) { listeners.push(fn); } },
        async download(options) {
          window.testDownloadCount += 1;
          window.savedFilename = options.filename;
          window.savedBytes = [...new Uint8Array(await (await fetch(options.url)).arrayBuffer())];
          const id = window.testDownloadCount;
          setTimeout(() => listeners.forEach((fn) => fn({ id, state: { current: window.testSaveMode }, error: { current: 'USER_CANCELED' } })), 30);
          return id;
        },
        async search() { return [{ state: 'in_progress' }]; }
      }
    };
  }, { origin });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const waitMessage = (text) => page.waitForFunction((text) => document.getElementById('message')?.textContent.includes(text), text);
  const open = (file, disk = false) => page.goto(`${origin}/download.html?fixture=${file}${disk ? '&disk=1' : ''}#${new URLSearchParams({ url: `${origin}/${file}`, title: '测试视频' })}`);
  await open('master.m3u8');
  await waitMessage('请选择');
  assert.equal(await page.locator('.variant:disabled').count(), 1);
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'artifacts/workspace.png'), fullPage: true });
  await page.locator('.variant:not(:disabled)').click();
  await waitMessage('视频已就绪');
  await page.click('#back');
  await waitMessage('请选择');
  await page.locator('.variant:not(:disabled)').click();
  await waitMessage('视频已就绪');
  await page.evaluate(() => { window.testSaveMode = 'interrupted'; });
  await page.click('#start');
  await waitMessage('保存取消或失败');
  const beforeRetry = segmentRequests;
  await page.evaluate(() => { window.testSaveMode = 'complete'; });
  await page.click('#save-again');
  await waitMessage('已保存');
  assert.equal(segmentRequests, beforeRetry, 'save retry should reuse the Blob');
  assert.equal(await page.evaluate(() => window.savedFilename), '测试视频.ts');
  assert.deepEqual(await page.evaluate(() => window.savedBytes), [...packet(1), ...packet(2)]);
  await open('slow.m3u8');
  await waitMessage('视频已就绪');
  await page.click('#start');
  await page.click('#cancel');
  await waitMessage('已保留下载进度');
  assert.equal(await page.evaluate(() => window.testDownloadCount), 0);
  const beforeResume = segmentRequests;
  await page.click('#start');
  await waitMessage('已保存');
  assert.ok(segmentRequests - beforeResume <= 2);
  assert.deepEqual(await page.evaluate(() => window.savedBytes), [...packet(1), ...packet(2)]);
  await open('media.m3u8', true);
  await waitMessage('视频已就绪');
  assert.equal(await page.locator('#output-mode').inputValue(), 'disk');
  await page.click('#start');
  await waitMessage('已保存');
  assert.equal(await page.evaluate(() => window.testDiskClosed), true);
  assert.equal(await page.evaluate(() => window.testDownloadCount), 0);
  assert.deepEqual(await page.evaluate(() => window.savedBytes), [...packet(1), ...packet(2)]);
  await open('invalid.m3u8');
  await waitMessage('HTTP 403');
  assert.equal(await page.locator('#selection').isHidden(), true);
  await page.goto(`${origin}/download.html#${new URLSearchParams({
    url: `${origin}/signed.m3u8?token=old&expires=9999999999&token_path=%2F`,
    title: '测试视频', sourceTabId: '1', sourceOrigin: origin
  })}`);
  await waitMessage('视频已就绪');
  assert.equal(await page.locator('#source-help').isHidden(), true);
  await page.click('#start');
  await waitMessage('来源页已刷新');
  assert.equal(await page.locator('#source-help').isVisible(), true);
  await page.click('#source-help');
  assert.equal(await page.evaluate(() => window.focusedTab), 1);
  await waitMessage('下载会自动继续');
  await page.click('#cancel');
  await waitMessage('已保留下载进度');
  await page.click('#source-help');
  await waitMessage('继续下载');
  await page.click('#discard');
  await page.locator('#auto-refresh').uncheck();
  await page.click('#start');
  await waitMessage('手动刷新来源页并播放');
  await page.click('#cancel');
  await page.goto(`${origin}/popup.html`);
  await page.waitForSelector('.media-card');
  assert.equal(await page.locator('.media-address').textContent(), `127.0.0.1:${server.address().port}/master.m3u8`);
  await page.setViewportSize({ width: 400, height: 620 });
  await page.screenshot({ path: path.join(root, 'artifacts/popup.png'), fullPage: true });
  await page.click('.download-button');
  // window.close() may be ignored for a tab not opened by a script; the mock retains the URL.
  assert.equal(await page.evaluate(() => window.openedManager), `${origin}/master.m3u8?token=hidden`);
  assert.deepEqual(errors, []);
  console.log('UI smoke passed: variants, exact merged bytes, save retry, pause/resume, disk write/close, HTTP error, popup and signed URLs.');
  console.log('Chrome APIs were mocked; this does not verify unpacked extension loading or real video playback.');
} finally {
  await browser?.close();
  server.closeAllConnections();
  server.close();
}
