// Автоотклики на странице поиска вакансий hh.
// Полуавтомат: собираем подходящие вакансии, вы отмечаете, расширение откликается.
// Автомат: откликаемся сразу по правилам, с паузами и суточным лимитом.
(function () {
  'use strict';
  if (window.__hhmAutoLoaded) return;
  window.__hhmAutoLoaded = true;

  const DEFAULTS = {
    mode: 'semi',          // 'semi' | 'auto'
    threshold: 70,         // минимальный % совпадения
    requireExpFit: true,   // только если опыт попадает в фильтр
    stopWords: '',         // через запятую: слова в названии или компании
    maxPages: 5,           // сколько страниц выдачи проверять
    dailyLimit: 50,        // наш суточный лимит (у hh свой — около 200)
    delayMin: 20,          // пауза между откликами, сек
    delayMax: 45,
    letterOn: false,
    letter: 'Здравствуйте! Меня заинтересовала вакансия «{вакансия}» в компании {компания}. У меня есть опыт с {технологии}. Буду рад обсудить детали.'
  };

  const st = {
    settings: { ...DEFAULTS },
    running: false,
    stop: false,
    phase: '',
    checked: 0,
    found: 0,
    sent: 0,
    items: [],          // кандидаты
    log: [],
    minimized: false,
    resumesNote: ''
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const todayKey = () => new Date().toDateString();

  async function sleepStoppable(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (st.stop) return false;
      await sleep(Math.min(500, end - Date.now()));
    }
    return !st.stop;
  }

  // ---------- хранилище ----------
  function searchKey() {
    const u = new URL(location.href);
    u.searchParams.delete('page');
    u.hash = '';
    return u.toString();
  }

  async function load() {
    const { hhmAuto, hhmApplyLog, hhmAutoMin, hhmAutoDraft } = await chrome.storage.local.get(['hhmAuto', 'hhmApplyLog', 'hhmAutoMin', 'hhmAutoDraft']);
    st.settings = { ...DEFAULTS, ...(hhmAuto || {}) };
    st.log = hhmApplyLog || [];
    st.minimized = !!hhmAutoMin;
    if (hhmAutoDraft && hhmAutoDraft.key === searchKey() && Date.now() - hhmAutoDraft.ts < 24 * 60 * 60 * 1000 && Array.isArray(hhmAutoDraft.items)) {
      st.items = hhmAutoDraft.items.filter((it) => it && it.id && it.title).map((it) => ({
        ...it,
        matched: Array.isArray(it.matched) ? it.matched : [],
        missing: Array.isArray(it.missing) ? it.missing : [],
        checked: it.checked !== false,
        status: ['sending', 'captcha'].includes(it.status) ? '' : (it.status || '')
      }));
      st.found = st.items.length;
      if (st.items.length) st.phase = `Восстановлен список: ${st.items.length} вакансий.`;
    }
  }
  const saveSettings = () => chrome.storage.local.set({ hhmAuto: st.settings });
  const saveDraft = async () => {
    try {
      await chrome.storage.local.set({ hhmAutoDraft: { key: searchKey(), ts: Date.now(), items: st.items } });
    } catch (_) { /* сохранение черновика не должно останавливать поиск или отклики */ }
  };
  async function clearDraft() {
    st.items = [];
    st.found = 0;
    st.phase = 'Сохранённый список очищен.';
    await chrome.storage.local.remove('hhmAutoDraft');
    render();
  }
  async function addLog(entry) {
    st.log.unshift({ ts: Date.now(), ...entry });
    st.log = st.log.slice(0, 1000);
    await chrome.storage.local.set({ hhmApplyLog: st.log });
  }
  const sentToday = () => st.log.filter((l) => l.status === 'sent' && new Date(l.ts).toDateString() === todayKey()).length;
  const doneIds = () => new Set(st.log.filter((l) => ['sent', 'already', 'test'].includes(l.status)).map((l) => String(l.id)));

  // ---------- резюме ----------
  async function getResumes() {
    let { hhmHh } = await chrome.storage.local.get('hhmHh');
    const stale = !hhmHh || !hhmHh.list || !hhmHh.list.length || Date.now() - (hhmHh.syncedAt || 0) > 30 * 60 * 1000;
    if (stale) {
      st.phase = 'Обновляю резюме с hh…'; renderStatus();
      try {
        const list = await window.HHSync.syncResumes();
        hhmHh = { list, syncedAt: Date.now(), error: '' };
        await chrome.storage.local.set({ hhmHh });
      } catch (e) {
        if (!hhmHh) throw e;
      }
    }
    // Откликнуться можно только резюме с hh (у ручного нет id на hh)
    return (hhmHh.list || []).filter((r) => r.text && r.source === 'hh').map((r) => ({
      ...r, years: (window.HHM.resumeYears(r.text) || {}).years
    }));
  }

  // ---------- выдача ----------
  function pageUrl(n) {
    const u = new URL(location.href);
    u.searchParams.set('page', String(n));
    return u.pathname + u.search;
  }

  function parseSearch(doc) {
    const out = [];
    const seen = new Set();
    let cards = Array.from(doc.querySelectorAll('[data-qa="vacancy-serp__vacancy"]'));
    if (!cards.length) cards = Array.from(doc.querySelectorAll('a[href*="/vacancy/"]')).map((a) => a.closest('div') || a);
    for (const card of cards) {
      const a = card.querySelector('a[data-qa="serp-item__title"]') || card.querySelector('a[href*="/vacancy/"]') || (card.matches && card.matches('a') ? card : null);
      const m = a && (a.getAttribute('href') || '').match(/\/vacancy\/(\d+)/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const expEl = card.querySelector('[data-qa^="vacancy-serp__vacancy-work-experience-"]');
      const expId = expEl ? expEl.getAttribute('data-qa').replace('vacancy-serp__vacancy-work-experience-', '') : null;
      const company = card.querySelector('[data-qa="vacancy-serp__vacancy-employer"]');
      out.push({
        id: m[1],
        title: (a.textContent || '').trim(),
        company: company ? company.textContent.trim() : '',
        expId,
        appliedOnCard: /вы откликнулись|отклик отправлен|резюме доставлено/i.test(card.textContent || '')
      });
    }
    return out;
  }

  function stopWordHit(text) {
    const words = st.settings.stopWords.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
    const t = String(text || '').toLowerCase();
    return words.find((w) => t.includes(w)) || null;
  }

  // ---------- капча ----------
  // Капчу решаете вы сами: расширение показывает страницу hh во встроенном окне поверх поиска
  // и ждёт, пока вы пройдёте проверку и нажмёте «Готово».
  function looksLikeCaptcha(html, url) {
    if (/captcha/i.test(url || '')) return true;
    const d = new DOMParser().parseFromString(html, 'text/html');
    const hasCaptcha = d.querySelector('form[action*="captcha"], img[src*="captcha"], [data-qa*="captcha"], iframe[src*="captcha"]');
    const hasContent = d.querySelector('[data-qa="vacancy-title"], [data-qa="vacancy-serp__vacancy"]');
    return !!hasCaptcha && !hasContent;
  }

  let captchaResolve = null;
  const baseTitle = document.title;
  function askCaptcha(url, note, item) {
    st.captcha = { url, note, item };
    document.title = '⚠ Нужна проверка hh — ' + baseTitle;
    renderCaptcha();
    return new Promise((res) => { captchaResolve = res; });
  }
  function closeCaptcha(result) {
    st.captcha = null;
    document.title = baseTitle;
    renderCaptcha();
    const r = captchaResolve;
    captchaResolve = null;
    if (r) r(result);
  }

  // Загрузка страницы hh; если вместо неё капча — просим пройти проверку и повторяем
  async function fetchHtml(url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(url, { credentials: 'include' });
      const html = await r.text();
      if (!looksLikeCaptcha(html, r.url)) return r.ok ? html : null;
      const a = await askCaptcha(r.url || url, 'hh попросил проверку, что вы не робот. Пройдите её в окне ниже и нажмите «Готово».');
      if (a === 'stop') { st.stop = true; return null; }
      if (a === 'skip') return null;
    }
    return null;
  }

  // ---------- оценка одной вакансии ----------
  async function evaluate(card, resumes) {
    const html = await fetchHtml(`/vacancy/${card.id}`);
    if (!html) return { skip: 'страница вакансии не загрузилась' };
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const vac = window.HHVacancy.parse(doc);
    if (vac.applied) return { skip: 'уже откликались', already: true };
    if (vac.archived) return { skip: 'вакансия в архиве' };
    const sw = stopWordHit(`${vac.title} ${vac.company || card.company}`);
    if (sw) return { skip: `стоп-слово «${sw}»` };

    let results = resumes.map((res) => ({ res, m: window.HHM.match(res.text, vac) }));
    if (st.settings.requireExpFit) results = results.filter((x) => x.m.experienceFit !== false);
    if (!results.length) return { skip: 'опыт не соответствует фильтру' };
    results.sort((a, b) => b.m.total - a.m.total);
    const best = results[0];
    const skills = best.m.criteria.find((c) => c.key === 'skills') || {};
    const item = {
      id: card.id,
      title: vac.title || card.title,
      company: vac.company || card.company,
      resumeId: best.res.id,
      resumeTitle: best.res.title,
      score: best.m.total,
      matched: (skills.matched || []).map((s) => s.name),
      missing: (skills.missing || []).map((s) => s.name),
      checked: true,
      status: '',
      detail: ''
    };
    if (best.m.total < st.settings.threshold) return { skip: `совпадение ${best.m.total}% ниже порога`, item };
    return { item };
  }

  function buildLetter(it) {
    if (!st.settings.letterOn) return '';
    const tech = it.matched.slice(0, 5).join(', ') || 'нужным стеком';
    return st.settings.letter
      .replace(/\{вакансия\}/g, it.title)
      .replace(/\{компания\}/g, it.company || 'вашей компании')
      .replace(/\{технологии\}/g, tech)
      .replace(/\{резюме\}/g, it.resumeTitle);
  }

  // Возвращает false, если дальше отправлять нельзя (лимит, капча, повторные ошибки)
  let errorsInRow = 0;
  async function applyOne(it) {
    if (sentToday() >= st.settings.dailyLimit) {
      st.phase = `Достигнут ваш суточный лимит (${st.settings.dailyLimit}). Остановлено.`;
      return false;
    }
    it.status = 'sending'; renderList();
    const send = () => window.HHApply.respond({ vacancyId: it.id, resumeHash: it.resumeId, letter: buildLetter(it) });
    let res = await send();
    for (let tries = 0; res.status === 'captcha' && tries < 3; tries++) {
      it.status = 'captcha'; renderList();
      const a = await askCaptcha(`/vacancy/${it.id}`,
        `hh попросил проверку. В окне ниже нажмите «Откликнуться», выберите резюме «${it.resumeTitle}», при желании вставьте письмо и пройдите капчу. Затем нажмите «Готово».`, it);
      if (a === 'stop') { st.stop = true; res = { ok: false, status: 'skipped', detail: 'остановлено на капче' }; break; }
      if (a === 'skip') { res = { ok: false, status: 'skipped', detail: 'пропущено на капче' }; break; }
      // Проверяем, ушёл ли отклик через окно hh; если нет — пробуем отправить ещё раз
      const html = await fetchHtml(`/vacancy/${it.id}`);
      const v = html && window.HHVacancy.parse(new DOMParser().parseFromString(html, 'text/html'));
      if (v && v.applied) { res = { ok: true, status: 'sent', detail: 'отклик отправлен через окно hh' }; break; }
      res = await send();
    }
    it.status = res.status;
    it.detail = res.detail;
    await addLog({ id: it.id, title: it.title, company: it.company, resumeTitle: it.resumeTitle, score: it.score, status: res.status, detail: res.detail, raw: res.raw });
    await saveDraft();
    if (res.ok) { st.sent++; errorsInRow = 0; }
    renderList(); renderStatus();
    if (res.status === 'limit' || res.status === 'captcha') { st.phase = res.detail + '. Остановлено.'; return false; }
    if (st.stop) return false;
    if (res.status === 'error' && ++errorsInRow >= 2) {
      st.phase = 'Две ошибки hh подряд — остановлено. Детали в журнале.';
      return false;
    }
    if (res.status !== 'error') errorsInRow = res.ok ? 0 : errorsInRow;
    return true;
  }

  async function delayBetweenApplies() {
    const sec = rand(st.settings.delayMin, Math.max(st.settings.delayMin, st.settings.delayMax));
    st.phase = `Пауза ${Math.round(sec)} с перед следующим откликом…`; renderStatus();
    return sleepStoppable(sec * 1000);
  }

  // ---------- основной проход ----------
  async function run() {
    if (st.running) return;
    const auto = st.settings.mode === 'auto';
    if (auto && !confirm(`Автоматически откликаться на вакансии с совпадением от ${st.settings.threshold}%?\nЛимит на сегодня: ${st.settings.dailyLimit} (уже отправлено ${sentToday()}).`)) return;
    Object.assign(st, { running: true, stop: false, checked: 0, found: 0, sent: 0, items: [], phase: '' });
    await saveDraft();
    errorsInRow = 0;
    render();
    try {
      const resumes = await getResumes();
      if (!resumes.length) throw new Error('Нет прочитанных резюме с hh. Откройте вакансию, чтобы расширение их подтянуло.');
      st.resumesNote = `Резюме: ${resumes.length}`;
      const done = doneIds();
      let lastApply = 0;
      outer:
      for (let p = 0; p < st.settings.maxPages; p++) {
        st.phase = `Читаю страницу выдачи ${p + 1}…`; renderStatus();
        const html = await fetchHtml(pageUrl(p));
        if (!html) break;
        const cards = parseSearch(new DOMParser().parseFromString(html, 'text/html'));
        if (!cards.length) break;
        for (const card of cards) {
          if (st.stop) break outer;
          if (done.has(card.id) || card.appliedOnCard) continue;
          if (stopWordHit(`${card.title} ${card.company}`)) continue;
          // Быстрый фильтр по опыту прямо из карточки — без загрузки вакансии
          if (st.settings.requireExpFit && card.expId && !resumes.some((r) => window.HHM.experienceFits(card.expId, r.years) !== false)) {
            st.checked++; renderStatus(); continue;
          }
          st.phase = `Проверяю: ${card.title}`; renderStatus();
          let ev;
          try { ev = await evaluate(card, resumes); } catch (e) { ev = { skip: String(e.message || e) }; }
          st.checked++;
          if (ev.already) await addLog({ id: card.id, title: card.title, company: card.company, status: 'already', detail: ev.skip });
          if (ev.item && !ev.skip) {
            st.found++;
            st.items.push(ev.item);
            renderList();
            updateSelectionUi();
            await saveDraft();
            if (auto) {
              if (lastApply && !(await delayBetweenApplies())) break outer;
              if (!(await applyOne(ev.item))) { st.stop = true; break outer; }
              lastApply = Date.now();
            }
          }
          renderStatus();
          if (!(await sleepStoppable(rand(800, 1600)))) break outer; // бережно к hh
        }
      }
      if (!st.phase.includes('Остановлено')) {
        st.phase = st.stop ? 'Остановлено.' : auto
          ? `Готово. Отправлено откликов: ${st.sent}.`
          : `Готово. Подходящих вакансий: ${st.found}. Снимите лишние галочки и нажмите «Откликнуться».`;
      }
    } catch (e) {
      st.phase = 'Ошибка: ' + (e.message || e);
    }
    st.running = false;
    await saveDraft();
    render();
  }

  async function applySelected() {
    if (st.running) return;
    const todo = st.items.filter((i) => i.checked && !['sent', 'already', 'test'].includes(i.status));
    if (!todo.length) return;
    Object.assign(st, { running: true, stop: false, sent: 0 });
    errorsInRow = 0;
    render();
    for (let k = 0; k < todo.length; k++) {
      if (st.stop) break;
      if (k > 0 && !(await delayBetweenApplies())) break;
      st.phase = `Отправляю ${k + 1} из ${todo.length}…`; renderStatus();
      if (!(await applyOne(todo[k]))) break;
    }
    if (!st.phase.includes('Остановлено')) st.phase = st.stop ? 'Остановлено.' : `Готово. Отправлено откликов: ${st.sent}.`;
    st.running = false;
    await saveDraft();
    render();
  }

  // ---------- интерфейс ----------
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .p {
      --ink: #1b2436; --muted: #5d6679; --line: #e3e7ef; --bg: #fff; --soft: #f5f7fb;
      --good: #1e7f55; --mid: #b86e0b; --bad: #b33a2e; --accent: #2d4bd1;
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; width: 380px;
      max-height: calc(100vh - 32px); display: flex; flex-direction: column;
      background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 12px;
      box-shadow: 0 12px 32px rgba(27,36,54,.16);
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    }
    .p.min { width: auto; border-radius: 999px; cursor: pointer; }
    .pill { padding: 8px 14px; font-weight: 700; }
    .top { display: flex; align-items: center; gap: 8px; padding: 12px 14px 8px; }
    .top h2 { margin: 0; font-size: 15px; flex: 1; }
    button { font: inherit; cursor: pointer; }
    button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .x { border: 0; background: none; color: var(--muted); width: 26px; height: 26px; border-radius: 6px; font-size: 16px; }
    .x:hover { background: var(--soft); }
    .seg { display: flex; margin: 0 14px 8px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .seg button { flex: 1; border: 0; background: var(--bg); padding: 7px 0; color: var(--muted); font-weight: 600; }
    .seg button[aria-pressed="true"] { background: var(--accent); color: #fff; }
    .seg button:disabled { cursor: default; }
    .hint { margin: 0 14px 8px; color: var(--muted); font-size: 12px; }
    details.rules { margin: 0 14px 8px; border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
    details.rules summary { cursor: pointer; font-weight: 600; }
    .grid { display: grid; grid-template-columns: 1fr auto; gap: 6px 10px; align-items: center; margin-top: 8px; }
    .grid label { color: var(--ink); }
    .grid input[type=number] { width: 70px; padding: 4px 6px; border: 1px solid var(--line); border-radius: 6px; font: inherit; }
    .full { grid-column: 1 / -1; }
    .full input[type=text], .full textarea { width: 100%; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; font: inherit; }
    .full textarea { height: 80px; resize: vertical; }
    .small { font-size: 11.5px; color: var(--muted); }
    .actions { display: flex; gap: 8px; padding: 0 14px 8px; }
    .primary { flex: 1; border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 8px; padding: 9px 12px; font-weight: 600; }
    .primary:disabled { opacity: .5; cursor: default; }
    .ghost { border: 1px solid var(--line); background: var(--bg); color: var(--ink); border-radius: 8px; padding: 9px 12px; font-weight: 600; }
    .status { padding: 0 14px 8px; font-size: 12px; color: var(--muted); }
    .status b { color: var(--ink); font-variant-numeric: tabular-nums; }
    .bulk { display: flex; align-items: center; gap: 8px; padding: 0 14px 8px; color: var(--muted); font-size: 12px; }
    .bulk span { margin-right: auto; }
    .bulk button { border: 0; background: none; padding: 2px 0; color: var(--accent); font-size: 12px; }
    .bulk button:hover { text-decoration: underline; }
    .bulk button:disabled { color: var(--muted); cursor: default; text-decoration: none; }
    .bulk .clear { color: var(--bad); }
    .list { list-style: none; margin: 0; padding: 0 8px; overflow: auto; flex: 1; min-height: 0; border-top: 1px solid var(--line); }
    .it { display: flex; gap: 8px; padding: 8px 6px; border-bottom: 1px solid var(--line); align-items: flex-start; }
    .it input { margin-top: 3px; accent-color: var(--accent); }
    .sc { flex: none; width: 40px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .bd { flex: 1; min-width: 0; }
    .bd a { color: var(--ink); font-weight: 600; text-decoration: none; }
    .bd a:hover { text-decoration: underline; }
    .meta { font-size: 11.5px; color: var(--muted); }
    .miss { font-size: 11.5px; color: var(--bad); }
    .stt { font-size: 11.5px; font-weight: 600; margin-top: 2px; }
    .stt.sent { color: var(--good); } .stt.sending { color: var(--accent); }
    .stt.error, .stt.limit, .stt.captcha { color: var(--bad); } .stt.test, .stt.letter, .stt.already { color: var(--mid); }
    .bottom { padding: 8px 14px 12px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
    .bottom details summary { cursor: pointer; }
    .log { max-height: 160px; overflow: auto; margin-top: 6px; }
    .log div { padding: 3px 0; border-bottom: 1px dashed var(--line); }
    .empty { padding: 10px 6px; color: var(--muted); font-size: 12px; }
    .cap { position: fixed; inset: 0; z-index: 2147483001; background: rgba(27,36,54,.45); display: flex; align-items: center; justify-content: center;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #1b2436; }
    .cap-box { width: min(1000px, 96vw); height: min(820px, 92vh); background: #fff; border-radius: 12px; display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 16px 48px rgba(27,36,54,.3); }
    .cap-head { padding: 12px 16px; border-bottom: 1px solid #e3e7ef; display: flex; flex-direction: column; gap: 2px; }
    .cap-head b { font-size: 15px; }
    .cap-note { color: #5d6679; }
    .cap iframe { flex: 1; width: 100%; border: 0; }
    .cap-blocked { padding: 10px 16px; background: #fdf4f3; color: #b33a2e; }
    .cap-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 16px; border-top: 1px solid #e3e7ef; }
    .cap-actions .primary { flex: 0 0 auto; border: 1px solid #2d4bd1; background: #2d4bd1; color: #fff; border-radius: 8px; padding: 9px 14px; font-weight: 600; }
    .cap-actions .ghost { border: 1px solid #e3e7ef; background: #fff; color: #1b2436; border-radius: 8px; padding: 9px 12px; font-weight: 600; }
  `;

  let host, root;
  function ensureHost() {
    if (host && document.body.contains(host)) return;
    host = document.createElement('div');
    host.id = 'hhm-auto';
    root = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
  }

  const color = (n) => (n >= 70 ? 'var(--good)' : n >= 40 ? 'var(--mid)' : 'var(--bad)');
  const STATUS_TEXT = { sent: 'Отклик отправлен', sending: 'Отправляю…', already: 'Уже откликались', test: 'Нужен тест — откликнитесь вручную', letter: 'Нужно письмо — включите шаблон письма', limit: 'Лимит hh', captcha: 'Ждёт проверки hh', skipped: 'Пропущено', error: 'Ошибка' };

  function render() {
    const view = root ? {
      scrollTop: root.getElementById('list')?.scrollTop || 0,
      rulesOpen: !!root.querySelector('details.rules')?.open,
      logOpen: !!root.querySelector('.bottom details')?.open
    } : null;
    ensureHost();
    const s = st.settings;
    if (st.minimized) {
      root.innerHTML = `<style>${CSS}</style><div class="p min" role="button" tabindex="0" id="expand"><div class="pill">Автоотклики${st.running ? ' — работают' : ''}</div></div>`;
      const ex = root.getElementById('expand');
      const open = () => { st.minimized = false; chrome.storage.local.set({ hhmAutoMin: false }); render(); };
      ex.addEventListener('click', open);
      ex.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      return;
    }
    const auto = s.mode === 'auto';
    const dis = st.running ? 'disabled' : '';
    const selected = st.items.filter((i) => i.checked && !['sent', 'already', 'test'].includes(i.status)).length;
    root.innerHTML = `<style>${CSS}</style>
    <div class="p" role="region" aria-label="Автоотклики">
      <div class="top"><h2>Автоотклики</h2><button class="x" id="min" aria-label="Свернуть">–</button></div>
      <div class="seg" role="group" aria-label="Режим">
        <button id="m-semi" aria-pressed="${!auto}" ${dis}>Полуавтомат</button>
        <button id="m-auto" aria-pressed="${auto}" ${dis}>Автомат</button>
      </div>
      <p class="hint">${auto
        ? 'Откликается сразу на подходящие вакансии из этого поиска, с паузами и лимитом.'
        : 'Соберёт подходящие вакансии из этого поиска. Вы отметите нужные и отправите отклики.'}</p>
      <details class="rules">
        <summary>Правила отбора</summary>
        <div class="grid">
          <label for="thr">Совпадение не ниже, %</label><input id="thr" type="number" min="0" max="100" value="${s.threshold}" ${dis}>
          <label for="exp" class="full"><input id="exp" type="checkbox" ${s.requireExpFit ? 'checked' : ''} ${dis}> Только если опыт соответствует фильтру</label>
          <div class="full"><label for="sw">Стоп-слова в названии или компании</label>
            <input id="sw" type="text" placeholder="стажер, 1С, Компания" value="${esc(s.stopWords)}" ${dis}></div>
          <label for="pg">Страниц выдачи проверить</label><input id="pg" type="number" min="1" max="40" value="${s.maxPages}" ${dis}>
          <label for="lim">Откликов в день, не больше</label><input id="lim" type="number" min="1" max="200" value="${s.dailyLimit}" ${dis}>
          <label for="dmin">Пауза между откликами, с</label>
          <span><input id="dmin" type="number" min="5" max="600" value="${s.delayMin}" ${dis}> – <input id="dmax" type="number" min="5" max="600" value="${s.delayMax}" ${dis}></span>
          <label for="lon" class="full"><input id="lon" type="checkbox" ${s.letterOn ? 'checked' : ''} ${dis}> Добавлять сопроводительное письмо</label>
          <div class="full"><textarea id="ltr" ${dis} aria-label="Шаблон письма">${esc(s.letter)}</textarea>
            <div class="small">Подстановки: {вакансия}, {компания}, {технологии}, {резюме}</div></div>
        </div>
      </details>
      <div class="actions">
        ${st.running
          ? '<button class="primary" id="stop">Остановить</button>'
          : `<button class="primary" id="go">${auto ? 'Запустить автоотклики' : 'Найти подходящие'}</button>
             ${!auto ? `<button class="ghost" id="apply" ${selected ? '' : 'hidden'}>Откликнуться (${selected})</button>` : ''}`}
      </div>
      <div class="status" id="status"></div>
      <div class="bulk" id="bulk" ${auto || !st.items.length ? 'hidden' : ''}>
        <span id="selected-count"></span>
        <button id="select-all" type="button" ${dis}>Выбрать все</button>
        <button id="select-none" type="button" ${dis}>Снять все</button>
        <button id="clear-results" class="clear" type="button" ${dis}>Очистить</button>
      </div>
      <ul class="list" id="list"></ul>
      <div class="bottom" id="bottom"></div>
    </div>`;
    bind();
    renderStatus();
    renderList();
    updateSelectionUi();
    renderBottom();
    renderCaptcha();
    if (view) {
      const list = root.getElementById('list');
      const rules = root.querySelector('details.rules');
      const log = root.querySelector('.bottom details');
      if (list) list.scrollTop = view.scrollTop;
      if (rules) rules.open = view.rulesOpen;
      if (log) log.open = view.logOpen;
    }
  }

  function renderStatus() {
    const el = root && root.getElementById('status');
    if (!el) return;
    el.innerHTML = `${esc(st.phase || 'Настройте фильтры поиска hh, затем запустите.')}
      ${st.checked || st.found ? `<br>Проверено <b>${st.checked}</b>, подходит <b>${st.found}</b>, отправлено <b>${st.sent}</b>` : ''}`;
    renderBottom();
  }

  function renderList() {
    const el = root && root.getElementById('list');
    if (!el) return;
    const scrollTop = el.scrollTop;
    if (!st.items.length) { el.innerHTML = ''; return; }
    const semi = st.settings.mode === 'semi';
    el.innerHTML = st.items.map((it, i) => `<li class="it">
      ${semi ? `<input type="checkbox" data-i="${i}" ${it.checked ? 'checked' : ''} ${st.running || ['sent', 'already', 'test'].includes(it.status) ? 'disabled' : ''} aria-label="Откликнуться на ${esc(it.title)}">` : ''}
      <span class="sc" style="color:${color(it.score)}">${it.score}%</span>
      <div class="bd">
        <a href="/vacancy/${it.id}" target="_blank">${esc(it.title)}</a>
        <div class="meta">${esc(it.company)}${it.company ? ', ' : ''}резюме «${esc(it.resumeTitle)}»</div>
        ${it.missing.length ? `<div class="miss">Не хватает: ${esc(it.missing.slice(0, 5).join(', '))}</div>` : ''}
        ${it.status ? `<div class="stt ${it.status}">${esc(STATUS_TEXT[it.status] || it.status)}${it.status === 'error' ? ': ' + esc(it.detail) : ''}</div>` : ''}
      </div></li>`).join('');
    el.querySelectorAll('input[data-i]').forEach((cb) => cb.addEventListener('change', () => {
      st.items[+cb.dataset.i].checked = cb.checked;
      updateSelectionUi();
      void saveDraft();
    }));
    el.scrollTop = scrollTop;
  }

  function updateSelectionUi() {
    if (!root) return;
    const semi = st.settings.mode === 'semi';
    const available = st.items.filter((i) => !['sent', 'already', 'test'].includes(i.status));
    const selected = available.filter((i) => i.checked).length;
    const bulk = root.getElementById('bulk');
    if (bulk) bulk.hidden = !semi || !st.items.length;
    const count = root.getElementById('selected-count');
    if (count) count.textContent = `Выбрано ${selected} из ${available.length}`;
    const apply = root.getElementById('apply');
    if (apply) {
      apply.hidden = !selected;
      apply.textContent = `Откликнуться (${selected})`;
    }
  }

  function renderBottom() {
    const el = root && root.getElementById('bottom');
    if (!el) return;
    const recent = st.log.slice(0, 30);
    el.innerHTML = `Сегодня отправлено: ${sentToday()} из ${st.settings.dailyLimit}
      ${recent.length ? `<details><summary>Журнал</summary><div class="log">${recent.map((l) =>
        `<div>${new Date(l.ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}:
          ${esc(STATUS_TEXT[l.status] || l.status)}, ${l.score != null ? l.score + '%, ' : ''}<a href="/vacancy/${l.id}" target="_blank">${esc(l.title)}</a>
          ${l.raw ? `<div class="small">${esc(l.raw)}</div>` : ''}</div>`).join('')}</div></details>` : ''}`;
  }

  function renderCaptcha() {
    if (!root) return;
    let wrap = root.getElementById('capwrap');
    if (!st.captcha) { if (wrap) wrap.remove(); return; }
    if (wrap && wrap.dataset.url === st.captcha.url) return; // уже показано
    if (wrap) wrap.remove();
    wrap = document.createElement('div');
    wrap.id = 'capwrap';
    wrap.dataset.url = st.captcha.url;
    const it = st.captcha.item;
    wrap.innerHTML = `<div class="cap" role="dialog" aria-modal="true" aria-label="Проверка hh">
      <div class="cap-box">
        <div class="cap-head">
          <b>Нужна проверка hh</b>
          <span class="cap-note">${esc(st.captcha.note)}</span>
        </div>
        <iframe id="capframe" src="${esc(st.captcha.url)}" title="Страница hh с проверкой"></iframe>
        <div class="cap-blocked" id="capblocked" hidden>hh не даёт показать страницу внутри окна. Нажмите «Открыть в отдельном окне», пройдите проверку там и вернитесь сюда.</div>
        <div class="cap-actions">
          <button class="primary" id="capdone">Готово, продолжить</button>
          ${it && st.settings.letterOn ? '<button class="ghost" id="capletter">Скопировать письмо</button>' : ''}
          <button class="ghost" id="capwin">Открыть в отдельном окне</button>
          <button class="ghost" id="capskip">Пропустить</button>
          <button class="ghost" id="capstop">Остановить</button>
        </div>
      </div></div>`;
    root.appendChild(wrap);
    const f = root.getElementById('capframe');
    f.addEventListener('load', () => {
      let ok = false;
      try { ok = !!(f.contentDocument && f.contentDocument.body && f.contentDocument.body.childElementCount); } catch (_) { ok = false; }
      root.getElementById('capblocked').hidden = ok;
    });
    root.getElementById('capdone').addEventListener('click', () => closeCaptcha('done'));
    root.getElementById('capskip').addEventListener('click', () => closeCaptcha('skip'));
    root.getElementById('capstop').addEventListener('click', () => closeCaptcha('stop'));
    root.getElementById('capwin').addEventListener('click', () => {
      window.open(st.captcha.url, 'hhm_captcha', 'width=1000,height=800');
    });
    const cl = root.getElementById('capletter');
    if (cl) cl.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(buildLetter(it)); cl.textContent = 'Скопировано'; } catch (_) { cl.textContent = 'Не удалось скопировать'; }
    });
    root.getElementById('capdone').focus();
  }

  function bind() {
    const $ = (id) => root.getElementById(id);
    $('min').addEventListener('click', () => { st.minimized = true; chrome.storage.local.set({ hhmAutoMin: true }); render(); });
    $('m-semi').addEventListener('click', () => { st.settings.mode = 'semi'; saveSettings(); render(); });
    $('m-auto').addEventListener('click', () => { st.settings.mode = 'auto'; saveSettings(); render(); });
    const num = (id, key, min, max) => $(id) && $(id).addEventListener('change', (e) => {
      const v = Math.max(min, Math.min(max, parseInt(e.target.value, 10) || min));
      st.settings[key] = v; e.target.value = v; saveSettings(); renderBottom();
    });
    num('thr', 'threshold', 0, 100);
    num('pg', 'maxPages', 1, 40);
    num('lim', 'dailyLimit', 1, 200);
    num('dmin', 'delayMin', 5, 600);
    num('dmax', 'delayMax', 5, 600);
    $('exp').addEventListener('change', (e) => { st.settings.requireExpFit = e.target.checked; saveSettings(); });
    $('lon').addEventListener('change', (e) => { st.settings.letterOn = e.target.checked; saveSettings(); });
    $('sw').addEventListener('change', (e) => { st.settings.stopWords = e.target.value; saveSettings(); });
    $('ltr').addEventListener('change', (e) => { st.settings.letter = e.target.value; saveSettings(); });
    if ($('go')) $('go').addEventListener('click', run);
    if ($('stop')) $('stop').addEventListener('click', () => { st.stop = true; st.phase = 'Останавливаю…'; renderStatus(); if (captchaResolve) closeCaptcha('stop'); });
    if ($('apply')) $('apply').addEventListener('click', applySelected);
    if ($('select-all')) $('select-all').addEventListener('click', () => {
      st.items.forEach((it) => { if (!['sent', 'already', 'test'].includes(it.status)) it.checked = true; });
      renderList(); updateSelectionUi(); void saveDraft();
    });
    if ($('select-none')) $('select-none').addEventListener('click', () => {
      st.items.forEach((it) => { if (!['sent', 'already', 'test'].includes(it.status)) it.checked = false; });
      renderList(); updateSelectionUi(); void saveDraft();
    });
    if ($('clear-results')) $('clear-results').addEventListener('click', () => {
      if (confirm('Очистить найденные вакансии?')) void clearDraft();
    });
  }

  load().then(render);
})();
