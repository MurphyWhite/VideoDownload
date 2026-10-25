import { signedContext } from './hls.js';
import { digestBytes, fetchBytes, loadPlaylist, readMediaSegment } from './downloader.js';

function relativeResource(url, playlistContext) {
  if (!url) return null;
  const context = signedContext(url);
  if (!context || context.origin !== playlistContext.origin ||
      context.scope !== playlistContext.scope || context.effectiveScope !== playlistContext.effectiveScope) return null;
  const parsed = new URL(url);
  const contentQuery = new URLSearchParams([...parsed.searchParams]
    .filter(([name]) => !['token', 'expires', 'token_path'].includes(name))).toString();
  return parsed.pathname.slice(context.effectiveScope.length) + (contentQuery ? `?${contentQuery}` : '');
}

function sameResource(oldUrl, freshUrl, oldContext, newContext) {
  if (!oldUrl || !freshUrl) return !oldUrl && !freshUrl;
  const relative = relativeResource(oldUrl, oldContext);
  return relative !== null && relative === relativeResource(freshUrl, newContext);
}

function sameRange(a, b) {
  return a?.offset === b?.offset && a?.length === b?.length;
}

function sameIv(a, b) {
  return JSON.stringify(a ? Array.from(a) : null) === JSON.stringify(b ? Array.from(b) : null);
}

function equivalentStructure(original, replacement) {
  const oldContext = signedContext(original.url);
  const newContext = signedContext(replacement.url);
  if (!oldContext || !newContext || oldContext.scope !== newContext.scope ||
      relativeResource(original.url, oldContext) !== relativeResource(replacement.url, newContext) ||
      original.format !== replacement.format || original.segments.length !== replacement.segments.length ||
      original.duration !== replacement.duration) return false;
  return original.segments.every((old, index) => {
    const fresh = replacement.segments[index];
    return relativeResource(old.url, oldContext) !== null &&
      relativeResource(old.url, oldContext) === relativeResource(fresh.url, newContext) &&
      old.duration === fresh.duration && sameRange(old.range, fresh.range) &&
      sameResource(old.map?.url, fresh.map?.url, oldContext, newContext) &&
      sameRange(old.map?.range, fresh.map?.range) &&
      sameResource(old.key?.url, fresh.key?.url, oldContext, newContext) &&
      sameIv(old.key?.iv, fresh.key?.iv);
  });
}

async function verifyCommittedBytes(playlist, state, signal) {
  if (state.initDone) {
    if (!state.initProof || !playlist.segments[0].map) throw new Error('缺少已写入初始化分片的校验记录，无法安全切换 CDN。');
    const map = playlist.segments[0].map;
    const bytes = (await fetchBytes(map.url, { signal, range: map.range })).bytes;
    if (await digestBytes(bytes) !== state.initProof) throw new Error('新 CDN 的初始化分片内容不一致，已保留原任务。');
  }
  if (state.completed > 0) {
    const first = state.firstSegmentProof;
    const last = state.lastSegmentProof;
    if (first?.index !== 0 || last?.index !== state.completed - 1) {
      throw new Error('缺少已下载分片的校验记录，无法安全切换 CDN。');
    }
    for (const proof of first.index === last.index ? [first] : [first, last]) {
      const bytes = await readMediaSegment(playlist.segments[proof.index], playlist.format, { signal });
      if (await digestBytes(bytes) !== proof.digest) throw new Error('新 CDN 的分片内容不一致，已保留原任务。');
    }
  }
}

// Candidate URLs are successful HLS requests from the bound source tab. Never
// copy a token across origins: load the candidate's own playlist and prove it
// describes the same quality and media before a paused job adopts its URLs.
export async function findReplacementPlaylist(original, state, sourceUrls, { signal } = {}) {
  const originalContext = signedContext(original?.url);
  if (!originalContext || original.type !== 'media') throw new Error('原视频缺少可验证的目录签名，无法安全切换 CDN。');
  if (!state?.completed) {
    throw new Error('尚无已下载媒体分片可校验；请从来源页的新视频源重新开始。');
  }
  let lastError = new Error('来源页尚未发现原视频资产目录的新播放列表。请在原页面刷新并播放后重试。');
  for (const url of sourceUrls.slice(0, 12)) {
    if (signal?.aborted) throw signal.reason || new DOMException('已取消', 'AbortError');
    const context = signedContext(url);
    if (!context || context.scope !== originalContext.scope) continue;
    try {
      let candidate = await loadPlaylist(url, signal);
      if (candidate.type === 'master') {
        const selectedPath = relativeResource(original.url, originalContext);
        const variant = candidate.variants.find((item) => !item.externalMedia &&
          relativeResource(item.url, context) === selectedPath);
        if (!variant) throw new Error('新来源找不到原清晰度，已保留原任务。');
        candidate = await loadPlaylist(variant.url, signal);
      }
      if (!equivalentStructure(original, candidate)) throw new Error('新 CDN 的分片顺序或结构与原视频不同，无法确认是相同视频。');
      await verifyCommittedBytes(candidate, state, signal);
      return candidate;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      lastError = error;
    }
  }
  throw lastError;
}
