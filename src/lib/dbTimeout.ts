/**
 * Deadline para las consultas a la base.
 *
 * Prisma no tiene un `queryTimeout` propio en la versión que usa la app. El
 * pooler de Supabase puede dejar una consulta esperando indefinidamente si la
 * conexión se queda a medias, y eso llega al alumno como la pantalla de
 * «Cargando la vista» para siempre. Aquí se pone un tope real: si la base no
 * contesta en el margen, se lanza un error controlado y el Server Component
 * decide qué enseñar.
 *
 * El timeout de Prisma (`DB_QUERY_TIMEOUT_MS`) protege todas las consultas,
 * incluidas acciones. `safeDb` añade el fallback de los widgets del Cuartel:
 * un fallo **pasajero** de conexión no tumba el resto de la página, mientras
 * que un problema real de esquema o permisos sí sube y se ve.
 */

const configuredTimeout = Number(process.env.DB_QUERY_TIMEOUT_MS);

/** 4,5 s por defecto; configurable entre 1 s y 10 s con `DB_QUERY_TIMEOUT_MS`. */
export const DB_QUERY_TIMEOUT_MS =
  Number.isFinite(configuredTimeout) && configuredTimeout >= 1000
    ? Math.min(configuredTimeout, 10_000)
    : 4_500;

/** Error con el mismo código que Prisma usa para «se agotó el tiempo». */
export class DbTimeoutError extends Error {
  readonly code = 'P1008';

  constructor(label: string, timeoutMs: number) {
    super(`La consulta «${label}» ha superado el límite de ${timeoutMs} ms.`);
    this.name = 'DbTimeoutError';
  }
}

/**
 * Espera a `promise` como máximo `timeoutMs`.
 *
 * La promesa original se deja terminar en segundo plano (Prisma no permite
 * cancelar una consulta en curso); el `then` con `catch` vacío evita que su
 * rechazo tardío se convierta en un `unhandledRejection`.
 */
export function withDbTimeout<T>(
  promise: Promise<T>,
  label = 'consulta',
  timeoutMs = DB_QUERY_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new DbTimeoutError(label, timeoutMs));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Los únicos fallos que se pueden tapar con un respaldo.
 *
 * Todos significan lo mismo: «ahora mismo no hay conexión disponible». Ninguno
 * dice que la consulta o el esquema estén mal, así que ninguno justifica tumbar
 * la vista: se pinta la sección con datos de respaldo y el alumno sigue
 * navegando mientras el pooler se recupera.
 *
 *   · P1001  no se puede alcanzar el servidor de la base
 *   · P1008  la operación ha agotado el tiempo de espera
 *   · P1017  el servidor ha cerrado la conexión
 *   · P2024  no hubo conexión libre en el pool a tiempo
 *   · ETIMEDOUT  el socket no contesta (error de red del driver)
 */
export const TRANSIENT_DB_CODES = new Set(['P1001', 'P1008', 'P1017', 'P2024', 'ETIMEDOUT']);

/**
 * ¿Este error es un fallo pasajero de conexión?
 *
 * Prisma pone el código en `error.code`; los errores de red de Node lo dejan en
 * `code` o en `cause.code`. Se mira también el código del `cause` porque un
 * `PrismaClientKnownRequestError` puede envolver un `ETIMEDOUT` del socket.
 */
export function isTransientDbError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  // Se recorre la cadena de causas (con tope) para no entrar en un ciclo raro.
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_DB_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * Resultado de una consulta protegida.
 *
 * `degraded` existe porque un respaldo vacío no es lo mismo que un dato vacío:
 * `[]` puede significar «no hay exámenes» o «la base no contestó». Las vistas
 * que deben decírselo al alumno usan `safeDbOutcome` y distinguen ambos casos;
 * el resto sigue usando `safeDb`, que devuelve solo el dato.
 */
export interface DbOutcome<T> {
  data: T;
  degraded: boolean;
  /** Código del fallo pasajero (`P1008`, `P2024`…) o `null` si fue bien. */
  code: string | null;
}

/**
 * Consulta con deadline y datos mínimos de respaldo, con el motivo del respaldo.
 *
 * Regla de oro: **solo se tapa lo transitorio**. Ante un P1001, P1008, P1017,
 * P2024 o ETIMEDOUT se escribe el motivo en `console.error` (Vercel lo captura
 * en stdout, que es el único sitio que sobrevive al contenedor) y se devuelve
 * `fallback` marcado como `degraded`, de modo que el Server Component pinta su
 * sección vacía en vez de lanzar y convertir la página entera en un #441 opaco.
 *
 * Cualquier otro error —P2021 tabla inexistente, P2022 columna que no existe,
 * P2025, permisos, cadena de conexión inválida— **se relanza**. Taparlo sería
 * esconder un esquema desincronizado o un fallo de permisos detrás de una
 * pantalla que parece «sin datos», y entonces nadie lo arregla.
 */
export async function safeDbOutcome<T>(
  label: string,
  run: () => Promise<T>,
  fallback: T,
  timeoutMs = DB_QUERY_TIMEOUT_MS
): Promise<DbOutcome<T>> {
  try {
    return { data: await withDbTimeout(run(), label, timeoutMs), degraded: false, code: null };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const detail = error instanceof Error ? error.message : String(error);

    if (!isTransientDbError(error)) {
      // No es un fallo de conexión: se deja subir tal cual, con su etiqueta para
      // que el log del servidor diga qué sección lo estaba intentando.
      throw error;
    }

    console.error(
      `[db] ${label}: se usa el respaldo mínimo (${typeof code === 'string' ? code : 'timeout'}: ${detail})`
    );
    return { data: fallback, degraded: true, code: typeof code === 'string' ? code : 'timeout' };
  }
}

/** Igual que `safeDbOutcome`, pero solo el dato (contrato original). */
export async function safeDb<T>(
  label: string,
  run: () => Promise<T>,
  fallback: T,
  timeoutMs = DB_QUERY_TIMEOUT_MS
): Promise<T> {
  return (await safeDbOutcome(label, run, fallback, timeoutMs)).data;
}
