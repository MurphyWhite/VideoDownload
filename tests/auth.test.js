import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthProvider } from '../lib/auth.js';
import { renewMediaUrl } from '../lib/hls.js';

const old = 'https://cdn.test/asset/720p/one.ts?token=old&expires=9999999998&token_path=%2Fasset%2F&keep=1';
const fresh = 'https://cdn.test/asset/master.m3u8?token=new&expires=9999999999&token_path=%2Fasset%2F';
test('concurrent 403s share one refresh and update every segment without changing its path', async () => {
  let candidate;
  let refreshes = 0;
  let waiting = 0;
  const auth = createAuthProvider({ fetchLatest: async () => candidate,
    refreshSource: async () => { refreshes += 1; candidate = fresh; },
    onWaiting: () => { waiting += 1; }, pollMs: 2, waitMs: 500 });
  const urls = await Promise.all(Array.from({ length: 8 }, () => auth.onUnauthorized(old, { status: 403 })));
  assert.equal(refreshes, 1);
  assert.equal(waiting, 1);
  assert.ok(urls.every((url) => new URL(url).searchParams.get('token') === 'new'));
  assert.equal(new URL(urls[0]).pathname, '/asset/720p/one.ts');
  assert.equal(new URL(urls[0]).searchParams.get('keep'), '1');
  assert.equal(new URL(auth.urlFor(old.replace('one.ts', 'two.ts'))).pathname, '/asset/720p/two.ts');
});
test('unrelated signatures cannot renew a job and a bounded wait retains actionable instructions', async () => {
  const auth = createAuthProvider({ fetchLatest: async () => fresh.replace('cdn.test', 'other.test'), pollMs: 2, waitMs: 12 });
  await assert.rejects(auth.onUnauthorized(old, { status: 403 }), /等待新签名超时.*保留/);
  assert.equal(auth.urlFor(old), old);
  assert.equal(await auth.onUnauthorized('https://cdn.test/not-signed.ts', { status: 403 }), null);
});
test('waiting for renewal can be paused promptly', async () => {
  const auth = createAuthProvider({ fetchLatest: async () => null, waitMs: 5000, pollMs: 1000 });
  const controller = new AbortController();
  const waiting = auth.onUnauthorized(old, { status: 403 }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(waiting, { name: 'AbortError' });
});
test('renewal rejects lower expiry, different scope, missing credentials and unsafe schemes', () => {
  for (const candidate of [fresh.replace('/asset/', '/other/').replace('%2Fasset%2F', '%2Fother%2F'),
    fresh.replace('9999999999', '123'), 'file:///asset/master.m3u8', 'https://cdn.test/asset/master.m3u8']) {
    assert.equal(renewMediaUrl(old, candidate), old);
  }
});

test('renewal distinguishes date-prefixed assets sharing the same declared token path', () => {
  const old = 'https://cdn.test/20261004/asset/720p/one.ts?token=old&expires=9999999998&token_path=%2Fasset%2F';
  const fresh = 'https://cdn.test/20261004/asset/playlist.m3u8?token=new&expires=9999999999&token_path=%2Fasset%2F';
  assert.equal(new URL(renewMediaUrl(old, fresh)).searchParams.get('token'), 'new');
  assert.equal(renewMediaUrl(old, fresh.replace('20261004', '20261005')), old);
  const auth = createAuthProvider({ fetchLatest: async () => fresh, pollMs: 2, waitMs: 100 });
  return auth.onUnauthorized(old, { status: 403 }).then((renewed) => {
    assert.equal(new URL(renewed).searchParams.get('token'), 'new');
    assert.equal(auth.urlFor(old.replace('20261004', '20261005')), old.replace('20261004', '20261005'));
  });
});
