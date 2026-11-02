// Фоновый воркер: получает данные вакансии через публичное API hh.ru.
// Запрос идёт отсюда, а не из content script, чтобы не зависеть от CORS страницы.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'fetchVacancy' && /^\d+$/.test(String(msg.id))) {
    fetch(`https://api.hh.ru/vacancies/${msg.id}`, {
      headers: { 'HH-User-Agent': 'HH-Resume-Matcher/1.0 (chrome-extension)' }
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // ответ асинхронный
  }
  return false;
});
