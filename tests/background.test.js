import test from 'node:test';
import assert from 'node:assert/strict';

const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const state = {};
const created = [];
globalThis.chrome = {
  runtime: { id: 'test-id', getURL: (path) => `chrome-extension://test-id/${path.replace(/^\//, '')}`, onMessage: event() },
  storage: { session: {
    async get(key) { return structuredClone(key === null ? state : { [key]: state[key] }); },
    async set(value) { Object.assign(state, structuredClone(value)); },
    async remove(key) { delete state[key]; }
  } },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  webRequest: { onHeadersReceived: event() },
  tabs: { onUpdated: event(), onRemoved: event(), async create(value) { created.push(value); }, async get() { return { url: 'https://page.test/', windowId: 7 }; }, async reload(id) { globalThis.reloadedTab = id; }, async update(id, changes) { globalThis.focusedTab = { id, ...changes }; } },
  windows: { async update(id, changes) { globalThis.focusedWindow = { id, ...changes }; } },
  scripting: { async executeScript() { return [{ result: { urls: ['https://cdn.test/dom.m3u8', 'javascript:bad'] } }]; } }
};
await import('../background.js');
const sender = { id: 'test-id', url: 'chrome-extension://test-id/popup.html' };
const send = (message, from = sender) => new Promise((resolve) => chrome.runtime.onMessage.listeners[0](message, from, resolve));
const detect = (url, tabId = 1, mime = 'application/vnd.apple.mpegurl') => chrome.webRequest.onHeadersReceived.listeners[0]({
  tabId, url, statusCode: 200, responseHeaders: [{ name: 'Content-Type', value: mime }]
});

test('network detection deduplicates racing requests, recognizes MIME and isolates tabs', async () => {
  detect('https://cdn.test/master.m3u8');
  detect('https://cdn.test/master.m3u8');
  detect('https://cdn.test/playlist-without-extension');
  detect('https://cdn.test/other.m3u8', 2);
  const result = await send({ type: 'GET_MEDIA', tabId: 1 });
  assert.equal(result.items.length, 2);
  assert.equal((await send({ type: 'GET_MEDIA', tabId: 2 })).items.length, 1);
});
test('messages reject page senders, unsafe URLs, invalid tabs and unknown operations', async () => {
  assert.equal((await send({ type: 'GET_MEDIA', tabId: 1 }, { id: 'test-id', url: 'https://page.test/popup.html' })).ok, false);
  assert.equal((await send({ type: 'OPEN_DOWNLOAD', url: 'javascript:alert(1)' })).ok, false);
  assert.equal((await send({ type: 'GET_MEDIA', tabId: -1 })).ok, false);
  assert.equal((await send({ type: 'UNKNOWN', tabId: 1 })).ok, false);
  assert.equal(created.length, 0);
});
test('manual URLs preserve signed queries in an internal manager tab', async () => {
  assert.equal((await send({ type: 'OPEN_DOWNLOAD', url: 'https://cdn.test/a.m3u8?token=a&b=c', title: '测试' })).ok, true);
  const opened = new URL(created[0].url);
  assert.equal(opened.pathname, '/download.html');
  assert.equal(new URLSearchParams(opened.hash.slice(1)).get('url'), 'https://cdn.test/a.m3u8?token=a&b=c');
});
test('explicit page scans filter results and navigation clears detected sources', async () => {
  assert.equal((await send({ type: 'SCAN', tabId: 1 })).items.length, 3);
  chrome.tabs.onUpdated.listeners[0](1, { status: 'loading' });
  assert.equal((await send({ type: 'GET_MEDIA', tabId: 1 })).items.length, 0);
});

test('renewal uses only successful network records from the exact signed asset scope', async () => {
  const old = 'https://cdn.test/asset/720p/a.ts?token=old&expires=9999999998&token_path=%2Fasset%2F';
  detect('https://cdn.test/other/master.m3u8?token=wrong&expires=9999999999&token_path=%2Fother%2F', 3);
  detect('https://other.test/asset/master.m3u8?token=wrong&expires=9999999999&token_path=%2Fasset%2F', 3);
  detect('https://cdn.test/asset/master.m3u8?token=new&expires=9999999999&token_path=%2Fasset%2F', 3);
  const renewed = await send({ type: 'GET_AUTH', url: old });
  assert.equal(new URL(renewed.url).pathname, '/asset/720p/a.ts');
  assert.equal(new URL(renewed.url).searchParams.get('token'), 'new');
  assert.equal((await send({ type: 'GET_AUTH', url: 'file:///etc/passwd' })).ok, false);
});
test('source refresh refuses a tab that navigated to another website', async () => {
  assert.equal((await send({ type: 'RELOAD_SOURCE', tabId: 1, sourceOrigin: 'https://other.test' })).ok, false);
  assert.equal(globalThis.reloadedTab, undefined);
  assert.equal((await send({ type: 'RELOAD_SOURCE', tabId: 1, sourceOrigin: 'https://page.test' })).ok, true);
  assert.equal(globalThis.reloadedTab, 1);
});

test('source playback guide only focuses the original website tab', async () => {
  assert.equal((await send({ type: 'FOCUS_SOURCE', tabId: 1, sourceOrigin: 'https://other.test' })).ok, false);
  assert.equal(globalThis.focusedTab, undefined);
  assert.equal((await send({ type: 'FOCUS_SOURCE', tabId: 1, sourceOrigin: 'https://page.test' })).ok, true);
  assert.deepEqual(globalThis.focusedTab, { id: 1, active: true });
  assert.deepEqual(globalThis.focusedWindow, { id: 7, focused: true });
});
