// Отправка отклика тем же запросом, что и кнопка «Откликнуться» на hh.
// Эндпоинт и поля взяты из кода страниц hh: /applicant/vacancy_response/popup.
(function (root) {
  'use strict';

  function xsrf() {
    const m = document.cookie.match(/(?:^|;\s*)_xsrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  // Коды ответа hh → понятный статус
  const CODES = [
    ['negotiations-limit-exceeded', 'limit', 'hh: исчерпан суточный лимит откликов'],
    ['captcha', 'captcha', 'hh попросил капчу — продолжите вручную'],
    ['test-required', 'test', 'нужно пройти тест или анкету работодателя'],
    ['letter-required', 'letter', 'работодатель требует сопроводительное письмо'],
    ['alreadyApplied', 'already', 'вы уже откликались'],
    ['already-applied', 'already', 'вы уже откликались']
  ];

  async function respond({ vacancyId, resumeHash, letter }) {
    const token = xsrf();
    if (!token) return { ok: false, status: 'error', detail: 'нет токена сессии — обновите страницу hh' };
    const fd = new FormData();
    fd.append('_xsrf', token);
    fd.append('vacancy_id', String(vacancyId));
    fd.append('resume_hash', resumeHash);
    fd.append('ignore_postponed', 'true');
    fd.append('incomplete', 'false');
    fd.append('letter', letter || '');
    fd.append('lux', 'true');
    fd.append('withoutTest', 'no');
    fd.append('hhtmFromLabel', '');
    fd.append('hhtmSourceLabel', '');

    let r, body = '';
    try {
      r = await fetch('/applicant/vacancy_response/popup', {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Xsrftoken': token, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
        body: fd
      });
      body = await r.text();
    } catch (e) {
      return { ok: false, status: 'error', detail: 'сеть: ' + (e.message || e) };
    }

    let json = null;
    try { json = JSON.parse(body); } catch (_) { /* не JSON */ }
    const success = r.ok && json && !json.error && (json.success === true || json.success === 'true' || json.responseStatus || json.topic_id || json.chatId);
    if (success) return { ok: true, status: 'sent', detail: 'отклик отправлен' };

    // Ищем код ошибки в ответе (поля error / errors / type / code или просто текст)
    const errText = json ? JSON.stringify([json.error, json.errors, json.type, json.code, json.reason]) : body;
    for (const [code, status, detail] of CODES) {
      if (errText.includes(code)) return { ok: false, status, detail };
    }
    if (r.status === 403 && /captcha/i.test(body)) return { ok: false, status: 'captcha', detail: CODES[1][2] };
    return {
      ok: false,
      status: 'error',
      detail: `hh ответил ${r.status}`,
      raw: body.slice(0, 300) // для диагностики в журнале
    };
  }

  root.HHApply = { respond };
})(globalThis);
