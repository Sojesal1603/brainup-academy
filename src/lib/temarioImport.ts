/**
 * Convierte el índice que TÚ pegas (el de tu profesor, el de tu libro, una
 * lista escrita a mano) en unidades del temario.
 *
 * Es un módulo puro: no toca la base de datos ni importa nada, para poder
 * probarlo aislado. Aquí no se inventa nada: si una línea no parece una unidad,
 * se descarta y se te dice cuál, en vez de colarla en tu temario.
 *
 * Reglas de lectura:
 *   · una unidad por línea (con o sin numerar, con o sin viñeta)
 *   · «1. Radicales», «U3 Trigonometría», «Tema 5: Derivadas» → título limpio
 *   · «1ª evaluación», «Segundo trimestre», «Evaluación 3» → cabecera: fija la
 *     evaluación de las unidades que vienen detrás
 *   · «Bloque II: Álgebra» o cualquier línea corta acabada en «:» → cabecera
 *   · dificultad opcional al final: «[4]», «[dif=4]», «(4/5)»
 *   · un párrafo largo (una introducción, una nota del profesor) no es un tema:
 *     se queda fuera y te lo digo, en vez de colártelo como unidad
 */

export interface ParsedTemarioUnit {
  title: string;
  /** Evaluación (1, 2 o 3) si el texto la indicaba. */
  term: number | null;
  /** Dificultad 1-5, por defecto 3. */
  difficulty: number;
}

export interface ParsedTemario {
  units: ParsedTemarioUnit[];
  /** Cabeceras leídas (evaluaciones y bloques), tal como venían. */
  headers: string[];
  /** Evaluaciones detectadas, ordenadas. */
  terms: number[];
  /** Títulos repetidos que se han descartado. */
  duplicates: string[];
  /** Líneas que no parecían unidades (para que las revises tú). */
  ignored: string[];
  /** Líneas con contenido leídas. */
  lines: number;
}

/** Orígenes que puede tener una unidad: los elige el alumno, no la app. */
export const TEMARIO_SOURCES = ['profesor', 'libro', 'manual'] as const;
export type TemarioSource = (typeof TEMARIO_SOURCES)[number];

export function isTemarioSource(value: unknown): value is TemarioSource {
  return typeof value === 'string' && (TEMARIO_SOURCES as readonly string[]).includes(value);
}

/** Máximo de unidades por importación: por encima, algo no es un temario. */
export const MAX_TEMARIO_UNITS = 300;
const MAX_TITLE_LENGTH = 180;

/** Compara títulos sin acentos, mayúsculas ni signos. */
export function normalizeTopicTitle(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const BULLET = /^[-–—•*·▪◦‣∙+]\s+/;
const COMMENT = /^(?:#|\/\/)/;
const DASHES_ONLY = /^[-–—_=*\s]+$/;
const SECTION_HEADER = /^(?:bloque|parte|apartado|secci[oó]n|unidad did[aá]ctica|saberes|contenidos|temario|[ií]ndice|materia|curso)\b/i;

const ORDINALS: Record<string, number> = {
  '1': 1, '1a': 1, '1ª': 1, '1º': 1, '1°': 1, '1er': 1, '1ro': 1, primera: 1, primer: 1, primero: 1,
  '2': 2, '2a': 2, '2ª': 2, '2º': 2, '2°': 2, '2do': 2, '2do.': 2, segunda: 2, segundo: 2,
  '3': 3, '3a': 3, '3ª': 3, '3º': 3, '3°': 3, '3er': 3, tercera: 3, tercer: 3, tercero: 3,
};

const PERIOD_WORD = /^(?:evaluaci[oó]n(?:es)?|eval|ev|trimestre(?:s)?|cuatrimestre)\b/i;

/** ¿Esta línea anuncia una evaluación (1, 2 o 3)? */
export function detectTerm(line: string): number | null {
  const clean = line
    .replace(/[*_#•·\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;

  const words = clean.split(' ');
  const firstWord = (words[0] ?? '').toLowerCase().replace(/\.$/, '');
  const rest = words.slice(1).join(' ');
  if (ORDINALS[firstWord] !== undefined && PERIOD_WORD.test(rest)) return ORDINALS[firstWord];

  // «1 ev», «1ª evaluación», «3 trimestre»
  const leading = clean.match(/^([123])\s*[ªaº°]?\s*[.:\-–]?\s*(?:evaluaci[oó]n(?:es)?|eval|ev|trimestre)/i);
  if (leading) return Number(leading[1]);

  // «Evaluación 1», «Trimestre: 2», «Ev 3»
  const trailing = clean.match(/^(?:evaluaci[oó]n(?:es)?|eval|ev|trimestre(?:s)?)\s*[.:\-–]?\s*([123])\b/i);
  if (trailing) return Number(trailing[1]);

  return null;
}

function isSectionHeader(line: string): boolean {
  if (SECTION_HEADER.test(line)) return true;
  // Una línea corta acabada en «:» es un rótulo, no un tema.
  return line.length <= 60 && /:$/.test(line) && !/\d\s*$/.test(line);
}

/** Un párrafo —una introducción, una nota— no es una unidad del temario. */
function looksLikeProse(line: string): boolean {
  if (line.length > 120) return true;
  return line.split(/\s+/).length >= 16;
}

/** Limpia una línea de unidad: fuera viñeta, numeración y marca de dificultad. */
export function cleanUnitTitle(line: string): { title: string; difficulty: number } | null {
  let text = line.trim();
  while (BULLET.test(text)) text = text.replace(BULLET, '').trim();

  // «1. », «1) », «1 - », «1 », «U1 », «Tema 5: », «Unidad 3. »
  // La numeración decimal («1.1 Radicales») se deja entera: es un subtema y su
  // número forma parte del nombre.
  const numbered = text.match(
    /^(?:(?:u(?:nidad)?|ud|tema|t)\s*\.?\s*)?(\d{1,3})(?!\s*[.\-–]\s*\d)\s*(?:[.)\-–—:]\s*|\s+)(\S.*)$/i
  );
  if (numbered && numbered[2].trim().length >= 2) text = numbered[2].trim();

  let difficulty = 3;
  const mark = text.match(/\s*[\[(]\s*(?:d(?:if(?:icultad)?)?\s*[=:]?\s*)?([1-5])(?:\s*\/\s*5)?\s*[\])]\s*$/i);
  if (mark) {
    difficulty = Number(mark[1]);
    text = text.replace(mark[0], '').trim();
  }

  text = text.replace(/[\s.;,·\-–—:]+$/, '').trim();
  if (text.length < 2 || DASHES_ONLY.test(text)) return null;
  if (text.length > MAX_TITLE_LENGTH) text = text.slice(0, MAX_TITLE_LENGTH).trim();

  return { title: text, difficulty };
}

/** Lee el texto pegado y devuelve las unidades, sin tocar nada más. */
export function parseTemarioText(raw: string): ParsedTemario {
  const lines = String(raw ?? '').replace(/\r\n?/g, '\n').split('\n');
  const units: ParsedTemarioUnit[] = [];
  const headers: string[] = [];
  const duplicates: string[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();
  const terms = new Set<number>();
  let currentTerm: number | null = null;
  let usefulLines = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (COMMENT.test(line) || DASHES_ONLY.test(line)) continue;
    usefulLines++;

    const term = detectTerm(line);
    if (term !== null) {
      currentTerm = term;
      terms.add(term);
      headers.push(line);
      continue;
    }

    if (isSectionHeader(line)) {
      headers.push(line);
      continue;
    }

    if (looksLikeProse(line)) {
      ignored.push(line);
      continue;
    }

    const parsed = cleanUnitTitle(line);
    if (!parsed) {
      ignored.push(line);
      continue;
    }

    const key = normalizeTopicTitle(parsed.title);
    if (!key) {
      ignored.push(line);
      continue;
    }
    if (seen.has(key)) {
      duplicates.push(parsed.title);
      continue;
    }
    if (units.length >= MAX_TEMARIO_UNITS) {
      ignored.push(line);
      continue;
    }

    seen.add(key);
    units.push({ title: parsed.title, term: currentTerm, difficulty: parsed.difficulty });
  }

  return {
    units,
    headers,
    terms: [...terms].sort((a, b) => a - b),
    duplicates,
    ignored,
    lines: usefulLines,
  };
}

/** Cuántas unidades caen en cada evaluación (para la vista previa). */
export function countByTerm(units: ParsedTemarioUnit[]): Record<string, number> {
  const counts: Record<string, number> = { sin: 0, '1': 0, '2': 0, '3': 0 };
  for (const unit of units) {
    const key = unit.term === null ? 'sin' : String(unit.term);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
