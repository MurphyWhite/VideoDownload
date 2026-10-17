import test from 'node:test';
import assert from 'node:assert/strict';
import { attributes, httpUrl, mediaUrl, parsePlaylist, sequenceIv, safeFilename } from '../lib/hls.js';

const base = 'https://cdn.example/path/list.m3u8?token=secret';
const media = (body) => `#EXTM3U\n${body}\n#EXT-X-ENDLIST`;

test('quoted attribute values keep codec commas intact', () => {
  assert.deepEqual(attributes('#EXT-X-STREAM-INF:BANDWIDTH=1280000,CODECS="avc1.64001f,mp4a.40.2"'),
    { BANDWIDTH: '1280000', CODECS: 'avc1.64001f,mp4a.40.2' });
});
test('master sorts variants and identifies only matching external renditions', () => {
  const result = parsePlaylist(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="external",URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360
low.m3u8?auth=1
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="external"
../high.m3u8`, base);
  assert.equal(result.variants[0].url, 'https://cdn.example/high.m3u8');
  assert.equal(result.variants[0].externalMedia, true);
  assert.equal(result.variants[1].externalMedia, false);
  assert.equal(result.variants[1].url, 'https://cdn.example/path/low.m3u8?auth=1');
});
test('VOD duration, original segment order and relative URLs', () => {
  const result = parsePlaylist(media('#EXTINF:2.5,\na.ts\n#EXTINF:3,\n../b.ts?token=xyz'), base);
  assert.equal(result.duration, 5.5);
  assert.equal(result.format, 'ts');
  assert.deepEqual(result.segments.map((segment) => segment.url),
    ['https://cdn.example/path/a.ts', 'https://cdn.example/b.ts?token=xyz']);
});
test('fMP4 init segment and implicit byte ranges', () => {
  const result = parsePlaylist(media(`#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"
#EXTINF:2,
#EXT-X-BYTERANGE:188@100
all.m4s
#EXTINF:2,
#EXT-X-BYTERANGE:188
all.m4s`), base);
  assert.equal(result.format, 'mp4');
  assert.deepEqual(result.segments[1].range, { offset: 288, length: 188 });
  assert.deepEqual(result.segments[0].map.range, { offset: 0, length: 100 });
});
test('AES-128 IVs use exact big integer media sequences and support METHOD=NONE', () => {
  const result = parsePlaylist(media(`#EXT-X-MEDIA-SEQUENCE:9007199254740993
#EXT-X-KEY:METHOD=AES-128,URI="key"
#EXTINF:2,
a.ts
#EXT-X-KEY:METHOD=AES-128,URI="key2",IV=0x0a
#EXTINF:2,
b.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:2,
c.ts`), base);
  assert.deepEqual(result.segments[0].key.iv, sequenceIv(9007199254740993n));
  assert.equal(result.segments[1].key.iv[15], 10);
  assert.equal(result.segments[2].key, null);
});
test('invalid, live, DRM, discontinuous, missing and changing media fail explicitly', () => {
  for (const [input, expected] of [
    ['<html>Login</html>', /不是有效/],
    ['#EXTM3U\n#EXTINF:2,\na.ts', /直播/],
    [media('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:2,\na.ts'), /DRM/],
    [media('#EXT-X-DISCONTINUITY\n#EXTINF:2,\na.ts'), /时间线/],
    [media('#EXT-X-GAP\n#EXTINF:2,\na.ts'), /缺失/],
    [media('#EXTINF:2,'), /不完整/],
    [media('a.ts'), /EXTINF/],
    [media('#EXT-X-MAP:URI="a.mp4"\n#EXTINF:2,\na.m4s\n#EXT-X-MAP:URI="b.mp4"'), /更换/],
    [media('#EXTINF:2,\n#EXT-X-BYTERANGE:100\na.ts'), /偏移/],
    [media('#EXTINF:2,\n#EXT-X-BYTERANGE:100@0\na.ts\n#EXTINF:2,\n#EXT-X-BYTERANGE:100\nb.ts'), /偏移/],
    ['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100', /缺少视频地址/]
  ]) assert.throws(() => parsePlaylist(input, base), expected);
});
test('URLs reject unsafe schemes and embedded credentials', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.com/a']) {
    assert.throws(() => httpUrl(url));
  }
  assert.equal(httpUrl('/a.m3u8?key=1#fragment', base), 'https://cdn.example/a.m3u8?key=1');
});
test('output filenames use the real container format and remove unsafe characters', () => {
  assert.equal(safeFilename('../my:video.mp4', 'ts'), '.._my_video.ts');
  assert.equal(safeFilename('   ', 'mp4'), 'video.mp4');
});

test('scoped CDN authentication reaches variants, segments, keys and init maps', () => {
  const signed = 'https://cdn.example/asset/playlist.m3u8?token=test-only&expires=9999999999&token_path=%2Fasset%2F&private=ignore';
  const master = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\n720p/video.m3u8', signed);
  const variant = new URL(master.variants[0].url);
  assert.equal(variant.searchParams.get('token'), 'test-only');
  assert.equal(variant.searchParams.has('private'), false);
  const parsed = parsePlaylist(media('#EXT-X-KEY:METHOD=AES-128,URI="../key"\n#EXTINF:2,\nsegment.ts'), variant.href);
  assert.equal(new URL(parsed.segments[0].url).searchParams.get('token'), 'test-only');
  assert.equal(new URL(parsed.segments[0].key.url).searchParams.get('token'), 'test-only');
  const mp4 = parsePlaylist(media('#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nsegment.m4s'), variant.href);
  assert.equal(new URL(mp4.segments[0].map.url).searchParams.get('token'), 'test-only');
});
test('authentication never leaks outside its origin/scope or overrides child authentication', () => {
  const signed = 'https://cdn.example/asset/playlist.m3u8?token=test-only&expires=9999999999&token_path=%2Fasset%2F';
  for (const child of ['https://other.example/asset/a.ts', '//other.example/asset/a.ts', '../other/a.ts',
    '/asset-copy/a.ts', '/asset/../outside/a.ts']) {
    assert.equal(new URL(mediaUrl(child, signed)).searchParams.has('token'), false);
  }
  const own = mediaUrl('child.m3u8?token=child&expires=123', signed);
  assert.equal(new URL(own).searchParams.get('token'), 'child');
  assert.equal(new URL(own).searchParams.get('expires'), '123');
  assert.equal(new URL(own).searchParams.has('token_path'), false);
  assert.equal(new URL(mediaUrl('child.ts', signed.replace('%2Fasset%2F', '%2F'))).searchParams.get('token'), 'test-only');
  assert.equal(new URL(mediaUrl('child.ts', signed.replace('%2Fasset%2F', '%2Fasset%2F..%2F'))).searchParams.has('token'), false);
  assert.equal(new URL(mediaUrl('child.ts', signed.replace('&token_path=%2Fasset%2F', ''))).searchParams.has('token'), false);
});
