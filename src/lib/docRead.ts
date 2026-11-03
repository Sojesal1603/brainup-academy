/**
 * Sacar el texto de un archivo, sea del tipo que sea.
 *
 * Aquí vive la razón por la que se puede subir un tema de 40 MB: al modelo no se
 * le manda el archivo (que es lo que tenía el tope de 6 MB y lo que llenaba la
 * petición), se le manda **el texto que hay dentro**, troceado y buscado aparte
 * (`docContext.ts`). Este módulo es solo la primera mitad: convertir bytes en
 * texto.
 *
 * Tres familias, y cada una se lee de una manera distinta:
 *
 *   - **Texto** (txt, md, csv, json, html, xml, tex, rtf, subtítulos…): se
 *     decodifica y, si el fichero venía en Latin-1, se decodifica otra vez. Un
 *     tema con tildes mal puestas es peor que no leerlo.
 *   - **PDF**: `pdfjs-dist`, página a página, con una marca `--- Página N ---`
 *     delante de cada una. Esa marca es la que después permite citar («en la
 *     página 213 pone…») y pedir más páginas concretas.
 *   - **Oficina** (docx, pptx, xlsx, odt…): son ZIP con XML dentro. Se descomprime
 *     con `zlib` (que viene con Node) y se convierte el XML a texto. Sin
 *     dependencias y sin librerías de Office.
 *
 * Dos reglas que no se rompen: **nada se inventa** (si una página no tiene texto,
 * se dice, no se rellena) y **un trozo roto no tumba el documento** (una página
 * que falla se salta y se apunta en `notes`).
 */

import { open, readFile, stat } from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { inflateRawSync } from 'zlib';
import { extensionOf, isTextReadableKind, kindOfMime } from './attachmentLimits';

/**
 * Tope de texto que se extrae de un archivo: **40 millones de caracteres**, del
 * orden de 8 000 páginas de libro (más que cualquier temario, libro de texto o
 * dos cursos enteros juntos). 
 *
 * Es un tope de sensatez, no el de antes: al modelo no se le manda el texto
 * entero —va troceado y buscado por relevancia—, así que lo que importa es que
 * el documento completo esté indexado y que cualquier página se pueda recuperar.
 * Solo si algo pasara de aquí se corta, y entonces se dice con los números
 * delante en vez de dejar creer que se ha leído todo.
 */
export const MAX_EXTRACTED_CHARS = 40_000_000;

export type DocReadMode = 'texto' | 'imagen' | 'sin_texto';

/** Marca que separa las páginas dentro del texto extraído. */
export const PAGE_MARKER = /^--- Página (\d+) ---$/;

/** La marca de una página, tal y como queda escrita en el texto. */
export function pageMarker(page: number): string {
  return `--- Página ${page} ---`;
}

export interface DocReadResult {
  mode: DocReadMode;
  /** Texto extraído, con sus marcas de página o diapositiva cuando las hay. */
  text: string;
  /** Páginas del PDF (0 si el formato no tiene páginas). */
  pages: number;
  chars: number;
  /** Avisos honestos, en castellano, para enseñárselos al alumno. */
  notes: string[];
}

function emptyResult(mode: DocReadMode, notes: string[] = []): DocReadResult {
  return { mode, text: '', pages: 0, chars: 0, notes };
}

/** Cuántas páginas sin texto se aceptan antes de aburrir con el aviso. */
function missingPagesNote(withoutText: number, total: number): string {
  return `${withoutText} de ${total} páginas no tienen capa de texto (son imágenes escaneadas): esas solo se pueden mirar como capturas`;
}

/** Aviso del corte por tamaño, con los números reales. */
function truncationNote(read: number, total: number | null): string {
  return total && total > read
    ? `El texto es enorme: se han leído ${read} caracteres de ${total} y el resto queda fuera`
    : `El texto es enorme: se han leído los primeros ${read} caracteres`;
}

/* ------------------------------------------------------------------ */
/* 1. Texto plano (y casi plano)                                       */
/* ------------------------------------------------------------------ */

/**
 * Lee un fichero de texto sin cargarlo entero si es gigante: se piden los bytes
 * que hacen falta y punto. Un `.txt` de 200 MB no debe pasar por la memoria del
 * servidor para acabar cortado en 12 millones de caracteres.
 */
async function readTextBytes(filePath: string, maxBytes: number): Promise<{ bytes: Buffer; total: number }> {
  const handle = await open(filePath, 'r');
  try {
    const stats = await handle.stat();
    const total = stats.size;
    const toRead = Math.min(total, maxBytes);
    const bytes = Buffer.alloc(toRead);
    await handle.read(bytes, 0, toRead, 0);
    return { bytes, total };
  } finally {
    await handle.close();
  }
}

/**
 * Decodifica el texto: primero UTF-8 y, si sale lleno de caracteres de
 * reemplazo (que es lo que pasa con Latin-1), se vuelve a decodificar en
 * `latin1`. Windows y los apuntes de muchos profesores vienen así.
 */
function decodeText(bytes: Buffer): string {
  const utf8 = bytes.toString('utf8');
  const broken = (utf8.match(/\uFFFD/g) ?? []).length;
  if (broken > 0 && broken / Math.max(1, utf8.length) > 0.002) return bytes.toString('latin1');
  return utf8;
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (match) => ENTITIES[match] ?? match)
    .replace(/&#(\d{2,5});/g, (_match, code: string) => {
      const value = Number(code);
      return Number.isFinite(value) && value > 31 && value < 65535 ? String.fromCharCode(value) : ' ';
    });
}

/**
 * HTML o XML a texto: fuera `script` y `style` enteros (que si no se cuelan como
 * si fueran contenido) y los cierres de bloque pasan a salto de línea, que es lo
 * que separa un párrafo de otro.
 */
function markupToText(markup: string): string {
  return decodeEntities(
    markup
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  );
}

/**
 * RTF a texto: se quitan los grupos de cabecera (fuentes, colores, hojas de
 * estilo) y las palabras de control. No es un intérprete de RTF —no hace
 * falta—: lo que importa es que el texto con sus acentos llegue entero.
 */
function rtfToText(rtf: string): string {
  return rtf
    .replace(/\\'([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\{\\\*[\s\S]*?\}/g, ' ')
    .replace(/\{\\(fonttbl|colortbl|stylesheet|info)[\s\S]*?\}\}/gi, ' ')
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\tab\b/g, '\t')
    .replace(/\\[a-z]+-?\d*\s?/gi, '')
    .replace(/[{}]/g, '');
}

async function readPlainText(fileInput: { path: string; mimeType: string; name: string }): Promise<DocReadResult> {
  const extension = extensionOf(fileInput.name);
  const looksMarkup =
    fileInput.mimeType === 'text/html' ||
    fileInput.mimeType === 'application/xml' ||
    fileInput.mimeType === 'text/xml' ||
    extension === 'html' ||
    extension === 'htm' ||
    extension === 'xml';

  const { bytes, total } = await readTextBytes(fileInput.path, MAX_EXTRACTED_CHARS * 4);
  let text = decodeText(bytes);

  if (looksMarkup) text = markupToText(text);
  else if (fileInput.mimeType === 'text/rtf' || fileInput.mimeType === 'application/rtf' || extension === 'rtf') {
    text = rtfToText(text);
  }

  // Espacios y saltos de más: el modelo cobra por carácter y para leer da igual.
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();

  const notes: string[] = [];
  if (text.length > MAX_EXTRACTED_CHARS) {
    notes.push(truncationNote(MAX_EXTRACTED_CHARS, text.length));
    text = text.slice(0, MAX_EXTRACTED_CHARS);
  } else if (total > bytes.length) {
    // El fichero era más grande de lo que se ha llegado a leer.
    notes.push(truncationNote(bytes.length, total));
  }

  if (text.trim().length === 0) {
    return { mode: 'sin_texto', text: '', pages: 0, chars: 0, notes: ['El documento no tiene texto que se pueda leer (¿está vacío?)'] };
  }

  // Un `.txt` exportado de un libro o de unos apuntes puede traer sus propias
  // marcas de página («--- Página 213 ---»). Si las trae, se cuentan: así el
  // catedrático puede citar «en la página 213» igual que con un PDF, y el trozo
  // que se le da lleva su número de página.
  return { mode: 'texto', text, pages: countPageMarkers(text), chars: text.length, notes };
}

/* ------------------------------------------------------------------ */
/* 2. PDF: página a página, con su marca                               */
/* ------------------------------------------------------------------ */

async function readPdf(fileInput: { path: string; name: string }): Promise<DocReadResult> {
  const data = new Uint8Array(await readFile(fileInput.path));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // Las fuentes estándar y los mapas de caracteres vienen con el paquete: sin
  // ellos, los PDFs con fuentes no incrustadas salen con símbolos raros. pdfjs
  // los pide como **URLs** (no como rutas de Windows): con una ruta a pelo,
  // `Invalid factory url` y el PDF entero se queda sin leer.
  const assets = path.join(process.cwd(), 'node_modules', 'pdfjs-dist');
  const assetsUrl = (folder: string) => `${pathToFileURL(path.join(assets, folder)).href}/`;

  // La tarea de carga es la que sabe cerrarse (`destroy()`); el documento es el
  // que se lee. Se guardan las dos porque dejar el worker vivo en un servidor
  // largo es ir dejando procesos sueltos por cada PDF que se lee.
  const task = pdfjs.getDocument({
    data,
    useSystemFonts: false,
    standardFontDataUrl: assetsUrl('standard_fonts'),
    cMapUrl: assetsUrl('cmaps'),
  });

  const document = await task.promise;

  const notes: string[] = [];
  const pieces: string[] = [];
  const total = document.numPages;
  let withoutText = 0;
  let failed = 0;

  for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
    try {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let current = '';

      for (const item of content.items) {
        const piece = item as { str?: string; hasEOL?: boolean };
        if (typeof piece.str === 'string' && piece.str.length > 0) current += piece.str;
        if (piece.hasEOL && current.trim().length > 0) {
          lines.push(current.trim());
          current = '';
        }
      }
      if (current.trim().length > 0) lines.push(current.trim());

      const pageText = lines.join('\n').trim();
      if (pageText.length === 0) {
        withoutText += 1;
        continue;
      }

      pieces.push(`${pageMarker(pageNumber)}\n${pageText}`);
    } catch (error) {
      // Una página rota no puede llevarse por delante el libro entero.
      failed += 1;
      if (failed <= 3) {
        notes.push(
          `La página ${pageNumber} no se ha podido leer: ${error instanceof Error ? error.message.slice(0, 90) : String(error)}`
        );
      }
    }
  }

  await task.destroy().catch(() => {});

  if (failed > 3) notes.push(`${failed} páginas no se han podido leer (se han saltado)`);
  if (pieces.length === 0) {
    return {
      mode: 'sin_texto',
      text: '',
      pages: total,
      chars: 0,
      notes: [...notes, 'El PDF no tiene capa de texto: son imágenes escaneadas, hay que mirarlas como capturas'],
    };
  }
  if (withoutText > 0) notes.push(missingPagesNote(withoutText, total));

  let text = pieces.join('\n\n');
  if (text.length > MAX_EXTRACTED_CHARS) {
    notes.push(truncationNote(MAX_EXTRACTED_CHARS, text.length));
    text = text.slice(0, MAX_EXTRACTED_CHARS);
  }

  return { mode: 'texto', text, pages: total, chars: text.length, notes };
}

/* ------------------------------------------------------------------ */
/* 3. Oficina: ZIP + XML, sin dependencias                             */
/* ------------------------------------------------------------------ */

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Un ZIP de oficina normal no llega a esto; por encima, mejor avisar que reventar. */
const MAX_ZIP_BYTES = 250 * 1024 * 1024;

/** El índice central está al final del fichero (con un comentario de hasta 64 kB). */
function endOfCentralDirectory(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - 66_000);
  for (let offset = buffer.length - 22; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/** Las entradas del ZIP, leídas del índice central. */
function zipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = endOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('El documento no es un ZIP válido: no encuentro su índice');

  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < total; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    entries.push({
      name: buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localHeaderOffset: buffer.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** El contenido de una entrada del ZIP, descomprimido si hace falta. */
function zipEntryData(buffer: Buffer, entry: ZipEntry): Buffer {
  const local = entry.localHeaderOffset;
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    throw new Error(`La parte «${entry.name}» del documento está ilegible`);
  }

  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`El documento usa una compresión que no sé leer (${entry.method})`);
}

/** XML de oficina a texto: los cierres de párrafo son los saltos de línea. */
function officeXmlToText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<w:tab\b[^>]*\/?>/g, '\t')
      .replace(/<w:br\b[^>]*\/?>/g, '\n')
      .replace(/<\/(w:p|a:p|text:p|row|w:tr)>/g, '\n')
      .replace(/<\/c>/g, '\t')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Los nombres numerados (slide2, sheet10) hay que ordenarlos como números. */
function byNumberInName(a: string, b: string): number {
  const number = (name: string) => {
    const match = name.match(/(\d+)/);
    return match ? Number(match[1]) : 0;
  };
  return number(a) - number(b) || a.localeCompare(b);
}

async function readOfficeDocument(fileInput: { path: string; mimeType: string; name: string }): Promise<DocReadResult> {
  const extension = extensionOf(fileInput.name);

  // Primero el tamaño: así un ZIP enorme se rechaza sin intentar cargarlo.
  const { size } = await stat(fileInput.path);
  if (size > MAX_ZIP_BYTES) {
    throw new Error(
      `El documento pesa demasiado para abrirlo entero (${Math.round(size / (1024 * 1024))} MB de un máximo de ${
        MAX_ZIP_BYTES / (1024 * 1024)
      } MB)`
    );
  }

  const buffer = await readFile(fileInput.path);
  const entries = zipEntries(buffer);
  const read = (entry: ZipEntry) => zipEntryData(buffer, entry).toString('utf8');
  const find = (pattern: RegExp) => entries.filter((entry) => pattern.test(entry.name));
  const pieces: string[] = [];
  const notes: string[] = [];

  if (extension === 'pptx' || find(/^ppt\/slides\/slide\d+\.xml$/).length > 0) {
    const slides = find(/^ppt\/slides\/slide\d+\.xml$/).sort((a, b) => byNumberInName(a.name, b.name));
    slides.forEach((slide, index) => {
      const text = officeXmlToText(read(slide));
      if (text.length > 0) pieces.push(`--- Diapositiva ${index + 1} ---\n${text}`);
    });
    if (slides.length === 0) notes.push('La presentación no trae diapositivas legibles');
  } else if (extension === 'xlsx' || find(/^xl\/worksheets\/sheet\d+\.xml$/).length > 0) {
    const shared = find(/^xl\/sharedStrings\.xml$/)[0];
    const sharedText = shared ? officeXmlToText(read(shared)) : '';
    if (sharedText.length > 0) pieces.push(`--- Textos de la hoja de cálculo ---\n${sharedText}`);
    find(/^xl\/worksheets\/sheet\d+\.xml$/)
      .sort((a, b) => byNumberInName(a.name, b.name))
      .forEach((sheet, index) => {
        // Los números de las celdas van dentro de `<v>`: se leen aparte porque
        // `officeXmlToText` los deja pegados y sin separación.
        const xml = read(sheet);
        const values = [...xml.matchAll(/<v>([^<]{1,40})<\/v>/g)].map((match) => match[1]);
        if (values.length > 0) pieces.push(`--- Hoja ${index + 1} ---\n${values.join('\t')}`);
      });
  } else if (find(/^word\/document\.xml$/).length > 0) {
    const documentXml = read(find(/^word\/document\.xml$/)[0]);
    pieces.push(officeXmlToText(documentXml));
    for (const extra of find(/^word\/(footnotes|endnotes)\.xml$/)) {
      const text = officeXmlToText(read(extra));
      if (text.length > 0) pieces.push(text);
    }
  } else if (find(/^content\.xml$/).length > 0) {
    pieces.push(officeXmlToText(read(find(/^content\.xml$/)[0])));
  } else {
    throw new Error('No encuentro el texto dentro de ese documento de oficina');
  }

  let text = pieces.filter((piece) => piece.trim().length > 0).join('\n\n').trim();
  if (text.length > MAX_EXTRACTED_CHARS) {
    notes.push(truncationNote(MAX_EXTRACTED_CHARS, text.length));
    text = text.slice(0, MAX_EXTRACTED_CHARS);
  }

  if (text.length === 0) {
    return { mode: 'sin_texto', text: '', pages: 0, chars: 0, notes: [...notes, 'El documento no tiene texto que se pueda leer'] };
  }

  return { mode: 'texto', text, pages: 0, chars: text.length, notes };
}

/* ------------------------------------------------------------------ */
/* 4. La puerta única                                                  */
/* ------------------------------------------------------------------ */

/** La página más alta que aparece marcada en el texto (0 si no hay marcas). */
function countPageMarkers(text: string): number {
  let highest = 0;
  // Se recorre con `matchAll` (sin partir el texto en un array de líneas: un
  // libro de 40 millones de caracteres no se trocea dos veces para contar esto).
  for (const match of text.matchAll(/^---\s*p[áa]gina\s+(\d+)\s*---\s*$/gim)) {
    const number = Number(match[1]);
    if (Number.isFinite(number) && number > highest) highest = number;
  }
  return highest;
}

/**
 * Lee un adjunto y devuelve su texto. Lo llama la subida, en cuanto el archivo
 * está en el disco: así, cuando el alumno manda el mensaje, el texto ya está
 * listo y el turno no espera.
 */
export async function readDocument(input: { path: string; mimeType: string; name: string }): Promise<DocReadResult> {
  const kind = kindOfMime(input.mimeType);
  const extension = extensionOf(input.name);

  if (kind === 'imagen') return emptyResult('imagen');

  if (kind === 'pdf' || input.mimeType === 'application/pdf' || extension === 'pdf') {
    return readPdf(input);
  }

  if (
    kind === 'oficina' ||
    ['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods'].includes(extension)
  ) {
    return readOfficeDocument(input);
  }

  if (isTextReadableKind(input.mimeType) || input.mimeType.startsWith('text/')) {
    return readPlainText(input);
  }

  // Un tipo que no sabemos leer no se inventa: se dice y ya está.
  return {
    mode: 'sin_texto',
    text: '',
    pages: 0,
    chars: 0,
    notes: [`No sé leer el texto de «${input.name}»: pásamelo en PDF, como texto o como captura`],
  };
}
