/**
 * Tipo REAL de un archivo, por sus primeros bytes.
 *
 * El navegador puede mentir con `file.type` y el nombre puede tener cualquier
 * extensión. Antes de guardar un adjunto se comprueba su firma: una imagen
 * renombrada a `.pdf` no se acepta como PDF, y un PDF renombrado a `.png` no se
 * manda al modelo como si fuera una captura.
 *
 * Es un módulo puro: no toca disco ni Prisma, así que el servidor y las pruebas
 * usan exactamente la misma regla.
 */

import { kindOfMime, isImageMime, type AttachmentKind } from './attachmentLimits';

export type SniffedKind = 'png' | 'jpeg' | 'webp' | 'gif' | 'pdf' | 'zip' | 'text' | 'unknown';

export interface SignatureResult {
  kind: SniffedKind;
  /** MIME real cuando se puede afirmar (imágenes, PDF y ZIP). */
  mimeType: string | null;
  /** El archivo parece texto UTF-8 legible. */
  text: boolean;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((value, index) => buffer[index] === value);
}

/** `%PDF-` puede venir precedido de basura o espacios en algunos generadores. */
function isPdf(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 1024);
  return buffer.subarray(0, limit).includes(Buffer.from('%PDF-'));
}

function isZip(buffer: Buffer): boolean {
  return (
    startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(buffer, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(buffer, [0x50, 0x4b, 0x07, 0x08])
  );
}

/**
 * ¿El contenido es texto legible? Se exige UTF-8 válido y una proporción alta
 * de caracteres imprimibles. Un binario renombrado a `.txt` no pasa.
 */
function looksLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  if (buffer.includes(0)) return false;

  const sample = buffer.subarray(0, 8192);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(sample);
  } catch {
    return false;
  }

  let printable = 0;
  for (const char of decoded) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) printable += 1;
  }
  return decoded.length > 0 && printable / decoded.length >= 0.9;
}

/** Firma de los primeros bytes. No usa el nombre ni el MIME declarado. */
export function sniffSignature(buffer: Buffer): SignatureResult {
  if (startsWith(buffer, Array.from(PNG))) {
    return { kind: 'png', mimeType: 'image/png', text: false };
  }
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return { kind: 'jpeg', mimeType: 'image/jpeg', text: false };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { kind: 'webp', mimeType: 'image/webp', text: false };
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return { kind: 'gif', mimeType: 'image/gif', text: false };
  }
  if (isPdf(buffer)) return { kind: 'pdf', mimeType: 'application/pdf', text: false };
  if (isZip(buffer)) return { kind: 'zip', mimeType: 'application/zip', text: false };
  if (looksLikeText(buffer)) return { kind: 'text', mimeType: null, text: true };
  return { kind: 'unknown', mimeType: null, text: false };
}

/**
 * ¿La firma real es compatible con el tipo declarado?
 *
 * Los documentos de oficina son ZIP; se aceptan como ZIP solo para esos MIME.
 * El texto no tiene firma, así que se valida que sea UTF-8 legible.
 */
export function signatureMatches(declaredMime: string, signature: SignatureResult): boolean {
  const kind: AttachmentKind = kindOfMime(declaredMime);

  if (isImageMime(declaredMime)) return signature.mimeType === declaredMime;
  if (declaredMime === 'application/pdf') return signature.kind === 'pdf';
  if (kind === 'oficina') return signature.kind === 'zip';
  if (kind === 'texto') return signature.text;
  return false;
}

/** Mensaje de rechazo uniforme, sin decir qué bytes tiene el archivo. */
export function signatureMismatchMessage(name: string, declaredMime: string): string {
  return `«${name}» no es un ${declaredMime} de verdad: su contenido no coincide con el tipo que dice. Súbelo con su formato correcto o expórtalo de nuevo.`;
}
