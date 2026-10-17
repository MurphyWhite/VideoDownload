// Manual real-extension validation only. Synthetic TS bytes are not playable video.
import http from 'node:http';
let generation = 0;
let expiry = 0;
let firstRequests = 0;
const count = 24;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/watch') {
    generation += 1;
    expiry = Math.max(Math.floor(Date.now() / 1000) + 60, expiry + 1);
    const query = new URLSearchParams({ token: String(generation), expires: String(expiry), token_path: '/asset/' });
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>流存 · 本地续传验证</title><h1>本地扩展测试</h1><p>仅请求合成播放列表，不播放真实视频。当前签名代次 ${generation}。</p><script>fetch('/asset/master.m3u8?${query}').then(r=>r.text())</script></html>`);
    return;
  }
  if (url.pathname.startsWith('/asset/')) {
    const token = url.searchParams.get('token');
    if (token !== String(generation) || (token === '1' && firstRequests >= 8)) {
      response.writeHead(403).end(); return;
    }
    if (url.pathname.endsWith('master.m3u8')) {
      response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=640x360\nvideo.m3u8'); return;
    }
    if (url.pathname.endsWith('video.m3u8')) {
      response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      response.end(`#EXTM3U\n${Array.from({ length: count }, (_, i) => `#EXTINF:2,\n${i}.ts`).join('\n')}\n#EXT-X-ENDLIST`); return;
    }
    const index = Number(url.pathname.split('/').at(-1).replace('.ts', ''));
    firstRequests += 1;
    const bytes = new Uint8Array(376).fill(index);
    bytes[0] = bytes[188] = 0x47;
    setTimeout(() => response.end(bytes), 150);
    return;
  }
  response.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => console.log(`Fixture: http://127.0.0.1:${server.address().port}/watch`));
