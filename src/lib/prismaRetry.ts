import { prismaErrorCode } from './databaseDiagnostics';

/**
 * Reintento de consultas cuando la conexión con la base se corta.
 *
 * El error que nos ocupa es **P1017** («el servidor ha cerrado la conexión»):
 * pasa con el pooler de Supabase (pgbouncer) cuando una conexión queda inactiva
 * y el servidor la cierra, o cuando se acumulan clientes por encima del cupo.
 * La consulta no se ha ejecutado: la conexión ya no estaba. Reintentarla es
 * seguro y cambia por completo la experiencia —un turno que se perdía entero
 * pasaba a ser un aviso rojo en mitad de la puesta a punto—.
 *
 * Se reintenta SOLO lo que puede repetirse sin efectos raros: cortes de
 * conexión. Un error de datos (violación de único, campo obligatorio…) se
 * lanza tal cual: insistir no lo arregla y esconde la causa real.
 */

/** Códigos de Prisma que significan «la conexión no está / se ha perdido». */
const TRANSIENT_CODES = new Set([
  'P1001', // no se alcanza el servidor
  'P1002', // se agotó el tiempo al conectar
  'P1008', // la operación agotó su tiempo
  'P1011', // TLS cerrado a mitad
  'P1017', // el servidor ha cerrado la conexión  ← el habitual con Supabase
  'P2024', // el pool no dio conexión a tiempo
  'P2034', // conflicto de escritura (deadlock)
]);

/**
 * Mensajes equivalentes sin código. No es redundancia: con el pooler, Prisma a
 * veces devuelve el texto del driver (`Error: Server has closed the connection.`)
 * sin `code`, y entonces el reintento no se activaba.
 */
const TRANSIENT_PATTERNS = [
  'server has closed the connection',
  'connection closed',
  'connection terminated',
  'terminating connection',
  'connection reset',
  'socket hang up',
  'econnreset',
  'epipe',
  'connection pool timed out',
  'timed out fetching a new connection',
  'ssl connection has been closed',
  "can't reach database server",
];

export function isTransientDbError(error: unknown): boolean {
  if (!error) return false;
  const code = prismaErrorCode(error);
  if (code && TRANSIENT_CODES.has(code)) return true;

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return TRANSIENT_PATTERNS.some((pattern) => message.includes(pattern));
}

/** Esperas entre intentos (ms). Tres intentos en total, ~1,2 s de margen. */
export const DB_RETRY_DELAYS_MS = [250, 900] as const;

export interface DbRetryOptions {
  /** Etiqueta para el log: qué consulta ha fallado. */
  label?: string;
  /**
   * Qué hacer antes de reintentar. Con Prisma conviene cerrar el pool
   * (`$disconnect`): la conexión muerta sigue en el pool y, si no se descarta,
   * el reintento falla por el mismo motivo.
   */
  reconnect?: () => Promise<void> | void;
  delays?: readonly number[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ejecuta `run` y, si falla por conexión, la vuelve a intentar.
 *
 * Devuelve el resultado del primer intento que funcione; si se agotan, lanza el
 * último error (el de verdad, no uno inventado).
 */
export async function withDbRetry<T>(run: () => Promise<T>, options: DbRetryOptions = {}): Promise<T> {
  const delays = options.delays ?? DB_RETRY_DELAYS_MS;
  const label = options.label ?? 'consulta';

  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isTransientDbError(error) || attempt >= delays.length) throw error;

      const code = prismaErrorCode(error) ?? 'sin código';
      console.warn(
        `[db] ${label}: conexión perdida (${code}), reintento ${attempt + 1}/${delays.length} en ${delays[attempt]} ms`
      );

      if (options.reconnect) {
        try {
          await options.reconnect();
        } catch {
          // Volver a conectar es lo mejor que se puede intentar: si falla, el
          // reintento decidirá si la base está caída de verdad.
        }
      }
      await sleep(delays[attempt]);
    }
  }
}
