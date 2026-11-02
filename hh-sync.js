// Подтягивает резюме пользователя прямо с hh. Работает внутри страницы hh,
// поэтому запросы идут с вашей сессией (вы должны быть залогинены).
//
// Страница резюме на hh рисуется скриптами, поэтому в «сыром» HTML текста почти нет.
// Читаем резюме тремя способами, по очереди:
//   1) данные страницы (JSON, который hh встраивает в HTML для отрисовки);
//   2) скрытая вкладка-фрейм: страница резюме отрисовывается целиком, и мы берём её текст;
//   3) кэш: текст, сохранённый, когда вы сами открывали своё резюме на hh.
(function (root) {
  'use strict';

  const MAX_RESUMES = 10;
  const MIN_TEXT = 300;
  const ID_RE = /\/resume\/([0-9a-f]{20,})/;
  const EMPLOYMENT_PREFIX = /^(постоянная работа|частичная занятость|проектная работа|разовое задание|стажировка|волонтерство|волонтёрство|вахта|подработка)\s*/i;

  const cleanTitle = (t) => String(t || '').replace(/\s+/g, ' ').trim().replace(EMPLOYMENT_PREFIX, '')
    .split(/(?=Уровень дохода|Доход не указан|\d[\d\s]*\s?₽|Обновлено|Показов)/)[0].trim();

  const BLOCK = /^(P|DIV|LI|UL|OL|H[1-6]|TR|TABLE|SECTION|ARTICLE|HEADER|BR|DT|DD|DL|TD|TH)$/;
  function blockText(el) {
    if (!el) return '';
    let out = '';
    (function walk(n) {
      if (n.nodeType === 3) { out += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      const b = BLOCK.test(n.tagName);
      if (b) out += '\n';
      for (const c of n.childNodes) walk(c);
      out += b ? '\n' : ' ';
    })(el);
    return out.replace(/[ \t\u00a0\u2009]+/g, ' ').replace(/ *\n[\s]*/g, '\n').trim();
  }

  async function fetchDoc(url) {
    const r = await fetch(url, { credentials: 'include', headers: { Accept: 'text/html' } });
    if (!r.ok) throw new Error(`hh ответил ${r.status}`);
    const html = await r.text();
    return { html, finalUrl: r.url, doc: new DOMParser().parseFromString(html, 'text/html') };
  }

  const isLogin = (url, doc) => /\/account\/login/.test(url) || !!doc.querySelector('[data-qa="account-login-form"]');

  // ---------- список резюме ----------
  async function discoverResumes() {
    const { hhmResumeIds } = await chrome.storage.local.get('hhmResumeIds');
    const found = new Map();
    let loginNeeded = false;
    const add = (id, t) => { t = cleanTitle(t); if (!found.has(id) || (!found.get(id) && t)) found.set(id, t); };
    try {
      const { html, doc, finalUrl } = await fetchDoc('/applicant/resumes');
      if (isLogin(finalUrl, doc)) loginNeeded = true;
      else {
        doc.querySelectorAll('a[href*="/resume/"]').forEach((a) => {
          const m = (a.getAttribute('href') || '').match(ID_RE);
          if (!m) return;
          const h = a.querySelector('h1,h2,h3,[data-qa*="title"]');
          add(m[1], h ? h.textContent : a.textContent);
        });
        for (const m of html.matchAll(/\/resume\/([0-9a-f]{20,})/g)) add(m[1], '');
      }
    } catch (e) {
      if (!(hhmResumeIds || []).length) throw e;
    }
    if (!found.size) for (const r of hhmResumeIds || []) add(r.id, r.title);
    if (!found.size && loginNeeded) throw new Error('Войдите в аккаунт hh, чтобы подтянуть резюме');
    if (!found.size) throw new Error('Не нашёл резюме. Откройте один раз страницу «Мои резюме» на hh');
    return Array.from(found, ([id, title]) => ({ id, title })).slice(0, MAX_RESUMES);
  }

  // ---------- способ 1: JSON из HTML страницы ----------
  const LANG_NAMES = { eng: 'Английский', deu: 'Немецкий', ger: 'Немецкий', fra: 'Французский', fre: 'Французский',
    spa: 'Испанский', zho: 'Китайский', chi: 'Китайский', ita: 'Итальянский', tur: 'Турецкий', jpn: 'Японский',
    kor: 'Корейский', ara: 'Арабский', rus: 'Русский' };
  const EDU_LEVELS = { higher: 'Высшее образование', bachelor: 'Высшее образование (бакалавр)', master: 'Высшее образование (магистр)',
    candidate: 'Высшее образование, кандидат наук', doctor: 'Высшее образование, доктор наук',
    unfinished_higher: 'Неоконченное высшее образование', special_secondary: 'Среднее специальное образование', secondary: 'Среднее образование' };
  const SKIP_KEY = /(url|href|link|hash|id$|^id|token|icon|image|photo|avatar|color|class|analytics|counter|_ts$|timestamp|created|updated|permission|button|tracking|hhtm|xsrf|mime|path|type$)/i;
  const LEVEL_RE = /^(a1|a2|b1|b2|c1|c2|l1|native)$/i;

  function readEmbeddedJson(html, doc) {
    const blobs = [];
    doc.querySelectorAll('template, script[type="application/json"], script#__NEXT_DATA__').forEach((n) => {
      const t = ((n.content && n.content.textContent) || n.textContent || n.innerHTML || '').trim();
      if (t.startsWith('{') && t.length > 200) blobs.push(t);
    });
    // На всякий случай — JSON внутри inline-скриптов вида window.__STATE__ = {...}
    for (const m of html.matchAll(/<script[^>]*>\s*window\.[\w$]+\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/g)) blobs.push(m[1]);
    const out = [];
    for (const b of blobs) { try { out.push(JSON.parse(b)); } catch (_) { /* не JSON */ } }
    return out;
  }

  // Ищем объект резюме: в нём есть сразу несколько характерных полей
  const RESUME_KEYS = ['keySkills', 'experience', 'educationLevel', 'education', 'language', 'languages', 'totalExperience', 'skills', 'title', 'specialization', 'professionalRole', 'primaryEducation'];
  function findResumeObject(node, id, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 12) return null;
    if (!Array.isArray(node)) {
      const keys = Object.keys(node);
      const hits = RESUME_KEYS.filter((k) => keys.includes(k)).length;
      if (hits >= 4) return node;
      // У hh резюме часто лежат в словаре по id/hash
      if (id && node[id] && typeof node[id] === 'object') {
        const r = findResumeObject(node[id], null, depth + 1);
        if (r) return r;
      }
    }
    for (const v of Array.isArray(node) ? node : Object.values(node)) {
      const r = findResumeObject(v, id, depth + 1);
      if (r) return r;
    }
    return null;
  }

  // Поля hh часто обёрнуты как {value: ...}
  const val = (x) => (x && typeof x === 'object' && !Array.isArray(x) && 'value' in x ? x.value : x);

  function resumeJsonToText(r) {
    const lines = [];
    const title = val(r.title);
    if (typeof title === 'string') lines.push(title);

    const te = val(r.totalExperience);
    if (te && typeof te === 'object' && ('years' in te || 'months' in te)) {
      lines.push(`Опыт работы ${te.years || 0} лет ${te.months || 0} месяцев`);
    } else if (te && typeof te === 'object' && 'months' in te) {
      lines.push(`Опыт работы ${Math.floor(te.months / 12)} лет ${te.months % 12} месяцев`);
    }

    const edu = val(r.educationLevel);
    const eduId = edu && (edu.id || edu.string || edu);
    if (typeof eduId === 'string' && EDU_LEVELS[eduId.toLowerCase()]) lines.push(EDU_LEVELS[eduId.toLowerCase()]);

    const langs = val(r.language) || val(r.languages);
    if (Array.isArray(langs) && langs.length) {
      lines.push('Знание языков');
      for (const l of langs) {
        const lid = String(l.language || l.id || l.code || '').toLowerCase();
        const name = l.name || l.title || LANG_NAMES[lid] || lid;
        const lvlRaw = l.degree || l.level || l.levelId;
        const lvl = typeof lvlRaw === 'object' && lvlRaw ? (lvlRaw.id || lvlRaw.name) : lvlRaw;
        lines.push(`${name}${lvl ? ' — ' + (LEVEL_RE.test(lvl) ? (lvl === 'l1' || lvl === 'native' ? 'Родной' : lvl.toUpperCase()) : lvl) : ''}`);
      }
    }

    // Всё остальное — собираем все строки из объекта резюме
    const seen = new Set(lines);
    (function walk(node, key, depth) {
      if (depth > 10 || node == null) return;
      if (typeof node === 'string') {
        const s = node.trim();
        if (s.length < 2 || s.length > 20000 || seen.has(s)) return;
        if (/^(https?:|\/|data:)/.test(s) || /^[0-9a-f-]{16,}$/i.test(s) || /^\d{4}-\d{2}(-\d{2})?/.test(s)) return;
        seen.add(s);
        lines.push(s.includes('<') ? blockText(new DOMParser().parseFromString(s, 'text/html').body) : s);
        return;
      }
      if (Array.isArray(node)) { node.forEach((v) => walk(v, key, depth + 1)); return; }
      if (typeof node === 'object') {
        // Период работы: startDate/endDate → «2019 — настоящее время»
        if ('startDate' in node || 'start' in node) {
          const a = String(node.startDate || node.start || '').slice(0, 4);
          const e = node.endDate || node.end;
          if (/^\d{4}$/.test(a)) lines.push(`${a} — ${e ? String(e).slice(0, 4) : 'настоящее время'}`);
        }
        for (const [k, v] of Object.entries(node)) {
          if (SKIP_KEY.test(k) && k !== 'title') continue;
          if (/^(language|languages|degree|level|educationLevel|totalExperience|gender|currency|relocation|businessTripReadiness|travelTime)$/.test(k)) continue; // уже учтено выше или служебное
          if (k === 'startDate' || k === 'endDate') continue;
          walk(v, k, depth + 1);
        }
      }
    })(r, '', 0);
    return lines.join('\n');
  }

  // Формат hh (проверено на реальной странице): window-состояние в <template id="HH-Lux-InitialState">,
  // резюме в applicantResume, поля — массивы вида [{string: ...}]
  const HH_LANG_IDS = { 34: 'Русский', 57: 'Английский' };
  function fromLuxState(st) {
    const r = st && st.applicantResume;
    if (!r || !r.title) return null;
    const S = (x) => (Array.isArray(x) ? x : [x])
      .map((i) => (i == null ? null : typeof i !== 'object' ? i : (i.string ?? i.text ?? i.name ?? null)))
      .filter((v) => v != null && v !== '');
    const yr = (d) => (d ? String(d).slice(0, 4) : '');
    const L = [];
    const title = S(r.title)[0] || '';
    L.push(title);
    for (const role of S(r.professionalRole)) if (typeof role === 'string' && role !== 'Другое') L.push(role);

    const months = Number(S(r.totalExperience)[0]);
    if (Number.isFinite(months) && months > 0) L.push(`Опыт работы ${Math.floor(months / 12)} лет ${months % 12} месяцев`);

    const edu = String(S(r.educationLevel)[0] || '').toLowerCase();
    if (EDU_LEVELS[edu]) L.push(EDU_LEVELS[edu]);

    const langs = Array.isArray(r.language) ? r.language : [];
    if (langs.length) {
      L.push('Знание языков');
      const codes = (st.resumeLanguages || []).map((c) => String(c).toUpperCase());
      for (const l of langs) {
        const deg = String(l.degree || '').toLowerCase();
        let name = HH_LANG_IDS[l.id] || l.name;
        if (!name) name = deg === 'l1' ? 'Родной язык' : codes.includes('EN') ? 'Английский' : 'Иностранный язык';
        L.push(`${name} — ${deg === 'l1' || deg === 'native' ? 'Родной' : deg.toUpperCase()}`);
      }
    }

    const skills = new Set([...S(r.keySkills), ...((r.advancedKeySkills || []).map((k) => k && k.name).filter(Boolean))]);
    if (skills.size) L.push('Ключевые навыки: ' + Array.from(skills).join(', '));

    const exp = Array.isArray(r.experience) ? r.experience : [];
    if (exp.length) L.push('Опыт работы');
    for (const e of exp) {
      L.push(`${yr(e.startDate)} — ${e.endDate ? yr(e.endDate) : 'настоящее время'}`);
      if (e.position) L.push(e.position);
      if (e.professionName && e.professionName !== e.position) L.push(e.professionName);
      if (e.companyName) L.push(e.companyName);
      if (e.description) L.push(String(e.description));
    }

    const about = S(r.skills).join('\n');
    if (about) L.push('О себе', about);

    const edus = [...(r.primaryEducation || []), ...(r.additionalEducation || [])];
    if (edus.length) L.push('Образование');
    for (const e of edus) {
      const lvl = EDU_LEVELS[String(e.educationLevel || '').toLowerCase()];
      L.push([lvl, e.name, e.organization, e.result, e.year].filter(Boolean).join(', '));
    }
    for (const c of r.certificate || []) if (c && (c.title || c.name)) L.push(c.title || c.name);

    const text = L.filter(Boolean).join('\n');
    return text.length >= MIN_TEXT ? { title, text } : null;
  }

  function fromJson(html, doc, id) {
    const datas = readEmbeddedJson(html, doc);
    for (const data of datas) {
      const hh = fromLuxState(data);
      if (hh) return hh;
    }
    for (const data of datas) {
      const r = findResumeObject(data, id);
      if (!r) continue;
      const text = resumeJsonToText(r);
      const t = val(r.title);
      if (text.length >= MIN_TEXT) return { title: typeof t === 'string' ? t : '', text };
    }
    return null;
  }

  // ---------- текст отрисованной страницы (для фрейма и для открытой вкладки) ----------
  function renderedText(doc) {
    const blocks = Array.from(doc.querySelectorAll('[data-qa^="resume-block"]'))
      .filter((el, _i, all) => !all.some((o) => o !== el && o.contains(el)));
    const titleEl = doc.querySelector('[data-qa="resume-block-title-position"], [data-qa="resume-block-position"], [data-qa="resume-title"], h1, h2');
    const title = cleanTitle(titleEl && (titleEl.innerText || titleEl.textContent));
    let text;
    if (blocks.length >= 2) text = blocks.map((b) => b.innerText || blockText(b)).join('\n\n');
    else {
      const main = doc.querySelector('main, [role="main"]') || doc.body;
      text = main.innerText || blockText(main);
      // Убираем шапку/подвал сайта, если они попали в main
      for (const sel of ['header', 'footer', 'nav']) {
        doc.querySelectorAll(sel).forEach((n) => { const t = n.innerText; if (t && t.length > 20) text = text.replace(t, ''); });
      }
    }
    return { title, text: `${title}\n${text}`.replace(/\n{3,}/g, '\n\n').trim() };
  }

  // Только если резюме уже размечено в HTML (старый интерфейс hh)
  function fromDocMarkup(doc) {
    if (doc.querySelectorAll('[data-qa^="resume-block"]').length < 2) return null;
    doc.querySelectorAll('script, style, noscript, svg, template, iframe, header, footer, nav').forEach((n) => n.remove());
    const r = renderedText(doc);
    return r.text.length >= MIN_TEXT ? r : null;
  }

  // ---------- способ 2: скрытый фрейм ----------
  function fromIframe(id, timeout = 12000) {
    return new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;visibility:hidden;';
      f.src = `/resume/${id}`;
      let done = false;
      const finish = (r) => { if (done) return; done = true; clearInterval(timer); f.remove(); resolve(r); };
      let lastLen = -1, stable = 0;
      const timer = setInterval(() => {
        let d;
        try { d = f.contentDocument; } catch (_) { return finish(null); } // фрейм запрещён
        if (!d || !d.body || d.location.href === 'about:blank') return;
        const len = d.body.innerText.length;
        // Ждём, пока текст перестанет расти (страница дорисовалась)
        if (len > 200 && len === lastLen) stable++; else stable = 0;
        lastLen = len;
        if (stable >= 2) {
          const r = renderedText(d);
          finish(r.text.length >= MIN_TEXT ? r : null);
        }
      }, 500);
      setTimeout(() => finish(null), timeout);
      document.documentElement.appendChild(f);
    });
  }

  // ---------- основной сценарий ----------
  async function readOne({ id, title }, cache) {
    const base = { id, title: title || 'Резюме', source: 'hh' };
    let html = '', doc = null;
    try {
      ({ html, doc } = await fetchDoc(`/resume/${id}`));
    } catch (_) { /* попробуем другие способы */ }

    let r = doc && (fromJson(html, doc, id) || fromDocMarkup(doc));
    let how = 'данные страницы';
    if (!r) { r = await fromIframe(id); how = 'отрисованная страница'; }
    if (!r && cache[id] && cache[id].text) {
      r = cache[id];
      how = 'сохранено ' + new Date(cache[id].ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }
    if (!r) {
      return { ...base, text: '', error: 'не удалось прочитать — откройте это резюме на hh один раз' };
    }
    return { ...base, title: cleanTitle(r.title) || base.title, text: r.text, how };
  }

  async function syncResumes() {
    const list = await discoverResumes();
    const { hhmResumeCache } = await chrome.storage.local.get('hhmResumeCache');
    const cache = hhmResumeCache || {};
    const out = [];
    // По одному, чтобы не открывать много фреймов разом
    for (const item of list) out.push(await readOne(item, cache));
    return out;
  }

  root.HHSync = { syncResumes, renderedText, cleanTitle, blockText, _internal: { fromJson, resumeJsonToText, findResumeObject } };
})(globalThis);
