import { totp, parseAccounts } from './totp.js';
const $ = (id) => document.getElementById(id);
let accounts = [];
let currentCode = '';
let codes = [];
let updating = false;
let importErrors = [];
let codePeriod = -1;

function updateTimer() {
  const timestamp = Date.now();
  const remaining = 30 - (timestamp % 30000) / 1000;
  $('totpCountdown').textContent = `${Math.ceil(remaining)} 秒后更新`;
  $('totpProgress').value = remaining;
  $('totpProgress').setAttribute('aria-valuetext', `${Math.ceil(remaining)} 秒后刷新`);
  if (Math.floor(timestamp / 30000) !== codePeriod) updateCodes();
}

async function copy(value, button) {
  try {
    await navigator.clipboard.writeText(value);
    const old = button.textContent; button.textContent = '已复制';
    setTimeout(() => { button.textContent = old; }, 1200);
  } catch { $('totpError').textContent = '复制失败，请检查浏览器剪贴板权限'; }
}

function copyButton(value) {
  const button = document.createElement('button'); button.className = 'mini'; button.textContent = '复制';
  button.addEventListener('click', () => copy(value, button)); return button;
}

function dataCell(row, text, copyValue = text) {
  const td = row.insertCell();
  const span = document.createElement('span'); span.textContent = text; td.appendChild(span);
  td.appendChild(copyButton(copyValue));
  return td;
}

function drawAccounts() {
  const body = $('accountsBody'); body.textContent = '';
  accounts.forEach((entry, index) => {
    const row = body.insertRow();
    dataCell(row, entry.account);
    dataCell(row, entry.password);
    dataCell(row, entry.secret);
    dataCell(row, codes[index] || '—', codes[index] || '');
  });
  $('accountsSummary').textContent = accounts.length ? `当前页面已解析 ${accounts.length} 条账号${importErrors.length ? `；跳过 ${importErrors.length} 行：${importErrors.join('；')}` : ''}` : '';
}

async function updateCodes() {
  if (updating) return;
  updating = true;
  try {
    const timestamp = Date.now();
    const secret = $('totpSecret').value.trim();
    try { currentCode = secret ? await totp(secret, timestamp) : ''; $('totpError').textContent = ''; }
    catch (err) { currentCode = ''; $('totpError').textContent = err.message; }
    $('totpCode').textContent = currentCode || '—';
    codes = await Promise.all(accounts.map((entry) => totp(entry.secret, timestamp).catch(() => '无效密钥')));
    drawAccounts();
    codePeriod = Math.floor(timestamp / 30000);
  } finally { updating = false; }
}

$('totpSecret').addEventListener('input', updateCodes);
$('btnCopyTotp').addEventListener('click', (event) => { if (currentCode) copy(currentCode, event.target); });
$('btnAccountsImport').addEventListener('click', () => { $('accountsImportError').textContent = ''; $('accountsImportModal').hidden = false; $('accountsInput').focus(); });
$('btnParseAccounts').addEventListener('click', async () => {
  const parsed = parseAccounts($('accountsInput').value);
  if (!parsed.accounts.length) { $('accountsImportError').textContent = parsed.errors.join('；') || '请输入账号列表'; return; }
  accounts = parsed.accounts; importErrors = parsed.errors;
  $('accountsImportModal').hidden = true;
  await updateCodes();
});
updateTimer();
setInterval(updateCodes, 1000);
setInterval(updateTimer, 100);
