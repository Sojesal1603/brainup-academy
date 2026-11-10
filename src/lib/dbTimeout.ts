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
 * nunca deja que una sección lenta tumbe el resto de la página.
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
 * Consulta con deadline y datos mínimos de respaldo.
 *
 * Se usa solo en lecturas de widgets. Un fallo se registra con la etiqueta de
 * la sección y devuelve `fallback`, de modo que el resto del Cuartel sigue
 * siendo usable aunque una consulta concreta esté lenta.
 */
export async function safeDb<T>(
  label: string,
  run: () => Promise<T>,
  fallback: T,
  timeoutMs = DB_QUERY_TIMEOUT_MS
): Promise<T> {
  try {
    return await withDbTimeout(run(), label, timeoutMs);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[db] ${label}: se usa el respaldo mínimo (${detail})`);
    return fallback;
  }
}
