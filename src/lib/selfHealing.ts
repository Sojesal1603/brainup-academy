/**
 * Capa de automantenimiento (autocuración) para utilidades puras.
 *
 * Por qué existe: TypeScript no protege la frontera de datos. `unstable_cache`
 * devuelve JSON, así que un campo declarado `Date` llega en runtime como
 * `string`; una función que llama `getFullYear()` sobre ese valor tumba la
 * página entera con un `TypeError` que el compilador nunca vio.
 *
 * Política del proyecto:
 *
 *  1. Las utilidades de tiempo y las que leen datos serializados **no confían
 *     en el tipo declarado**: llaman a `toDate` / `toFiniteNumber` en su
 *     entrada. La conversión es barata y documenta que el dato viene de fuera.
 *  2. Si un valor es irrecuperable, se usa un respaldo seguro y se deja una
 *     advertencia en el log (una por minuto y punto, para no inundar).
 *  3. `selfHealing` envuelve la función completa: si aun así algo lanza, se
 *     registra una vez y se devuelve un estado neutro en lugar de propagar la
 *     excepción al render o a la ruta.
 *
 * Lo que NO hace: inventar datos. Un respaldo es «no lo sé» (0, días=0,
 * silencio), nunca una medición o una fecha concreta inventada.
 */

/** Entrada de fecha tal y como puede llegar de la base, la caché o un JSON. */
export type DateLike = Date | string | number | null | undefined;

/** Una advertencia por punto y minuto: suficiente para diagnosticar, sin ruido. */
const WARN_THROTTLE_MS = 60_000;
const warnedAt = new Map<string, number>();

function warn(site: string, detail: string): void {
  const now = Date.now();
  const last = warnedAt.get(site);
  if (last !== undefined && now - last < WARN_THROTTLE_MS) return;

  // Techo defensivo: el mapa no puede crecer sin límite en un proceso largo.
  if (warnedAt.size >= 80) warnedAt.clear();
  warnedAt.set(site, now);

  // console.warn ya lo recogen los logs del servidor.
  console.warn(`[autocuración] ${site}: ${detail}`);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Convierte cualquier entrada en una `Date` válida, sin lanzar jamás.
 *
 * Acepta `Date` (si no es `Invalid Date`), números en milisegundos y cadenas
 * ISO o numéricas. Cualquier otra cosa —`null`, `undefined`, `{}`, `'ayer'`,
 * `NaN`— cae al respaldo (por defecto, ahora) y avisa.
 */
export function toDate(
  value: unknown,
  fallback: Date = new Date(),
  site = 'toDate'
): Date {
  const safeFallback = fallback instanceof Date && !Number.isNaN(fallback.getTime())
    ? fallback
    : new Date();

  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return value;
    warn(site, 'la fecha es una Date inválida (NaN); se usa el respaldo');
    return safeFallback;
  }

  if (typeof value === 'number') {
    if (Number.isFinite(value)) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    warn(site, `número de fecha no válido (${String(value)}); se usa el respaldo`);
    return safeFallback;
  }

  if (typeof value === 'string') {
    const raw = value.trim();
    if (raw) {
      // Una cadena de solo dígitos es una marca de tiempo, no un año suelto.
      const parsed = new Date(/^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    warn(site, `cadena de fecha no válida («${String(value).slice(0, 40)}»); se usa el respaldo`);
    return safeFallback;
  }

  warn(site, `tipo inesperado (${describe(value)}) en lugar de una fecha; se usa el respaldo`);
  return safeFallback;
}

/** Número finito o respaldo. Acepta cadenas numéricas; rechaza booleanos y NaN. */
export function toFiniteNumber(value: unknown, fallback = 0, site = 'toFiniteNumber'): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  if (value !== null && value !== undefined) {
    warn(site, `se esperaba un número y llegó ${describe(value)}; se usa ${String(fallback)}`);
  }
  return fallback;
}

/**
 * Envuelve una utilidad para que una excepción inesperada no se propague.
 *
 * `recover` puede ser un valor neutro o una función que reciba los mismos
 * argumentos. Si el propio respaldo falla (bug de programación), se devuelve
 * `undefined` como último recurso: el contrato de «nunca lanza» se mantiene y
 * el log deja la pista. Úsalo solo en funciones puras y deterministas; no
 * envuelvas escrituras de base (un fallo ahí no debe fingir éxito).
 */
export function selfHealing<Args extends unknown[], R>(
  name: string,
  fn: (...args: Args) => R,
  recover: R | ((...args: Args) => R)
): (...args: Args) => R {
  return (...args: Args): R => {
    try {
      return fn(...args);
    } catch (error) {
      warn(name, `excepción contenida: ${error instanceof Error ? error.message : String(error)}`);

      try {
        return typeof recover === 'function'
          ? (recover as (...args: Args) => R)(...args)
          : recover;
      } catch (recoverError) {
        warn(
          `${name}.respaldo`,
          `el respaldo también falló: ${
            recoverError instanceof Error ? recoverError.message : String(recoverError)
          }`
        );
        return undefined as R;
      }
    }
  };
}
