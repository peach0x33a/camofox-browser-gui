import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { decodeBase32, totp, parseAccounts } from '../public/totp.js';

test('TOTP matches known SHA1 vectors at time boundaries', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.deepEqual([...decodeBase32(secret)], [...new TextEncoder().encode('12345678901234567890')]);
  assert.equal(await totp(secret, 59_000, webcrypto.subtle), '287082');
  assert.equal(await totp(secret, 1_111_111_109_000, webcrypto.subtle), '081804');
  assert.equal(await totp(secret, 1_234_567_890_000, webcrypto.subtle), '005924');
});

test('account list preserves symbols in password and reports invalid lines', () => {
  const input = 'ellis@example.com----2r*nQ&XUnb&+39----4D77LPR63T4VAO7CZJK32NJNK3UKLPG7\ninvalid\n';
  const { accounts, errors } = parseAccounts(input);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].password, '2r*nQ&XUnb&+39');
  assert.equal(errors.length, 1);
  assert.throws(() => decodeBase32('bad!'));
});
