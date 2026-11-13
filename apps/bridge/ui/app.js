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

const AGENT_LABELS = { claude: 'Claude Code', antigravity: 'Antigravity (agy)' };

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

refresh();
setInterval(refresh, 2000);
