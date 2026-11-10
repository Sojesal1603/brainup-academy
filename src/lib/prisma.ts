import { PrismaClient } from '@prisma/client';
import { resolveDatabaseUrl } from './databaseDiagnostics';
import { withDbRetry } from './prismaRetry';
import { DB_QUERY_TIMEOUT_MS, withDbTimeout } from './dbTimeout';

/**
 * El cliente de Prisma, uno solo por proceso.
 *
 * En Netlify cada función serverless levanta su propia instancia: reutilizar el
 * cliente entre peticiones de la misma instancia evita abrir una conexión nueva
 * por cada render (con el pooler de Supabase, eso es la diferencia entre
 * funcionar y agotar el cupo del plan gratuito).
 *
 * Lleva puesto el **reintento por conexión perdida** (P1017): el pooler de
 * Supabase cierra las conexiones que quedan inactivas y, sin reintento, ese
 * corte llega al alumno como un turno perdido («la base de datos no ha
 * respondido»). Aquí se descarta la conexión muerta y se repite la consulta, que
 * es lo que evita el error de raíz. Al estar en el cliente, vale para toda la
 * app (páginas, acciones y todas las rutas) sin tocar cada consulta.
 */

/**
 * La URL ya normalizada para serverless (TLS y pooler). La normalización vive en
 * `databaseDiagnostics.ts` para poder usarla en `/api/salud` y `/diagnostico`
 * sin cargar el motor de Prisma.
 */
const databaseUrl = resolveDatabaseUrl();

function createClient() {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    ...(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {}),
  });

  /**
   * Cerrar el pool antes de reintentar. Si la conexión ha muerto, Prisma la
   * conserva y el reintento falla por el mismo motivo; al desconectar se abre
   * una nueva en la siguiente consulta. Se comparte la promesa para que veinte
   * consultas simultáneas no cierren el pool veinte veces.
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
          withDbRetry(() => query(args), { label, reconnect }),
          label,
          DB_QUERY_TIMEOUT_MS
        );
      },
    },
  });
}

/** Tipo del cliente con el reintento puesto (el que se usa en toda la app). */
export type BrainUpPrisma = ReturnType<typeof createClient>;

const globalForPrisma = globalThis as unknown as {
  prisma: BrainUpPrisma | undefined;
};

export const prisma: BrainUpPrisma = globalForPrisma.prisma ?? createClient();

globalForPrisma.prisma = prisma;
