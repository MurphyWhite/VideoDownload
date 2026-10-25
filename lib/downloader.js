import { httpUrl, parsePlaylist } from './hls.js';

export const MAX_BYTES = 512 * 1024 * 1024;
const MAX_RESOURCE = 64 * 1024 * 1024;

function abortError() { return new DOMException('下载已取消。', 'AbortError'); }

async function readLimited(response, limit, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) { await response.body?.cancel(); throw new Error('文件超过当前下载大小限制。'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('服务器没有返回文件内容。');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason || abortError();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('文件超过当前下载大小限制。');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

// A fresh timeout covers headers AND the response body on every attempt.
export async function fetchBytes(url, { signal, range, limit = MAX_RESOURCE, attempts = 3, urlFor = (value) => value, onUnauthorized } = {}) {
  httpUrl(url);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason || abortError();
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason || abortError());
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('请求超时，请重试。')), 30000);
    let requested = url;
    try {
      requested = httpUrl(urlFor(url));
      const headers = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {};
      const response = await fetch(requested, { credentials: 'include', headers, signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        const expires = Number(new URL(requested).searchParams.get('expires'));
        const expired = response.status === 403 && expires > 0 && expires < Date.now() / 1000;
        const error = new Error(expired
          ? '服务器返回 HTTP 403：该签名链接已过期。请刷新原视频页面，重新从扩展弹窗打开最新视频源。'
          : `服务器返回 HTTP ${response.status}。链接可能已过期，或服务器要求页面专用授权。`);
        error.retryable = response.status === 429 || response.status >= 500;
        error.status = response.status;
        throw error;
      }
      if (range) {
        const contentRange = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/.exec(response.headers.get('content-range') || '');
        if (response.status !== 206 || !contentRange || Number(contentRange[1]) !== range.offset ||
            Number(contentRange[2]) !== range.offset + range.length - 1) {
          await response.body?.cancel();
          throw new Error('服务器未正确响应分片字节范围请求。');
        }
      }
      const bytes = await readLimited(response, Math.min(limit, range?.length ?? limit), controller.signal);
      if (range && bytes.byteLength !== range.length) throw new Error('分片字节范围内容不完整。');
      return { bytes, url: httpUrl(response.url || requested) };
    } catch (error) {
      if (signal?.aborted) throw signal.reason || abortError();
      if ([401, 403].includes(error.status) && onUnauthorized && attempt < attempts - 1) {
        // Waiting for a new signed URL is outside the HTTP timeout. Cancellation
        // and a bounded wait are handled by the shared renewal provider.
        clearTimeout(timer);
        const replacement = await onUnauthorized(requested, error, signal);
        if (replacement && replacement !== requested) { url = httpUrl(replacement); continue; }
      }
      const retryable = error.retryable ?? (error instanceof TypeError || controller.signal.aborted);
      if (!retryable || attempt === attempts - 1) throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
    // Small bounded backoff; the next attempt checks cancellation again.
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
}

export async function loadPlaylist(url, signal, options = {}) {
  const result = await fetchBytes(httpUrl(url), { ...options, signal, limit: 2 * 1024 * 1024 });
  return { ...parsePlaylist(new TextDecoder().decode(result.bytes), result.url), url: result.url };
}

function validateMedia(bytes, format, isMap = false) {
  if (format === 'ts') {
    // A TS packet is 188 bytes; reject HTML responses and unsupported packed audio.
    if (bytes.length < 188 || bytes[0] !== 0x47 || bytes.length % 188 !== 0 ||
        (bytes.length >= 376 && bytes[188] !== 0x47)) {
      throw new Error('分片不是标准 MPEG-TS 视频。可能返回了登录页面，或使用了暂不支持的音频/媒体格式。');
    }
  } else {
    const box = new TextDecoder().decode(bytes.subarray(4, 8));
    const accepted = isMap ? ['ftyp', 'moov', 'styp'] : ['styp', 'moof', 'sidx', 'emsg', 'prft', 'free'];
    if (bytes.length < 8 || !accepted.includes(box)) throw new Error('分片不是受支持的 fMP4 媒体。');
  }
}

export async function digestBytes(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Used both by normal downloads and by the CDN continuity proof. Key promises
// are shared within one run, while each new run gets a fresh cache.
export async function readMediaSegment(segment, format, options = {}, keys = new Map()) {
  let bytes = (await fetchBytes(segment.url, { ...options, range: segment.range })).bytes;
  if (segment.key) {
    const resolved = options.urlFor ? options.urlFor(segment.key.url) : segment.key.url;
    if (!keys.has(resolved)) keys.set(resolved, (async () => {
      const result = await fetchBytes(segment.key.url, { ...options, limit: 16 });
      if (result.bytes.length !== 16) throw new Error('AES-128 密钥必须为 16 字节。');
      return crypto.subtle.importKey('raw', result.bytes, 'AES-CBC', false, ['decrypt']);
    })());
    const key = await keys.get(resolved);
    try { bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: segment.key.iv },
      key, bytes)); }
    catch { throw new Error('AES-128 分片解密失败，请刷新签名或重新解析视频。'); }
  }
  validateMedia(bytes, format);
  return bytes;
}

// A session owns an ordered prefix plus at most one bounded window of pending
// segments. Keep it across pause/retry; never reuse it for a different playlist.
export function createDownloadState(playlist, writer = null) {
  return { playlist, writer, completed: 0, bytes: 0, initDone: false, initProof: null,
    firstSegmentProof: null, lastSegmentProof: null, parts: [], pending: new Map(), failedWrite: false };
}

export async function downloadMedia(playlist, {
  signal, onProgress = () => {}, maxBytes = MAX_BYTES, concurrency = 8,
  state = createDownloadState(playlist), urlFor, onUnauthorized
} = {}) {
  if (playlist.type !== 'media') throw new Error('请先选择一个具体清晰度。');
  if (state.playlist !== playlist || state.failedWrite) throw new Error('此任务无法续传，请重新解析视频并选择保存位置。');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error('并发数应为 1 到 12。');
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason || abortError());
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const localSignal = controller.signal;
  const options = { signal: localSignal, urlFor, onUnauthorized };
  const keys = new Map();
  const progress = () => onProgress({ completed: state.completed, total: playlist.segments.length, bytes: state.bytes });
  const commit = async (bytes) => {
    if (!state.writer && state.bytes + bytes.byteLength > maxBytes) {
      throw new Error('视频超过 512 MiB 内存下载限制，请选择“直接写入磁盘”模式。');
    }
    if (state.writer) {
      try { await state.writer.write(bytes); }
      catch { state.failedWrite = true; throw new Error('文件写入失败，请检查磁盘空间或文件权限，然后重新开始。'); }
    } else state.parts.push(bytes);
    state.bytes += bytes.byteLength;
  };
  try {
    if (localSignal.aborted) throw localSignal.reason || abortError();
    const map = playlist.segments[0].map;
    if (map && !state.initDone) {
      const init = (await fetchBytes(map.url, { ...options, range: map.range })).bytes;
      validateMedia(init, 'mp4', true);
      const proof = await digestBytes(init);
      await commit(init);
      state.initDone = true;
      state.initProof = proof;
    }
    progress();
    // Backpressure: fetch only a bounded window ahead of the ordered disk writer.
    // Successful out-of-order results survive a failed batch without duplicate writes.
    while (state.completed < playlist.segments.length) {
      if (localSignal.aborted) throw localSignal.reason || abortError();
      const start = state.completed;
      const end = Math.min(start + concurrency, playlist.segments.length);
      const outcomes = await Promise.allSettled(Array.from({ length: end - start }, async (_, offset) => {
        const index = start + offset;
        if (state.pending.has(index)) return;
        const segment = playlist.segments[index];
        state.pending.set(index, await readMediaSegment(segment, playlist.format, options, keys));
      }));
      for (let index = start; index < end; index += 1) {
        const outcome = outcomes[index - start];
        if (outcome.status === 'rejected') throw outcome.reason;
        const bytes = state.pending.get(index);
        const proof = await digestBytes(bytes);
        await commit(bytes);
        state.pending.delete(index);
        state.completed += 1;
        if (index === 0) state.firstSegmentProof = { index, digest: proof };
        state.lastSegmentProof = { index, digest: proof };
        progress();
      }
    }
    if (localSignal.aborted) throw localSignal.reason || abortError();
    return state.writer ? null : new Blob(state.parts, { type: playlist.format === 'mp4' ? 'video/mp4' : 'video/mp2t' });
  } finally {
    controller.abort();
    signal?.removeEventListener('abort', cancel);
  }
}
