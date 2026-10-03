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
let openUrlProfileId = null;
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
  settingsRendered = true;
}

async function saveSettings() {
  try {
    const data = await api('POST', '/api/settings', {
      camofoxDir: $('setCamofoxDir').value.trim(),
      basePort: Number($('setBasePort').value),
      startUrl: $('setStartUrl').value.trim(),
      defaultMode: $('setDefaultMode').value,
    });
    state = data;
    renderSettings();
    renderAll();
    toast('设置已保存', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function testProxy(id, button, type = 'node') {
  const output = $('proxyTestResult');
  const proxy = (type === 'chain' ? state.settings.chains : state.settings.proxies).find((p) => p.id === id);
  if (!proxy) return;
  button.disabled = true;
  output.textContent = `测试中… ${proxy.route.join(' → ')}`;
  output.className = 'muted small result-line';
  try {
    const result = await api('POST', '/api/proxy/test', { [type === 'chain' ? 'chainId' : 'proxyId']: proxy.id });
    if (result.ok) {
      const where = result.country ? ` ${result.country}` : '';
      output.textContent = `通畅，出口 IP ${result.ip}${where}（${result.latencyMs}ms，经 ${result.via}）`;
      output.className = 'small result-line';
    } else {
      output.textContent = result.error;
      output.className = 'error result-line';
    }
  } catch (err) {
    output.textContent = err.message;
    output.className = 'error result-line';
  } finally {
    button.disabled = false;
  }
}

// --- proxy nodes and chains ---

let editingProxyId = null;
let editingChainId = null;
let chainDraft = [];
let copying = null;

function renderProxyNodes() {
  const nodes = state.settings?.proxies || [];
  const body = $('proxyBody');
  body.textContent = '';
  $('proxyCount').textContent = nodes.length ? `共 ${nodes.length} 个节点` : '';
  $('proxyEmpty').hidden = nodes.length > 0;
  for (const node of nodes) {
    const row = document.createElement('tr');
    const name = cell(document.createTextNode(node.name)); name.dataset.label = '节点'; row.appendChild(name);
    const endpoint = cell(document.createTextNode(node.label)); endpoint.className = 'proxy'; endpoint.dataset.label = '代理地址'; row.appendChild(endpoint);
    const visible = document.createElement('input');
    visible.type = 'checkbox'; visible.checked = node.showInList;
    visible.setAttribute('aria-label', `${node.name} 展示在实例列表`);
    visible.addEventListener('change', async () => {
      visible.disabled = true;
      try {
        const data = await api('PATCH', `/api/proxies/${node.id}`, { showInList: visible.checked });
        state = data.state; renderProxyNodes(); renderTable();
      } catch (err) { visible.checked = node.showInList; toast(err.message, 'err'); }
      finally { visible.disabled = false; }
    });
    const visibilityCell = cell(visible); visibilityCell.dataset.label = '实例列表'; row.appendChild(visibilityCell);
    const actions = document.createElement('div'); actions.className = 'actions';
    actions.appendChild(button('编辑', 'mini', false, () => openProxyModal(node.id)));
    actions.appendChild(button('复制', 'mini', false, () => openCopyModal('proxies', node)));
    actions.appendChild(button('删除', 'danger mini', false, () => deleteProxy(node.id)));
    const actionCell = cell(actions); actionCell.dataset.label = '操作'; row.appendChild(actionCell); body.appendChild(row);
  }
  renderProxyChains();
}

function renderProxyChains() {
  const chains = state.settings?.chains || [];
  const body = $('chainBody');
  body.textContent = '';
  $('chainCount').textContent = chains.length ? `共 ${chains.length} 条链路` : '';
  $('chainEmpty').hidden = chains.length > 0;
  for (const chain of chains) {
    const row = document.createElement('tr');
    const name = cell(document.createTextNode(chain.name)); name.dataset.label = '链路'; row.appendChild(name);
    const components = cell(document.createTextNode(chain.items.map((item) => {
      const entry = (item.type === 'node' ? state.settings.proxies : chains).find((entry) => entry.id === item.id);
      return `${item.type === 'node' ? '节点' : '链路'}: ${entry?.name || item.id}`;
    }).join(' → ')));
    components.className = 'node-route'; components.title = components.textContent; components.dataset.label = '组成'; row.appendChild(components);
    const path = cell(document.createTextNode(chain.route.join(' → ')));
    path.className = 'node-route'; path.title = path.textContent; path.dataset.label = '完整路径'; row.appendChild(path);
    const visible = document.createElement('input');
    visible.type = 'checkbox'; visible.checked = chain.showInList;
    visible.setAttribute('aria-label', `${chain.name} 展示在实例列表`);
    visible.addEventListener('change', async () => {
      visible.disabled = true;
      try {
        const data = await api('PATCH', `/api/chains/${chain.id}`, { showInList: visible.checked });
        state = data.state; renderProxyNodes(); renderTable();
      } catch (err) { visible.checked = chain.showInList; toast(err.message, 'err'); }
      finally { visible.disabled = false; }
    });
    const visibilityCell = cell(visible); visibilityCell.dataset.label = '实例列表'; row.appendChild(visibilityCell);
    const actions = document.createElement('div'); actions.className = 'actions';
    const test = button('测试', 'mini', false, () => testProxy(chain.id, test, 'chain'));
    actions.appendChild(test);
    actions.appendChild(button('编辑', 'mini', false, () => openChainModal(chain.id)));
    actions.appendChild(button('复制', 'mini', false, () => openCopyModal('chains', chain)));
    actions.appendChild(button('删除', 'danger mini', false, () => deleteChain(chain.id)));
    const actionCell = cell(actions); actionCell.dataset.label = '操作'; row.appendChild(actionCell);
    body.appendChild(row);
  }
}

function fillNodeSelect(select, selectedId = '') {
  select.textContent = '';
  select.appendChild(new Option('不使用代理', ''));
  for (const [label, type, entries] of [
    ['代理节点', 'node', state.settings?.proxies || []], ['代理链路', 'chain', state.settings?.chains || []],
  ]) {
    const group = document.createElement('optgroup'); group.label = label;
    for (const entry of entries) {
      if (entry.showInList) group.appendChild(new Option(`${entry.name} · ${entry.route.join(' → ')}`, `${type}:${entry.id}`));
    }
    if (group.childElementCount) select.appendChild(group);
  }
  select.value = selectedId;
}

function selectedProxyTarget(value) {
  const [type, id] = value.split(':');
  return { proxyMode: id ? type : 'none', proxyNodeId: type === 'node' ? id : '', proxyChainId: type === 'chain' ? id : '' };
}

function openChainModal(id) {
  editingChainId = id || null;
  const chain = (state.settings.chains || []).find((entry) => entry.id === id);
  $('chainModalTitle').textContent = chain ? `编辑链路 · ${chain.name}` : '新增链路';
  $('chainName').value = chain?.name || '';
  $('chainShow').checked = chain?.showInList !== false;
  $('chainModalError').textContent = '';
  chainDraft = chain?.items.map((item) => ({ ...item })) || [];
  renderChainDraft();
  showModal('chainModal');
  $('chainName').focus();
}

function renderChainDraft() {
  const body = $('chainItems'); body.textContent = '';
  chainDraft.forEach((item, index) => {
    const row = document.createElement('div'); row.className = 'chain-item';
    const label = document.createElement('span'); label.textContent = `${index + 1}. ${item.type === 'node' ? '代理节点' : '代理链路'}`; row.appendChild(label);
    const select = document.createElement('select');
    const options = item.type === 'node' ? state.settings.proxies : state.settings.chains.filter((entry) => entry.id !== editingChainId);
    for (const entry of options) select.appendChild(new Option(entry.name, entry.id));
    select.value = item.id;
    select.addEventListener('change', () => { item.id = select.value; });
    row.appendChild(select);
    row.appendChild(button('↑', 'mini', index === 0, () => { [chainDraft[index - 1], chainDraft[index]] = [chainDraft[index], chainDraft[index - 1]]; renderChainDraft(); }));
    row.appendChild(button('↓', 'mini', index === chainDraft.length - 1, () => { [chainDraft[index + 1], chainDraft[index]] = [chainDraft[index], chainDraft[index + 1]]; renderChainDraft(); }));
    row.appendChild(button('移除', 'danger mini', false, () => { chainDraft.splice(index, 1); renderChainDraft(); }));
    body.appendChild(row);
  });
}

function addChainItem(type) {
  const entries = type === 'node' ? state.settings.proxies : state.settings.chains.filter((entry) => entry.id !== editingChainId);
  if (!entries.length) return toast(type === 'node' ? '请先添加代理节点' : '还没有可添加的链路', 'err');
  chainDraft.push({ type, id: entries[0].id }); renderChainDraft();
}

async function saveChain() {
  try {
    const body = { name: $('chainName').value.trim(), showInList: $('chainShow').checked, items: chainDraft };
    const data = editingChainId ? await api('PATCH', `/api/chains/${editingChainId}`, body) : await api('POST', '/api/chains', body);
    state = data.state; renderProxyNodes(); renderAll(); hideModal('chainModal'); toast('链路已保存', 'ok');
  } catch (err) { $('chainModalError').textContent = err.message; }
}

async function deleteChain(id) {
  const chain = state.settings.chains.find((entry) => entry.id === id);
  if (!confirm(`删除链路「${chain.name}」？`)) return;
  try {
    const data = await api('DELETE', `/api/chains/${id}`);
    state = data.state; renderProxyNodes(); renderAll(); toast('链路已删除', 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

function openCopyModal(kind, entry) {
  copying = { kind, id: entry.id };
  $('copyModalTitle').textContent = `复制${kind === 'chains' ? '链路' : '节点'} · ${entry.name}`;
  $('copyModalError').textContent = '';
  $('copyCount').value = 1;
  showModal('copyModal'); $('copyCount').focus();
}

async function copyItem() {
  try {
    const data = await api('POST', `/api/${copying.kind}/${copying.id}/copy`, { count: Number($('copyCount').value) });
    state = data.state; renderProxyNodes(); renderAll(); hideModal('copyModal'); toast(`已复制 ${data.created} 份`, 'ok');
  } catch (err) { $('copyModalError').textContent = err.message; }
}

function openProxyModal(id) {
  editingProxyId = id || null;
  const proxy = id ? (state.settings.proxies || []).find((p) => p.id === id) : null;
  $('proxyModalTitle').textContent = proxy ? `编辑节点 · ${proxy.name}` : '添加节点';
  $('proxyModalError').textContent = '';
  $('pxName').value = proxy?.name || '';
  $('pxShow').checked = proxy?.showInList !== false;
  $('pxScheme').value = proxy?.scheme || 'http';
  $('pxHost').value = proxy?.host || '';
  $('pxPort').value = proxy?.port || '';
  $('pxUser').value = proxy?.username || '';
  $('pxPass').value = proxy?.password || '';
  $('pxPaste').value = '';
  showModal('proxyModal');
  $('pxName').focus();
}

function readProxyForm() {
  return {
    name: $('pxName').value.trim(),
    showInList: $('pxShow').checked,
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
    if ($('pxPaste').value.trim()) {
      const parsed = await api('POST', '/api/proxy/parse', { line: $('pxPaste').value.trim() });
      for (const [field, id] of [['scheme', 'pxScheme'], ['host', 'pxHost'], ['port', 'pxPort'], ['username', 'pxUser'], ['password', 'pxPass']]) {
        $(id).value = parsed.proxy[field];
      }
      $('pxPaste').value = '';
    }
    if (editingProxyId) {
      const data = await api('PATCH', `/api/proxies/${editingProxyId}`, readProxyForm());
      state = data.state;
      renderProxyNodes(); renderAll();
      hideModal('proxyModal');
      toast('已保存', 'ok');
      return;
    }
    const data = await api('POST', '/api/proxies', { node: readProxyForm() });
    state = data.state;
    renderProxyNodes(); renderAll();
    hideModal('proxyModal');
    toast('节点已添加', 'ok');
  } catch (err) {
    $('proxyModalError').textContent = err.message;
  }
}

async function deleteProxy(id) {
  const proxy = (state.settings.proxies || []).find((p) => p.id === id);
  if (!proxy) return;
  if (!confirm(`删除节点「${proxy.name}」？`)) return;
  try {
    const data = await api('DELETE', `/api/proxies/${proxy.id}`);
    state = data.state;
    renderProxyNodes();
    renderAll();
    toast('节点已删除', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function importProxies() {
  try {
    const data = await api('POST', '/api/proxies', { list: $('pxImportList').value });
    state = data.state;
    renderProxyNodes(); renderAll();
    if (data.errors.length) {
      $('proxyImportError').textContent = `已导入 ${data.added} 个；${data.errors.length} 行失败：${data.errors.join('；')}`;
      return;
    }
    hideModal('proxyImportModal');
    toast(`已导入 ${data.added} 个节点${data.duplicates ? `，跳过 ${data.duplicates} 个重复项` : ''}`, 'ok');
  } catch (err) { $('proxyImportError').textContent = err.message; }
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
    if (!['node', 'chain'].includes(profile.proxyMode) && profile.upstreamProxyLabel) {
      const front = document.createElement('div');
      front.className = 'muted small';
      front.textContent = '前置: ' + profile.upstreamProxyLabel;
      front.title = front.textContent;
      proxyCell.appendChild(front);
    }
    proxyCell.title = profile.proxyLabel;
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
    actions.appendChild(button('打开网址', 'mini', false, () => openUrl(profile.id)));
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

function renderUrlPresets(selected = $('openUrlPreset').value) {
  const select = $('openUrlPreset');
  select.textContent = '';
  select.appendChild(new Option('选择预设', ''));
  for (const url of state.settings?.urlPresets || []) select.appendChild(new Option(url, url));
  select.value = selected;
  $('btnDeleteUrlPreset').disabled = !select.value;
}

function openUrl(id) {
  openUrlProfileId = id;
  const profile = state.profiles.find((p) => p.id === id);
  $('openUrlTitle').textContent = `在 ${profile.name} 中打开网址`;
  $('openUrlInput').value = profile.effectiveStartUrl || '';
  $('openUrlError').textContent = '';
  renderUrlPresets('');
  $('btnOpenUrl').disabled = statusOf(id).status !== 'running';
  showModal('openUrlModal');
  $('openUrlInput').focus();
}

async function saveUrlPreset() {
  try {
    const data = await api('POST', '/api/url-presets', { url: $('openUrlInput').value });
    state = data.state;
    $('openUrlInput').value = data.url;
    renderUrlPresets(data.url);
    $('openUrlError').textContent = '';
    toast('网址预设已保存', 'ok');
  } catch (err) { $('openUrlError').textContent = err.message; }
}

async function deleteUrlPreset() {
  const url = $('openUrlPreset').value;
  if (!url) return;
  try {
    const data = await api('DELETE', `/api/url-presets?url=${encodeURIComponent(url)}`);
    state = data.state;
    renderUrlPresets('');
    $('openUrlError').textContent = '';
    toast('预设已删除', 'ok');
  } catch (err) { $('openUrlError').textContent = err.message; }
}

async function submitOpenUrl() {
  if (!openUrlProfileId) return;
  try {
    await api('POST', `/api/profiles/${openUrlProfileId}/open`, { url: $('openUrlInput').value });
    hideModal('openUrlModal');
    toast('已打开新标签页', 'ok');
  } catch (err) { $('openUrlError').textContent = err.message; }
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

function openProfileModal(id) {
  editingId = id || null;
  const profile = id ? state.profiles.find((p) => p.id === id) : null;
  $('profileModalTitle').textContent = profile ? `编辑 ${profile.name}` : '新建 Profile';
  $('profileModalError').textContent = '';
  $('pfName').value = profile?.name || '';
  $('pfMode').value = profile?.mode || state.settings.defaultMode || 'visible';
  $('pfStartUrl').value = profile?.startUrl || '';
  $('pfPort').value = profile?.port || '';
  fillNodeSelect($('pfProxyNode'), profile?.proxyMode === 'node' ? `node:${profile.proxyNodeId}` : profile?.proxyMode === 'chain' ? `chain:${profile.proxyChainId}` : '');
  $('pfNote').value = profile?.note || '';
  showModal('profileModal');
  $('pfName').focus();
}

async function saveProfile() {
  const payload = {
    name: $('pfName').value.trim(),
    mode: $('pfMode').value,
    startUrl: $('pfStartUrl').value.trim(),
    ...selectedProxyTarget($('pfProxyNode').value),
    note: $('pfNote').value.trim(),
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

function openBatchModal() {
  $('batchModalError').textContent = '';
  $('bcMode').value = state.settings.defaultMode || 'visible';
  fillNodeSelect($('bcProxyNode'));
  showModal('batchModal');
  $('bcPrefix').focus();
}

async function saveBatch() {
  try {
    const data = await api('POST', '/api/profiles/batch', {
      prefix: $('bcPrefix').value.trim(),
      mode: $('bcMode').value,
      count: Number($('bcCount').value),
      startUrl: $('bcStartUrl').value.trim(),
      ...selectedProxyTarget($('bcProxyNode').value),
    });
    state = data.state;
    renderAll();
    hideModal('batchModal');
    toast(`已创建 ${data.created} 个 profile`, 'ok');
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
    renderProxyNodes();
    renderUrlPresets();
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

const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
function activateTab(tab, focus = false) {
  for (const item of tabs) {
    const active = item === tab;
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
    $(item.getAttribute('aria-controls')).hidden = !active;
  }
  if (focus) tab.focus();
}
for (const tab of tabs) {
  tab.addEventListener('click', () => activateTab(tab));
  tab.addEventListener('keydown', (event) => {
    const index = tabs.indexOf(tab);
    const target = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length]
      : event.key === 'ArrowLeft' ? tabs[(index - 1 + tabs.length) % tabs.length]
        : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : null;
    if (!target) return;
    event.preventDefault();
    activateTab(target, true);
  });
}

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
$('openUrlPreset').addEventListener('change', (event) => {
  if (event.target.value) $('openUrlInput').value = event.target.value;
  $('btnDeleteUrlPreset').disabled = !event.target.value;
});
$('btnSaveUrlPreset').addEventListener('click', saveUrlPreset);
$('btnDeleteUrlPreset').addEventListener('click', deleteUrlPreset);
$('btnOpenUrl').addEventListener('click', submitOpenUrl);
$('btnChainAdd').addEventListener('click', () => openChainModal(null));
$('btnChainItemNode').addEventListener('click', () => addChainItem('node'));
$('btnChainItemChain').addEventListener('click', () => addChainItem('chain'));
$('btnSaveChain').addEventListener('click', saveChain);
$('btnConfirmCopy').addEventListener('click', copyItem);
$('btnProxyAdd').addEventListener('click', () => openProxyModal(null));
$('btnProxyImport').addEventListener('click', () => {
  $('proxyImportError').textContent = '';
  $('pxImportList').value = '';
  showModal('proxyImportModal');
  $('pxImportList').focus();
});
$('btnSaveProxyImport').addEventListener('click', importProxies);
$('btnSaveProxy').addEventListener('click', saveProxy);
$('pxPaste').addEventListener('change', async (event) => {
  if (!event.target.value.trim()) return;
  try {
    const { proxy } = await api('POST', '/api/proxy/parse', { line: event.target.value.trim() });
    for (const [field, id] of [['scheme', 'pxScheme'], ['host', 'pxHost'], ['port', 'pxPort'], ['username', 'pxUser'], ['password', 'pxPass']]) $(id).value = proxy[field];
    event.target.value = '';
    $('proxyModalError').textContent = '';
  } catch (err) { $('proxyModalError').textContent = err.message; }
});
$('btnNew').addEventListener('click', () => openProfileModal(null));
$('btnBatch').addEventListener('click', openBatchModal);
$('btnStartSelected').addEventListener('click', bulkStart);
$('btnStopSelected').addEventListener('click', bulkStop);
$('btnDeleteSelected').addEventListener('click', bulkDelete);
$('btnSaveProfile').addEventListener('click', saveProfile);
$('btnSaveBatch').addEventListener('click', saveBatch);
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
