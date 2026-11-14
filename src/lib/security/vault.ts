import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Caja fuerte de secretos de la app.
 *
 * Guarda un secreto (una clave de IA, el token de Moodle…) cifrado con
 * AES-256-GCM y lo devuelve solo a quien pueda demostrar el mismo contexto
 * (`aad`). El contexto habitual es el `userId`: un texto cifrado para una
 * cuenta no se descifra con otra, aunque alguien copiara la fila entera.
 *
 * Formato guardado, siempre con cuatro segmentos separados por puntos:
 *
 *     v1.<iv>.<tag>.<ciphertext>
 *
 * Los tres últimos van en base64url. El prefijo de versión permite cambiar de
 * algoritmo o de longitud sin adivinar el formato viejo: una versión que este
 * código no conoce se rechaza con un error claro, no se intenta a ciegas.
 *
 * La clave vive en `SECRETS_KEY_V1` (32 bytes en base64) y se lee **en cada
 * operación**, no al importar el módulo: si falta o está mal, la app sigue en
 * pie y solo fallan las acciones que cifran o descifran. Nunca se registra ni
 * se devuelve el secreto ni la clave maestra en un mensaje de error.
 *
 * Este módulo es genérico a propósito: no conoce `UserAiKey` ni Moodle. Cada
 * función recibe el texto y el contexto; el formato y la criptografía viven
 * aquí una sola vez.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type VaultErrorCode =
  | 'vault_key_missing'
  | 'vault_key_invalid'
  | 'vault_format_invalid'
  | 'vault_version_unknown'
  | 'vault_decrypt_failed';

/** Fallo controlado del vault: siempre se puede enseñar tal cual al usuario. */
export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function fromBase64Url(value: string): Buffer {
  // `Buffer.from(..., 'base64url')` ignora caracteres raros; re-codificar y
  // comparar es lo que distingue un segmento válido de una cadena corrupta.
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || base64Url(decoded) !== value) {
    throw new VaultError('vault_format_invalid', 'El secreto guardado está dañado: formato inválido.');
  }
  return decoded;
}

/** Carga la clave maestra; lanza un error claro si no existe o no mide 32 bytes. */
function loadMasterKey(): Buffer {
  const raw = (process.env.SECRETS_KEY_V1 ?? '').trim();
  if (raw.length === 0) {
    throw new VaultError(
      'vault_key_missing',
      'Falta SECRETS_KEY_V1: sin esa clave no se pueden guardar ni leer secretos cifrados.'
    );
  }

  // Se acepta base64 estándar y base64url, con o sin relleno: la misma clave
  // puede venir de `openssl rand -base64 32` o de un panel que use la variante
  // segura para URL. Lo que no se acepta es una longitud distinta de 32 bytes.
  const normalizada = raw.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = Buffer.from(normalizada, 'base64');
  if (decoded.length !== KEY_BYTES) {
    throw new VaultError(
      'vault_key_invalid',
      `SECRETS_KEY_V1 debe ser una clave de ${KEY_BYTES} bytes en base64 (mide ${decoded.length}).`
    );
  }
  return decoded;
}

/** ¿Se puede cifrar ahora mismo? Sin lanzar: para pintar el estado en Ajustes. */
export function vaultStatus(): { ready: boolean; reason: string | null } {
  try {
    loadMasterKey();
    return { ready: true, reason: null };
  } catch (error) {
    return {
      ready: false,
      reason:
        error instanceof VaultError
          ? error.message
          : 'La clave de cifrado no está disponible en este entorno.',
    };
  }
}

/**
 * Cifra un secreto con un contexto (AAD). El mismo texto y el mismo contexto
 * producen textos distintos cada vez: el IV es aleatorio y nunca se reutiliza.
 */
export function encryptSecret(plaintext: string, aad: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new VaultError('vault_format_invalid', 'No se puede cifrar un secreto vacío.');
  }
  if (typeof aad !== 'string' || aad.length === 0) {
    throw new VaultError('vault_format_invalid', 'Falta el contexto (AAD) del secreto.');
  }

  const key = loadMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, base64Url(iv), base64Url(tag), base64Url(ciphertext)].join('.');
}

/**
 * Descifra un secreto. Cualquier cambio en el texto, en el tag, en el IV o en el
 * contexto hace que GCM falle: no hay descifrado «a medias» ni texto basura.
 */
export function decryptSecret(payload: string, aad: string): string {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new VaultError('vault_format_invalid', 'No hay ningún secreto guardado.');
  }
  if (typeof aad !== 'string' || aad.length === 0) {
    throw new VaultError('vault_format_invalid', 'Falta el contexto (AAD) del secreto.');
  }

  const parts = payload.split('.');
  if (parts.length !== 4) {
    throw new VaultError('vault_format_invalid', 'El secreto guardado está dañado: formato inválido.');
  }

  const [version, ivPart, tagPart, ciphertextPart] = parts;
  if (version !== VERSION) {
    throw new VaultError(
      'vault_version_unknown',
      `El secreto usa una versión de cifrado desconocida (${version.slice(0, 24)}).`
    );
  }

  const iv = fromBase64Url(ivPart);
  const tag = fromBase64Url(tagPart);
  const ciphertext = fromBase64Url(ciphertextPart);
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new VaultError('vault_format_invalid', 'El secreto guardado está dañado: formato inválido.');
  }

  try {
    const key = loadMasterKey();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof VaultError) throw error;
    // No se propaga el error de OpenSSL: puede nombrar detalles internos y no
    // aporta nada al usuario. Tampoco se incluye el payload ni el AAD.
    throw new VaultError(
      'vault_decrypt_failed',
      'No se pudo descifrar el secreto: la clave de cifrado no coincide o el dato está dañado.'
    );
  }
}

/** Formato que produce este módulo, para validaciones y pruebas. */
export const VAULT_FORMAT = 'v1.iv.tag.ct';
