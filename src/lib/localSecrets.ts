/**
 * Guardar un secreto del alumno en su propio ordenador, cifrado.
 *
 * El caso que lo pide: para que BrainUp pueda entrar solo en Moodle (todas las
 * mañanas, sin que él escriba nada) hace falta su contraseña, y una contraseña
 * en claro dentro de un archivo de texto es una contraseña regalada. Aquí se
 * cifra con AES-256-GCM y una clave que vive **solo** en su disco
 * (`data/.clave-local`, creada la primera vez con permisos de propietario).
 *
 * Qué protege y qué no, dicho sin adornos:
 *   - Protege de que la contraseña se lea a simple vista en `dev.db` o en una
 *     copia de seguridad que se comparta.
 *   - No protege de alguien que ya tenga acceso a su sesión de Windows: con los
 *     dos archivos (la clave y la base) se descifra. Para eso está el botón de
 *     desconectar, que la borra.
 *
 * Si la clave local no existe se crea; si se pierde, el secreto guardado deja de
 * poder leerse (y la app pedirá la contraseña otra vez, que es exactamente el
 * comportamiento honesto).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

/** Dónde vive la clave del equipo. Nunca sale de aquí ni se manda al navegador. */
export const LOCAL_KEY_PATH = path.join(process.cwd(), 'data', '.clave-local');

function readOrCreateKey(): Buffer {
  try {
    const stored = Buffer.from(fs.readFileSync(LOCAL_KEY_PATH, 'utf8').trim(), 'base64');
    if (stored.length === 32) return stored;
  } catch {
    // Todavía no hay clave: se crea abajo.
  }

  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(LOCAL_KEY_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_KEY_PATH, key.toString('base64'), { mode: 0o600 });
  return key;
}

/** Deja el texto cifrado en un solo campo (`v1:iv:tag:datos`, todo en base64). */
export function sealSecret(plain: string): string {
  const key = readOrCreateKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
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
 * Descifra lo que guardó `sealSecret`. Devuelve `null` si el formato no es el
 * esperado, si la clave local ya no está o si el contenido está manipulado (el
 * GCM lo detecta): en los tres casos, la app vuelve a pedir la contraseña.
 */
export function openSecret(sealed: string | null | undefined): string | null {
  const raw = String(sealed ?? '').trim();
  if (!raw) return null;

  const parts = raw.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const iv = decodeBase64Exact(parts[1]);
    const tag = decodeBase64Exact(parts[2]);
    const data = decodeBase64Exact(parts[3]);
    if (!iv || !tag || !data) return null;

    const key = readOrCreateKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return plain.length > 0 ? plain : null;
  } catch {
    return null;
  }
}

/** ¿Se puede cifrar en este equipo? (para poder avisar en Ajustes). */
export function canSealSecrets(): boolean {
  try {
    readOrCreateKey();
    return true;
  } catch {
    return false;
  }
}
