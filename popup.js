const $ = (id) => document.getElementById(id);
let activeTab;
let supportedPage = false;

async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '扩展后台未响应，请重新加载扩展。');
  return result;
}

function notice(text = '') { $('notice').textContent = text; }

function render(items) {
  $('media-list').replaceChildren();
  $('count').textContent = `${items.length} 个视频源`;
  $('empty').hidden = items.length !== 0;
  items.forEach((item, index) => {
    const card = document.createElement('article');
    card.className = 'media-card';
    const heading = document.createElement('h2');
    heading.textContent = `视频源 ${String(index + 1).padStart(2, '0')}`;
    const source = document.createElement('span');
    source.className = 'source-tag';
    source.textContent = item.source === 'network' ? '网络发现' : '页面发现';
    const top = document.createElement('div');
    top.className = 'card-top';
    top.append(heading, source);
    const address = document.createElement('p');
    address.className = 'media-address';
    const url = new URL(item.url);
    // Signed query strings stay out of the visible list, but are preserved for fetching.
    address.textContent = `${url.host}${url.pathname}`;
    const button = document.createElement('button');
    button.className = 'download-button';
    button.textContent = '选择清晰度并下载 ↗';
    button.addEventListener('click', () => openManager(item.url));
    card.append(top, address, button);
    $('media-list').append(card);
  });
}

async function openManager(url = '') {
  try {
    await send({ type: 'OPEN_DOWNLOAD', url, title: activeTab?.title || 'video', sourceTabId: activeTab?.id });
    window.close();
  } catch (error) { notice(error.message); }
}

async function scan() {
  $('scan').disabled = true;
  notice('正在检查页面资源…');
  try {
    const result = await send({ type: 'SCAN', tabId: activeTab.id });
    render(result.items);
    notice(result.items.length ? '已发现视频源。打开后可查看清晰度。' : '暂未发现，请播放视频后重试。');
  } catch (error) { notice(`页面扫描失败：${error.message}`); }
  finally { $('scan').disabled = !supportedPage; }
}

$('scan').addEventListener('click', scan);
$('manager').addEventListener('click', () => openManager());
$('manual-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void openManager($('manual-url').value.trim());
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && activeTab && changes[`media:${activeTab.id}`]) {
    render(changes[`media:${activeTab.id}`].newValue || []);
  }
});

try {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  supportedPage = /^https?:\/\//.test(activeTab?.url || '');
  $('page-title').textContent = activeTab?.title || '未选择网页';
  $('scan').disabled = !supportedPage;
  if (activeTab?.id !== undefined) render((await send({ type: 'GET_MEDIA', tabId: activeTab.id })).items);
  else render([]);
  if (supportedPage) await scan();
  else notice('此页面无法扫描。请打开普通网页，或手动粘贴视频地址。');
} catch (error) { notice(error.message); }
