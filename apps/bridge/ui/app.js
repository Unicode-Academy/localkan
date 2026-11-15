const { invoke } = window.__TAURI__.core;

const $ = (id) => document.getElementById(id);

const LINK_LABELS = {
  idle: 'Chưa chạy',
  connecting: 'Đang kết nối…',
  connected: 'Đã kết nối',
  disconnected: 'Mất kết nối',
  unauthorized: 'Server từ chối máy này',
  error: 'Lỗi',
};

const AGENT_LABELS = { claude: 'Claude Code', antigravity: 'Antigravity (agy)', codex: 'Codex', grok: 'Grok' };

async function refresh() {
  let s;
  try {
    s = await invoke('get_status');
  } catch (e) {
    return;
  }
  $('status').hidden = !s.paired;
  $('pair').hidden = s.paired;
  if (!s.paired) return;

  $('link').textContent = LINK_LABELS[s.link] ?? s.link;
  $('dot').className = `dot ${s.link === 'connected' ? 'ok' : s.link === 'connecting' ? 'wait' : 'off'}`;
  $('detail').textContent = s.detail ?? '';
  $('server').textContent = s.serverUrl ?? '—';
  $('device').textContent = s.deviceName ?? '—';
  $('datadir').textContent = s.dataDir;
  const info = s.info;
  if (info) {
    $('orca').textContent = info.orca.reachable
      ? `Sẵn sàng (${info.orca.version ?? '?'})`
      : `Chưa chạy${info.orca.error ? `: ${info.orca.error}` : ''}`;
    $('agents').textContent = Object.entries(info.agents)
      .map(([k, v]) => `${AGENT_LABELS[k] ?? k} ${v ? '✓' : '✗'}`)
      .join(' · ');
  }
}

$('pair').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('pair-error').hidden = true;
  $('pair-btn').disabled = true;
  try {
    await invoke('pair', {
      serverUrl: $('server-url').value.trim(),
      code: $('code').value.trim(),
      deviceName: $('name').value.trim() || null,
    });
    $('code').value = '';
    await refresh();
  } catch (err) {
    $('pair-error').textContent = String(err);
    $('pair-error').hidden = false;
  } finally {
    $('pair-btn').disabled = false;
  }
});

$('open-board').addEventListener('click', () => invoke('open_board').catch(alert));
$('reconnect').addEventListener('click', () => invoke('reconnect').then(refresh));
$('unpair').addEventListener('click', async () => {
  if (!confirm('Gỡ ghép nối máy này khỏi server? Agent đang chạy sẽ không còn nhận lệnh.')) return;
  await invoke('unpair').catch(alert);
  refresh();
});

// -- machine setup ------------------------------------------------------------

const MARKS = { ok: '✓', missing: '✕', setup: '!' };
let setupItems = [];
let setupOpen = null; // the user's choice; null: open while something needs doing
let setupRunning = false;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text, onClick, className = 'small') {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

async function act(fn, after = loadSetup) {
  try {
    await fn();
    await after();
  } catch (err) {
    alert(String(err));
  }
}

async function install(ids) {
  await act(() => invoke('setup_install', { ids }), pollSetup);
}

/** A small form (inputs + Lưu) for what only the user can provide. */
function form(fields, save) {
  const f = el('form', 'setup-form');
  const inputs = fields.map(([placeholder, type]) => {
    const i = el('input');
    i.placeholder = placeholder;
    i.type = type ?? 'text';
    i.autocomplete = 'off';
    i.required = true;
    f.append(i);
    return i;
  });
  const row = el('div', 'row');
  const ok = el('button', 'small primary', 'Lưu');
  row.append(ok);
  f.append(row);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    act(() => save(...inputs.map((i) => i.value.trim())));
  });
  return { f, row };
}

function actionFor(it, text) {
  if (it.state === 'missing' && it.installable) return button('Cài', () => install([it.id]));
  if (it.state !== 'setup') return null;
  if (it.id === 'gh') return button('Đăng nhập', () => act(() => invoke('setup_gh_login'), async () => {}));
  if (it.id === 'ngrok') {
    const { f, row } = form([['Dán authtoken của ngrok', 'password']], (token) => invoke('setup_ngrok_token', { token }));
    row.append(button('Lấy token', () => invoke('setup_ngrok_dashboard').catch(alert)));
    text.append(f);
  }
  if (it.id === 'identity') {
    const { f } = form([['Tên hiển thị trong commit'], ['Email', 'email']], (name, email) =>
      invoke('setup_identity', { name, email }),
    );
    text.append(f);
  }
  return null;
}

function renderSetup(prog) {
  setupRunning = prog.running;
  const pending = setupItems.filter((i) => i.state !== 'ok');
  const installable = setupItems.filter((i) => i.state === 'missing' && i.installable);
  $('setup-summary').textContent = !setupItems.length
    ? 'Đang kiểm tra…'
    : prog.running
      ? 'Đang cài…'
      : pending.length
        ? `${pending.length} mục cần xử lý`
        : 'Đủ cả ✓';
  const open = setupOpen ?? (pending.length > 0 || prog.running || prog.log.length > 0);
  $('setup-body').hidden = !open;
  $('setup-toggle').textContent = open ? 'Thu gọn' : 'Chi tiết';

  const list = $('setup-list');
  list.replaceChildren();
  for (const it of setupItems) {
    const current = prog.current === it.id;
    const li = el('li', `setup-item ${it.state}${current ? ' current' : ''}`);
    li.append(el('span', 'state-mark', current ? '…' : MARKS[it.state]));
    const text = el('div');
    const title = el('div', 'title', it.label);
    if (!it.required) title.append(el('span', 'muted small', ' · tùy chọn'));
    text.append(title, el('div', 'muted small detail', it.state === 'missing' ? it.detail ?? it.purpose : it.detail ?? ''));
    li.append(text);
    const action = prog.running ? null : actionFor(it, text);
    if (action) li.append(action);
    list.append(li);
  }

  $('setup-all').hidden = prog.running || installable.length === 0;
  $('setup-all').textContent = `Cài ${installable.length} mục còn thiếu`;
  $('setup-cancel').hidden = !prog.running;
  $('setup-recheck').disabled = prog.running;
  const log = $('setup-log');
  log.hidden = prog.log.length === 0;
  const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  log.textContent = prog.log.join('\n');
  if (atEnd) log.scrollTop = log.scrollHeight;
}

async function loadSetup() {
  try {
    setupItems = await invoke('setup_check');
    renderSetup(await invoke('setup_progress'));
  } catch {
    /* window opened before the app is ready */
  }
}

/** While an install runs, follow it; when it ends, check everything again. */
async function pollSetup() {
  const prog = await invoke('setup_progress');
  renderSetup(prog);
  if (prog.running) setTimeout(pollSetup, 1000);
  else loadSetup();
}

$('setup-toggle').addEventListener('click', () => {
  setupOpen = $('setup-body').hidden;
  $('setup-body').hidden = !setupOpen;
  $('setup-toggle').textContent = setupOpen ? 'Thu gọn' : 'Chi tiết';
});
$('setup-all').addEventListener('click', () => install(null));
$('setup-cancel').addEventListener('click', () => invoke('setup_cancel'));
$('setup-recheck').addEventListener('click', () => {
  $('setup-summary').textContent = 'Đang kiểm tra…';
  loadSetup();
});

refresh();
setInterval(refresh, 2000);
loadSetup().then(() => setupRunning && pollSetup());
// The window stays alive in the tray: check again whenever it is shown.
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && !setupRunning && loadSetup());
