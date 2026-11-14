/**
 * Verificación del vault de secretos (pasos 1–3 de claves de IA).
 *
 * Lo que se comprueba, con el mismo código que corre en la app:
 *   - ida y vuelta correcta;
 *   - el formato guardado es `v1.iv.tag.ct`;
 *   - el IV no se repite entre dos cifrados del mismo texto;
 *   - descifrar con otro userId (AAD distinto) falla;
 *   - alterar el tag falla;
 *   - una versión desconocida falla con un error claro;
 *   - una clave maestra ausente o de longitud incorrecta solo hace fallar la
 *     operación, no el arranque del módulo.
 *
 * Uso: `node scripts/verify-vault.js`
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { compilaTs } = require('./lib/compilaTs');

const KEY = crypto.randomBytes(32).toString('base64');
process.env.SECRETS_KEY_V1 = KEY;

const outDir = compilaTs('security/vault', '.tmp-verify-vault');
const vault = require(path.join(outDir, 'vault.js'));

const USER_A = '16bb4958-5288-493b-8c65-379dd31782f5';
const USER_B = '3af632ee-22dc-4e75-85a8-139aa70600bf';
const SECRET = 'AIzaSy-FAKE-KEY-DO-NOT-PRINT-1234567890';

let checks = 0;
function ok(name, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

function throwsVault(name, fn, code) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `${name}: debía fallar`);
  assert.equal(caught.name, 'VaultError', `${name}: ${caught.name}`);
  if (code) assert.equal(caught.code, code, `${name}: ${caught.code}`);
  assert.ok(!String(caught.message).includes(SECRET), `${name}: el error filtra el secreto`);
  checks += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\n  Vault de secretos\n');

ok('ida y vuelta con el mismo contexto', () => {
  const sealed = vault.encryptSecret(SECRET, USER_A);
  assert.equal(vault.decryptSecret(sealed, USER_A), SECRET);
});

ok('el formato guardado es v1.iv.tag.ct', () => {
  const sealed = vault.encryptSecret(SECRET, USER_A);
  const parts = sealed.split('.');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'v1');
  assert.ok(parts[1].length > 0 && parts[2].length > 0 && parts[3].length > 0);
  assert.equal(vault.VAULT_FORMAT, 'v1.iv.tag.ct');
});

ok('dos cifrados del mismo texto usan IV distinto', () => {
  const uno = vault.encryptSecret(SECRET, USER_A).split('.');
  const dos = vault.encryptSecret(SECRET, USER_A).split('.');
  assert.notEqual(uno[1], dos[1], 'el IV se ha reutilizado');
  assert.notEqual(uno[3], dos[3], 'el texto cifrado debería cambiar');
});

throwsVault(
  'descifrar con otro userId falla (AAD distinto)',
  () => vault.decryptSecret(vault.encryptSecret(SECRET, USER_A), USER_B),
  'vault_decrypt_failed'
);

throwsVault(
  'alterar el tag falla',
  () => {
    const parts = vault.encryptSecret(SECRET, USER_A).split('.');
    const tag = Buffer.from(parts[2], 'base64url');
    tag[tag.length - 1] ^= 0x01;
    parts[2] = tag.toString('base64url');
    vault.decryptSecret(parts.join('.'), USER_A);
  },
  'vault_decrypt_failed'
);

throwsVault(
  'alterar el texto cifrado falla',
  () => {
    const parts = vault.encryptSecret(SECRET, USER_A).split('.');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    ciphertext[0] ^= 0x01;
    parts[3] = ciphertext.toString('base64url');
    vault.decryptSecret(parts.join('.'), USER_A);
  },
  'vault_decrypt_failed'
);

throwsVault(
  'una versión de cifrado desconocida se rechaza',
  () => {
    const parts = vault.encryptSecret(SECRET, USER_A).split('.');
    parts[0] = 'v9';
    vault.decryptSecret(parts.join('.'), USER_A);
  },
  'vault_version_unknown'
);

throwsVault(
  'un formato incompleto se rechaza',
  () => vault.decryptSecret('v1.solo-dos-segmentos', USER_A),
  'vault_format_invalid'
);

// La clave maestra se lee en cada operación: quitarla no rompe el módulo, solo
// la acción que cifra. Esto es justo lo que exige el requisito de que la app no
// se caiga entera si el hosting no tiene la variable.
ok('sin SECRETS_KEY_V1 el módulo sigue cargado y solo falla al operar', () => {
  const original = process.env.SECRETS_KEY_V1;
  delete process.env.SECRETS_KEY_V1;
  try {
    assert.equal(vault.vaultStatus().ready, false);
    let caught = null;
    try {
      vault.encryptSecret(SECRET, USER_A);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught);
    assert.equal(caught.code, 'vault_key_missing');
    assert.ok(!caught.message.includes(SECRET));
  } finally {
    process.env.SECRETS_KEY_V1 = original;
  }
});

throwsVault(
  'una clave maestra que no mide 32 bytes se rechaza',
  () => {
    const original = process.env.SECRETS_KEY_V1;
    process.env.SECRETS_KEY_V1 = crypto.randomBytes(16).toString('base64');
    try {
      vault.encryptSecret(SECRET, USER_A);
    } finally {
      process.env.SECRETS_KEY_V1 = original;
    }
  },
  'vault_key_invalid'
);

ok('vaultStatus informa listo con la clave correcta', () => {
  assert.deepEqual(vault.vaultStatus(), { ready: true, reason: null });
});

console.log(`\n  ✅ ${checks} comprobaciones en verde\n`);
