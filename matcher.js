// Ядро сравнения резюме и вакансии. Без зависимостей, работает и в браузере, и в Node.
(function (root) {
  'use strict';

  const WEIGHTS = {
    skills: 45,      // необходимые технологии
    title: 20,       // название должности и грейд
    experience: 15,  // опыт работы (попадание в диапазон фильтра hh)
    languages: 10,   // иностранные языки
    education: 10    // высшее образование
  };

  const STOP = new Set((
    'и в во на с со по для от до из у к ко о об при за под над без не ни но а же ли бы или то это как что чтобы ' +
    'так также все всё вся весь его ее её их мы вы вас нас наш ваш наша ваша наши ваши мы будет будут быть есть ' +
    'который которая которые которых работа работы работе работать работу опыт опыта опытом знание знания умение ' +
    'навыки навык плюсом плюс будет преимуществом требования требуется обязанности условия задачи компания команда ' +
    'команде команды нашей наш год года лет более менее очень хорошо хорошее хороший уровень уровне уровня ' +
    'возможность возможности офис офиса удаленно удаленная удалённо гибрид график дмс зарплата оклад ' +
    'the and for with you our are will your from have has this that team work experience skills'
  ).split(/\s+/));

  const TITLE_STOP = new Set((
    'junior middle senior lead ведущий старший младший стажер стажёр главный intern trainee head ' +
    'в на по и для с удаленно удалённо remote офис гибрид москва спб санкт-петербург'
  ).split(/\s+/));

  // ---------- утилиты текста ----------
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[\u00a0\u2009]/g, ' ');
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const words = (s) => norm(s).match(/[\p{L}\p{N}][\p{L}\p{N}+#.\-]*[\p{L}\p{N}+#]|[\p{L}\p{N}]/gu) || [];
  const isCyr = (w) => /[а-я]/.test(w);

  // Грубый стемминг: отрезаем окончание, сравниваем по префиксу.
  function stem(w) {
    if (isCyr(w)) return w.length <= 4 ? w : w.slice(0, Math.max(4, w.length - 3));
    return w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w;
  }

  function aliasRegex(alias) {
    return new RegExp('(?<![\\p{L}\\p{N}+#.])' + escapeRe(norm(alias)) + '(?![\\p{L}\\p{N}+#])', 'u');
  }

  // Индекс текста резюме для быстрых проверок
  function buildIndex(text) {
    const t = norm(text);
    const list = Array.from(new Set(words(t).flatMap((w) => [w, ...w.split(/[-/]/)])));
    return {
      text: t,
      head: t.slice(0, 600),
      words: list,
      hasStem(s, inHead) {
        const src = inHead ? words(this.head) : this.words;
        return src.some((w) => w.startsWith(s));
      },
      has(alias) { return aliasRegex(alias).test(this.text); }
    };
  }

  // ---------- словарь навыков ----------
  const SKILLS = (root.HHM_SKILLS || []).map(([name, aliases, weak]) => ({
    name,
    aliases: aliases.map(norm),
    weak: (weak || []).map(norm),
    re: aliases.map(aliasRegex)
  }));

  function findDictEntry(skill) {
    const s = norm(skill).trim();
    return SKILLS.find((e) => norm(e.name) === s || e.aliases.includes(s) || e.weak.includes(s)) || null;
  }

  function scanSkills(text) {
    const t = norm(text);
    return SKILLS.filter((e) => e.re.some((r) => r.test(t)));
  }

  function resumeHasEntry(idx, entry) {
    return entry.aliases.some((a) => idx.has(a)) || entry.weak.some((a) => idx.has(a));
  }

  // Навык не из словаря ("Управление проектами") — нечёткое совпадение по основам слов
  function resumeHasFuzzy(idx, skill) {
    if (idx.has(skill)) return true;
    const toks = words(skill).filter((w) => w.length >= 3 && !STOP.has(w));
    if (!toks.length) return false;
    const hit = toks.filter((w) => idx.hasStem(stem(w))).length;
    return hit >= Math.ceil(toks.length * 0.7);
  }

  // ---------- навыки ----------
  function scoreSkills(idx, vac) {
    const items = new Map(); // key -> {name, matched, source}
    for (const ks of vac.keySkills || []) {
      const e = findDictEntry(ks);
      const key = e ? e.name : norm(ks);
      if (items.has(key)) continue;
      items.set(key, { name: e ? e.name : ks, source: 'key', matched: e ? resumeHasEntry(idx, e) : resumeHasFuzzy(idx, ks) });
    }
    const { main, plus } = splitSections(vac.description);
    for (const e of scanSkills(vac.title + '\n' + main)) {
      if (!items.has(e.name)) items.set(e.name, { name: e.name, source: 'text', matched: resumeHasEntry(idx, e) });
    }
    // Технологии только из «Будет плюсом» в оценку не входят — показываем отдельно
    const optional = scanSkills(plus).filter((e) => !items.has(e.name))
      .map((e) => ({ name: e.name, source: 'plus', matched: resumeHasEntry(idx, e) }));

    const list = Array.from(items.values());
    if (!list.length) return { score: null, matched: [], missing: [], optional, note: 'в вакансии не найдено обязательных технологий' };
    const got = list.filter((i) => i.matched).length;
    const bySource = (a, b) => (a.source === b.source ? 0 : a.source === 'key' ? -1 : 1);
    return {
      score: got / list.length,
      matched: list.filter((i) => i.matched).sort(bySource),
      missing: list.filter((i) => !i.matched).sort(bySource),
      optional,
      note: `есть ${got} из ${list.length} необходимых`
    };
  }

  // ---------- должность и грейд ----------
  const GRADES = [
    [0, /(стажер|intern|trainee|без опыта)/],
    [1, /(junior|джун|младш)/],
    [2, /(middle|мидл)/],
    [3, /(senior|сеньор|синьор|старш|ведущ)/],
    [4, /(team ?lead|тимлид|техлид|tech ?lead|head of|руководител|lead\b)/]
  ];
  const GRADE_NAMES = ['стажёр', 'junior', 'middle', 'senior', 'lead'];
  function detectGrade(text) {
    const t = norm(text);
    let g = null;
    for (const [lvl, re] of GRADES) if (re.test(t)) g = lvl;
    return g;
  }
  function gradeFromYears(y) {
    if (y == null) return null;
    if (y < 1) return 0;
    if (y < 3) return 1;
    if (y < 6) return 2;
    return 3;
  }

  // Синонимы для сравнения заголовков (основы слов)
  const TITLE_SYN = [
    ['qa', 'тестиров', 'тестировщ', 'tester', 'testing', 'test'],
    ['frontend', 'front', 'фронтенд', 'фронт'],
    ['backend', 'back', 'бэкенд', 'бекенд'],
    ['fullstack', 'full', 'фулстек', 'фуллстек'],
    ['developer', 'разработч', 'программист', 'dev'],
    ['engineer', 'инженер'],
    ['analyst', 'аналитик'],
    ['designer', 'дизайнер'],
    ['manager', 'менеджер'],
    ['automation', 'автоматиз', 'auto', 'авто', 'aqa', 'sdet'],
    ['mobile', 'мобильн', 'ios', 'android'],
    ['data', 'данных', 'дата']
  ];
  function titleAlts(w) {
    const s = stem(w);
    const g = TITLE_SYN.find((grp) => grp.some((x) => s.startsWith(x) || x.startsWith(s) && s.length >= 3));
    return g ? g : [s];
  }

  // Сравниваем название вакансии с заголовком резюме (первая строка)
  function scoreTitle(idx, vac, years) {
    const resumeTitle = norm(idx.text.split('\n').find((l) => l.trim()) || '');
    const rtWords = words(resumeTitle).flatMap((w) => [w, ...w.split(/[-/]/)]);
    const inTitle = (alts) => rtWords.some((w) => alts.some((a) => w.startsWith(a)));
    const toks = Array.from(new Set(words(vac.title).flatMap((w) => w.split(/[-/]/))
      .filter((w) => w.length >= 2 && !TITLE_STOP.has(w) && !/^\d+$/.test(w))));
    let tokScore = 0;
    const found = [], lost = [];
    for (const w of toks) {
      if (inTitle(titleAlts(w))) { tokScore += 1; found.push(w); }
      else lost.push(w);
    }
    const tokPart = toks.length ? tokScore / toks.length : null;

    const vg = detectGrade(vac.title);
    const rg = detectGrade(resumeTitle) ?? gradeFromYears(years);
    let gradePart = null, gradeNote = '';
    if (vg != null && rg != null) {
      const d = Math.abs(vg - rg);
      gradePart = d === 0 ? 1 : d === 1 ? 0.6 : 0.2;
      gradeNote = `грейд: в вакансии ${GRADE_NAMES[vg]}, у вас ${GRADE_NAMES[rg]}`;
    }
    let score = tokPart;
    if (tokPart != null && gradePart != null) score = tokPart * 0.75 + gradePart * 0.25;
    return {
      score,
      found, lost,
      note: [
        found.length ? `совпало: ${found.join(', ')}` : 'слова из названия вакансии не найдены в заголовке',
        lost.length && found.length ? `нет в заголовке: ${lost.join(', ')}` : '',
        gradeNote
      ].filter(Boolean).join('; ')
    };
  }

  // ---------- опыт ----------
  const EXP = {
    noExperience: { min: 0, max: 1, maxExclusive: true, label: 'без опыта' },
    between1And3: { min: 1, max: 3, label: '1–3 года' },
    between3And6: { min: 3, max: 6, label: '3–6 лет' },
    moreThan6: { min: 6, max: Infinity, label: 'более 6 лет' }
  };

  function experienceIdFromText(text) {
    const t = norm(text);
    if (/не требуется|без опыта|no experience/.test(t)) return 'noExperience';
    if (/1\s*[–\-—]\s*3/.test(t)) return 'between1And3';
    if (/3\s*[–\-—]\s*6/.test(t)) return 'between3And6';
    if (/более\s*6|6\+|more than 6/.test(t)) return 'moreThan6';
    return null;
  }

  function resumeYears(text) {
    const t = norm(text);
    // Формат hh: "Опыт работы — 5 лет 3 месяца" / "Опыт работы 11 месяцев"
    let m = t.match(/опыт работы\s*[—\-–:]?\s*(?:(\d{1,2})\s*(?:года|год|лет))?\s*(?:(\d{1,2})\s*месяц)?/);
    if (m && (m[1] || m[2])) return { years: (+m[1] || 0) + (+m[2] || 0) / 12, how: 'по резюме' };
    m = t.match(/(\d{1,2})\+?\s*(?:years?|yrs|лет|года|год)\s*(?:of\s*)?(?:experience|опыта|коммерческ)/);
    if (m) return { years: +m[1], how: 'по резюме' };
    // Оценка по диапазонам лет в опыте работы
    const now = new Date().getFullYear();
    const re = /((?:19|20)\d{2})\s*[—\-–]\s*((?:19|20)\d{2}|по настоящее время|настоящее время|н\.?\s*в\.?|present|now|сейчас|текущее время)/g;
    let start = Infinity, end = -Infinity, r;
    while ((r = re.exec(t))) {
      const a = +r[1];
      const b = /^\d/.test(r[2]) ? +r[2] : now;
      if (a > 1970 && b >= a) { start = Math.min(start, a); end = Math.max(end, b); }
    }
    if (isFinite(start)) return { years: end - start, how: 'оценка по датам' };
    return null;
  }

  // Опыт сравниваем как фильтр hh: либо попадает в диапазон вакансии, либо нет
  function scoreExperience(vac, ry) {
    const req = EXP[vac.experienceId];
    if (!req) return { score: null, fit: null, note: 'требование к опыту не указано' };
    if (!ry) return { score: null, fit: null, note: `нужно: ${req.label}; в резюме опыт не найден` };
    const y = Math.round(ry.years * 10) / 10;
    const yTxt = y < 1 ? `${Math.round(ry.years * 12)} мес.` : `${String(y).replace('.', ',')} г.`;
    const below = y < req.min;
    const above = req.maxExclusive ? y >= req.max : y > req.max;
    const fit = !below && !above;
    const why = below ? 'меньше требуемого' : above ? 'больше требуемого' : 'в диапазоне';
    return {
      score: fit ? 1 : 0,
      fit,
      note: `нужно: ${req.label}; у вас: ${yTxt} — ${fit ? 'соответствует фильтру' : 'не соответствует фильтру (' + why + ')'}`
    };
  }

  // ---------- языки ----------
  const LANGS = [
    ['Английский', /(английск\p{L}*|english|\beng\b)/u, 'eng'],
    ['Немецкий', /(немецк\p{L}*|german|deutsch)/u, 'deu'],
    ['Французский', /(французск\p{L}*|french)/u, 'fra'],
    ['Испанский', /(испанск\p{L}*|spanish)/u, 'spa'],
    ['Китайский', /(китайск\p{L}*|chinese|mandarin)/u, 'zho'],
    ['Итальянский', /(итальянск\p{L}*|italian)/u, 'ita'],
    ['Турецкий', /(турецк\p{L}*|turkish)/u, 'tur'],
    ['Японский', /(японск\p{L}*|japanese)/u, 'jpn'],
    ['Корейский', /(корейск\p{L}*|korean)/u, 'kor'],
    ['Арабский', /(арабск\p{L}*|arabic)/u, 'ara']
  ];
  const LEVELS = [
    [6, /(\bc2\b|proficien|native|родн|свободн|fluent|носител)/u],
    [5, /(\bc1\b|(?<!upper[\s-]?)advanced|(?<!средне[\s-]?)продвинут)/u],
    [4, /(\bb2\b|upper[\s-]?intermediate|выше средн|средне[\s-]?продвинут)/u],
    [3, /(\bb1\b|(?<!upper[\s-]?|pre[\s-]?)intermediate|средн\p{L}*|разговорн|technical|технич\p{L}*|чтение документац|читаю документац)/u],
    [2, /(\ba2\b|pre[\s-]?intermediate|elementary|базов|начальн)/u],
    [1, /(\ba1\b|beginner)/u]
  ];
  const LEVEL_NAMES = { 1: 'A1', 2: 'A2', 3: 'B1', 4: 'B2', 5: 'C1', 6: 'C2' };
  const API_LEVEL = { a1: 1, a2: 2, b1: 3, b2: 4, c1: 5, c2: 6, l1: 6 };

  const ANY_LANG = new RegExp(LANGS.map((l) => l[1].source).join('|'), 'u');
  function levelNear(text, pos, before, after) {
    let tail = text.slice(pos, pos + after);
    const next = ANY_LANG.exec(tail.slice(3));
    if (next) tail = tail.slice(0, next.index + 3); // не залезать в соседний язык
    const win = text.slice(Math.max(0, pos - before), pos) + tail;
    for (const [lvl, re] of LEVELS) if (re.test(win)) return lvl;
    return null;
  }

  function languagesFromText(text, before, after, defaultLevel) {
    const t = norm(text);
    const out = [];
    for (const [name, re, code] of LANGS) {
      const m = re.exec(t);
      if (!m) continue;
      out.push({ name, code, level: levelNear(t, m.index, before, after) ?? defaultLevel });
    }
    return out;
  }

  function scoreLanguages(resumeText, vac) {
    let req = (vac.languages || []).filter((l) => l.code !== 'rus');
    if (!req.length) req = languagesFromText(vac.description, 60, 80, 3);
    if (!req.length) return { score: null, note: 'не требуются' };
    const have = languagesFromText(resumeText, 5, 60, null);
    const parts = [];
    let sum = 0;
    for (const r of req) {
      const h = have.find((x) => x.code === r.code || x.name === r.name);
      const need = r.level || 3;
      let s = 0, txt;
      if (!h) { txt = `${r.name}: нужен ${LEVEL_NAMES[need]}, в резюме не указан`; }
      else if (h.level == null) { s = 0.5; txt = `${r.name}: нужен ${LEVEL_NAMES[need]}, уровень в резюме не указан`; }
      else { s = Math.min(1, h.level / need); txt = `${r.name}: нужен ${LEVEL_NAMES[need]}, у вас ${LEVEL_NAMES[h.level]}`; }
      sum += s;
      parts.push(txt);
    }
    return { score: sum / req.length, note: parts.join('; ') };
  }

  // ---------- образование ----------
  function scoreEducation(resumeText, vac) {
    const d = norm(vac.description);
    const requires = /(высш\p{L}*\s+(?:\p{L}+\s+){0,2}образован|higher education|bachelor'?s? degree|master'?s? degree|\bdegree in|профильн\p{L}*\s+образован)/u.test(d);
    const technical = /(техническ\p{L}*|математическ\p{L}*|инженерн\p{L}*|профильн\p{L}*|it[\s-]?)\s+(?:высш\p{L}*\s+)?образован/u.test(d);
    const incompleteOk = /неоконченн\p{L}*\s+высш/u.test(d);
    if (!requires) return { score: null, note: 'не указано в вакансии' };

    const r = norm(resumeText);
    const eduBlock = (r.match(/образование[\s\S]{0,700}/) || [''])[0];
    const hasHigher = /(высшее|бакалавр|магистр|специалитет|аспирант|кандидат \p{L}+ наук|university|bachelor|master|mba|phd)/u.test(r) ||
      /(университет|институт|академи|политехн|мгу|мфти|мифи|вшэ|итмо|бауман)/u.test(eduBlock);
    const incomplete = /неоконченн\p{L}*\s+высш|незаконченн\p{L}*\s+высш|incomplete/u.test(r);
    const techRes = /(техническ|инженер|информатик|программн|математ|физик|computer science|вычислительн|информационн|радио|автоматиз|прикладн)/u.test(eduBlock || r);

    let score, note;
    if (hasHigher && !incomplete) { score = 1; note = 'высшее — есть'; }
    else if (incomplete) { score = incompleteOk ? 1 : 0.6; note = 'неоконченное высшее'; }
    else { score = 0; note = 'нужно высшее, в резюме не найдено'; }
    if (technical && score > 0 && !techRes) { score *= 0.7; note += '; вакансия просит техническое/профильное, профиль не очевиден'; }
    else if (technical && techRes) note += '; профильное';
    return { score, note };
  }

  // ---------- разделы описания: обязательное и «будет плюсом» ----------
  const SECTION_PLUS = /^(будет плюсом|плюсом будет|будет преимуществом|желательно|преимуществом|nice to have|plus|would be a plus)/;
  const SECTION_ANY = /^(требован|что мы ждем|мы ждем|ожидаем|что нужно|что важно|кого мы ищем|нам важно|необходим|обязанност|задачи|чем предстоит|что предстоит|вам предстоит|мы предлагаем|условия|что мы предлагаем|предлагаем|о компании|о нас|о проекте|бонусы|стек|технологи|requirements|responsibilities|we offer|benefits|about|tech stack)/;

  // Делим описание на обязательную часть и блок «Будет плюсом»
  function splitSections(description) {
    const main = [], plus = [];
    let inPlus = false;
    for (const raw of String(description || '').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const l = norm(line).replace(/^[\s•·▪●◦*–\-]+/, '');
      if (SECTION_PLUS.test(l)) {
        inPlus = true;
        const rest = line.replace(/^[^:]*:\s*/, '');
        if (rest !== line && rest) plus.push(rest); // «Будет плюсом: Docker, Kafka»
        continue;
      }
      if (line.length < 60 && (/:$/.test(line) || SECTION_ANY.test(l))) inPlus = false;
      (inPlus ? plus : main).push(line);
    }
    return { main: main.join('\n'), plus: plus.join('\n') };
  }

  // ---------- итог ----------
  function match(resumeText, vacancy) {
    const vac = {
      title: vacancy.title || '',
      keySkills: vacancy.keySkills || [],
      description: vacancy.description || '',
      experienceId: vacancy.experienceId || null,
      languages: vacancy.languages || []
    };
    const idx = buildIndex(resumeText);
    const ry = resumeYears(resumeText);

    const criteria = [
      { key: 'skills', label: 'Технологии', ...scoreSkills(idx, vac) },
      { key: 'title', label: 'Заголовок резюме', ...scoreTitle(idx, vac, ry && ry.years) },
      { key: 'experience', label: 'Опыт работы', ...scoreExperience(vac, ry) },
      { key: 'languages', label: 'Иностранные языки', ...scoreLanguages(resumeText, vac) },
      { key: 'education', label: 'Образование', ...scoreEducation(resumeText, vac) }
    ].map((c) => ({ ...c, weight: WEIGHTS[c.key] }));

    const used = criteria.filter((c) => c.score != null);
    const wsum = used.reduce((s, c) => s + c.weight, 0);
    const total = wsum ? Math.round((used.reduce((s, c) => s + c.weight * c.score, 0) / wsum) * 100) : 0;

    let verdict;
    if (total >= 75) verdict = 'Сильное совпадение';
    else if (total >= 55) verdict = 'Хорошее совпадение';
    else if (total >= 35) verdict = 'Частичное совпадение';
    else verdict = 'Слабое совпадение';

    const exp = criteria.find((c) => c.key === 'experience');
    return { total, verdict, criteria, experienceFit: exp ? exp.fit : null };
  }

  // Попадает ли стаж (лет) в диапазон фильтра hh
  function experienceFits(expId, years) {
    const req = EXP[expId];
    if (!req || years == null) return null;
    const y = Math.round(years * 10) / 10;
    return y >= req.min && (req.maxExclusive ? y < req.max : y <= req.max);
  }

  const HHM = { match, experienceIdFromText, experienceFits, resumeYears, _internal: { resumeYears, languagesFromText, detectGrade, scanSkills, stem } };
  root.HHM = HHM;
  if (typeof module !== 'undefined' && module.exports) module.exports = HHM;
})(globalThis);
