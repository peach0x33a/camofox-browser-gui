/* camofox-gui front-end: no framework, no build step. */

const $ = (id) => document.getElementById(id);
const PASSWORD_PLACEHOLDER = '••••••';

const STATUS_TEXT = {
  stopped: '已停止',
  starting: '启动中…',
  running: '运行中',
  stopping: '停止中…',
  error: '出错',
};

let state = { settings: {}, profiles: [], statuses: [] };
let selected = new Set();
let logFilter = '';
const logs = new Map();
let editingId = null;
let settingsRendered = false;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toast(message, kind = '') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, kind === 'err' ? 6000 : 3000);
}

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function statusOf(id) {
  return state.statuses.find((s) => s.id === id) || { status: 'stopped', port: 0 };
}

function busy(status) {
  return status === 'starting' || status === 'stopping';
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

function renderSettings() {
  const s = state.settings || {};
  $('setCamofoxDir').value = s.camofoxDir || '';
  $('setBasePort').value = s.basePort || 9400;
  $('setStartUrl').value = s.startUrl || '';
  $('setDefaultMode').value = s.defaultMode || 'visible';
  $('camofoxDirLabel').textContent = s.camofoxDir || '未检测到 camofox-browser 目录，请在全局设置里填写';
  renderProxySelect();
  settingsRendered = true;
}

/** The saved-proxy dropdown. Labels are pre-masked by the server. */
function renderProxySelect() {
  const select = $('setProxySelect');
  const proxies = state.settings?.proxies || [];
  select.textContent = '';
  select.appendChild(new Option(proxies.length ? '不使用全局代理' : '还没有保存任何代理，点「+ 添加」', ''));
  for (const proxy of proxies) select.appendChild(new Option(proxy.label, proxy.id));
  select.value = state.settings?.proxyId || '';
  const none = !select.value;
  $('btnProxyEdit').disabled = none;
  $('btnProxyDelete').disabled = none;
  $('btnTestProxy').disabled = none;
}

function selectedProxy() {
  const id = $('setProxySelect').value;
  return (state.settings?.proxies || []).find((p) => p.id === id) || null;
}

async function saveSettings() {
  try {
    const data = await api('POST', '/api/settings', {
      camofoxDir: $('setCamofoxDir').value.trim(),
      basePort: Number($('setBasePort').value),
      startUrl: $('setStartUrl').value.trim(),
      defaultMode: $('setDefaultMode').value,
      proxyId: $('setProxySelect').value,
    });
    state = data;
    renderSettings();
    renderAll();
    toast('设置已保存', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function testProxy() {
  const button = $('btnTestProxy');
  const output = $('proxyTestResult');
  const proxy = selectedProxy();
  if (!proxy) return toast('请先选择一个代理', 'err');
  button.disabled = true;
  output.textContent = `测试中… ${proxy.label}`;
  output.className = 'muted small result-line';
  try {
    const result = await api('POST', '/api/proxy/test', { proxyId: proxy.id });
    if (result.ok) {
      const where = result.country ? ` ${result.country}` : '';
      output.textContent = `✅ 通畅，出口 IP ${result.ip}${where}（${result.latencyMs}ms，经 ${result.via}）`;
      output.className = 'small result-line';
    } else {
      output.textContent = `❌ ${result.error}`;
      output.className = 'error result-line';
    }
  } catch (err) {
    output.textContent = `❌ ${err.message}`;
    output.className = 'error result-line';
  } finally {
    button.disabled = false;
  }
}

// --- proxy pool management ---

let editingProxyId = null;

function openProxyModal(id) {
  editingProxyId = id || null;
  const proxy = id ? (state.settings.proxies || []).find((p) => p.id === id) : null;
  $('proxyModalTitle').textContent = proxy ? '编辑代理' : '添加代理';
  $('proxyModalError').textContent = '';
  $('proxyPasteBlock').hidden = !!proxy; // pasting a list only makes sense when adding
  $('pxList').value = '';
  $('pxScheme').value = proxy?.scheme || 'http';
  $('pxHost').value = proxy?.host || '';
  $('pxPort').value = proxy?.port || '';
  $('pxUser').value = proxy?.username || '';
  $('pxPass').value = proxy?.password || '';
  showModal('proxyModal');
  (proxy ? $('pxHost') : $('pxList')).focus();
}

function readProxyForm() {
  return {
    enabled: true,
    scheme: $('pxScheme').value,
    host: $('pxHost').value.trim(),
    port: $('pxPort').value.trim(),
    username: $('pxUser').value.trim(),
    password: $('pxPass').value,
  };
}

async function saveProxy() {
  try {
    if (editingProxyId) {
      const data = await api('PATCH', `/api/proxies/${editingProxyId}`, { proxy: readProxyForm() });
      state = data.state;
      renderSettings();
      hideModal('proxyModal');
      toast('已保存', 'ok');
      return;
    }
    const form = readProxyForm();
    const data = await api('POST', '/api/proxies', {
      list: $('pxList').value,
      proxy: form.host ? form : undefined,
    });
    state = data.state;
    renderSettings();
    if (data.errors.length) {
      $('proxyModalError').textContent = `已添加 ${data.added} 个；${data.errors.length} 行没解析成功：${data.errors.join('；')}`;
      return;
    }
    hideModal('proxyModal');
    const dup = data.duplicates ? `，${data.duplicates} 个已存在跳过` : '';
    toast(data.added ? `已添加 ${data.added} 个代理${dup}` : `没有新增，${data.duplicates} 个已存在`, 'ok');
  } catch (err) {
    $('proxyModalError').textContent = err.message;
  }
}

async function deleteProxy() {
  const proxy = selectedProxy();
  if (!proxy) return;
  const following = state.profiles.filter((p) => p.proxyMode === 'global').length;
  const warn = proxy.id === state.settings.proxyId && following
    ? `\n有 ${following} 个 profile 正在「跟随全局」，删除后会改用列表里的下一个代理。`
    : '';
  if (!confirm(`删除代理 ${proxy.label}？${warn}`)) return;
  try {
    const data = await api('DELETE', `/api/proxies/${proxy.id}`);
    state = data.state;
    renderSettings();
    renderAll();
    toast('已删除', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------------------------------------------------------------------------
// profile table
// ---------------------------------------------------------------------------

function renderTable() {
  const body = $('profileBody');
  body.textContent = '';
  $('profileCount').textContent = state.profiles.length ? `共 ${state.profiles.length} 个` : '';
  $('emptyHint').hidden = state.profiles.length > 0;

  for (const profile of state.profiles) {
    const status = statusOf(profile.id);
    const row = document.createElement('tr');
    if (selected.has(profile.id)) row.className = 'selected';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selected.has(profile.id);
    check.addEventListener('change', () => {
      if (check.checked) selected.add(profile.id); else selected.delete(profile.id);
      renderTable();
    });
    row.appendChild(cell(check));

    const name = document.createElement('div');
    name.textContent = profile.name;
    if (profile.note) {
      const note = document.createElement('div');
      note.className = 'muted small';
      note.textContent = profile.note;
      name.appendChild(note);
    }
    row.appendChild(cell(name));

    const mode = document.createElement('span');
    mode.className = 'tag';
    mode.textContent = profile.mode === 'visible' ? '可见窗口' : '无头';
    row.appendChild(cell(mode));

    const proxyCell = cell(document.createTextNode(profile.proxyLabel));
    proxyCell.className = 'proxy';
    proxyCell.title = `${profile.proxyMode === 'custom' ? '独立代理' : profile.proxyMode === 'none' ? '不使用代理' : '跟随全局'} · ${profile.proxyLabel}`;
    row.appendChild(proxyCell);

    row.appendChild(cell(document.createTextNode(String(status.port || profile.port || '-'))));

    const badge = document.createElement('span');
    badge.className = `badge ${status.status}`;
    badge.textContent = STATUS_TEXT[status.status] || status.status;
    if (status.status === 'running' && status.health && status.health.browserConnected === false) {
      badge.textContent = '运行中（浏览器已关闭）';
    }
    if (status.error) badge.title = status.error;
    row.appendChild(cell(badge));

    const actions = document.createElement('div');
    actions.className = 'actions';
    const running = status.status === 'running';
    actions.appendChild(button(running ? '停止' : '启动', running ? 'danger mini' : 'primary mini', busy(status.status), () => (
      running ? stopProfile(profile.id) : startProfile(profile.id)
    )));
    actions.appendChild(button('打开网址', 'mini', !running, () => openUrl(profile.id)));
    if (profile.mode === 'headless' && running) {
      actions.appendChild(button('API 文档', 'mini', false, () => window.open(`http://127.0.0.1:${status.port}/docs`, '_blank')));
    }
    actions.appendChild(button('编辑', 'mini', false, () => openProfileModal(profile.id)));
    actions.appendChild(button('删除', 'danger mini', busy(status.status), () => deleteProfile(profile.id)));
    row.appendChild(cell(actions));

    body.appendChild(row);
  }

  $('checkAll').checked = state.profiles.length > 0 && selected.size === state.profiles.length;
}

function cell(child) {
  const td = document.createElement('td');
  td.appendChild(child);
  return td;
}

function button(label, className, disabled, onClick) {
  const el = document.createElement('button');
  el.className = className;
  el.textContent = label;
  el.disabled = disabled;
  el.addEventListener('click', onClick);
  return el;
}

function renderLogSelect() {
  const select = $('logSelect');
  const previous = select.value;
  select.textContent = '';
  const all = new Option('全部 profile', '');
  select.appendChild(all);
  for (const profile of state.profiles) {
    select.appendChild(new Option(profile.name, profile.id));
  }
  select.value = state.profiles.some((p) => p.id === previous) ? previous : '';
  logFilter = select.value;
}

function renderAll() {
  renderTable();
  renderLogSelect();
  renderLogs();
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function startProfile(id) {
  try {
    logFilter = id;
    $('logSelect').value = id;
    renderLogs();
    await api('POST', `/api/profiles/${id}/start`);
    toast('已启动', 'ok');
  } catch (err) {
    toast(`启动失败: ${err.message}`, 'err');
  }
}

async function stopProfile(id) {
  try {
    await api('POST', `/api/profiles/${id}/stop`);
    toast('已停止', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function openUrl(id) {
  const url = prompt('要在该 profile 里打开的网址：', state.profiles.find((p) => p.id === id)?.effectiveStartUrl || 'https://');
  if (!url) return;
  try {
    await api('POST', `/api/profiles/${id}/open`, { url });
    toast('已打开新标签页', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function deleteProfile(id) {
  const profile = state.profiles.find((p) => p.id === id);
  if (!confirm(`删除 profile「${profile?.name}」？\n确定后同时删除它的 cookie / 登录状态数据。`)) return;
  try {
    const data = await api('DELETE', `/api/profiles/${id}?purge=1`);
    selected.delete(id);
    state = data.state;
    renderAll();
    toast('已删除', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function bulkStart() {
  const ids = [...selected];
  if (!ids.length) return toast('请先勾选 profile', 'err');
  toast(`正在依次启动 ${ids.length} 个 profile…`);
  try {
    const data = await api('POST', '/api/bulk/start', { ids });
    const failed = data.results.filter((r) => !r.ok);
    if (failed.length) toast(`${ids.length - failed.length} 个成功，${failed.length} 个失败：${failed[0].error}`, 'err');
    else toast('全部启动完成', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function bulkStop() {
  const ids = [...selected];
  try {
    const data = await api('POST', '/api/bulk/stop', { ids });
    state = data.state;
    renderAll();
    toast(ids.length ? '已停止选中的 profile' : '已停止全部 profile', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function bulkDelete() {
  const ids = [...selected];
  if (!ids.length) return toast('请先勾选 profile', 'err');
  if (!confirm(`删除选中的 ${ids.length} 个 profile？同时删除它们的登录状态数据。`)) return;
  for (const id of ids) {
    try {
      const data = await api('DELETE', `/api/profiles/${id}?purge=1`);
      state = data.state;
    } catch (err) {
      toast(err.message, 'err');
    }
  }
  selected.clear();
  renderAll();
  toast('已删除', 'ok');
}

// ---------------------------------------------------------------------------
// modals
// ---------------------------------------------------------------------------

function showModal(id) { $(id).hidden = false; }
function hideModal(id) { $(id).hidden = true; }

function syncProxyFields() {
  $('pfProxyFields').classList.toggle('hidden', $('pfProxyMode').value !== 'custom');
}

function openProfileModal(id) {
  editingId = id || null;
  const profile = id ? state.profiles.find((p) => p.id === id) : null;
  $('profileModalTitle').textContent = profile ? `编辑 ${profile.name}` : '新建 Profile';
  $('profileModalError').textContent = '';
  $('pfName').value = profile?.name || '';
  $('pfMode').value = profile?.mode || state.settings.defaultMode || 'visible';
  $('pfStartUrl').value = profile?.startUrl || '';
  $('pfPort').value = profile?.port || '';
  $('pfProxyMode').value = profile?.proxyMode || 'global';
  $('pfNote').value = profile?.note || '';
  const proxy = profile?.proxy || {};
  $('pfProxyScheme').value = proxy.scheme || 'http';
  $('pfProxyHost').value = proxy.host || '';
  $('pfProxyPort').value = proxy.port || '';
  $('pfProxyUser').value = proxy.username || '';
  $('pfProxyPass').value = proxy.password || '';
  $('pfProxyPaste').value = '';
  syncProxyFields();
  showModal('profileModal');
  $('pfName').focus();
}

async function saveProfile() {
  const payload = {
    name: $('pfName').value.trim(),
    mode: $('pfMode').value,
    startUrl: $('pfStartUrl').value.trim(),
    proxyMode: $('pfProxyMode').value,
    note: $('pfNote').value.trim(),
    proxy: {
      enabled: true,
      scheme: $('pfProxyScheme').value,
      host: $('pfProxyHost').value.trim(),
      port: $('pfProxyPort').value.trim(),
      username: $('pfProxyUser').value.trim(),
      password: $('pfProxyPass').value,
    },
  };
  const port = $('pfPort').value.trim();
  if (port) payload.port = Number(port);
  if (!payload.name) {
    $('profileModalError').textContent = '名称不能为空';
    return;
  }
  try {
    const data = editingId
      ? await api('PATCH', `/api/profiles/${editingId}`, payload)
      : await api('POST', '/api/profiles', payload);
    state = data.state;
    renderAll();
    hideModal('profileModal');
    toast(editingId ? '已保存' : '已创建', 'ok');
  } catch (err) {
    $('profileModalError').textContent = err.message;
  }
}

async function pasteProxy(value) {
  const line = value.trim();
  if (!line) return;
  try {
    const { proxy } = await api('POST', '/api/proxy/parse', { line });
    $('pfProxyScheme').value = proxy.scheme;
    $('pfProxyHost').value = proxy.host;
    $('pfProxyPort').value = proxy.port;
    $('pfProxyUser').value = proxy.username;
    $('pfProxyPass').value = proxy.password;
    $('pfProxyMode').value = 'custom';
    syncProxyFields();
    $('pfProxyPaste').value = '';
    $('profileModalError').textContent = '';
  } catch (err) {
    $('profileModalError').textContent = err.message;
  }
}

function openBatchModal() {
  $('batchModalError').textContent = '';
  $('bcChoice').hidden = true;
  $('bcMode').value = state.settings.defaultMode || 'visible';
  showModal('batchModal');
  $('bcProxyList').focus();
}

async function saveBatch(shortage) {
  try {
    const data = await api('POST', '/api/profiles/batch', {
      prefix: $('bcPrefix').value.trim(),
      mode: $('bcMode').value,
      count: Number($('bcCount').value),
      startUrl: $('bcStartUrl').value.trim(),
      proxyList: $('bcProxyList').value,
      shortage,
    });

    // Fewer proxies than profiles: the server created nothing and wants a call.
    if (data.needsChoice) {
      $('bcChoiceText').textContent =
        `只粘贴了 ${data.proxyCount} 条代理，但要创建 ${data.count} 个 profile。不足的部分怎么处理？`;
      $('bcSetGlobal').hidden = data.proxyCount !== 1;
      $('bcChoice').hidden = false;
      // Show which lines failed to parse *before* the user decides -- the
      // "只粘贴了 N 条" count is otherwise misleading when lines were dropped.
      $('batchModalError').textContent = data.errors.length
        ? `${data.errors.length} 行没解析成功（不计入上面的条数）：${data.errors.join('；')}`
        : '';
      return;
    }

    state = data.state;
    renderSettings(); // setGlobal may have just replaced the global proxy
    renderAll();
    // Parse errors are worth reading in full, so keep the dialog open for them.
    if (data.errors.length) {
      $('bcChoice').hidden = true;
      $('batchModalError').textContent = `已创建 ${data.created} 个；${data.errors.length} 行没解析成功：${data.errors.join('；')}`;
      toast(`已创建 ${data.created} 个 profile，${data.errors.length} 行有问题`, 'err');
      return;
    }
    hideModal('batchModal');
    toast(data.note ? `已创建 ${data.created} 个 profile（${data.note}）` : `已创建 ${data.created} 个 profile`, 'ok');
  } catch (err) {
    $('batchModalError').textContent = err.message;
  }
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

function pushLog(profileId, entry) {
  if (!logs.has(profileId)) logs.set(profileId, []);
  const list = logs.get(profileId);
  list.push(entry);
  if (list.length > 800) list.splice(0, list.length - 800);
  if (logFilter && logFilter !== profileId) return;
  appendLogLine(profileId, entry);
}

function appendLogLine(profileId, entry) {
  const view = $('logView');
  const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
  const line = document.createElement('div');
  line.className = `l-${entry.level}`;
  const name = state.profiles.find((p) => p.id === profileId)?.name || profileId;
  const time = entry.ts.slice(11, 19);
  line.textContent = logFilter ? `${time}  ${entry.line}` : `${time}  [${name}] ${entry.line}`;
  view.appendChild(line);
  while (view.childElementCount > 1000) view.removeChild(view.firstChild);
  if (atBottom) view.scrollTop = view.scrollHeight;
}

function renderLogs() {
  const view = $('logView');
  view.textContent = '';
  const entries = [];
  for (const [profileId, list] of logs) {
    if (logFilter && logFilter !== profileId) continue;
    for (const entry of list) entries.push([profileId, entry]);
  }
  entries.sort((a, b) => a[1].ts.localeCompare(b[1].ts));
  for (const [profileId, entry] of entries) appendLogLine(profileId, entry);
  view.scrollTop = view.scrollHeight;
}

async function loadLogs(profileId) {
  try {
    const data = await api('GET', `/api/profiles/${profileId}/logs`);
    logs.set(profileId, data.logs);
  } catch { /* profile may have been removed */ }
}

// ---------------------------------------------------------------------------
// live updates
// ---------------------------------------------------------------------------

function connect() {
  const source = new EventSource('/api/events');

  source.addEventListener('open', () => {
    $('connDot').className = 'dot on';
    $('connText').textContent = '已连接';
  });

  source.addEventListener('error', () => {
    $('connDot').className = 'dot off';
    $('connText').textContent = '连接断开，重试中…';
  });

  source.addEventListener('state', async (event) => {
    state = JSON.parse(event.data);
    // Re-render the settings pane on every state push, otherwise it keeps
    // showing stale values (e.g. after a batch "设为全局代理" or an edit in
    // another tab) and the next "保存设置" would write those stale values back,
    // silently reverting the server. Skipped while the user is typing in it.
    const editing = $('settingsBody').contains(document.activeElement);
    if (!settingsRendered || !editing) renderSettings();
    // Drop selections for profiles that no longer exist (deleted here or in
    // another tab), otherwise bulk actions carry dead IDs and the "select all"
    // checkbox never matches.
    const live = new Set(state.profiles.map((p) => p.id));
    for (const id of [...selected]) if (!live.has(id)) selected.delete(id);
    renderAll();
    // Only fetch history for profiles this tab has never seen.
    const missing = state.profiles.filter((p) => !logs.has(p.id));
    if (missing.length) {
      await Promise.all(missing.map((p) => loadLogs(p.id)));
      renderLogs();
    }
  });

  source.addEventListener('logreset', (event) => {
    const { profileId } = JSON.parse(event.data);
    logs.set(profileId, []);
    renderLogs();
  });

  source.addEventListener('status', (event) => {
    const status = JSON.parse(event.data);
    const index = state.statuses.findIndex((s) => s.id === status.id);
    if (index === -1) state.statuses.push(status); else state.statuses[index] = status;
    renderTable();
  });

  source.addEventListener('log', (event) => {
    const { profileId, entry } = JSON.parse(event.data);
    pushLog(profileId, entry);
  });
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

document.querySelectorAll('[data-toggle]').forEach((head) => {
  head.addEventListener('click', () => {
    head.classList.toggle('collapsed');
    $(head.dataset.toggle).classList.toggle('hidden');
  });
});

document.querySelectorAll('[data-close-modal]').forEach((el) => {
  el.addEventListener('click', () => hideModal(el.dataset.closeModal));
});

document.querySelectorAll('.modal').forEach((modal) => {
  modal.addEventListener('mousedown', (event) => {
    if (event.target === modal) modal.hidden = true;
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
});

$('btnSaveSettings').addEventListener('click', saveSettings);
$('btnTestProxy').addEventListener('click', testProxy);
$('btnProxyAdd').addEventListener('click', () => openProxyModal(null));
$('btnProxyEdit').addEventListener('click', () => openProxyModal($('setProxySelect').value));
$('btnProxyDelete').addEventListener('click', deleteProxy);
$('btnSaveProxy').addEventListener('click', saveProxy);
$('setProxySelect').addEventListener('change', () => {
  // Switching the selection immediately reflects which buttons apply; the
  // choice itself is only persisted by "保存设置".
  const none = !$('setProxySelect').value;
  $('btnProxyEdit').disabled = none;
  $('btnProxyDelete').disabled = none;
  $('btnTestProxy').disabled = none;
  $('proxyTestResult').textContent = '';
});
$('btnNew').addEventListener('click', () => openProfileModal(null));
$('btnBatch').addEventListener('click', openBatchModal);
$('btnStartSelected').addEventListener('click', bulkStart);
$('btnStopSelected').addEventListener('click', bulkStop);
$('btnDeleteSelected').addEventListener('click', bulkDelete);
$('btnSaveProfile').addEventListener('click', saveProfile);
$('btnSaveBatch').addEventListener('click', () => saveBatch());
document.querySelectorAll('[data-shortage]').forEach((button) => {
  button.addEventListener('click', () => saveBatch(button.dataset.shortage));
});
$('pfProxyMode').addEventListener('change', syncProxyFields);
$('pfProxyPaste').addEventListener('change', (event) => pasteProxy(event.target.value));
$('checkAll').addEventListener('change', (event) => {
  selected = event.target.checked ? new Set(state.profiles.map((p) => p.id)) : new Set();
  renderTable();
});
$('logSelect').addEventListener('change', (event) => {
  logFilter = event.target.value;
  renderLogs();
});
$('btnClearLog').addEventListener('click', () => {
  logs.clear();
  renderLogs();
});

connect();
