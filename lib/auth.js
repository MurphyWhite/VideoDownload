import { renewMediaUrl, signedContext } from './hls.js';

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal.reason || new DOMException('已暂停', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

// Only renew credentials already observed in successful requests to the same
// CDN asset scope. Multiple concurrent 403s share a single source-page refresh.
export function createAuthProvider({ fetchLatest, refreshSource, onWaiting = () => {},
  onReady = () => {}, waitMs = 120000, pollMs = 1500, refreshCooldownMs = 30000 }) {
  const known = new Map();
  const pending = new Map();
  const refreshedAt = new Map();
  const scopeKey = (url) => {
    const ctx = signedContext(url);
    return ctx ? JSON.stringify([ctx.origin, ctx.scope, ctx.effectiveScope]) : null;
  };
  const urlFor = (url) => {
    const candidate = known.get(scopeKey(url));
    return candidate ? renewMediaUrl(url, candidate) : url;
  };
  const onUnauthorized = async (url, error, signal) => {
    const key = scopeKey(url);
    if (!key) return null;
    const ready = urlFor(url);
    if (ready !== url) return ready;
    if (!pending.has(key)) {
      const renewal = (async () => {
        onWaiting();
        const started = Date.now();
        let attemptedRefresh = false;
        while (Date.now() - started < waitMs) {
          if (signal?.aborted) throw signal.reason || new DOMException('已暂停', 'AbortError');
          const candidate = await fetchLatest(url);
          const changed = candidate ? renewMediaUrl(url, candidate) : url;
          if (changed !== url) { known.set(key, changed); onReady(); return; }
          if (!attemptedRefresh && refreshSource && Date.now() - (refreshedAt.get(key) || 0) >= refreshCooldownMs) {
            attemptedRefresh = true;
            refreshedAt.set(key, Date.now());
            await refreshSource();
          }
          await wait(pollMs, signal);
        }
        throw new Error('等待新签名超时，已保留本页下载进度。请刷新来源页并播放视频，然后点击继续下载。');
      })();
      pending.set(key, renewal);
      void renewal.finally(() => { if (pending.get(key) === renewal) pending.delete(key); }).catch(() => {});
    }
    await pending.get(key);
    return urlFor(url);
  };
  return { urlFor, onUnauthorized };
}
