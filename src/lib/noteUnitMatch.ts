/**
 * La unidad del temario a la que van unos apuntes.
 *
 * El catedrático propone el apunte con un número (`[[apunte:U16=Química del
 * carbono…]]`), y el número se puede confundir: en Física y Química la química
 * orgánica es la U9 y el trabajo mecánico la U16, y un modelo que no tiene el
 * temario delante acaba escribiendo el número de la unidad que está dando en
 * clase. El resultado era el peor posible: se redactaban —y se enseñaban en la
 * vista previa— los apuntes de otro tema («le pido orgánica y me sale trabajo
 * mecánico»).
 *
 * Aquí el **título** manda cuando discrepa con claridad. La regla es
 * deliberadamente conservadora, porque cambiar de unidad por error es tan malo
 * como no cambiarla:
 *
 *   - Cuentan las palabras significativas del título (sin acentos, sin «unidad»,
 *     «tema» ni «apuntes», que salen en todas partes).
 *   - Las que solo aparecen en una unidad del temario identifican esa unidad; las
 *     que salen en varias valen la mitad. Y pesan más las primeras del título,
 *     porque en castellano el tema se nombra al principio («Química del carbono:
 *     formulación y nomenclatura» va de química antes que de nomenclatura).
 *   - La unidad del título tiene que ganar **en solitario** (nadie empata) y
 *     compartir más con ese título que la unidad del número.
 *
 * Si algo de eso no se cumple, se queda la unidad del número, que es lo que
 * había. Nunca se adivina y nunca se inventa una unidad que no existe.
 *
 * Módulo puro (sin Prisma ni red) para poder probarlo de forma aislada.
 */

/** Lo mínimo que hace falta saber de una unidad del temario. */
export interface SyllabusUnitLike {
  id: string;
  unitNumber: number | null;
  title: string;
}

/** Lo que propone el catedrático: un número y un título para el apunte. */
export interface RequestedUnit {
  unitNumber: number | null;
  title: string;
}

export interface UnitResolution<T extends SyllabusUnitLike> {
  /** La unidad que se va a usar (o `null` si no hay ninguna). */
  unit: T | null;
  /** ¿El título ha corregido el número propuesto? */
  corrected: boolean;
  /** La unidad a la que apuntaba el número, aunque haya ganado otra. */
  numbered: T | null;
}

/**
 * Palabras que no distinguen una unidad de otra. `unidad`, `tema` y `apuntes`
 * salen en casi todos los títulos y en casi todas las peticiones («unos apuntes
 * del tema 3»), así que no sirven para decidir.
 */
const STOPWORDS = new Set([
  'unidad',
  'unidades',
  'tema',
  'temas',
  'apunte',
  'apuntes',
  'resumen',
  'resumenes',
  'completo',
  'completos',
  'general',
  'generales',
  'basico',
  'basica',
  'basicos',
  'basicas',
  'clave',
  'claves',
  'tipos',
  'tipo',
  'parte',
  'partes',
  'introduccion',
  'repaso',
  'para',
  'como',
  'desde',
  'entre',
  'sobre',
  'segun',
  'hacia',
  'contra',
]);

/**
 * Palabras significativas de un título, en orden: minúsculas, sin acentos, de
 * cuatro letras o más, sin números sueltos y sin las de relleno de arriba.
 * «Química orgánica: grupos funcionales y formulación» → [quimica, organica,
 * grupos, funcionales, formulacion].
 */
export function significantTokens(text: string): string[] {
  const normalized = String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const tokens: string[] = [];
  for (const raw of normalized.split(/[^a-z0-9]+/)) {
    if (raw.length < 4) continue; // descarta «y», «de», «u3», «i»
    if (/^\d+$/.test(raw)) continue; // descarta números sueltos
    if (STOPWORDS.has(raw)) continue;
    if (!tokens.includes(raw)) tokens.push(raw);
  }
  return tokens;
}

/** Cuántas palabras significativas comparten los dos títulos (sin ponderar). */
export function titleOverlap(a: string, b: string): number {
  const right = new Set(significantTokens(b));
  return significantTokens(a).filter((token) => right.has(token)).length;
}

/**
 * Peso de cada palabra según su posición en el título: lo que se nombra primero
 * es el asunto; lo que viene después, el detalle. La primera pesa 1.5 y baja
 * hasta 0.75.
 */
function positionWeight(index: number): number {
  return index === 0 ? 1.5 : index === 1 ? 1.25 : index <= 3 ? 1 : 0.75;
}

/** Cuántas unidades del temario llevan cada palabra. */
function documentFrequency(units: SyllabusUnitLike[]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const unit of units) {
    for (const token of significantTokens(unit.title)) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  return frequency;
}

/**
 * Resuelve a qué unidad van los apuntes. Ver la cabecera del módulo para las
 * reglas: el título solo manda cuando gana con claridad, y nunca se inventa una
 * unidad.
 */
export function resolveNoteUnit<T extends SyllabusUnitLike>(
  units: T[],
  requested: RequestedUnit
): UnitResolution<T> {
  const numbered =
    requested.unitNumber === null
      ? null
      : units.find((unit) => unit.unitNumber === requested.unitNumber) ?? null;

  const requestedTokens = significantTokens(requested.title);
  if (requestedTokens.length === 0 || units.length === 0) {
    return { unit: numbered, corrected: false, numbered };
  }

  const frequency = documentFrequency(units);

  /** Cuánto identifica el título a cada unidad (más las palabras exclusivas). */
  const scores = units.map((unit) => {
    const tokens = new Set(significantTokens(unit.title));
    let score = 0;
    requestedTokens.forEach((token, index) => {
      if (!tokens.has(token)) return;
      const weight = (frequency.get(token) ?? 1) === 1 ? 1 : 0.5;
      score += positionWeight(index) * weight;
    });
    return { unit, score };
  });

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const runnerUp = scores[1];
  const numberedScore =
    numbered === null ? 0 : scores.find((entry) => entry.unit.id === numbered.id)?.score ?? 0;

  const decisive =
    best.unit.id !== numbered?.id &&
    best.score > 0.5 &&
    best.score > (runnerUp?.score ?? 0) &&
    best.score > numberedScore;

  if (decisive) {
    return { unit: best.unit, corrected: true, numbered };
  }

  return { unit: numbered, corrected: false, numbered };
}
