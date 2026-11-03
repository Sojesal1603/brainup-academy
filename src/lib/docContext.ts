/**
 * El documento, en trozos: lo que el catedrático puede leer de verdad.
 *
 * Un PDF de 300 páginas no cabe en un turno de chat, y mandarlo entero tampoco
 * sirve: se paga en tiempo, en memoria y en ruido. Lo que hace falta es que el
 * catedrático **sepa de qué va el documento** (el mapa) y que reciba **los trozos
 * que le tocan a la pregunta de ahora** (los extractos), con la página a la vista
 * para poder citarla. Si necesita algo que no está ahí, pide las páginas —«pásame
 * las páginas 210-214»— y el turno siguiente se las trae: eso es `parsePageRequests`,
 * que lee su propia respuesta anterior y traduce ese ruego a números.
 *
 * Este módulo es **puro de verdad** (sin `fs`, sin `prisma`, sin fecha del
 * sistema): entra texto, salen trozos y cadenas. Así se puede medir solo, sin
 * base de datos ni modelo, y el mismo troceado vale para el que acaba de subir
 * un archivo y para el que relee uno de hace un mes.
 */

/** Tope de un trozo. Más grande, y el modelo pierde el hilo; más pequeño, y no cabe una idea. */
export const CHUNK_MAX_CHARS = 1500;

/**
 * Solape entre trozos consecutivos: una idea que empieza al final de un párrafo y
 * sigue en el siguiente no puede caer justo en la frontera y desaparecer.
 */
export const CHUNK_OVERLAP_CHARS = 200;

/** Presupuesto de texto de documento que se mete en un turno (caracteres). */
export const DOC_CONTEXT_BUDGET_CHARS = 45_000;

/** Como mucho, estas páginas cuando el catedrático pide páginas. */
export const MAX_PAGES_PER_REQUEST = 12;

/**
 * Página más alta que se acepta en una petición («pásame la 70 000»). Es un tope
 * de cordura contra números absurdos, no un límite del tamaño del documento.
 */
export const MAX_PAGE_NUMBER = 500_000;

export interface DocChunk {
  /** Orden dentro del documento (0, 1, 2…). */
  index: number;
  /**
   * Página de la que sale el trozo, si el texto traía marcas de página. Es la de
   * su primera frase **propia** (el solape viene de la página anterior y es
   * contexto, no contenido: si se citara, se citaría mal).
   */
  page: number | null;
  /**
   * Primera y última página que **cubren** sus frases. Un trozo de 1 500
   * caracteres suele abarcar más de una página, así que pedir «la página 213»
   * tiene que encontrar el trozo que la contiene aunque su etiqueta diga 212.
   * Opcionales para no invalidar los índices ya guardados (sin ellos se usa
   * `page`).
   */
  pageFrom?: number | null;
  pageTo?: number | null;
  /** Primera línea con pinta de título: es lo que se enseña en el mapa. */
  label: string;
  text: string;
}

export interface IndexedDoc {
  id: string;
  name: string;
  /** Cómo se leyó el archivo: `texto`, `imagen`, `sin_texto`… */
  mode: string;
  pages: number;
  chars: number;
  /** Primer título del documento (o su nombre si no hay ninguno). */
  title: string;
  chunks: DocChunk[];
}

/* ------------------------------------------------------------------ */
/* Leer el texto: párrafos y páginas                                   */
/* ------------------------------------------------------------------ */

/**
 * La marca de página que deja el extractor. Se acepta con o sin acentos y con
 * espacios de más: el texto viene de un PDF ajeno y no siempre sale igual.
 */
const PAGE_LINE = /^---\s*p[áa]gina\s+(\d+)\s*---$/i;

interface Piece {
  page: number | null;
  text: string;
}

/**
 * Trocea el texto en párrafos, apuntando de qué página es cada uno. Un párrafo
 * son líneas seguidas sin línea en blanco (así un párrafo partido en varias
 * líneas por el PDF no se rompe en pedazos).
 */
function splitPieces(text: string): Piece[] {
  const pieces: Piece[] = [];
  let page: number | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const joined = buffer.join('\n').trim();
    buffer = [];
    if (joined.length > 0) pieces.push({ page, text: joined });
  };

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const marker = line.trim().match(PAGE_LINE);
    if (marker) {
      flush();
      const number = Number(marker[1]);
      if (Number.isFinite(number) && number > 0) page = number;
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    buffer.push(line);
  }

  flush();
  return pieces;
}

/** Un párrafo más largo que un trozo se parte por palabras (y una palabra gigante, a lo bruto). */
function sliceLongPiece(piece: Piece, maxChars: number): Piece[] {
  if (piece.text.length <= maxChars) return [piece];

  const out: Piece[] = [];
  let current = '';

  for (const word of piece.text.split(/\s+/)) {
    if (current.length > 0 && current.length + 1 + word.length > maxChars) {
      out.push({ page: piece.page, text: current });
      current = '';
    }
    current = current.length > 0 ? `${current} ${word}` : word;
    while (current.length > maxChars) {
      out.push({ page: piece.page, text: current.slice(0, maxChars) });
      current = current.slice(maxChars);
    }
  }

  if (current.length > 0) out.push({ page: piece.page, text: current });
  return out;
}

/** El final de un trozo, cortado por palabra, para el solape. */
function tailOf(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const tail = text.slice(text.length - maxChars);
  const space = tail.indexOf(' ');
  return (space > 0 ? tail.slice(space + 1) : tail).trim();
}

/* ------------------------------------------------------------------ */
/* Trocear                                                             */
/* ------------------------------------------------------------------ */

const HEADING_LINE = /^#{1,6}\s+(.+)$/;
const NUMBERED_LINE = /^\d+(?:\.\d+){0,3}[.)]?\s+\S/;

/** Texto de una línea, sin marcas de Markdown, para usarlo como etiqueta. */
function clean(text: string): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[*_`>#]/g, '')
    .trim();
}

/** ¿La línea está en mayúsculas? (un título de sección de toda la vida). */
function isUpperLine(line: string): boolean {
  const letters = line.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, '');
  return letters.length >= 3 && letters === letters.toUpperCase();
}

/**
 * La etiqueta del trozo: su primer título si lo tiene. Se busca en las primeras
 * líneas (`## Los enlaces`, `1.2 Tipos de enlace`, `ELECTRÓLISIS`) y, si no hay
 * nada con pinta de título, se usan los primeros caracteres del texto. Sirve para
 * el mapa: es lo que le dice al catedrático «por aquí se habla de esto».
 */
function labelOf(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 6);

  for (const line of lines) {
    const heading = line.match(HEADING_LINE);
    if (heading) return clean(heading[1]).slice(0, 80);
    if (NUMBERED_LINE.test(line) && line.length <= 90) return clean(line).slice(0, 80);
    if (line.length >= 3 && line.length <= 70 && !/[.,;:]$/.test(line) && isUpperLine(line)) {
      return clean(line).slice(0, 80);
    }
  }

  return clean(text).slice(0, 60);
}

/**
 * El documento en trozos: párrafos consecutivos hasta `CHUNK_MAX_CHARS`, con
 * `CHUNK_OVERLAP_CHARS` del trozo anterior delante. La página del trozo es la de
 * su primera frase propia (el solape viene de la página anterior y es contexto,
 * no contenido: si se citara, se citaría mal).
 */
export function chunkDocument(text: string): DocChunk[] {
  const pieces = splitPieces(text).flatMap((piece) => sliceLongPiece(piece, CHUNK_MAX_CHARS));
  const chunks: DocChunk[] = [];

  /** Lo que lleva el trozo en construcción (con el solape del anterior delante). */
  let current = '';
  /** Página de la primera frase PROPIA del trozo (el solape es de la anterior). */
  let currentPage: number | null = null;
  /** Primera y última página que cubren sus frases propias. */
  let currentFrom: number | null = null;
  let currentTo: number | null = null;
  /** Solape que entra al empezar un trozo nuevo. */
  let carry = '';

  const close = () => {
    const body = current.trim();
    // La página se guarda ANTES de limpiarla: es el dato que luego se cita.
    const page = currentPage;
    const pageFrom = currentFrom;
    const pageTo = currentTo;
    current = '';
    currentPage = null;
    currentFrom = null;
    currentTo = null;
    if (body.length === 0) return;
    chunks.push({ index: chunks.length, page, pageFrom, pageTo, label: labelOf(body), text: body });
  };

  for (const piece of pieces) {
    if (current.length === 0) {
      current = carry.length > 0 ? `${carry}\n\n${piece.text}` : piece.text;
      currentPage = piece.page;
      currentFrom = piece.page;
      currentTo = piece.page;
      continue;
    }

    const addition = `${current}\n\n${piece.text}`;
    if (addition.length <= CHUNK_MAX_CHARS) {
      current = addition;
      if (piece.page !== null) {
        if (currentFrom === null) currentFrom = piece.page;
        currentTo = piece.page;
      }
      continue;
    }

    // No cabe: se cierra el trozo y el siguiente arranca con el final del que se
    // acaba de cerrar, para que una idea a caballo entre los dos no se pierda.
    close();
    carry = tailOf(chunks.length > 0 ? chunks[chunks.length - 1].text : '', CHUNK_OVERLAP_CHARS);
    current = `${carry}\n\n${piece.text}`;
    currentPage = piece.page;
    currentFrom = piece.page;
    currentTo = piece.page;
  }

  close();

  return chunks;
}

/* ------------------------------------------------------------------ */
/* Términos: qué pregunta y de qué va cada trozo                       */
/* ------------------------------------------------------------------ */

/**
 * Palabras que no distinguen nada. Fuera de la puntuación: si se quedan, «para»
 * o «como» aparecen en todos los trozos y la búsqueda no dice nada.
 */
const STOPWORDS = new Set([
  'para', 'como', 'porque', 'cuando', 'donde', 'desde', 'hasta', 'entre', 'sobre', 'segun',
  'tambien', 'tiene', 'tienen', 'puede', 'pueden', 'hace', 'hacen', 'este', 'esta', 'estos',
  'estas', 'esto', 'esos', 'esas', 'aquel', 'aquella', 'todo', 'toda', 'todos', 'todas',
  'muy', 'mas', 'menos', 'sino', 'pero', 'aunque', 'mientras', 'cual', 'cuales', 'quien',
  'quienes', 'cada', 'otro', 'otra', 'otros', 'otras', 'mismo', 'misma', 'tanto', 'tanta',
  'casi', 'solo', 'seria', 'serian', 'sera', 'seran', 'haya', 'hay', 'han', 'hemos', 'sido',
  'esta', 'estan', 'estoy', 'estas', 'eje', 'ejemplo', 'ejemplos', 'explica', 'explicar',
  'dime', 'quiero', 'necesito', 'puedes', 'podrias', 'ayuda', 'ayudame', 'entiendo',
  'the', 'and', 'with', 'from', 'this', 'that', 'what', 'how',
]);

/** Sin acentos y en minúsculas, para comparar «función» con «funcion». */
function fold(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Los términos con su número de apariciones. Cortos y vacíos, fuera. */
function termsOf(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of fold(text).split(/[^a-z0-9]+/)) {
    if (word.length < 4) continue;
    if (STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

interface DocTerms {
  /** En cuántos trozos sale cada término (frecuencia de documento). */
  df: Map<string, number>;
  perChunk: Array<Map<string, number>>;
}

/**
 * Los términos de un documento se calculan una vez y se recuerdan mientras el
 * proceso viva: trocear y contar 12 millones de caracteres en cada pregunta del
 * chat se nota en la espera del alumno, y el documento no cambia.
 */
const termCache = new Map<string, DocTerms>();
const TERM_CACHE_MAX = 8;

function termsFor(doc: IndexedDoc): DocTerms {
  const key = `${doc.id}|${doc.chunks.length}|${doc.chars}|${doc.title}`;
  const cached = termCache.get(key);
  if (cached) return cached;

  const perChunk = doc.chunks.map((chunk) => termsOf(chunk.text.slice(0, 4000)));
  const df = new Map<string, number>();
  for (const counts of perChunk) {
    for (const term of counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const value: DocTerms = { df, perChunk };
  termCache.set(key, value);
  if (termCache.size > TERM_CACHE_MAX) {
    const oldest = termCache.keys().next().value;
    if (oldest !== undefined) termCache.delete(oldest);
  }
  return value;
}

export interface RankedChunk {
  chunk: DocChunk;
  score: number;
}

/**
 * Los trozos ordenados por lo que tienen que ver con la pregunta.
 *
 * La puntuación es **frecuencia inversa**: compartir un término que sale en dos
 * trozos de trescientos dice muchísimo más que compartir uno que sale en todos.
 * Y si el término está también en el **título** del apartado, el trozo va de eso
 * y se multiplica por 1,5. Es determinista y no gasta ni una llamada de IA.
 */
export function rankChunks(doc: IndexedDoc, question: string): RankedChunk[] {
  const questionTerms = termsOf(question);
  if (questionTerms.size === 0 || doc.chunks.length === 0) return [];

  const { df, perChunk } = termsFor(doc);
  const totalChunks = Math.max(1, doc.chunks.length);

  const ranked = doc.chunks.map((chunk, index) => {
    const counts = perChunk[index] ?? new Map<string, number>();
    let score = 0;

    for (const [term, appearances] of counts) {
      if (!questionTerms.has(term)) continue;
      const frequency = df.get(term) ?? 1;
      score += (totalChunks / frequency) * (1 + Math.log(1 + appearances));
    }

    if (score > 0) {
      for (const term of termsOf(chunk.label).keys()) {
        if (questionTerms.has(term)) {
          score *= 1.5;
          break;
        }
      }
    }

    return { chunk, score };
  });

  ranked.sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index);
  return ranked;
}

/* ------------------------------------------------------------------ */
/* Elegir los trozos de este turno                                     */
/* ------------------------------------------------------------------ */

/**
 * ¿Este trozo contiene la página pedida? Se mira **todo el rango** que cubre, no
 * solo su etiqueta: un trozo de 1 500 caracteres abarca varias páginas y pedir
 * «la página 213» tiene que traer el trozo que la contiene (aunque empiece en la
 * 212). En los índices antiguos, sin rango, se usa la página del trozo.
 */
function coversPage(chunk: DocChunk, page: number): boolean {
  const from = chunk.pageFrom ?? chunk.page;
  if (from === null || from === undefined) return false;
  const to = chunk.pageTo ?? from;
  return page >= from && page <= to;
}

/**
 * Los trozos que se le dan al catedrático en este turno: primero los de las
 * páginas que ha pedido (en su orden) y después los mejor puntuados, sin repetir
 * y **sin pasarse nunca** de `budgetChars`: ese presupuesto es el turno del
 * alumno, que está esperando.
 */
export function selectChunks(
  doc: IndexedDoc,
  question: string,
  options: { budgetChars: number; pages?: number[] }
): DocChunk[] {
  const budget = Math.max(0, Math.floor(options?.budgetChars ?? 0));
  if (budget <= 0 || !Array.isArray(doc?.chunks) || doc.chunks.length === 0) return [];

  const chosen: DocChunk[] = [];
  const used = new Set<number>();
  let left = budget;

  const add = (index: number) => {
    const chunk = doc.chunks[index];
    if (!chunk || used.has(index)) return;

    if (chunk.text.length <= left) {
      chosen.push(chunk);
      used.add(index);
      left -= chunk.text.length;
      return;
    }

    // Un solo trozo más grande que todo el presupuesto: antes que devolver nada,
    // se entrega recortado. Es el único sitio donde se recorta, y se dice.
    if (chosen.length === 0 && left > 200) {
      chosen.push({ ...chunk, text: `${chunk.text.slice(0, left - 1).trimEnd()}…` });
      used.add(index);
      left = 0;
    }
  };

  for (const page of options.pages ?? []) {
    for (const chunk of doc.chunks) {
      if (coversPage(chunk, page)) add(chunk.index);
    }
  }

  for (const row of rankChunks(doc, question)) {
    if (row.score <= 0) break;
    add(row.chunk.index);
    if (left <= 0) break;
  }

  return chosen;
}

/* ------------------------------------------------------------------ */
/* El mapa: de qué va el documento                                     */
/* ------------------------------------------------------------------ */

function entryOf(chunk: DocChunk): string {
  if (!chunk.page) return `«${chunk.label}»`;
  const to = chunk.pageTo ?? chunk.page;
  const range = to > chunk.page ? `págs. ${chunk.page}-${to}` : `pág. ${chunk.page}`;
  return `${range} · «${chunk.label}»`;
}

/**
 * El mapa del documento: los apartados con su página, en una línea. Es lo que
 * permite pedir «más» con sentido (si el catedrático ve que hay un apartado
 * «Electrólisis» en la página 88, puede pedirlo). Con muchos apartados se cogen
 * repartidos por **todo** el documento, no solo los primeros, y se dice cuántos
 * quedan fuera.
 */
export function documentMap(doc: IndexedDoc, maxEntries = 60): string {
  const limit = Math.max(1, Math.floor(Number.isFinite(maxEntries) ? maxEntries : 60));
  const seen = new Set<string>();
  const labelled: DocChunk[] = [];

  for (const chunk of doc?.chunks ?? []) {
    const key = `${chunk.page ?? '-'}|${chunk.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    labelled.push(chunk);
  }

  if (labelled.length === 0) return doc?.title ? `«${doc.title}»` : '';

  const entries: string[] = [];
  if (labelled.length <= limit) {
    for (const chunk of labelled) entries.push(entryOf(chunk));
  } else {
    // Los apartados que se enseñan van repartidos por TODO el documento y con el
    // primero y el último dentro: el catedrático tiene que saber que el temario
    // acaba donde acaba (y poder pedir el final) aunque el mapa sea corto.
    const last = labelled.length - 1;
    const picks: number[] = [];
    for (let i = 0; i < limit; i += 1) {
      const index = limit === 1 ? 0 : Math.round((i * last) / (limit - 1));
      if (!picks.includes(index)) picks.push(index);
    }
    for (const index of picks) entries.push(entryOf(labelled[index]));
    entries.push(`y ${labelled.length - picks.length} apartado(s) más`);
  }

  return entries.join(' · ');
}

/* ------------------------------------------------------------------ */
/* Lo que el catedrático pide («pásame las páginas 210-214»)           */
/* ------------------------------------------------------------------ */

/**
 * Las páginas que pide el catedrático en su respuesta anterior, en números.
 *
 * Es el sustituto honesto de una herramienta de búsqueda: el modelo dice qué
 * quiere («pásame las páginas 210-214») y estas se le sirven en el turno
 * siguiente. Un rango al revés o imposible se descarta; un rango enorme se corta
 * por `MAX_PAGES_PER_REQUEST` en vez de tragarse medio libro.
 */
export function parsePageRequests(text: string): number[] {
  const source = String(text ?? '');
  const out: number[] = [];

  const add = (value: number) => {
    if (!Number.isFinite(value)) return;
    const page = Math.floor(value);
    // El tope es de cordura (un número de página, no un año): un libro de 70 000
    // páginas es un documento real y sus páginas tienen que poder pedirse.
    if (page < 1 || page > MAX_PAGE_NUMBER) return;
    if (out.length >= MAX_PAGES_PER_REQUEST) return;
    if (!out.includes(page)) out.push(page);
  };

  // Rangos: «páginas 210-214», «págs. 210 a 214», «page 210–214». Los números van
  // acotados por los dos lados (`(?<!\d)…(?!\d)`) para que un «99999999» no se lea
  // como la página 99999: un número de página es un número entero, no un trozo.
  const range = /\b(?:p[áa]ginas?|p[áa]gs?\.?|pages?)\s*(?:n[ºo°]?\s*)?(?<!\d)(\d{1,6})(?!\d)\s*(?:-|–|—|a|hasta|to)\s*(?<!\d)(\d{1,6})(?!\d)/gi;
  for (const match of source.matchAll(range)) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    // Un rango al revés no es una petición: se ignora entero (y por eso se
    // recuerda su texto para no volver a mirarlo como si fueran sueltas).
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
    for (let page = from; page <= to && out.length < MAX_PAGES_PER_REQUEST; page += 1) add(page);
  }

  // Sueltas y listas: «página 213», «páginas 12, 15 y 20», «pág. 4/5». Los rangos
  // ya se han resuelto arriba, así que se tapan antes de buscarlas sueltas: si
  // no, un «90-40» (que no es nada) dejaría colado un 90 como si lo pidiera.
  const sinRangos = source.replace(new RegExp(range.source, 'gi'), ' ');
  const single = /\b(?:p[áa]ginas?|p[áa]gs?\.?|pages?)\s*(?:n[ºo°]?\s*)?(?<!\d)(\d{1,6}(?!\d)(?:\s*(?:,|y|e|\/)\s*\d{1,6}(?!\d))*)/gi;
  for (const match of sinRangos.matchAll(single)) {
    for (const raw of match[1].split(/\s*(?:,|y|e|\/)\s*/i)) add(Number(raw));
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* El bloque de prompt                                                 */
/* ------------------------------------------------------------------ */

/** Miles con punto, como se escriben aquí («412.300 caracteres»). */
function thousands(value: number): string {
  const rounded = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function pagesLabel(doc: IndexedDoc): string {
  return doc.pages > 0 ? `${doc.pages} páginas` : 'sin paginación';
}

/** Texto de un trozo con las líneas de continuación alineadas bajo la etiqueta. */
function blockText(chunk: DocChunk): string {
  const to = chunk.pageTo ?? chunk.page;
  const where =
    chunk.page === null
      ? `trozo ${chunk.index + 1}`
      : to && to > chunk.page
        ? `págs. ${chunk.page}-${to}`
        : `pág. ${chunk.page}`;
  const head = `[${where}]`;
  const [first, ...rest] = chunk.text.split('\n');
  const lines = [`   ${head} ${first}`];
  for (const line of rest) lines.push(`   ${' '.repeat(head.length)} ${line}`);
  return lines.join('\n');
}

/**
 * El bloque que se le mete al catedrático en el prompt: qué documentos tiene,
 * de qué va cada uno (mapa) y los extractos que le tocan a **esta** pregunta.
 *
 * El reparto entre varios documentos es **proporcional a lo que cada uno tiene
 * que ver** con la pregunta (con un suelo para que ninguno se quede sin su mapa:
 * puede ser justo el que haga falta pedir). Devuelve cadena vacía si no hay
 * documentos.
 */
export function buildDocumentContext(
  docs: IndexedDoc[],
  question: string,
  options: { budgetChars?: number; pages?: number[] } = {}
): string {
  const list = (Array.isArray(docs) ? docs : []).filter(
    (doc): doc is IndexedDoc => Boolean(doc) && Array.isArray(doc.chunks) && doc.chunks.length > 0
  );
  if (list.length === 0) return '';

  const budget = Math.max(0, Math.floor(options.budgetChars ?? DOC_CONTEXT_BUDGET_CHARS));
  if (budget === 0) return '';

  // 1. Cuánto pesa cada documento: se mira qué se seleccionaría de cada uno con
  //    el presupuesto entero y se queda con lo que puntúan sus mejores trozos.
  const probes = list.map((doc) => {
    const best = rankChunks(doc, question).slice(0, 6);
    const score = best.reduce((total, row) => total + row.score, 0);
    // Acotado en (0,5 · 1,5]: un documento sin ninguna coincidencia no puede
    // quedarse a cero (su mapa hay que darlo) ni uno muy bueno comerse el turno.
    const weight = 0.5 + score / (1 + score);
    return { doc, weight };
  });

  const totalWeight = probes.reduce((total, probe) => total + probe.weight, 0) || 1;
  const shares = probes.map((probe) => Math.floor((budget * probe.weight) / totalWeight));

  // 2. Suelo por documento (que se vea algo de cada uno) y, si con los suelos no
  //    cabe, se reparte el presupuesto tal cual: el tope manda.
  const withFloor = (share: number, doc: IndexedDoc) => Math.max(share, Math.min(3000, doc.chars));
  const floored = probes.map((probe, index) => withFloor(shares[index], probe.doc));
  const flooredTotal = floored.reduce((total, value) => total + value, 0);
  const finalShares =
    flooredTotal <= budget
      ? floored
      : probes.map((probe) => Math.max(0, Math.floor((budget * probe.weight) / totalWeight)));

  // 3. Se selecciona con lo que le toca a cada uno y lo que sobra (un documento
  //    corto no gasta su parte) se reparte entre los que se quedaron sin sitio.
  const selections = probes.map((probe, index) => ({
    doc: probe.doc,
    picked: selectChunks(probe.doc, question, { budgetChars: finalShares[index], pages: options.pages }),
  }));

  const spent = selections.reduce(
    (total, selection) => total + selection.picked.reduce((sum, chunk) => sum + chunk.text.length, 0),
    0
  );
  let leftover = Math.max(0, budget - spent);

  if (leftover > 500) {
    const order = selections
      .map((selection, index) => ({ index, weight: probes[index].weight }))
      .sort((a, b) => b.weight - a.weight);

    for (const { index } of order) {
      if (leftover <= 500) break;
      const selection = selections[index];
      const extra = selectChunks(selection.doc, question, {
        budgetChars: selection.picked.reduce((sum, chunk) => sum + chunk.text.length, 0) + leftover,
        pages: options.pages,
      });
      const alreadyThere = new Set(selection.picked.map((chunk) => chunk.index));
      const added = extra.filter((chunk) => !alreadyThere.has(chunk.index));
      if (added.length === 0) continue;
      const grew = added.reduce((sum, chunk) => sum + chunk.text.length, 0);
      selection.picked = [...selection.picked, ...added];
      leftover -= grew;
    }
  }

  // 4. Se pinta. Los extractos van en orden de documento (página y luego índice)
  //    aunque se hayan elegido por relevancia: así se lee como un texto seguido.
  const lines: string[] = [];
  lines.push('DOCUMENTOS QUE TE HA DADO EL ALUMNO (los ha leído la app; tú solo ves lo que va aquí):');

  selections.forEach((selection, index) => {
    const { doc } = selection;
    lines.push(
      `${index + 1}) «${doc.name}» · ${pagesLabel(doc)} · ${thousands(doc.chars)} caracteres · modo: ${doc.mode}`
    );

    const map = documentMap(doc);
    if (map) lines.push(`   MAPA (para que sepas de qué va y por dónde pedir más): ${map}`);

    if (selection.picked.length === 0) {
      lines.push(
        '   No he encontrado nada de esta pregunta en su texto: mira el mapa y pídele el apartado o las páginas que necesites.'
      );
      return;
    }

    const ordered = [...selection.picked].sort(
      (a, b) => (a.page ?? Number.MAX_SAFE_INTEGER) - (b.page ?? Number.MAX_SAFE_INTEGER) || a.index - b.index
    );

    lines.push('   EXTRACTOS QUE LE TOCAN A ESTA PREGUNTA:');
    for (const chunk of ordered) lines.push(blockText(chunk));
    if (ordered.length < doc.chunks.length) {
      lines.push(
        `   (has visto ${ordered.length} de ${doc.chunks.length} trozos; el resto está a un «pásame las páginas X» de distancia)`
      );
    }
  });

  lines.push(
    'CÓMO USARLOS: cita la página o el apartado de donde sale lo que digas («en la página 213 de tus apuntes pone…»). Si lo que necesitas no está en los extractos, NO lo inventes: pídele al alumno las páginas o el apartado exacto y te lo traerá en el siguiente mensaje.'
  );

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Construir el índice                                                 */
/* ------------------------------------------------------------------ */

/** El primer título del documento, o su nombre si no hay ninguno. */
function titleOf(chunks: DocChunk[], name: string): string {
  const first = chunks.find((chunk) => chunk.label.length > 0);
  return first ? first.label : clean(name);
}

/**
 * El documento listo para guardar: su texto troceado y el mapa que sale de él.
 * Es lo que se calcula **una vez**, al subir el archivo, para que cada pregunta
 * del chat no tenga que volver a trocear 300 páginas.
 */
export function buildDocumentIndex(input: {
  id: string;
  name: string;
  text: string;
  pages: number;
  mode: string;
}): IndexedDoc {
  const text = String(input?.text ?? '');
  const chunks = chunkDocument(text);
  const name = String(input?.name ?? 'documento');
  const pages = Number(input?.pages);

  return {
    id: String(input?.id ?? ''),
    name,
    mode: String(input?.mode ?? 'texto'),
    pages: Number.isFinite(pages) ? Math.max(0, Math.floor(pages)) : 0,
    chars: text.length,
    title: titleOf(chunks, name),
    chunks,
  };
}
