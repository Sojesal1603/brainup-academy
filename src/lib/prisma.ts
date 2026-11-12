import { PrismaClient } from '@prisma/client';
import { databaseTarget, resolveDatabaseUrl } from './databaseDiagnostics';
import { needsFreshConnection, withDbRetry } from './prismaRetry';
import { DB_QUERY_TIMEOUT_MS, withDbTimeout } from './dbTimeout';

/**
 * El cliente de Prisma, UNO SOLO por proceso.
 *
 * El singleton no es un detalle de estilo: cada `new PrismaClient()` abre su
 * propio pool. En desarrollo, Next recarga los módulos en cada cambio y sin el
 * singleton cada guardado dejaba un pool huérfano conectado al pooler de
 * Supabase; en Netlify, cada función serverless crea su propio proceso, así que
 * el singleton evita además que dos importaciones de este módulo (página, acción
 * y ruta) levanten dos pools en la misma función.
 *
 * Lleva puesto el **reintento por conexión perdida** (P1017): el pooler cierra
 * las conexiones que quedan inactivas y, sin reintento, ese corte llega al
 * alumno como un turno perdido. Al estar en el cliente, vale para toda la app
 * (páginas, acciones y todas las rutas) sin tocar cada consulta.
 */

/**
 * La URL ya normalizada para serverless (TLS, pooler, pgbouncer y
 * `connection_limit=1`). La normalización vive en `databaseDiagnostics.ts` para
 * poder usarla en `/api/salud` y `/diagnostico` sin cargar el motor de Prisma.
 */
const databaseUrl = resolveDatabaseUrl();

function createClient() {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    ...(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {}),
    // Las transacciones interactivas también tienen tope. En el pooler de
    // Supabase una transacción abierta ocupa una conexión del proyecto: si se
    // queda colgada, nadie más puede consultar hasta que el servidor la mate.
    // `maxWait` no supera el tope del pool (4 s) para que el fallo sea P2024 y
    // no una espera a ciegas.
    transactionOptions: { maxWait: 4_000, timeout: 10_000 },
  });

  /**
   * Cerrar el pool antes de reintentar. Si la conexión ha muerto, Prisma la
   * conserva y el reintento falla por el mismo motivo; al desconectar se abre
   * una nueva en la siguiente consulta. Se comparte la promesa para que veinte
   * consultas simultáneas no cierren el pool veinte veces.
   *
   * OJO: solo se llama cuando la conexión está muerta de verdad
   * (`needsFreshConnection`). En un P1008/P2024 la conexión sigue viva y
   * cerrarla multiplicaría las conexiones nuevas justo cuando el proyecto está
   * saturado, que es cómo se pasa de «una consulta lenta» a «la app entera
   * caída».
   */
  let reconnecting: Promise<void> | null = null;
  const reconnect = (): Promise<void> => {
    if (!reconnecting) {
      reconnecting = base
        .$disconnect()
        .catch(() => undefined)
        .then(() => {
          reconnecting = null;
        });
    }
    return reconnecting;
  };

  return base.$extends({
    name: 'brainup-db-retry',
    query: {
      async $allOperations({ operation, model, args, query }) {
        const label = `${model ?? 'db'}.${operation}`;
        // El deadline envuelve también los reintentos: una conexión muerta no
        // puede sumar 4,5 s por intento y dejar la vista colgada tres veces.
        return withDbTimeout(
          withDbRetry(() => query(args), {
            label,
            reconnect: async (error) => {
              if (needsFreshConnection(error)) await reconnect();
            },
          }),
          label,
          DB_QUERY_TIMEOUT_MS
        );
      },
    },
  });
}

/** Tipo del cliente con el reintento puesto (el que se usa en toda la app). */
export type BrainUpPrisma = ReturnType<typeof createClient>;

/**
 * `globalThis` sobrevive al Hot Reload de Next y a la recarga de módulos dentro
 * del mismo proceso. Ahí se guarda el cliente: si ya hay uno, se reutiliza en
 * vez de abrir otro pool.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: BrainUpPrisma | undefined;
};

export const prisma: BrainUpPrisma = globalForPrisma.prisma ?? createClient();

// Se asigna también en producción a propósito: agrupar las importaciones de una
// misma función serverless en un solo cliente es exactamente lo que se busca.
globalForPrisma.prisma = prisma;

if (process.env.NODE_ENV === 'development') {
  const { host, port, connectionLimit } = databaseTarget();
  console.info(
    `[prisma] ${host ?? 'sin DATABASE_URL'}:${port ?? '5432'} · ${connectionLimit ?? '—'} conexión(es) por proceso`
  );
}
