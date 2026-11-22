/**
 * Lector del cifrador **antiguo** de secretos del equipo.
 *
 * Hasta el Paso 15 la contraseña de Moodle se cifraba con AES-256-GCM y una
 * clave que vivía solo en el disco del equipo (`data/.clave-local`). Eso no
 * sobrevive a un despliegue serverless: cada instancia tiene su propio disco.
 * Ahora el secreto se guarda con el vault (`src/lib/security/vault.ts`), con
 * contexto por cuenta, y este módulo queda **solo para leer** lo guardado antes
 * y poder re-cifrarlo.
 *
 * Dos reglas para que sea seguro en un servidor:
 *
 *   1. **No crea claves.** Si el archivo no existe, devuelve `null`; no escribe
 *      nada en disco solo porque alguien intente leer un secreto.
 *   2. **No cifra.** `sealSecret` se retiró a propósito: la única puerta de
 *      escritura es `moodleSecrets.sealMoodlePassword`, que usa el vault. Así no
 *      puede volver a colarse un secreto con una clave que no viaja al hosting.
 *
 * El formato antiguo era `v1:iv:tag:datos` (base64 estándar, separado por dos
 * puntos). Se mantiene la validación estricta de base64: `Buffer.from(...,'base64')`
 * ignora en silencio los caracteres que sobran.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

/** Dónde vivía la clave del equipo. Solo se lee; nunca se escribe desde aquí. */
export const LOCAL_KEY_PATH = path.join(process.cwd(), 'data', '.clave-local');

/** Lee la clave del equipo si existe y mide 32 bytes. No la crea. */
function readExistingKey(): Buffer | null {
  try {
    const stored = Buffer.from(fs.readFileSync(LOCAL_KEY_PATH, 'utf8').trim(), 'base64');
    return stored.length === 32 ? stored : null;
  } catch {
    return null;
  }
}

/** ¿Queda una clave local que pueda descifrar valores antiguos? */
export function hasLocalKey(): boolean {
  return readExistingKey() !== null;
}

/**
 * Base64 **exacto**: si el valor lleva caracteres de más (o de menos), no vale.
 *
 * Hace falta porque `Buffer.from(..., 'base64')` ignora en silencio todo lo que
 * venga detrás del relleno: un valor manipulado podría decodificarse igual y
 * colarse como si fuera el original. Aquí se vuelve a codificar y se compara.
 */
function decodeBase64Exact(value: string): Buffer | null {
  if (value.length === 0) return null;
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0) return null;
  if (buffer.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) return null;
  return buffer;
}

/**
 * Descifra un valor del cifrador antiguo. Devuelve `null` si el formato no es
 * el esperado, si la clave local ya no está o si el contenido está manipulado
 * (el GCM lo detecta). Nunca lanza.
 */
export function openLegacySecret(sealed: string | null | undefined): string | null {
  const raw = String(sealed ?? '').trim();
  if (!raw) return null;

  const parts = raw.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  const key = readExistingKey();
  if (!key) return null;

  try {
    const iv = decodeBase64Exact(parts[1]);
    const tag = decodeBase64Exact(parts[2]);
    const data = decodeBase64Exact(parts[3]);
    if (!iv || !tag || !data) return null;

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return plain.length > 0 ? plain : null;
  } catch {
    return null;
  }
}
