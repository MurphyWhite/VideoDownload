import { httpUrl, renewMediaUrl, signedContext } from './lib/hls.js';

const queues = new Map();
const keyFor = (tabId) => `media:${tabId}`;
const isPlaylist = (url) => /\.m3u8(?:$|[?#])/i.test(url);

// Serialize storage changes for each tab; session storage survives worker restarts.
function enqueue(tabId, task) {
  const next = (queues.get(tabId) || Promise.resolve()).catch(() => {}).then(task);
  queues.set(tabId, next);
  void next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); }).catch(console.error);
  return next;
}

async function badge(tabId, count) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#167568' });
    await chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' });
  } catch { /* The tab may have closed while a network event was being processed. */ }
}

function record(tabId, urls, source) {
  if (!Number.isInteger(tabId) || tabId < 0) return Promise.resolve();
  return enqueue(tabId, async () => {
    const key = keyFor(tabId);
    const state = await chrome.storage.session.get(key);
    const items = state[key] || [];
    for (const value of urls.slice(0, 100)) {
      try {
        if (typeof value !== 'string' || value.length > 8192) continue;
        const url = httpUrl(value);
        if (!items.some((item) => item.url === url)) items.push({ url, source, detectedAt: Date.now() });
      } catch { /* Ignore non-HTTP and malformed page resources. */ }
    }
    const bounded = items.slice(-80);
    await chrome.storage.session.set({ [key]: bounded });
    await badge(tabId, bounded.length);
    return bounded;
  });
}

chrome.webRequest.onHeadersReceived.addListener((details) => {
  const type = details.responseHeaders?.find((header) => header.name.toLowerCase() === 'content-type')?.value || '';
  if (details.statusCode >= 200 && details.statusCode < 300 &&
      (isPlaylist(details.url) || /(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)/i.test(type))) {
    void record(details.tabId, [details.url], 'network').catch(console.error);
  }
}, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);

chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.status === 'loading') {
    void enqueue(tabId, async () => {
      await chrome.storage.session.remove(keyFor(tabId));
      await badge(tabId, 0);
    }).catch(console.error);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void enqueue(tabId, () => chrome.storage.session.remove(keyFor(tabId))).catch(console.error);
});

function trustedUi(sender) {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  const url = new URL(sender.url);
  const base = new URL(chrome.runtime.getURL('/'));
  return url.protocol === base.protocol && url.host === base.host &&
    ['/popup.html', '/download.html'].includes(url.pathname);
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error('无效消息。');
  if (message.type === 'OPEN_DOWNLOAD') {
    if ((message.url !== undefined && typeof message.url !== 'string') ||
        (message.title !== undefined && typeof message.title !== 'string')) throw new Error('无效的视频地址或标题。');
    const url = message.url ? httpUrl(message.url) : '';
    if (url.length > 8192) throw new Error('视频地址过长。');
    const params = new URLSearchParams({ url, title: String(message.title || 'video').slice(0, 200) });
    if (Number.isInteger(message.sourceTabId) && message.sourceTabId >= 0) {
      try {
        const source = await chrome.tabs.get(message.sourceTabId);
        params.set('sourceOrigin', new URL(httpUrl(source.url)).origin);
        params.set('sourceTabId', message.sourceTabId);
      } catch { /* Manual input remains usable without a normal source page. */ }
    }
    await chrome.tabs.create({ url: chrome.runtime.getURL(`download.html#${params}`) });
    return {};
  }
  if (message.type === 'GET_AUTH') {
    if (typeof message.url !== 'string' || message.url.length > 8192) throw new Error('无效视频地址。');
    const original = httpUrl(message.url);
    if (!signedContext(original)) return { url: original };
    await Promise.allSettled([...queues.values()]);
    const stored = await chrome.storage.session.get(null);
    let renewed = original;
    const items = Object.entries(stored).filter(([key]) => key.startsWith('media:'))
      .flatMap(([, value]) => Array.isArray(value) ? value : []).filter((item) => item.source === 'network')
      .sort((a, b) => a.detectedAt - b.detectedAt);
    for (const item of items) renewed = renewMediaUrl(renewed, item.url);
    return { url: renewed };
  }
  if (!Number.isInteger(message.tabId) || message.tabId < 0) throw new Error('无效标签页。');
  if (message.type === 'GET_MEDIA') {
    await queues.get(message.tabId)?.catch(() => {});
    const data = await chrome.storage.session.get(keyFor(message.tabId));
    return { items: data[keyFor(message.tabId)] || [] };
  }
  if (message.type === 'RELOAD_SOURCE' || message.type === 'FOCUS_SOURCE') {
    const tab = await chrome.tabs.get(message.tabId);
    const source = new URL(httpUrl(tab.url));
    if (typeof message.sourceOrigin !== 'string' || source.origin !== message.sourceOrigin) {
      throw new Error('来源标签页已切换网站，请手动刷新原视频页面。');
    }
    if (message.type === 'RELOAD_SOURCE') await chrome.tabs.reload(message.tabId);
    else {
      await chrome.tabs.update(message.tabId, { active: true });
      // Activating a tab does not focus its window when the source is elsewhere.
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return {};
  }
  if (message.type === 'SCAN') {
    const tab = await chrome.tabs.get(message.tabId);
    httpUrl(tab.url);
    const result = await chrome.scripting.executeScript({ target: { tabId: message.tabId }, files: ['content.js'] });
    const urls = result[0]?.result?.urls;
    if (!Array.isArray(urls)) throw new Error('页面扫描未返回有效结果。');
    return { items: await record(message.tabId, urls.filter(isPlaylist), 'page') };
  }
  throw new Error('不支持的消息类型。');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!trustedUi(sender)) { sendResponse({ ok: false, error: '不允许的消息来源。' }); return false; }
  void handleMessage(message).then((data) => sendResponse({ ok: true, ...data }),
    (error) => sendResponse({ ok: false, error: error.message || '操作失败。' }));
  return true;
});
