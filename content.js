// Runs only after the user opens the popup or clicks “重新扫描”. No page globals are patched.
(() => {
  const urls = new Set();
  function add(value) {
    if (typeof value !== 'string' || !/\.m3u8(?:$|[?#])/i.test(value)) return;
    try {
      const url = new URL(value, document.baseURI);
      if (['http:', 'https:'].includes(url.protocol)) urls.add(url.href);
    } catch { /* Ignore malformed DOM attributes. */ }
  }
  for (const entry of performance.getEntriesByType('resource')) add(entry.name);
  for (const element of [...document.querySelectorAll('video, source, a[href]')].slice(0, 2000)) {
    add(element.currentSrc);
    add(element.getAttribute('src'));
    add(element.getAttribute('href'));
  }
  return { urls: [...urls].slice(0, 100) };
})();
