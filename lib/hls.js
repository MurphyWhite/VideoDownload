// Pure HLS parsing: shared by the browser and the Node test suite.
export function httpUrl(value, base) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('仅支持不含用户名和密码的 HTTP / HTTPS 地址。');
  }
  url.hash = '';
  return url.href;
}

// Some signed CDNs leave child URIs relative and have the player append this
// scoped authentication tuple. Never copy arbitrary queries or cross origins.
export function mediaUrl(value, base) {
  const target = new URL(httpUrl(value, base));
  const parent = new URL(httpUrl(base));
  const names = ['token', 'expires', 'token_path'];
  const context = signedContext(base);
  if (target.origin !== parent.origin || !context || names.some((name) => target.searchParams.has(name)) ||
      !target.pathname.startsWith(context.effectiveScope)) return target.href;
  if (context.scope !== '/' && target.pathname.indexOf(context.scope) !== target.pathname.lastIndexOf(context.scope)) {
    throw new Error('签名目录在媒体路径中重复，无法安全判定授权范围。');
  }
  for (const name of names) target.searchParams.set(name, parent.searchParams.get(name));
  return target.href;
}

export function signedContext(value) {
  try {
    const url = new URL(httpUrl(value));
    const scope = url.searchParams.get('token_path');
    const rawExpires = url.searchParams.get('expires');
    const expires = Number(rawExpires);
    if (!url.searchParams.get('token') || !scope?.startsWith('/') || !scope.endsWith('/') ||
        /[?#\\]/.test(scope) || new URL(scope, url.origin).pathname !== scope ||
        new URL(scope, url.origin).origin !== url.origin ||
        !/^\d+$/.test(rawExpires || '') || !Number.isSafeInteger(expires) || expires <= 0) return null;
    // Some CDNs declare /asset/ while serving it at /date/asset/. Match whole
    // directory segments and keep the observed prefix as part of the boundary.
    const offset = url.pathname.indexOf(scope);
    if (offset < 0 || (scope !== '/' && offset !== url.pathname.lastIndexOf(scope))) return null;
    const effectiveScope = url.pathname.slice(0, offset) + scope;
    return { origin: url.origin, scope, effectiveScope, expires, token: url.searchParams.get('token') };
  } catch { return null; }
}

// Renew only the same signed asset scope, keeping the segment path and other query fields.
export function renewMediaUrl(value, candidate) {
  const current = signedContext(value);
  const fresh = signedContext(candidate);
  if (!current || !fresh || current.origin !== fresh.origin || current.scope !== fresh.scope ||
      current.effectiveScope !== fresh.effectiveScope ||
      fresh.expires < current.expires || fresh.expires <= Date.now() / 1000 ||
      (fresh.expires === current.expires && fresh.token === current.token)) return value;
  const url = new URL(value);
  for (const name of ['token', 'expires', 'token_path']) url.searchParams.delete(name);
  return mediaUrl(url.href, candidate);
}

export function attributes(line) {
  const result = {};
  const input = line.slice(line.indexOf(':') + 1);
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (const match of input.matchAll(pattern)) {
    result[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return result;
}

function integer(value, label) {
  if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label}无效。`);
  }
  return Number(value);
}

function rangeFor(value, url, previous) {
  if (!value) return null;
  const match = /^(\d+)(?:@(\d+))?$/.exec(value);
  if (!match) throw new Error('无效的分片字节范围。');
  const length = integer(match[1], '字节长度');
  if (!length) throw new Error('分片字节长度必须大于零。');
  const offset = match[2] !== undefined ? integer(match[2], '字节偏移') :
    previous?.url === url && previous.range ? previous.range.offset + previous.range.length : NaN;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(offset + length)) {
    throw new Error('字节范围缺少有效的起始偏移。');
  }
  return { offset, length };
}

export function sequenceIv(sequence) {
  let value = BigInt(sequence);
  if (value < 0n || value >= 2n ** 128n) throw new Error('媒体序号超出范围。');
  const bytes = new Uint8Array(16);
  for (let i = 15; i >= 0; i -= 1) { bytes[i] = Number(value & 255n); value >>= 8n; }
  return bytes;
}

function explicitIv(value) {
  if (!/^0x[\da-f]{1,32}$/i.test(value)) throw new Error('AES-128 的 IV 格式无效。');
  const hex = value.slice(2).padStart(32, '0');
  return Uint8Array.from(hex.match(/../g), (byte) => parseInt(byte, 16));
}

export function parsePlaylist(text, base) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('返回内容不是有效的 M3U8 播放列表，可能需要登录或链接已过期。');
  const variants = [];
  const renditions = [];
  let pendingVariant = null;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA:')) renditions.push(attributes(line));
    if (line.startsWith('#EXT-X-STREAM-INF:')) pendingVariant = attributes(line);
    else if (!line.startsWith('#') && pendingVariant) {
      variants.push({ url: mediaUrl(line, base), ...pendingVariant });
      pendingVariant = null;
    }
  }
  if (pendingVariant) throw new Error('清晰度列表缺少视频地址。');
  if (variants.length) {
    return { type: 'master', variants: variants.map((variant) => ({
      ...variant,
      externalMedia: renditions.some((item) => item.URI &&
        ((item.TYPE === 'AUDIO' && item['GROUP-ID'] === variant.AUDIO) ||
         (item.TYPE === 'VIDEO' && item['GROUP-ID'] === variant.VIDEO)))
    })).sort((a, b) => Number(b.BANDWIDTH || 0) - Number(a.BANDWIDTH || 0)) };
  }

  if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('这是直播或尚未结束的播放列表。当前版本只下载已结束的点播视频。');
  const segments = [];
  let sequence = 0n;
  let key = null;
  let map = null;
  let rangeText = null;
  let duration = null;
  let previousMap = null;
  let totalDuration = 0;
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const value = line.split(':')[1];
      if (!/^\d+$/.test(value) || segments.length) throw new Error('媒体序号无效。');
      sequence = BigInt(value);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attr = attributes(line);
      if (attr.METHOD === 'NONE') { key = null; continue; }
      if (attr.METHOD !== 'AES-128' || (attr.KEYFORMAT && attr.KEYFORMAT !== 'identity')) {
        throw new Error('此视频使用 DRM 或暂不支持的加密方式。仅支持普通 AES-128 HLS。');
      }
      if (!attr.URI) throw new Error('AES-128 播放列表缺少密钥地址。');
      key = { url: mediaUrl(attr.URI, base), iv: attr.IV ? explicitIv(attr.IV) : null };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      if (key) throw new Error('暂不支持加密的 fMP4 初始化分片。');
      const attr = attributes(line);
      if (!attr.URI) throw new Error('初始化分片缺少地址。');
      const url = mediaUrl(attr.URI, base);
      const nextMap = { url, range: rangeFor(attr.BYTERANGE, url, previousMap) };
      if (map && JSON.stringify(map) !== JSON.stringify(nextMap)) {
        throw new Error('视频中途更换了初始化分片，需要重新封装，当前版本暂不支持。');
      }
      map = nextMap;
      previousMap = nextMap;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      rangeText = line.split(':')[1];
    } else if (line.startsWith('#EXTINF:')) {
      duration = Number(line.slice(8).split(',')[0]);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('分片时长无效。');
    } else if (line === '#EXT-X-DISCONTINUITY' || line === '#EXT-X-GAP' || line === '#EXT-X-I-FRAMES-ONLY') {
      throw new Error('此视频包含时间线切换、缺失分片或仅关键帧，需要重新封装，当前版本暂不支持。');
    } else if (!line.startsWith('#')) {
      if (duration === null) throw new Error('媒体分片缺少 EXTINF 时长。');
      const url = mediaUrl(line, base);
      segments.push({ url, duration, range: rangeFor(rangeText, url, segments.at(-1)), map,
        key: key ? { url: key.url, iv: key.iv ?? sequenceIv(sequence) } : null });
      totalDuration += duration;
      sequence += 1n;
      rangeText = null;
      duration = null;
      if (segments.length > 10000) throw new Error('分片超过 10,000 个，请使用桌面下载工具。');
    }
  }
  if (duration !== null || rangeText) throw new Error('播放列表不完整，存在没有地址的分片。');
  if (!segments.length) throw new Error('播放列表中没有可下载的分片。');
  if (segments.some((segment) => Boolean(segment.map) !== Boolean(segments[0].map))) {
    throw new Error('视频中途切换了媒体容器，当前版本暂不支持。');
  }
  return { type: 'media', segments, duration: totalDuration, format: segments[0].map ? 'mp4' : 'ts' };
}

export function safeFilename(value, extension) {
  const name = String(value || 'video').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\.(m3u8|mp4|ts)$/i, '').replace(/[. ]+$/g, '').trim().slice(0, 100) || 'video';
  return `${name}.${extension}`;
}
