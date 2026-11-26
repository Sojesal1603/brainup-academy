/**
 * Recuperación estricta del catedrático.
 *
 * Qué aporta esta capa y qué NO:
 *
 *   · Filtra SIEMPRE por `userId` antes de puntuar. Un fragmento de otra cuenta
 *     no llega ni a la lista de candidatos.
 *   · Recupera por léxico y estructura (título, página, rango de páginas). Es
 *     determinista y no gasta una llamada de IA.
 *   · Deja preparada la fusión RRF con vectores, pero **apagada por defecto**:
 *     `RETRIEVAL_MODE=hybrid` solo se usa si hay puntuaciones vectoriales. Sin
 *     ellas, el modo efectivo sigue siendo léxico; nunca se inventa un vector.
 *
 * El módulo es puro (sin Prisma, sin red) para poder probarlo con dos corpus
 * sintéticos y demostrar el aislamiento sin tocar la base.
 */

import { chunkDocument, type DocChunk, type IndexedDoc } from '../docContext';
import type { CitationChunk } from './citation';
import { renderChunkContext, type PromptChunk } from './prompts';

export type TutorScope = 'estudio' | 'curiosidad' | 'examen';
export type RetrievalMode = 'lexical' | 'hybrid';

export const TUTOR_SCOPES: readonly TutorScope[] = ['estudio', 'curiosidad', 'examen'];

export interface RetrievalSourceChunk {
  id: string;
  userId: string;
  kind: 'document' | 'note' | 'upload';
  sourceId: string;
  sourceTitle: string;
  label: string;
  pageFrom: number | null;
  pageTo: number | null;
  text: string;
  order: number;
}

export interface RetrievalSourceMeta {
  id: string;
  title: string;
  kind: RetrievalSourceChunk['kind'];
  label: string;
  pageFrom: number | null;
  pageTo: number | null;
}

export interface RetrievalPlan {
  scope: TutorScope;
  requestedMode: RetrievalMode;
  /** Modo que se ha aplicado de verdad. `hybrid` solo si había vectores. */
  mode: RetrievalMode;
  /** Fragmentos que se le enseñan al modelo, ya recortados al presupuesto. */
  chunks: PromptChunk[];
  /** Mapa para el validador: solo lo que se ha mandado en ESTE turno. */
  allowed: Map<string, CitationChunk>;
  sources: RetrievalSourceMeta[];
  /** Metadatos por `chunkId` para construir la lista de fuentes visible. */
  chunkMeta: Map<string, RetrievalSourceMeta>;
  /** Bloques del corpus de esta materia/unidad (no solo los recuperados). */
  corpusBlocks: number;
  retrievedBlocks: number;
  /** Bloques con alguna coincidencia léxica antes de recortar por presupuesto. */
  matchedBlocks: number;
  /** Solo en `estudio`: no hay material o nada se parece a la pregunta. */
  outOfScope: boolean;
  reason: 'sin_fuentes' | 'sin_coincidencias' | null;
  /** Texto listo para el prompt, con identificadores citables. Vacío sin chunks. */
  prompt: string;
}

/** Normaliza el modo del alumno. Cualquier cosa rara cae en `estudio`. */
export function normalizeTutorScope(value: unknown): TutorScope {
  if (typeof value !== 'string') return 'estudio';
  const normalized = value.trim().toLowerCase();
  return (TUTOR_SCOPES as readonly string[]).includes(normalized)
    ? (normalized as TutorScope)
    : 'estudio';
}

/**
 * `lexical` por defecto, siempre. El híbrido es una mejora que hay que validar
 * con preguntas reales antes de encenderlo; una variable mal puesta no lo activa.
 */
export function normalizeRetrievalMode(value: unknown = process.env.RETRIEVAL_MODE): RetrievalMode {
  if (typeof value !== 'string') return 'lexical';
  return value.trim().toLowerCase() === 'hybrid' ? 'hybrid' : 'lexical';
}

/**
 * Un saludo o un «gracias» no es una pregunta de contenido: no debe quedar
 * «fuera de temario» ni bloquear el chat por no aparecer en los apuntes.
 */
export function isConversationalQuery(query: string): boolean {
  const text = fold(query).replace(/[^a-z0-9áéíóúñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.length > 40) return false;
  if (/^(gracias|muchas gracias|vale|ok|de acuerdo|perfecto|genial|que tal|como estas|como va)$/.test(text)) {
    return true;
  }
  return /^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey)( (que tal|como estas|como va))?$/.test(text);
}

const STOPWORDS = new Set([
  'para', 'como', 'porque', 'cuando', 'donde', 'desde', 'hasta', 'entre', 'sobre', 'segun',
  'tambien', 'tiene', 'tienen', 'puede', 'pueden', 'hace', 'hacen', 'este', 'esta', 'estos',
  'estas', 'esto', 'esos', 'esas', 'aquel', 'aquella', 'todo', 'toda', 'todos', 'todas',
  'muy', 'mas', 'menos', 'sino', 'pero', 'aunque', 'mientras', 'cual', 'cuales', 'quien',
  'quienes', 'cada', 'otro', 'otra', 'otros', 'otras', 'mismo', 'misma', 'tanto', 'tanta',
  'casi', 'solo', 'seria', 'serian', 'sera', 'seran', 'haya', 'hay', 'han', 'hemos', 'sido',
  'estoy', 'dime', 'quiero', 'necesito', 'puedes', 'podrias', 'ayuda', 'ayudame', 'entiendo',
  'explica', 'explicame', 'explicar', 'the', 'and', 'with', 'from', 'this', 'that', 'what', 'how',
]);

function fold(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Equivalencias directas y frecuentes en apuntes de instituto. No es una
 * ontología: es una red de seguridad barata para que «sustracción» encuentre
 * «resta» sin encender embeddings. La primera palabra de cada grupo es la
 * forma canónica que se usa para puntuar.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['suma', 'adicion', 'adicionar', 'sumar', 'sumando'],
  ['resta', 'sustraccion', 'sustraer', 'sustraendo', 'restar'],
  ['multiplicacion', 'multiplicar', 'producto'],
  ['division', 'dividir', 'cociente'],
  ['derivada', 'derivar', 'diferenciacion', 'diferenciar'],
  ['integral', 'integrar', 'integracion', 'antiderivada'],
  ['velocidad', 'rapidez'],
  ['aceleracion', 'acelerar'],
  ['gravedad', 'gravitacion'],
  ['fotosintesis', 'fotosintetica'],
  ['respiracion', 'respirar'],
  ['celula', 'celular'],
  ['adn', 'dna'],
  ['arn', 'rna'],
  ['oracion', 'frase'],
  ['sustantivo', 'nombre'],
  ['guerra', 'conflicto', 'belico'],
  ['revolucion', 'revuelta'],
  ['poblacion', 'demografia'],
  ['enlace', 'union'],
];

const SYNONYMS = new Map<string, string>();
for (const group of SYNONYM_GROUPS) {
  const canonical = stemSpanish(group[0]!);
  for (const word of group) SYNONYMS.set(stemSpanish(word), canonical);
}

/**
 * Lematización mínima del español, a propósito conservadora: plurales y
 * terminaciones verbales habituales. No pretende ser un stemmer académico;
 * busca que «restas» y «resta» cuenten como el mismo término sin fusionar
 * palabras que no tienen nada que ver.
 */
function stemSpanish(word: string): string {
  let stem = word;
  if (stem.length > 5 && stem.endsWith('ces')) {
    stem = `${stem.slice(0, -3)}z`;
  } else if (stem.length > 5 && stem.endsWith('es')) {
    stem = stem.slice(0, -2);
  } else if (stem.length > 4 && stem.endsWith('s')) {
    stem = stem.slice(0, -1);
  }
  if (stem.length > 6) {
    if (stem.endsWith('iendo')) stem = stem.slice(0, -5);
    else if (stem.endsWith('ando')) stem = stem.slice(0, -4);
    else if (stem.endsWith('ado') || stem.endsWith('ido')) stem = stem.slice(0, -3);
  }
  return stem;
}

/** Forma estable de un término para comparar pregunta y fragmento. */
export function canonicalRetrievalTerm(word: string): string {
  const normalized = stemSpanish(fold(word).replace(/[^a-z0-9]+/g, ''));
  return SYNONYMS.get(normalized) ?? normalized;
}

function termsOf(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of fold(text).split(/[^a-z0-9]+/)) {
    if (word.length < 3) continue;
    if (STOPWORDS.has(word)) continue;
    const term = canonicalRetrievalTerm(word);
    // Los términos de tres letras solo entran si son siglas conocidas (ADN,
    // ARN…); el resto sería ruido para el IDF.
    if (term.length < 4 && !SYNONYMS.has(term)) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

interface ScoredChunk {
  chunk: RetrievalSourceChunk;
  score: number;
}

/**
 * Ranking léxico con IDF sobre el corpus visible de la cuenta. Un término que
 * sale en todos los fragmentos no ayuda; uno que solo sale en el correcto, sí.
 * La etiqueta y el título pesan más: si la pregunta nombra el apartado, ese
 * fragmento va delante aunque el cuerpo repita palabras comunes.
 */
export function rankRetrievalChunks(
  chunks: readonly RetrievalSourceChunk[],
  query: string
): ScoredChunk[] {
  const question = termsOf(query);
  const total = Math.max(1, chunks.length);

  if (question.size === 0) {
    return chunks
      .slice()
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.order - b.order)
      .map((chunk) => ({ chunk, score: 1 }));
  }

  const perChunk = chunks.map((chunk) => termsOf(chunk.text.slice(0, 5000)));
  const df = new Map<string, number>();
  for (const counts of perChunk) {
    for (const term of counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const phrase = fold(query).replace(/\s+/g, ' ').trim();

  const scored = chunks.map((chunk, index) => {
    const counts = perChunk[index];
    let score = 0;
    for (const [term, appearances] of counts) {
      if (!question.has(term)) continue;
      const frequency = df.get(term) ?? 1;
      score += (total / frequency) * (1 + Math.log(1 + appearances));
    }

    if (score > 0) {
      const labelTerms = termsOf(`${chunk.label} ${chunk.sourceTitle}`);
      for (const term of labelTerms.keys()) {
        if (question.has(term)) {
          score *= 1.5;
          break;
        }
      }
      if (phrase.length >= 8 && fold(chunk.text).includes(phrase)) score += 2;
    }

    return { chunk, score };
  });

  return scored.sort((a, b) => b.score - a.score || a.chunk.order - b.chunk.order);
}

/**
 * Fusión Reciprocal Rank Fusion: suma 1/(k + posición) de cada lista. Es la
 * forma estándar de combinar léxico y vectores sin comparar puntuaciones de
 * escalas distintas. `k = 60` es el valor habitual y estable.
 */
export function fuseRrf(
  lexical: readonly RetrievalSourceChunk[],
  vector: readonly RetrievalSourceChunk[],
  k = 60
): RetrievalSourceChunk[] {
  const scores = new Map<string, number>();
  const byId = new Map<string, RetrievalSourceChunk>();

  const add = (list: readonly RetrievalSourceChunk[]) => {
    list.forEach((chunk, index) => {
      byId.set(chunk.id, chunk);
      scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (k + index + 1));
    });
  };

  add(lexical);
  add(vector);

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => byId.get(id))
    .filter((chunk): chunk is RetrievalSourceChunk => Boolean(chunk));
}

function coversPage(chunk: RetrievalSourceChunk, page: number): boolean {
  const from = chunk.pageFrom;
  if (from === null || from === undefined) return false;
  const to = chunk.pageTo ?? from;
  return page >= from && page <= to;
}

/**
 * Elige lo que viaja al modelo. Primero las páginas que haya pedido en el turno
 * anterior, después el ranking. Nunca más de `budgetChars`.
 */
export function selectRetrievalContext(params: {
  userId: string;
  chunks: readonly RetrievalSourceChunk[];
  query: string;
  scope: TutorScope;
  mode?: RetrievalMode;
  budgetChars?: number;
  maxChunks?: number;
  pages?: readonly number[];
  vectorScores?: ReadonlyMap<string, number>;
  /** Un saludo o un turno sin pregunta no se bloquea por no citar el temario. */
  allowNoMatch?: boolean;
}): RetrievalPlan {
  const scope = params.scope;
  const requestedMode = params.mode ?? 'lexical';
  const budget = Math.max(0, Math.floor(params.budgetChars ?? 30_000));
  const maxChunks = Math.max(1, Math.floor(params.maxChunks ?? 20));

  // La frontera de seguridad: se filtra por dueño ANTES de puntuar. Aunque el
  // llamador junte corpus de varias cuentas, aquí no pasa ni un fragmento ajeno.
  const own = (params.chunks ?? []).filter((chunk) => chunk.userId === params.userId);

  const lexicalRanked = rankRetrievalChunks(own, params.query);
  const lexical = lexicalRanked.filter((row) => row.score > 0).map((row) => row.chunk);

  let ranked = lexical;
  let mode: RetrievalMode = 'lexical';

  if (requestedMode === 'hybrid' && params.vectorScores && params.vectorScores.size > 0) {
    const vector = own
      .filter((chunk) => (params.vectorScores?.get(chunk.id) ?? 0) > 0)
      .sort(
        (a, b) =>
          (params.vectorScores?.get(b.id) ?? 0) - (params.vectorScores?.get(a.id) ?? 0) ||
          a.order - b.order
      );
    if (vector.length > 0) {
      ranked = fuseRrf(lexical, vector);
      mode = 'hybrid';
    }
  }

  // Si la pregunta no tiene términos (o no hay coincidencias), no se manda un
  // fragmento al azar: en estudio es «fuera de ámbito»; en curiosidad se sigue
  // sin contexto, que es justo lo que permite ese modo.
  const hasQuery = termsOf(params.query).size > 0;
  const matchedBlocks = hasQuery ? lexical.length : Math.min(own.length, 1);

  const ordered: RetrievalSourceChunk[] = [];
  const used = new Set<string>();
  const add = (chunk: RetrievalSourceChunk) => {
    if (used.has(chunk.id)) return;
    ordered.push(chunk);
    used.add(chunk.id);
  };

  for (const page of params.pages ?? []) {
    for (const chunk of own) {
      if (coversPage(chunk, page)) add(chunk);
    }
  }

  for (const chunk of ranked) {
    add(chunk);
    if (ordered.length >= maxChunks) break;
  }

  if (hasQuery && ordered.length === 0 && !params.pages?.length) {
    // Sin coincidencias: el plan queda vacío. El modo decide qué hacer con eso.
  }

  const chunks: PromptChunk[] = [];
  const allowed = new Map<string, CitationChunk>();
  const sources = new Map<string, RetrievalSourceMeta>();
  const chunkMeta = new Map<string, RetrievalSourceMeta>();
  let left = budget;

  for (const chunk of ordered) {
    if (chunks.length >= maxChunks || left < 80) break;
    const text = chunk.text.length > left ? `${chunk.text.slice(0, Math.max(0, left - 1)).trimEnd()}…` : chunk.text;
    if (text.length < 20) break;

    chunks.push({
      id: chunk.id,
      label: `${chunk.sourceTitle}${chunk.label ? ` · ${chunk.label}` : ''}`,
      pageFrom: chunk.pageFrom,
      pageTo: chunk.pageTo,
      text,
    });
    allowed.set(chunk.id, {
      id: chunk.id,
      userId: chunk.userId,
      text: chunk.text,
    });
    const meta: RetrievalSourceMeta = {
      id: chunk.sourceId,
      title: chunk.sourceTitle,
      kind: chunk.kind,
      label: chunk.label,
      pageFrom: chunk.pageFrom,
      pageTo: chunk.pageTo,
    };
    if (!sources.has(chunk.sourceId)) sources.set(chunk.sourceId, meta);
    chunkMeta.set(chunk.id, meta);
    left -= text.length;
  }

  const outOfScope =
    scope === 'estudio' &&
    params.allowNoMatch !== true &&
    (own.length === 0 || chunks.length === 0);
  const reason: RetrievalPlan['reason'] =
    !outOfScope ? null : own.length === 0 ? 'sin_fuentes' : 'sin_coincidencias';

  return {
    scope,
    requestedMode,
    mode,
    chunks,
    allowed,
    sources: [...sources.values()],
    chunkMeta,
    corpusBlocks: own.length,
    retrievedBlocks: chunks.length,
    matchedBlocks,
    outOfScope,
    reason,
    prompt:
      chunks.length > 0
        ? renderChunkContext(chunks)
        : '',
  };
}

/* ------------------------------------------------------------------ */
/* Corpus: notas y documentos subidos en el turno                     */
/* ------------------------------------------------------------------ */

/** Convierte una nota real (de esta cuenta y materia) en fragmentos citables. */
export function chunksFromNote(params: {
  id: string;
  userId: string;
  title: string;
  topicTitle?: string | null;
  content: string;
  maxChunks?: number;
}): RetrievalSourceChunk[] {
  const pieces = chunkDocument(String(params.content ?? '')).slice(0, params.maxChunks ?? 40);
  return pieces.map((piece, index) => ({
    id: `note:${params.id}:${index}`,
    userId: params.userId,
    kind: 'note',
    sourceId: params.id,
    sourceTitle: params.topicTitle ? `${params.title} (${params.topicTitle})` : params.title,
    label: piece.label,
    pageFrom: piece.pageFrom ?? piece.page ?? null,
    pageTo: piece.pageTo ?? piece.page ?? null,
    text: piece.text,
    order: index,
  }));
}

/** Convierte un documento indexado en este turno en fragmentos citables. */
export function chunksFromUpload(params: {
  userId: string;
  doc: IndexedDoc;
  maxChunks?: number;
}): RetrievalSourceChunk[] {
  return params.doc.chunks.slice(0, params.maxChunks ?? 300).map((chunk: DocChunk) => ({
    id: `upload:${params.doc.id}:${chunk.index}`,
    userId: params.userId,
    kind: 'upload',
    sourceId: params.doc.id,
    sourceTitle: params.doc.title || params.doc.name,
    label: chunk.label,
    pageFrom: chunk.pageFrom ?? chunk.page ?? null,
    pageTo: chunk.pageTo ?? chunk.page ?? null,
    text: chunk.text,
    order: chunk.index,
  }));
}
