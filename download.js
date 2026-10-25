import { httpUrl, safeFilename, signedContext } from './lib/hls.js';
import { loadPlaylist, downloadMedia, createDownloadState } from './lib/downloader.js';
import { createAuthProvider } from './lib/auth.js';
import { findReplacementPlaylist } from './lib/continuity.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const sourceTabId = /^\d+$/.test(params.get('sourceTabId') || '') ? Number(params.get('sourceTabId')) : null;
const sourceOrigin = params.get('sourceOrigin');
const hasSourceTab = sourceTabId !== null && Boolean(sourceOrigin);
let selected;
let controller;
let working = false;
let savedBlob;
let blobUrl;
let downloadId;
let lastFilename;
let history = [];
let job;

async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '扩展后台未响应。');
  return result;
}
function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}
function showSourceHelp(show) { $('source-help').hidden = !show || !hasSourceTab; }
function showSourceSwitch(show) { $('source-switch').hidden = !show || !hasSourceTab; }
function setBusy(value) {
  working = value;
  for (const id of ['analyze', 'playlist-url', 'filename', 'back', 'output-mode']) $(id).disabled = value || Boolean(job);
  $('start').disabled = value;
  $('source-switch').disabled = value;
  $('concurrency').disabled = value;
  $('discard').hidden = !job || value;
  $('auto-refresh').disabled = sourceTabId === null || !sourceOrigin;
  $('start').textContent = job ? '继续下载 ↓' : '下载并合并视频 ↓';
  for (const button of $('variants').querySelectorAll('button')) {
    button.disabled = value || Boolean(job) || button.dataset.unsupported === 'true';
  }
}
function clearBlob() {
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = undefined;
  savedBlob = undefined;
  downloadId = undefined;
  $('save-again').hidden = true;
}
async function discardJob() {
  if (job?.writer) await job.writer.abort().catch(() => {});
  job = undefined;
  showSourceHelp(false);
  showSourceSwitch(false);
  setBusy(false);
}

const auth = createAuthProvider({
  fetchLatest: async (url) => (await send({ type: 'GET_AUTH', url })).url,
  refreshSource: async () => {
    if ($('auto-refresh').checked && sourceTabId !== null && sourceOrigin) {
      try { await send({ type: 'RELOAD_SOURCE', tabId: sourceTabId, sourceOrigin }); }
      catch { message('无法自动刷新来源页面。点击“打开来源页并播放”，手动刷新并播放视频；本页会保留进度并等待新签名。'); return; }
      message('来源页已刷新。浏览器可能阻止自动播放；若下载未继续，请点击“打开来源页并播放”，在原页面点击播放。');
    }
  },
  onWaiting: () => {
    $('progress-title').textContent = '签名已失效，等待新链接';
    showSourceHelp(true);
    message(hasSourceTab
      ? ($('auto-refresh').checked
        ? '已保留下载进度，正在获取新签名。若来源页刷新后暂停，请点击“打开来源页并播放”。'
        : '已保留下载进度，正在获取新签名。请打开来源页，手动刷新来源页并播放视频。')
      : '已保留下载进度，正在获取新签名。请在原视频页面刷新并播放；不要关闭此工作台。');
  },
  onReady: () => {
    showSourceHelp(false);
    $('playlist-url').value = auth.urlFor($('playlist-url').value);
    $('progress-title').textContent = job ? '正在继续下载分片' : '正在读取播放列表';
    message('已获取新签名，自动从未完成的分片继续。');
  }
});

function renderPlaylist(playlist) {
  selected = playlist.type === 'media' ? playlist : undefined;
  $('selection').hidden = false;
  $('variants').replaceChildren();
  $('media-info').hidden = playlist.type !== 'media';
  $('start').hidden = playlist.type !== 'media';
  $('back').hidden = history.length === 0;
  if (playlist.type === 'master') {
    playlist.variants.forEach((variant, index) => {
      const button = document.createElement('button');
      button.className = 'variant';
      const heading = document.createElement('strong');
      heading.textContent = variant.RESOLUTION || variant.NAME || `清晰度 ${index + 1}`;
      const meta = document.createElement('span');
      const bandwidth = Number(variant['AVERAGE-BANDWIDTH'] || variant.BANDWIDTH);
      meta.textContent = `${bandwidth > 0 ? `${(bandwidth / 1e6).toFixed(2)} Mbps` : '码率未知'}${variant.CODECS ? ` · ${variant.CODECS}` : ''}`;
      if (variant.externalMedia) meta.textContent += ' · 独立音视频轨，暂不支持合并';
      button.disabled = variant.externalMedia;
      button.dataset.unsupported = String(variant.externalMedia);
      button.append(heading, meta);
      button.addEventListener('click', () => analyze(variant.url, true));
      $('variants').append(button);
    });
    message(playlist.variants.every((variant) => variant.externalMedia)
      ? '该播放列表使用独立音视频轨，当前版本无法合并。' : '请选择一个清晰度。');
  } else {
    const minutes = Math.floor(playlist.duration / 60);
    const seconds = Math.floor(playlist.duration % 60).toString().padStart(2, '0');
    $('media-info').textContent = `${minutes}:${seconds} 时长  ·  ${playlist.segments.length} 个分片  ·  ${playlist.format.toUpperCase()}${playlist.segments.some((segment) => segment.key) ? '  ·  AES-128' : ''}`;
    message('视频已就绪，可以开始下载。磁盘模式会先让你选择保存位置。');
  }
}

async function analyze(url, nested = false) {
  if (working || job) return false;
  const previous = $('playlist-url').value;
  setBusy(true);
  showSourceHelp(false);
  showSourceSwitch(false);
  $('selection').hidden = true;
  selected = undefined;
  controller = new AbortController();
  $('progress-panel').hidden = false;
  $('progress-title').textContent = '正在读取播放列表';
  $('progress-detail').textContent = '请求超时后会自动重试';
  $('percentage').textContent = '…';
  $('progress').removeAttribute('value');
  $('cancel').textContent = '取消';
  $('cancel').hidden = false;
  message('正在解析视频…');
  try {
    const normalized = httpUrl(url.trim());
    if (normalized.length > 8192) throw new Error('视频地址过长。');
    if (nested && history.length >= 5) throw new Error('播放列表嵌套过深，无法继续解析。');
    const playlist = await loadPlaylist(normalized, controller.signal, auth);
    if (nested) history.push(previous);
    else history = [];
    $('playlist-url').value = playlist.url;
    clearBlob();
    renderPlaylist(playlist);
    return true;
  } catch (error) {
    message(controller.signal.aborted ? '解析已取消。' : error.message, !controller.signal.aborted);
    if (nested && $('variants').children.length) $('selection').hidden = false;
    return false;
  } finally {
    $('progress-panel').hidden = true;
    setBusy(false);
  }
}

async function saveFile() {
  $('save-again').hidden = true;
  setBusy(true);
  try {
    if (!savedBlob) throw new Error('没有可保存的视频，请重新下载。');
    blobUrl ??= URL.createObjectURL(savedBlob);
    downloadId = await chrome.downloads.download({ url: blobUrl, filename: lastFilename, saveAs: true });
    $('progress-title').textContent = '等待浏览器保存';
    message('请在保存对话框中选择位置。文件完成保存前请保持此标签页打开。');
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item?.state === 'complete') finishSave();
    else if (item?.state === 'interrupted') interruptedSave(item.error);
  } catch (error) { interruptedSave(error.message); }
}
function finishSave() {
  showSourceHelp(false);
  showSourceSwitch(false);
  $('progress-title').textContent = '视频已保存';
  message(`已保存 ${lastFilename}。现在可以关闭此标签页。`);
  clearBlob();
  setBusy(false);
}
function interruptedSave(reason) {
  downloadId = undefined;
  $('progress-title').textContent = '文件尚未保存';
  message(`保存取消或失败：${reason || '浏览器中断下载'}。可点击“重新保存文件”，无需重新下载分片。`, true);
  $('save-again').hidden = !savedBlob;
  setBusy(false);
}
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.id !== downloadId) return;
  if (delta.state?.current === 'complete') finishSave();
  else if (delta.state?.current === 'interrupted') interruptedSave(delta.error?.current);
});

$('playlist-form').addEventListener('submit', (event) => { event.preventDefault(); void analyze($('playlist-url').value); });
$('playlist-url').addEventListener('input', () => { selected = undefined; $('selection').hidden = true; });
$('back').addEventListener('click', async () => {
  if (!history.length || working || job) return;
  const parent = history.at(-1);
  const prior = [...history];
  const success = await analyze(parent);
  history = success ? prior.slice(0, -1) : prior;
  $('back').hidden = history.length === 0;
});
$('cancel').addEventListener('click', () => controller?.abort());
$('source-help').addEventListener('click', async () => {
  if (!hasSourceTab) return;
  try {
    await send({ type: 'FOCUS_SOURCE', tabId: sourceTabId, sourceOrigin });
    message(working
      ? '请在来源页点击播放，让网站发出新的视频请求；随后回到此工作台，下载会自动继续。'
      : '请在来源页点击播放，让网站发出新的视频请求；随后回到此工作台，点击“继续下载”。');
  } catch (error) { message(error.message, true); }
});
$('source-switch').addEventListener('click', async () => {
  if (!job || working || !selected || !hasSourceTab) return;
  controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('检查新来源超时，请在原页面播放后重试。')), 30000);
  setBusy(true);
  $('cancel').textContent = '取消检查';
  $('cancel').hidden = false;
  message('正在核对新来源的清晰度、分片和已下载内容…');
  let adopted = false;
  try {
    const result = await send({ type: 'GET_SOURCE_MEDIA', tabId: sourceTabId, sourceOrigin });
    const replacement = await findReplacementPlaylist(selected, job,
      result.items.map((item) => item.url), { signal: controller.signal });
    if (controller.signal.aborted) throw controller.signal.reason;
    // Uncommitted results can be fetched again; the validated disk prefix stays.
    job.pending.clear();
    job.playlist = replacement;
    selected = replacement;
    $('playlist-url').value = replacement.url;
    showSourceSwitch(false);
    showSourceHelp(false);
    message('已核对播放列表与已写入内容的抽样，正在从未完成的分片继续。');
    adopted = true;
  } catch (error) { message(error.message || '无法验证新来源，原任务和进度已保留。', true); }
  finally {
    clearTimeout(timeout);
    $('cancel').hidden = true;
    $('cancel').textContent = '暂停';
    setBusy(false);
  }
  if (adopted) $('start').click();
});
$('save-again').addEventListener('click', saveFile);
$('discard').addEventListener('click', async () => {
  if (working) return;
  await discardJob();
  $('progress-panel').hidden = true;
  message('已放弃未完成任务，可重新选择视频和保存方式。');
});
$('start').addEventListener('click', async () => {
  if (!selected || working) return;
  clearBlob();
  showSourceHelp(false);
  showSourceSwitch(false);
  controller = new AbortController();
  setBusy(true);
  $('progress-panel').hidden = false;
  $('progress-title').textContent = job ? '正在继续下载分片' : '准备下载';
  $('cancel').textContent = '暂停';
  $('cancel').hidden = false;
  try {
    if (!job) {
      lastFilename = safeFilename($('filename').value, selected.format);
      let writer = null;
      if ($('output-mode').value === 'disk') {
        // Must run under the original click's user activation, before any network await.
        const handle = await window.showSaveFilePicker({ suggestedName: lastFilename,
          types: [{ description: selected.format === 'ts' ? 'MPEG-TS 视频' : 'MP4 视频',
            accept: { [selected.format === 'ts' ? 'video/mp2t' : 'video/mp4']: [`.${selected.format}`] } }] });
        lastFilename = handle.name || lastFilename;
        writer = await handle.createWritable();
      }
      job = createDownloadState(selected, writer);
    }
    const activeJob = job;
    const started = performance.now();
    const initialBytes = job.bytes;
    message('正在下载，请保持此标签页打开。暂停后可从本页继续。');
    const blob = await downloadMedia(selected, { state: job, signal: controller.signal,
      concurrency: Number($('concurrency').value), ...auth,
      onProgress: ({ completed, total, bytes }) => {
        const percent = Math.floor(completed / total * 100);
        const elapsed = Math.max((performance.now() - started) / 1000, 0.1);
        const rate = Math.max(0, bytes - initialBytes) / elapsed / 1024 / 1024;
        $('progress').value = percent;
        $('percentage').textContent = `${percent}%`;
        $('progress-detail').textContent = `${completed} / ${total} 个分片 · ${(bytes / 1024 / 1024).toFixed(1)} MiB · ${rate.toFixed(1)} MiB/s`;
      }
    });
    $('cancel').hidden = true;
    if (activeJob.writer) {
      $('progress-title').textContent = '正在提交保存';
      try { await activeJob.writer.close(); }
      catch { activeJob.failedWrite = true; throw new Error('提交保存失败，请检查磁盘空间并重新开始。'); }
      job = undefined;
      finishSave();
    } else {
      savedBlob = blob;
      job = undefined;
      await saveFile();
    }
  } catch (error) {
    const paused = controller.signal.aborted || error.name === 'AbortError';
    $('progress-title').textContent = paused ? (job ? '下载已暂停' : '已取消选择保存位置') : '下载已暂停 · 需要重试';
    if (job?.failedWrite) await discardJob();
    showSourceSwitch(Boolean(job && signedContext(selected?.url)));
    message(paused ? (job ? '已保留下载进度，点击“继续下载”即可续传。' : '尚未开始下载，可重新选择保存位置。')
      : `${error.message}${job ? ' 已完成分片保留在本页，可点击继续下载。' : ''}`, !paused);
    $('cancel').hidden = true;
    setBusy(false);
  }
});
window.addEventListener('beforeunload', (event) => {
  if (working || savedBlob || job) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => {
  controller?.abort();
  if (job?.writer) void job.writer.abort().catch(() => {});
  if (blobUrl) URL.revokeObjectURL(blobUrl);
});

if (typeof window.showSaveFilePicker !== 'function') {
  $('output-mode').value = 'memory';
  $('output-mode').querySelector('[value="disk"]').disabled = true;
}
if (sourceTabId === null || !sourceOrigin) $('auto-refresh').checked = false;
setBusy(false);
$('filename').value = params.get('title') || 'video';
if (params.get('url')) { $('playlist-url').value = params.get('url'); void analyze(params.get('url')); }
