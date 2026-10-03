/* Local-only TOTP and account-list parsing; secrets never leave this page. */
export function decodeBase32(value) {
  const compact = String(value || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!compact || /[^A-Z2-7]/.test(compact)) throw new Error('2FA 密钥需要是 Base32 格式');
  let buffer = 0; let bits = 0;
  const bytes = [];
  for (const char of compact) {
    buffer = (buffer << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); buffer &= (1 << bits) - 1; }
  }
  if (!bytes.length || bits >= 5 || buffer !== 0) throw new Error('2FA 密钥 Base32 长度或末尾数据无效');
  return new Uint8Array(bytes);
}

export async function totp(secret, timestamp = Date.now(), subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('当前浏览器不支持安全的 TOTP 计算');
  const key = await subtle.importKey('raw', decodeBase32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const counter = Math.floor(timestamp / 30000);
  const bytes = new Uint8Array(8);
  let value = counter;
  for (let i = 7; i >= 0; i--) { bytes[i] = value % 256; value = Math.floor(value / 256); }
  const digest = new Uint8Array(await subtle.sign('HMAC', key, bytes));
  const offset = digest.at(-1) & 15;
  const number = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(number % 1000000).padStart(6, '0');
}

export function parseAccounts(input) {
  const accounts = []; const errors = [];
  String(input || '').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const fields = line.split(/\s*-{3,}\s*/).map((field) => field.trim());
    if (fields.length !== 3 || fields.some((field) => !field)) { errors.push(`第 ${index + 1} 行格式不正确`); return; }
    try { decodeBase32(fields[2]); } catch (error) { errors.push(`第 ${index + 1} 行：${error.message}`); return; }
    accounts.push({ account: fields[0], password: fields[1], secret: fields[2] });
  });
  return { accounts, errors };
}
