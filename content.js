// Content script: собирает данные вакансии на hh и показывает панель совпадения.
(function () {
  'use strict';
  if (window.__hhmLoaded) return;
  window.__hhmLoaded = true;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const text = (el) => (el ? el.innerText || el.textContent || '' : '').trim();
  const stripHtml = (html) => {
    const d = document.createElement('div');
    d.innerHTML = String(html || '').replace(/<(br|\/p|\/li|\/div|\/h\d)[^>]*>/gi, '\n$&');
    return d.textContent || '';
  };

  function vacancyId() {
    const m = location.pathname.match(/\/vacancy\/(\d+)/);
    return m ? m[1] : null;
  }

  // ---------- данные вакансии ----------
  function fromApi(d) {
    return {
      source: 'API hh.ru',
      title: d.name || '',
      keySkills: (d.key_skills || []).map((k) => k.name),
      description: stripHtml(d.description),
      experienceId: d.experience && d.experience.id,
      languages: (d.languages || []).map((l) => ({
        name: l.name,
        code: l.id,
        level: { a1: 1, a2: 2, b1: 3, b2: 4, c1: 5, c2: 6, l1: 6 }[l.level && l.level.id] || 3
      }))
    };
  }

  function fromDom() {
    return window.HHVacancy.parse(document);
  }

  function loadVacancy(id) {
    // Публичное API hh сейчас отвечает 403, поэтому сначала читаем страницу, API — запасной вариант
    const dom = fromDom();
    if (dom.title && dom.description.length > 200) return Promise.resolve(dom);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'fetchVacancy', id }, (res) => {
          if (chrome.runtime.lastError || !res || !res.ok) return resolve(fromDom());
          const v = fromApi(res.data);
          // Если API отдало пустое описание, добираем со страницы
          if (!v.description) v.description = fromDom().description;
          resolve(v);
        });
      } catch (e) {
        resolve(fromDom());
      }
    });
  }

  // ---------- панель ----------
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .p {
      --ink: #1b2436; --muted: #5d6679; --line: #e3e7ef; --bg: #ffffff; --soft: #f5f7fb;
      --good: #1e7f55; --mid: #b86e0b; --bad: #b33a2e; --accent: #2d4bd1;
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      width: 348px; max-height: calc(100vh - 32px); overflow: auto;
      background: var(--bg); color: var(--ink);
      border: 1px solid var(--line); border-radius: 12px;
      box-shadow: 0 12px 32px rgba(27, 36, 54, .16);
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    }
    .p.min { width: auto; overflow: hidden; border-radius: 999px; cursor: pointer; }
    .head { display: flex; align-items: flex-start; gap: 12px; padding: 14px 14px 10px; }
    .score { font-size: 40px; font-weight: 700; line-height: 1; letter-spacing: -1px; font-variant-numeric: tabular-nums; }
    .score small { font-size: 18px; font-weight: 600; margin-left: 1px; }
    .verdict { font-weight: 600; font-size: 14px; margin-top: 2px; }
    .src { color: var(--muted); font-size: 11.5px; margin-top: 2px; }
    .grow { flex: 1; min-width: 0; }
    button.x {
      border: 0; background: transparent; color: var(--muted); cursor: pointer;
      width: 26px; height: 26px; border-radius: 6px; font-size: 16px; line-height: 1;
    }
    button.x:hover { background: var(--soft); color: var(--ink); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .rows { padding: 2px 14px 6px; }
    .row { padding: 8px 0; border-top: 1px solid var(--line); }
    .row-top { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; }
    .row-top .pct { font-variant-numeric: tabular-nums; }
    .bar { height: 4px; background: var(--soft); border-radius: 2px; margin: 5px 0 4px; overflow: hidden; }
    .bar i { display: block; height: 100%; border-radius: 2px; }
    .note { color: var(--muted); font-size: 12px; }
    .na .row-top { color: var(--muted); font-weight: 500; }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .chip { font-size: 11.5px; padding: 2px 7px; border-radius: 5px; border: 1px solid; white-space: nowrap; }
    .chip.ok { color: var(--good); border-color: #bfe0d0; background: #f1faf5; }
    .chip.no { color: var(--bad); border-color: #efc9c4; background: #fdf4f3; }
    .chip.text { border-style: dashed; }
    .sub { font-size: 11.5px; color: var(--muted); margin-top: 8px; }
    .reqs { list-style: none; margin: 4px 0 0; padding: 0; }
    .req { display: flex; gap: 8px; padding: 5px 0; font-size: 12px; }
    .req + .req { border-top: 1px dashed var(--line); }
    .mark { flex: none; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; }
    .req.ok .mark { background: var(--good); }
    .req.partial .mark { background: var(--mid); }
    .req.miss .mark { background: var(--bad); }
    .req-text { color: var(--ink); }
    .req.ok .req-text { color: var(--muted); }
    .req-miss { color: var(--muted); margin-top: 2px; }
    .req-miss b { color: var(--bad); font-weight: 600; }
    details { margin-top: 8px; }
    summary { cursor: pointer; font-size: 11.5px; color: var(--muted); }
    summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .chip.opt { color: var(--muted); border-color: var(--line); background: var(--bg); border-style: dashed; }
    .chip.opt.has { color: var(--good); }
    .flag { display: inline-block; margin-top: 6px; padding: 2px 8px; border-radius: 5px; font-size: 12px; font-weight: 600;
      color: var(--bad); background: #fdf4f3; border: 1px solid #efc9c4; }
    .flag.sm { display: inline-block; margin-top: 3px; font-size: 11px; padding: 1px 6px; font-weight: 600; }
    .foot { padding: 8px 14px 12px; color: var(--muted); font-size: 11.5px; border-top: 1px solid var(--line); }
    .pill { display: flex; align-items: center; gap: 8px; padding: 8px 14px; font-weight: 700; font-size: 15px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; }
    .empty { padding: 14px; }
    .empty p { margin: 0 0 6px; }
    @media (prefers-reduced-motion: no-preference) { .bar i { transition: width .4s ease; } }
    .vac { padding: 14px 14px 10px; display: flex; gap: 8px; align-items: flex-start; }
    .vac-title { font-weight: 600; font-size: 13.5px; }
    .vac .src { margin-top: 1px; }
    .resumes { list-style: none; margin: 0; padding: 0 8px 8px; }
    .res {
      display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
      padding: 8px 8px; border: 1px solid transparent; border-radius: 8px;
      background: transparent; color: var(--ink); cursor: pointer; font: inherit;
    }
    .res:hover { background: var(--soft); }
    .res[aria-pressed="true"] { background: var(--soft); border-color: var(--line); }
    .res-pct { flex: none; width: 46px; font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .res-body { flex: 1; min-width: 0; }
    .res-name { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
    .res-meta { display: block; font-size: 11.5px; color: var(--muted); }
    .best { color: var(--good); font-weight: 600; }
    .res.err .res-pct { color: var(--muted); font-size: 14px; }
    .mini-bar { display: block; height: 3px; background: var(--line); border-radius: 2px; margin-top: 4px; overflow: hidden; }
    .mini-bar i { display: block; height: 100%; }
    .detail-head { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px 6px; border-top: 1px solid var(--line); }
    .sync { padding: 0 14px 8px; font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; gap: 8px; }
    .sync button { border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; padding: 0; }
    .sync .err { color: var(--bad); }
  `;

  const color = (s) => (s >= 0.7 ? 'var(--good)' : s >= 0.4 ? 'var(--mid)' : 'var(--bad)');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const state = {
    minimized: false,
    vacancy: null,
    resumes: [],      // [{id, title, text, source, error?}]
    results: [],      // [{resume, result}] отсортировано по убыванию
    selectedId: null,
    syncing: false,
    syncError: '',
    syncedAt: 0
  };
  let host, shadow;

  function ensureHost() {
    if (host && document.body.contains(host)) return;
    host = document.createElement('div');
    host.id = 'hhm-host';
    shadow = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
  }

  function ago(ts) {
    if (!ts) return 'ещё не обновлялись';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'обновлено только что';
    if (s < 3600) return `обновлено ${Math.round(s / 60)} мин назад`;
    return `обновлено ${new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  }

  function renderRows(result) {
    return result.criteria.map((c) => {
      const na = c.score == null;
      const pct = na ? '—' : Math.round(c.score * 100) + '%';
      let extra = '';
      if (c.key === 'skills' && !na) {
        const chip = (i, cls) => `<span class="chip ${cls} ${i.source === 'text' ? 'text' : ''}" title="${i.source === 'key' ? 'Ключевой навык вакансии' : 'Найдено в описании'}">${esc(i.name)}</span>`;
        if (c.missing.length) extra += `<div class="sub">Не хватает в резюме</div><div class="chips">${c.missing.map((i) => chip(i, 'no')).join('')}</div>`;
        if (c.matched.length) extra += `<div class="sub">Есть в резюме</div><div class="chips">${c.matched.map((i) => chip(i, 'ok')).join('')}</div>`;
      }
      if (c.key === 'skills' && (c.optional || []).length) {
        extra += `<div class="sub">Будет плюсом (не влияет на оценку)</div><div class="chips">${
          c.optional.map((i) => `<span class="chip opt ${i.matched ? 'has' : ''}" title="${i.matched ? 'Есть в резюме' : 'Нет в резюме'}">${i.matched ? '✓ ' : ''}${esc(i.name)}</span>`).join('')}</div>`;
      }
      if (c.key === 'experience' && c.fit === false) extra += `<div class="flag">Не соответствует фильтру по опыту</div>`;
      return `<div class="row ${na ? 'na' : ''}">
        <div class="row-top"><span>${esc(c.label)}</span><span class="pct">${pct}</span></div>
        ${na ? '' : `<div class="bar"><i style="width:${Math.round(c.score * 100)}%;background:${color(c.score)}"></i></div>`}
        <div class="note">${esc(c.note || '')}${na ? ' — не учитывается в оценке' : ''}</div>
        ${extra}
      </div>`;
    }).join('');
  }

  function render() {
    ensureHost();
    const { minimized, vacancy, results, resumes, syncing, syncError } = state;
    let html = `<style>${CSS}</style>`;
    const ok = results.filter((r) => r.result);

    if (!resumes.length) {
      html += `<div class="p"><div class="head"><div class="grow">
          <div class="verdict">${syncing ? 'Загружаю ваши резюме с hh…' : 'Резюме не найдены'}</div>
          <div class="src">${syncing ? '' : esc(syncError || 'Войдите в аккаунт hh или добавьте резюме вручную через значок расширения.')}</div>
        </div><button class="x" data-act="close" aria-label="Закрыть">×</button></div></div>`;
      shadow.innerHTML = html; bind(); return;
    }
    if (!vacancy || !ok.length && syncing) {
      shadow.innerHTML = html + `<div class="p"><div class="empty">Сравниваю резюме с вакансией…</div></div>`;
      return;
    }

    if (!ok.length) {
      const errs = results.map((r) => `${esc(r.resume.title)}: ${esc(r.resume.error || 'нет текста')}`).join('<br>');
      html += `<div class="p"><div class="head"><div class="grow">
          <div class="verdict">Не удалось прочитать резюме</div>
          <div class="src">${errs || esc(syncError)}</div>
        </div><button class="x" data-act="close" aria-label="Закрыть">×</button></div>
        <div class="sync"><span></span><button data-act="sync">Попробовать ещё раз</button></div></div>`;
      shadow.innerHTML = html; bind(); return;
    }
    const best = ok[0];
    const sel = results.find((r) => r.resume.id === state.selectedId && r.result) || best;

    if (minimized) {
      const t = best ? best.result.total : 0;
      html += `<div class="p min" data-act="expand" role="button" tabindex="0" aria-label="Показать детали совпадения">
        <div class="pill"><span class="dot" style="background:${color(t / 100)}"></span>${t}%
        <span style="font-weight:500;font-size:13px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(best ? best.resume.title : '')}</span></div></div>`;
      shadow.innerHTML = html; bind(); return;
    }

    const list = results.map((r) => {
      if (!r.result) {
        return `<li><div class="res err"><span class="res-pct">—</span><span class="res-body">
          <span class="res-name">${esc(r.resume.title)}</span>
          <span class="res-meta">${esc(r.resume.error || 'нет текста')}</span></span></div></li>`;
      }
      const t = r.result.total;
      const isBest = r === best && ok.length > 1;
      const gap = best && r !== best ? `, на ${best.result.total - t} п. ниже лучшего` : '';
      return `<li><button class="res" data-sel="${esc(r.resume.id)}" aria-pressed="${r === sel}">
        <span class="res-pct" style="color:${color(t / 100)}">${t}%</span>
        <span class="res-body">
          <span class="res-name">${esc(r.resume.title)}</span>
          <span class="res-meta">${isBest ? '<span class="best">Лучше всего подходит</span>' : esc(r.result.verdict) + gap}${r.resume.source === 'manual' ? ', добавлено вручную' : ''}</span>
          ${r.result.experienceFit === false ? '<span class="flag sm">Опыт не соответствует фильтру</span>' : ''}
          <span class="mini-bar"><i style="width:${t}%;background:${color(t / 100)}"></i></span>
        </span></button></li>`;
    }).join('');

    const st = sel.result;
    html += `<div class="p" role="region" aria-label="Совпадение резюме с вакансией">
      <div class="vac">
        <div class="grow"><div class="vac-title">${esc(vacancy.title || 'Вакансия')}</div>
        <div class="src">Ваши резюме (${resumes.length}), отсортированы по совпадению</div></div>
        <button class="x" data-act="min" aria-label="Свернуть">–</button>
      </div>
      <ul class="resumes">${list}</ul>
      <div class="sync"><span class="${syncError ? 'err' : ''}">${syncing ? 'Обновляю резюме с hh…' : esc(syncError || ago(state.syncedAt))}</span>
        ${syncing ? '' : '<button data-act="sync">Обновить</button>'}</div>
      <div class="detail-head">
        <div class="score" style="color:${color(st.total / 100)}">${st.total}<small>%</small></div>
        <div class="grow"><div class="verdict">${esc(st.verdict)}</div>
        <div class="src">Детали для резюме «${esc(sel.resume.title)}»</div></div>
      </div>
      <div class="rows">${renderRows(st)}</div>
      <div class="foot">Данные вакансии: ${esc(vacancy.source)}. Сплошная рамка — ключевой навык вакансии, пунктир — технология из описания.</div>
    </div>`;
    shadow.innerHTML = html;
    bind();
  }

  function bind() {
    shadow.querySelectorAll('[data-act]').forEach((el) => {
      const act = el.getAttribute('data-act');
      const fn = () => {
        if (act === 'close') { host.remove(); return; }
        if (act === 'sync') { sync(true); return; }
        state.minimized = act === 'min';
        chrome.storage.local.set({ hhmMinimized: state.minimized });
        render();
      };
      el.addEventListener('click', fn);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
    });
    shadow.querySelectorAll('[data-sel]').forEach((el) => {
      el.addEventListener('click', () => { state.selectedId = el.getAttribute('data-sel'); render(); });
    });
  }

  // ---------- данные ----------
  async function loadResumesFromStorage() {
    const { hhmHh, hhmResume, hhmSyncEnabled } = await chrome.storage.local.get(['hhmHh', 'hhmResume', 'hhmSyncEnabled']);
    const list = [];
    if (hhmSyncEnabled !== false && hhmHh && hhmHh.list) {
      list.push(...hhmHh.list);
      state.syncedAt = hhmHh.syncedAt || 0;
      state.syncError = hhmHh.error || '';
    }
    if (hhmResume && hhmResume.trim().length > 30) {
      list.push({ id: 'manual', title: 'Резюме, добавленное вручную', text: hhmResume, source: 'manual' });
    }
    state.resumes = list;
    return hhmSyncEnabled !== false;
  }

  function recompute() {
    if (!state.vacancy) return;
    state.results = state.resumes
      .map((resume) => ({ resume, result: resume.text ? window.HHM.match(resume.text, state.vacancy) : null }))
      .sort((a, b) => (b.result ? b.result.total : -1) - (a.result ? a.result.total : -1));
    if (!state.results.some((r) => r.resume.id === state.selectedId && r.result)) state.selectedId = null;
  }

  let syncPromise = null;
  async function sync(force) {
    const { hhmSyncEnabled } = await chrome.storage.local.get('hhmSyncEnabled');
    if (hhmSyncEnabled === false) return;
    if (!force && Date.now() - state.syncedAt < 10000) return; // не дёргаем hh чаще раза в 10 секунд
    if (syncPromise) return syncPromise;
    state.syncing = true; render();
    syncPromise = (async () => {
      let saved;
      try {
        const list = await window.HHSync.syncResumes();
        saved = { list, syncedAt: Date.now(), error: '' };
      } catch (e) {
        const prev = (await chrome.storage.local.get('hhmHh')).hhmHh || {};
        saved = { list: prev.list || [], syncedAt: prev.syncedAt || 0, error: String(e.message || e) };
      }
      await chrome.storage.local.set({ hhmHh: saved });
      state.syncing = false;
      await loadResumesFromStorage();
      recompute();
      render();
      syncPromise = null;
    })();
    return syncPromise;
  }

  // ---------- запуск ----------
  let currentId = null;
  async function run() {
    const id = vacancyId();
    if (!id) { if (host) host.remove(); return; }
    currentId = id;
    const { hhmMinimized } = await chrome.storage.local.get('hhmMinimized');
    state.minimized = !!hhmMinimized;
    const syncOn = await loadResumesFromStorage();
    state.vacancy = null;
    state.syncing = syncOn;
    render();

    // Резюме с hh обновляем при каждом открытии вакансии, параллельно с загрузкой вакансии
    const syncing = syncOn ? sync(false) : Promise.resolve();
    const vac = await loadVacancy(id);
    if (id !== currentId) return;
    state.vacancy = vac;
    recompute();
    if (!syncPromise) state.syncing = false;
    render();
    await syncing;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.hhmResume || changes.hhmSyncEnabled) {
      loadResumesFromStorage().then(() => { recompute(); render(); if (changes.hhmSyncEnabled) sync(true); });
    }
  });

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg && msg.type === 'hhmSync') {
      sync(true).then(() => sendResponse({ ok: !state.syncError, error: state.syncError, count: state.resumes.length }));
      return true;
    }
    return false;
  });

  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; run(); }
  }, 1000);

  run();
})();
