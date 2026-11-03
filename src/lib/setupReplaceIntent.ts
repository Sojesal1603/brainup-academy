/**
 * «Sustituye el temario de Lengua por este»: detectar que lo ha pedido ÉL.
 *
 * El sistema tiene una red que impide que un `[[sustituir:…]]` mal puesto borre
 * medio temario (pasó de verdad: un turno se llevó 16 unidades y dejó 8). Pero
 * esa red no puede convertir la app en algo que desobedece: cuando el alumno
 * pide **expresamente** reemplazar el temario, hay que hacerlo, aunque la lista
 * nueva sea más corta.
 *
 * Aquí se separan las dos cosas:
 *   · `hasReplaceIntent` mira el mensaje del ALUMNO (no la respuesta del modelo)
 *     y dice si ha pedido un reemplazo de forma explícita.
 *   · `matchSubjectInMessage` dice de qué materia habla, comparando con los
 *     nombres reales de su curso (vale «Lengua» para «Lengua Castellana y
 *     Literatura I»).
 *   · `armPendingReplace` recuerda la petición unos minutos: si pide sustituir
 *     y la lista llega en el mensaje siguiente, sigue valiendo.
 *
 * Módulo puro salvo el mapa en memoria (que es deliberadamente efímero: una
 * petición de reemplazo no debe sobrevivir a un reinicio).
 */

/** Una petición de reemplazo caduca a los 10 minutos. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/** Peticiones vivas: id de materia → instante de caducidad. */
const pending = new Map<string, number>();

/** Quita acentos, signos y mayúsculas: «Física» → «fisica». */
function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Verbos que piden cambiar algo. */
const REPLACE_VERB =
  /\b(sustitu\w*|reemplaz\w*|cambi\w*|borr\w*|quit\w*|pon\w*|poner|mete\w*|meter|actualiz\w*|deja\w*|dejar)\b/;

/** Lo que se sustituye. */
const REPLACE_TARGET = /\b(temario|unidades|unidad|lista|indice|contenidos?)\b/;

/** «no cambies», «no me borres»… no es una orden de reemplazo. */
const NEGATED =
  /\bno\s+(me\s+)?(cambies|sustituyas|reemplaces|borres|quites|toques|modifiques)\b/;

/**
 * ¿El alumno ha pedido expresamente reemplazar el temario?
 *
 * Se exige un verbo de cambio Y la palabra temario/unidades/lista en el mismo
 * mensaje, y que no venga negado. Así «¿qué temario me falta?» no autoriza nada,
 * y «sustituye el temario de Lengua por este» sí.
 */
export function hasReplaceIntent(message: string): boolean {
  const text = normalize(message);
  if (text.length === 0) return false;
  if (NEGATED.test(text)) return false;
  return REPLACE_VERB.test(text) && REPLACE_TARGET.test(text);
}

/** Palabras que no identifican una materia por sí solas. */
const STOP_WORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'i', 'en']);

/**
 * La materia de la que habla el mensaje, o null.
 *
 * Primero se busca el nombre completo; si no, la primera palabra significativa
 * («Lengua», «Matemáticas», «Física»). Gana la coincidencia más larga para que
 * «Física y Química» no se quede en «Física».
 */
export function matchSubjectInMessage(message: string, subjectNames: string[]): string | null {
  const text = normalize(message);
  if (text.length === 0) return null;

  // Dos variables sueltas en vez de un objeto: el compilador no puede seguir
  // las asignaciones hechas dentro de una función y daría el objeto por nulo.
  let bestName: string | null = null;
  let bestLength = 0;

  const consider = (name: string, length: number) => {
    if (length < 5) return;
    if (length > bestLength) {
      bestName = name;
      bestLength = length;
    }
  };

  for (const name of subjectNames) {
    const full = normalize(name);
    if (full.length >= 5 && text.includes(full)) {
      consider(name, full.length);
      continue;
    }

    // Nombre corto: la primera palabra que de verdad identifica la materia.
    const key = full
      .split(' ')
      .find((token) => token.length >= 5 && !STOP_WORDS.has(token));
    if (key && new RegExp(`\\b${key}\\b`).test(text)) {
      consider(name, key.length);
    }
  }

  return bestName;
}

/** Recuerda que el alumno ha pedido sustituir el temario de esa materia. */
export function armPendingReplace(subjectId: string): void {
  if (!subjectId) return;
  pending.set(subjectId, Date.now() + PENDING_TTL_MS);
}

/** ¿Sigue viva la petición para esa materia? (sin gastarla) */
export function hasPendingReplace(subjectId: string): boolean {
  const expiresAt = pending.get(subjectId);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    pending.delete(subjectId);
    return false;
  }
  return true;
}

/**
 * Gasta la petición: se usa al aplicar el reemplazo.
 * Devuelve true si había una petición viva.
 */
export function consumePendingReplace(subjectId: string): boolean {
  const alive = hasPendingReplace(subjectId);
  pending.delete(subjectId);
  return alive;
}

/** Para las pruebas: deja el mapa limpio. */
export function clearPendingReplaces(): void {
  pending.clear();
}
