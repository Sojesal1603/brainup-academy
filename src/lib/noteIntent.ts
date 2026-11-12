/**
 * «Ábreme los apuntes de la unidad 3 de filosofía».
 *
 * El catedrático ya puede pedir que se proyecte un apunte guardado con la
 * etiqueta `[[abrir:N3]]`, pero eso depende de que el modelo se acuerde de
 * escribirla. Cuando el alumno pide EXPLÍCITAMENTE abrir unos apuntes, la app
 * no puede quedarse esperando a que el modelo acierte: tiene que buscar el
 * documento en su cuaderno y abrirlo. Este módulo hace esa búsqueda sin gastar
 * una llamada de IA.
 *
 * Dos piezas puras:
 *
 *   1. `detectOpenNoteIntent` reconoce la petición y saca la unidad y el tema.
 *   2. `matchNoteIntent` puntúa los apuntes guardados por unidad y por título.
 *
 * Es deliberadamente conservador: si no hay una coincidencia clara, devuelve
 * `null` y manda el modelo de siempre. Abrir un apunte equivocado es peor que
 * no abrir ninguno.
 */

import { significantTokens } from './noteUnitMatch';

/** Lo que el alumno ha pedido abrir, ya desmontado. */
export interface NoteOpenIntent {
  /** Palabras útiles para buscar por título («matrices», «kant»). */
  query: string;
  /** Unidad explícita («unidad 3», «tema 3», «U3»), si la ha dicho. */
  unitNumber: number | null;
  /** El mensaje original, para trazas. */
  raw: string;
}

/** Lo mínimo que hace falta de un apunte guardado para poder abrirlo. */
export interface NoteIntentCandidate {
  id: string;
  title: string;
  unitNumber: number | null;
  /** Título de la unidad a la que cuelga el apunte, si se conoce. */
  unitTitle: string | null;
}

/**
 * Verbos que piden abrir algo. Se exige uno de ellos Y una palabra de apuntes:
 * «explícame los apuntes» no abre nada, «ábreme los apuntes» sí.
 */
// Ojo con el acento: un `\b` delante de «ábreme» no funciona, porque en JS el
// límite de palabra es ASCII y «á» ya no es carácter de palabra. Se exige que
// delante haya inicio de texto o algo que no sea una letra.
const OPEN_VERB =
  /(?:^|[^\p{L}])(?:abr(?:e|ir)|ábreme|abreme|mu[eé]strame|muestrame|ens[eé][ñn]ame|ensename|recupera|carga|cargame|c[aá]rgame|lee|l[eé]eme|proyecta|saca|vuelve a abrir|quiero (?:ver|leer|abrir))\b/iu;

/** Sustantivos que identifican el cuaderno. */
const NOTE_NOUN = /\b(apuntes?|res[uú]men(?:es)?|esquemas?|dossier|documento|tema|unidad)\b/i;

/**
 * Detecta la intención de abrir un apunte guardado.
 *
 * Ejemplos que entran: «ábreme los apuntes de la unidad 3 de filosofía»,
 * «muéstrame el resumen de matrices», «recupera mi esquema de Kant».
 * Ejemplos que NO entran: «hazme unos apuntes de la unidad 3» (no hay verbo de
 * apertura) y «explícame los apuntes» (no pide abrir el documento).
 */
export function detectOpenNoteIntent(message: string): NoteOpenIntent | null {
  const raw = String(message ?? '').trim();
  if (raw.length === 0) return null;
  if (!OPEN_VERB.test(raw) || !NOTE_NOUN.test(raw)) return null;

  const unitMatch =
    raw.match(/\bunidad\s*(?:n[º°]?\.?\s*)?(\d{1,2})\b/i) ??
    raw.match(/\btema\s*(?:n[º°]?\.?\s*)?(\d{1,2})\b/i) ??
    raw.match(/\bU\s*(\d{1,2})\b/);
  const unitNumber = unitMatch ? Number(unitMatch[1]) : null;

  // El tema: lo que va detrás de «apuntes de…», «resumen de…», «esquema de…».
  // Si no hay esa fórmula, se usa el mensaje entero sin el número de unidad.
  const afterNoun = raw.match(
    /\b(?:apuntes?|res[uú]men(?:es)?|esquemas?|dossier|documento)\s+(?:de|del|sobre|acerca de)\s+(.+)$/i
  );
  let query = afterNoun ? afterNoun[1] : raw;

  // Fuera las expresiones de unidad y las muletillas de la petición: lo que
  // queda son las palabras que de verdad identifican el apunte.
  query = query
    .replace(/\b(?:unidad|tema|u)\s*(?:n[º°]?\.?\s*)?\d{1,2}\b/gi, ' ')
    .replace(/\b(?:por favor|que tengo|que hice|de antes|guardad[oa]s?|del catedr[aá]tico)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Si solo queda la asignatura («de filosofía»), la búsqueda por título no
  // aporta: la unidad manda. `matchNoteIntent` ignora las palabras de la
  // asignatura, así que aquí no hace falta adivinar más.
  return { query, unitNumber, raw };
}

/**
 * Puntúa un apunte contra la petición. El número de unidad es la señal más
 * fuerte; el título y el nombre de la unidad deciden cuando no hay número o
 * cuando hay que desempatar.
 */
function scoreCandidate(
  intent: NoteOpenIntent,
  note: NoteIntentCandidate,
  subjectWords: Set<string>
): number {
  const queryTokens = significantTokens(intent.query).filter((token) => !subjectWords.has(token));

  let score = 0;
  if (intent.unitNumber !== null) {
    // Si el alumno ha dicho una unidad, un apunte de otra unidad NO es una
    // coincidencia parcial: es otro tema. Se descarta y se busca en su unidad.
    if (note.unitNumber !== intent.unitNumber) return Number.NEGATIVE_INFINITY;
    score += 6;
  }

  if (queryTokens.length > 0) {
    const noteTokens = new Set(
      significantTokens(`${note.title} ${note.unitTitle ?? ''}`).filter(
        (token) => !subjectWords.has(token)
      )
    );
    const overlap = queryTokens.filter((token) => noteTokens.has(token)).length;
    score += overlap * 2;

    // Compartir una palabra rara («kant», «matrices») vale más que compartir
    // una que sale en medio temario. El título del apunte es el que manda.
    const titleTokens = new Set(significantTokens(note.title));
    if (queryTokens.some((token) => titleTokens.has(token))) score += 2;
  }

  return score;
}

/**
 * Elige el apunte que el alumno ha pedido abrir, o `null` si no hay una
 * coincidencia clara.
 *
 * `subjectName` se usa para no confundir la asignatura con el tema: en
 * «ábreme los apuntes de la unidad 3 de filosofía», «filosofía» es el nombre de
 * la materia, no una palabra que deba buscar en los títulos.
 */
export function matchNoteIntent(
  intent: NoteOpenIntent,
  notes: NoteIntentCandidate[],
  subjectName = ''
): NoteIntentCandidate | null {
  if (notes.length === 0) return null;

  const subjectWords = new Set(significantTokens(subjectName));
  let best: { note: NoteIntentCandidate; score: number } | null = null;

  for (const note of notes) {
    const score = scoreCandidate(intent, note, subjectWords);
    if (!best || score > best.score) best = { note, score };
  }

  if (!best) return null;

  // Umbral: con unidad explícita basta con que coincida (6). Sin unidad, hacen
  // falta al menos dos señales de título (una palabra compartida + el extra del
  // título). Así «abre mis apuntes» no abre el primero que pase.
  const threshold = intent.unitNumber !== null ? 6 : 2;
  return best.score >= threshold ? best.note : null;
}
