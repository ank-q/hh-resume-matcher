// Когда вы открываете своё резюме на hh, запоминаем его текст.
// Это запасной источник, если резюме не удаётся прочитать со страницы вакансии.
(function () {
  'use strict';
  const m = location.pathname.match(/^\/resume\/([0-9a-f]{20,})/);
  if (!m || window.top !== window) return;
  const id = m[1];

  async function isMine() {
    const { hhmResumeIds, hhmHh } = await chrome.storage.local.get(['hhmResumeIds', 'hhmHh']);
    const ids = new Set([...(hhmResumeIds || []).map((r) => r.id), ...((hhmHh && hhmHh.list) || []).map((r) => r.id)]);
    // Если список ещё не известен — признак своего резюме: кнопки редактирования
    return ids.has(id) || !!document.querySelector(`a[href*="/resume/edit/${id}"], a[href*="/profile/resume/"][href*="${id}"]`);
  }

  let lastLen = -1, stable = 0, saved = false;
  const timer = setInterval(async () => {
    const len = document.body ? document.body.innerText.length : 0;
    if (len > 200 && len === lastLen) stable++; else stable = 0;
    lastLen = len;
    if (stable < 2 || saved) return;
    saved = true;
    clearInterval(timer);
    if (!(await isMine())) return;
    const r = window.HHSync.renderedText(document);
    if (r.text.length < 300) return;
    const { hhmResumeCache } = await chrome.storage.local.get('hhmResumeCache');
    const cache = hhmResumeCache || {};
    cache[id] = { title: r.title, text: r.text, ts: Date.now() };
    await chrome.storage.local.set({ hhmResumeCache: cache });
  }, 700);
  setTimeout(() => clearInterval(timer), 30000);
})();
