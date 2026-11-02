// На странице «Мои резюме» запоминаем id и названия резюме — запасной источник,
// если список не удастся получить запросом со страницы вакансии.
(function () {
  'use strict';
  const ID_RE = /\/resume\/([0-9a-f]{20,})/;
  let last = '';

  function collect() {
    const found = new Map();
    document.querySelectorAll('a[href*="/resume/"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(ID_RE);
      if (!m) return;
      const t = (a.textContent || '').trim();
      if (!found.has(m[1]) || (!found.get(m[1]) && t)) found.set(m[1], t);
    });
    if (!found.size) return;
    const list = Array.from(found, ([id, title]) => ({ id, title }));
    const key = JSON.stringify(list);
    if (key === last) return;
    last = key;
    chrome.storage.local.set({ hhmResumeIds: list });
  }

  collect();
  const obs = new MutationObserver(collect);
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => obs.disconnect(), 15000);
})();
