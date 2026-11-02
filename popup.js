const $ = (id) => document.getElementById(id);
const ta = $('resume');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function setStatus(el, msg, cls) { el.textContent = msg; el.className = (el.id === 'status' ? 'status ' : '') + (cls || ''); }
function updateCount() { $('count').textContent = `${ta.value.length.toLocaleString('ru-RU')} символов`; }

function ago(ts) {
  if (!ts) return 'Ещё не обновлялись — откройте любую вакансию на hh';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'Обновлено только что';
  if (s < 3600) return `Обновлено ${Math.round(s / 60)} мин назад`;
  return 'Обновлено ' + new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function renderList() {
  const { hhmHh, hhmResume, hhmSyncEnabled } = await chrome.storage.local.get(['hhmHh', 'hhmResume', 'hhmSyncEnabled']);
  const syncOn = hhmSyncEnabled !== false;
  $('syncOn').checked = syncOn;
  const items = [];
  if (syncOn && hhmHh && hhmHh.list) {
    for (const r of hhmHh.list) {
      items.push(`<li><div class="line"><a class="name" href="https://hh.ru/resume/${esc(r.id)}" target="_blank" title="Открыть на hh">${esc(r.title)}</a>
        <span class="info ${r.error ? 'bad' : ''}">${r.error ? 'не прочитано' : (r.text.length / 1000).toFixed(1).replace('.', ',') + ' тыс. симв.'}</span></div>
        ${r.error ? `<div class="err-text">${esc(r.error)}</div>` : `<details class="peek"><summary>Что прочитано${r.how ? ' (' + esc(r.how) + ')' : ''}</summary><pre>${esc(r.text.slice(0, 1500))}${r.text.length > 1500 ? '\n…' : ''}</pre></details>`}</li>`);
    }
  }
  if (hhmResume && hhmResume.trim().length > 30) {
    items.push(`<li><div class="line"><span class="name">Добавлено вручную</span><span class="info">${(hhmResume.length / 1000).toFixed(1).replace('.', ',')} тыс. симв.</span></div></li>`);
  }
  $('list').innerHTML = items.join('') || `<li><span class="empty">${syncOn
    ? 'Пока пусто. Войдите в аккаунт hh и откройте любую вакансию — резюме подтянутся автоматически.'
    : 'Синхронизация выключена. Добавьте резюме вручную ниже.'}</span></li>`;
  $('synced').textContent = syncOn ? ago(hhmHh && hhmHh.syncedAt) : '';
  $('refresh').hidden = !syncOn;
  if (syncOn && hhmHh && hhmHh.error) setStatus($('status'), hhmHh.error, 'err');
}

// Обновление идёт через открытую вкладку hh — там есть ваша сессия
$('refresh').addEventListener('click', async () => {
  setStatus($('status'), 'Обновляю…');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'hhmSync' });
    if (res && res.ok) setStatus($('status'), `Готово: резюме — ${res.count}`, 'ok');
    else setStatus($('status'), (res && res.error) || 'Не удалось обновить', 'err');
  } catch {
    setStatus($('status'), 'Откройте вакансию на hh в этой вкладке и нажмите ещё раз', 'err');
  }
  renderList();
});

$('syncOn').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ hhmSyncEnabled: e.target.checked });
  setStatus($('status'), '');
  renderList();
});

// ---------- ручное резюме ----------
function decode(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1251').decode(buf); }
}

async function saveManual() {
  const v = ta.value.trim();
  if (v.length < 30) { setStatus($('mstatus'), 'Слишком короткий текст', 'err'); return; }
  await chrome.storage.local.set({ hhmResume: v });
  setStatus($('mstatus'), 'Сохранено', 'ok');
  renderList();
}

chrome.storage.local.get('hhmResume').then(({ hhmResume }) => {
  if (hhmResume) { ta.value = hhmResume; $('manualBox').open = true; }
  updateCount();
});
ta.addEventListener('input', () => { updateCount(); setStatus($('mstatus'), 'Не сохранено'); });
$('save').addEventListener('click', saveManual);
$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (!/\.(txt|md)$/i.test(f.name) && f.type !== 'text/plain') { setStatus($('mstatus'), 'Нужен файл .txt', 'err'); return; }
  ta.value = decode(await f.arrayBuffer()).replace(/\r\n/g, '\n');
  updateCount();
  e.target.value = '';
  await saveManual();
});
$('clear').addEventListener('click', async () => {
  ta.value = ''; updateCount();
  await chrome.storage.local.remove('hhmResume');
  setStatus($('mstatus'), 'Удалено');
  renderList();
});

chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.hhmHh) renderList(); });
renderList();
