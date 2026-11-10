/**
 * Los apuntes del alumno, vistos por el catedrático.
 *
 * El catedrático IA puede leer el cuaderno del alumno: es la diferencia entre
 * un tutor que solo conoce el temario y uno que sabe **qué se ha escrito él**
 * (sus esquemas, sus reglas preventivas, sus resúmenes de clase).
 *
 * Dos reglas mandan aquí:
 *
 *   - **Presupuesto, no volcado.** Los apuntes pueden ser enormes. Se manda un
 *     extracto por apunte y un tope total de caracteres; el resto no viaja.
 *   - **Es lo que él ha escrito, no la verdad.** El prompt lo dice así: si algo
 *     no está en sus apuntes ni en el temario, el catedrático lo pregunta, no
 *     lo inventa.
 *
 * Módulo puro (sin Prisma ni red): se puede probar de forma aislada.
 */

/** Apuntes como máximo en el prompt de un turno. */
export const MAX_SHARED_NOTES = 6;

/** Caracteres de extracto por apunte. */
export const MAX_NOTE_EXCERPT_CHARS = 500;

/** Presupuesto total de caracteres de apuntes en el prompt. */
export const MAX_TOTAL_NOTES_CHARS = 2400;

export interface NoteRowForTutor {
  id: string;
  title: string;
  content: string;
  tags: string | null;
  isPinned: boolean;
  updatedAt: Date;
  /** Unidad del temario a la que cuelga el apunte, si se conoce. */
  topicTitle: string | null;
  unitNumber: number | null;
}

export interface SharedNote {
  id: string;
  title: string;
  /** «U3 · Matrices», o `null` si el apunte no cuelga de una unidad. */
  topicLabel: string | null;
  excerpt: string;
}

/**
 * Extracto legible de un apunte: sin vallas de código, sin markdown pesado y
 * cortado por palabra. Un apunte vacío no produce extracto.
 *
 * `limit` es un tope DURO: si hay que cortar, los puntos suspensivos cuentan
 * dentro del límite (si no, el presupuesto total se pasaría en un carácter por
 * apunte y dejaría de estar acotado).
 */
export function noteExcerpt(content: string, limit: number = MAX_NOTE_EXCERPT_CHARS): string {
  const flat = String(content ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/[*_>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (flat.length <= limit) return flat;

  const room = Math.max(1, limit - 1); // el hueco que ocupa el «…»
  const cut = flat.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > room * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Etiqueta de la unidad a la que pertenece el apunte. */
export function noteTopicLabel(note: Pick<NoteRowForTutor, 'topicTitle' | 'unitNumber'>): string | null {
  if (!note.topicTitle) return null;
  return note.unitNumber ? `U${note.unitNumber} · ${note.topicTitle}` : note.topicTitle;
}

/* ------------------------------------------------------------------ */
/* El índice del cuaderno: para ABRIR un apunte, no para volcarlo      */
/* ------------------------------------------------------------------ */

/**
 * Apuntes que entran en el índice de apertura de un turno.
 *
 * Es memoria total del cuaderno: el catedrático ve el título y la unidad de TODO
 * lo que el alumno tiene de la materia, no solo de los últimos seis. El texto
 * sigue acotado aparte, así que el prompt no se dispara.
 */
export const MAX_NOTE_INDEX = 40;

export interface NoteIndexEntry {
  /** Clave corta que el modelo copia en su etiqueta: `N1`, `N2`… */
  key: string;
  /** Id real del apunte, que solo conoce el servidor. */
  id: string;
  title: string;
  topicLabel: string | null;
  unitNumber: number | null;
  unitTitle: string | null;
}

/**
 * Índice de apuntes guardados de la materia, con una clave corta por apunte.
 *
 * Es lo que hace que «ábreme los apuntes de matrices» abra el documento que ya
 * existe en vez de reescribirlo: el catedrático ve el título, la unidad y una
 * clave que puede devolver en su respuesta. El texto de cada apunte no viaja
 * aquí; eso lo decide `selectNotesForTutor`.
 */
export function buildNoteIndex(
  rows: NoteRowForTutor[],
  limit: number = MAX_NOTE_INDEX
): NoteIndexEntry[] {
  const ordered = [...rows].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });

  return ordered.slice(0, Math.max(0, limit)).map((row, index) => ({
    key: `N${index + 1}`,
    id: row.id,
    title: row.title.trim() || 'Sin título',
    topicLabel: noteTopicLabel(row),
    unitNumber: row.unitNumber,
    unitTitle: row.topicTitle,
  }));
}

/**
 * Cómo se pide abrir un apunte guardado. Va en el prompt porque el catedrático
 * tiene que saber que **no** se reescribe lo que ya está en el cuaderno.
 */
export const NOTE_OPEN_TAG_INSTRUCTION = [
  'ABRIR APUNTES YA GUARDADOS (memoria del cuaderno):',
  'Si te pide recuperar, abrir, leer o repasar unos apuntes que YA están en su cuaderno («ábreme los apuntes de…», «recupera mi esquema anterior», «enséñame el resumen de…»), NO los escribas otra vez ni los pegues en el chat: localízalos en el ÍNDICE DE APUNTES GUARDADOS y termina tu mensaje con una única etiqueta invisible [[abrir:N<clave>]] (por ejemplo [[abrir:N3]]).',
  'La app cargará ese documento en el panel derecho. En el texto visible di en una frase cuál abres y qué conviene repasar, sin repetir su contenido. Si ninguno encaja de verdad con lo que pide, dilo y ofrécele escribirlo nuevo con la etiqueta de apuntes de siempre.',
  'Nunca inventes una clave: usa solo una de las que aparecen en el índice.',
].join('\n');

/**
 * Elige qué apuntes entran y con cuánto texto: primero los fijados, después
 * los más recientes, hasta agotar el presupuesto total. Los apuntes sin
 * contenido no cuentan.
 */
export function selectNotesForTutor(rows: NoteRowForTutor[]): SharedNote[] {
  const ordered = [...rows].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });

  const selected: SharedNote[] = [];
  let budget = MAX_TOTAL_NOTES_CHARS;

  for (const row of ordered) {
    if (selected.length >= MAX_SHARED_NOTES) break;
    if (budget <= 120) break;

    const excerpt = noteExcerpt(row.content, Math.min(MAX_NOTE_EXCERPT_CHARS, budget));
    if (excerpt.length === 0) continue;

    selected.push({
      id: row.id,
      title: row.title.trim() || 'Sin título',
      topicLabel: noteTopicLabel(row),
      excerpt,
    });

    budget -= excerpt.length;
  }

  return selected;
}
