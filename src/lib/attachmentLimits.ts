/**
 * Límites de los adjuntos que se le pueden enseñar al catedrático.
 *
 * Módulo **puro** (nada de `fs`, ni rutas, ni Prisma) para que lo pueda importar
 * el servidor y también el navegador: así el formulario rechaza en el acto lo
 * que el servidor rechazaría igual, con el mismo mensaje y sin gastar una
 * llamada de IA. La validación del servidor sigue siendo la que manda.
 *
 * Lo que cambió (y por qué): antes un archivo no podía pasar de **6 MB** y solo
 * se aceptaban capturas y PDF. Eso dejaba fuera justo el material de estudio de
 * verdad —un tema escaneado, el libro entero, los apuntes del profesor—. Ahora
 * el archivo **no se manda en base64 dentro del JSON** (que era lo que obligaba
 * a poner un tope pequeño y llenaba la memoria del navegador): se sube en
 * **streaming a disco** por su propia puerta y aquí solo quedan los topes de
 * sensatez. El texto de dentro se extrae en el servidor y es eso lo que lee el
 * catedrático, así que el tamaño deja de ser el problema.
 */

/** Máximo de archivos por mensaje. */
export const MAX_TUTOR_ATTACHMENTS = 12;

/**
 * Tamaño máximo por archivo: **512 MB**.
 *
 * No es una promesa de que un archivo de ese tamaño vaya a caber en el modelo:
 * es el tope de lo que la app acepta, guarda y sabe leer. Lo que de verdad se le
 * enseña al catedrático es el **texto** extraído del documento (troceado y
 * buscado por relevancia), y eso no depende de los megas.
 */
export const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;

/** Tope del conjunto de archivos de un mismo mensaje: 1 GB. */
export const MAX_TURN_ATTACHMENT_BYTES = 1024 * 1024 * 1024;

/**
 * Lo que cabe **en la misma petición** al modelo multimodal (una captura o un
 * PDF escaneado que hay que *ver*, no leer).
 *
 * Los proveedores admiten los archivos incrustados en la petición hasta un
 * límite; por encima de esto el archivo se guarda igual y, si tiene texto, se le
 * da el texto; si es un escaneo sin capa de texto y es demasiado grande, se dice
 * claro y se pide por páginas o como capturas.
 */
export const MAX_INLINE_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/** Turnos recientes con adjunto que conservan el archivo binario en el historial. */
export const ATTACHMENT_LIVE_TURNS = 3;

/**
 * Cómo hay que leer un archivo:
 *   - `imagen`: solo se puede mirar (visión del modelo).
 *   - `pdf`: se intenta sacar su texto y, si no tiene, se mira.
 *   - `texto`: se lee su texto (Markdown, CSV, código, LaTeX, RTF…).
 *   - `oficina`: es un ZIP con XML dentro (docx, pptx, xlsx, odt): se le quita la
 *     envoltura y se lee el texto de sus etiquetas.
 */
export type AttachmentKind = 'imagen' | 'pdf' | 'texto' | 'oficina';

export interface AllowedAttachmentType {
  /** Extensión por defecto, para nombrar la copia local. */
  ext: string;
  /** Cómo se llama en el mensaje de error. */
  label: string;
  kind: AttachmentKind;
}

/**
 * Tipos que sabemos leer. Cualquier otra cosa se rechaza con un mensaje que dice
 * qué sí se acepta.
 */
export const ALLOWED_MIME: Record<string, AllowedAttachmentType> = {
  'image/png': { ext: 'png', label: 'PNG', kind: 'imagen' },
  'image/jpeg': { ext: 'jpg', label: 'JPG', kind: 'imagen' },
  'image/webp': { ext: 'webp', label: 'WEBP', kind: 'imagen' },
  'image/gif': { ext: 'gif', label: 'GIF', kind: 'imagen' },
  'application/pdf': { ext: 'pdf', label: 'PDF', kind: 'pdf' },
  'text/plain': { ext: 'txt', label: 'texto', kind: 'texto' },
  'text/markdown': { ext: 'md', label: 'Markdown', kind: 'texto' },
  'text/csv': { ext: 'csv', label: 'CSV', kind: 'texto' },
  'text/tab-separated-values': { ext: 'tsv', label: 'TSV', kind: 'texto' },
  'application/json': { ext: 'json', label: 'JSON', kind: 'texto' },
  'text/html': { ext: 'html', label: 'HTML', kind: 'texto' },
  'application/xml': { ext: 'xml', label: 'XML', kind: 'texto' },
  'text/xml': { ext: 'xml', label: 'XML', kind: 'texto' },
  'application/x-tex': { ext: 'tex', label: 'LaTeX', kind: 'texto' },
  'text/x-tex': { ext: 'tex', label: 'LaTeX', kind: 'texto' },
  'text/rtf': { ext: 'rtf', label: 'RTF', kind: 'texto' },
  'application/rtf': { ext: 'rtf', label: 'RTF', kind: 'texto' },
  'text/vtt': { ext: 'vtt', label: 'subtítulos', kind: 'texto' },
  'application/x-subrip': { ext: 'srt', label: 'subtítulos', kind: 'texto' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    ext: 'docx',
    label: 'Word',
    kind: 'oficina',
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    ext: 'pptx',
    label: 'PowerPoint',
    kind: 'oficina',
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    ext: 'xlsx',
    label: 'Excel',
    kind: 'oficina',
  },
  'application/vnd.oasis.opendocument.text': { ext: 'odt', label: 'OpenDocument', kind: 'oficina' },
  'application/vnd.oasis.opendocument.presentation': { ext: 'odp', label: 'OpenDocument', kind: 'oficina' },
  'application/vnd.oasis.opendocument.spreadsheet': { ext: 'ods', label: 'OpenDocument', kind: 'oficina' },
};

/**
 * Extensión → MIME. Se usa cuando el navegador no dice el tipo (pasa con `.md`,
 * `.tex` o `.srt`, que muchas veces llegan como cadena vacía o como
 * `application/octet-stream`) y también para comprobar la coherencia del nombre.
 */
export const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  tex: 'application/x-tex',
  latex: 'application/x-tex',
  rtf: 'text/rtf',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  log: 'text/plain',
  yml: 'text/plain',
  yaml: 'text/plain',
  sql: 'text/plain',
  ini: 'text/plain',
  cfg: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text',
  odp: 'application/vnd.oasis.opendocument.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
};

/** El atributo `accept` del selector de archivos. */
export const ATTACHMENT_ACCEPT = Object.keys(MIME_BY_EXTENSION)
  .map((ext) => `.${ext}`)
  .concat(Object.keys(ALLOWED_MIME))
  .join(',');

/** Cómo se llama cada tipo en los mensajes: «PDF», «Word», «captura»… */
export function attachmentLabel(mimeType: string): string {
  const entry = ALLOWED_MIME[mimeType];
  if (entry) return entry.label;
  const kind = kindOfMime(mimeType);
  return kind === 'imagen' ? 'captura' : 'documento';
}

/** Extensión de un nombre de archivo, en minúsculas y sin el punto. */
export function extensionOf(name: string): string {
  const match = String(name ?? '').match(/\.([a-zA-Z0-9]{1,8})$/);
  return match ? match[1].toLowerCase() : '';
}

/**
 * El tipo real de un archivo que llega del navegador: se cree el MIME si lo
 * dice, y si no (o si dice `application/octet-stream`) se mira la extensión.
 * Devuelve cadena vacía si no se reconoce ninguna de las dos cosas.
 */
export function resolveMimeType(name: string, mimeType: string): string {
  const declared = String(mimeType ?? '').trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && isAllowedMime(declared)) return declared;

  const fromExtension = MIME_BY_EXTENSION[extensionOf(name)];
  if (fromExtension) return fromExtension;

  return declared && isAllowedMime(declared) ? declared : '';
}

export function isAllowedMime(mimeType: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED_MIME, mimeType);
}

/** ¿Es una imagen? (para enseñar miniatura en el chat en vez de un icono). */
export function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/** Qué es este archivo: imagen, PDF, texto u oficina. */
export function kindOfMime(mimeType: string): AttachmentKind {
  const entry = ALLOWED_MIME[mimeType];
  if (entry) return entry.kind;
  return isImageMime(mimeType) ? 'imagen' : 'texto';
}

/** ¿Este tipo se puede leer como texto (sin necesidad de visión)? */
export function isTextReadableKind(mimeType: string): boolean {
  const kind = kindOfMime(mimeType);
  return kind === 'texto' || kind === 'oficina' || kind === 'pdf';
}

/** Tamaño legible: «1,2 MB» o «340 kB». */
export function formatBytes(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024 * 1024) return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(1).replace('.', ',')} GB`;
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
  if (sizeBytes >= 1024) return `${Math.round(sizeBytes / 1024)} kB`;
  return `${sizeBytes} B`;
}

export const ALLOWED_ATTACHMENT_HINT = `Se aceptan capturas (${[
  'PNG',
  'JPG',
  'WEBP',
  'GIF',
].join(', ')}), PDF y documentos de texto (${[
  'txt',
  'md',
  'csv',
  'json',
  'html',
  'xml',
  'tex',
  'rtf',
  'docx',
  'pptx',
  'xlsx',
  'odt',
].join(', ')}). Hasta ${MAX_TUTOR_ATTACHMENTS} archivos por mensaje, de ${formatBytes(
  MAX_ATTACHMENT_BYTES
)} cada uno.`;
