const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const context = {
  console,
  crypto: require('node:crypto').webcrypto,
  window: { crypto: require('node:crypto').webcrypto },
  TextEncoder,
  TextDecoder,
  Uint8Array,
  ArrayBuffer,
  atob: (value) => Buffer.from(value, 'base64').toString('binary'),
  btoa: (value) => Buffer.from(value, 'binary').toString('base64')
};

vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'crypto-vault.js'), 'utf8'), context);
const CryptoVault = vm.runInNewContext('CryptoVault', context);

test('encrypt + decrypt round trip works for normal vault data', async () => {
  const payload = { hello: 'world', count: 2 };
  const encrypted = await CryptoVault.encrypt(payload, 'super-secret-passphrase');
  const decrypted = await CryptoVault.decrypt(encrypted, 'super-secret-passphrase');
  assert.equal(JSON.stringify(decrypted), JSON.stringify(payload));
});

test('wrapped P2P payloads can be encrypted and decrypted with the same password', async () => {
  const payload = { full: true, accounts: [{ secret: 'abc', updatedAt: 1 }] };
  const wrapped = await CryptoVault.encryptP2p(payload, 'shared-passphrase', 'snapshot');
  assert.equal(wrapped.protocol, 'webauth-p2p');
  assert.equal(wrapped.version, 2);
  assert.equal(wrapped.messageType, 'snapshot');

  const restored = await CryptoVault.decryptP2p(wrapped, 'shared-passphrase');
  assert.equal(JSON.stringify(restored), JSON.stringify(payload));
});

test('wrong password on wrapped P2P payload is classified as wrong-key-or-password', async () => {
  const wrapped = await CryptoVault.encryptP2p({ test: 'value' }, 'correct-passphrase', 'delta');

  await assert.rejects(
    () => CryptoVault.decryptP2p(wrapped, 'wrong-passphrase'),
    /wrong-key-or-password/
  );
});

test('invalid payload is rejected before decryption', async () => {
  await assert.rejects(
    () => CryptoVault.decryptP2p({ protocol: 'webauth-p2p', version: 2, messageType: 'snapshot' }, 'guess'),
    /invalid-payload/
  );
});

test('unsupported protocol version is rejected with a safe category', async () => {
  const payload = {
    protocol: 'webauth-p2p',
    version: 99,
    messageType: 'snapshot',
    keyId: 'vault',
    iv: [1, 2, 3],
    salt: [1, 2, 3],
    ciphertext: [1, 2, 3]
  };

  await assert.rejects(
    () => CryptoVault.decryptP2p(payload, 'anything'),
    /unsupported-protocol/
  );
});

test('oversized payloads are rejected safely', async () => {
  const huge = {
    protocol: 'webauth-p2p',
    version: 2,
    messageType: 'snapshot',
    keyId: 'vault',
    iv: new Array(12).fill(1),
    salt: new Array(16).fill(2),
    ciphertext: new Array(524289).fill(3)
  };

  await assert.rejects(
    () => CryptoVault.decryptP2p(huge, 'anything'),
    /invalid-payload/
  );
});