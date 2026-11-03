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
