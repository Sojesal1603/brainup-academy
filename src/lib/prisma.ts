import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaClient, type Prisma } from '@prisma/client';
import { databaseTarget, resolveRuntimeDatabaseUrl } from './databaseDiagnostics';
import { DB_RETRY_DELAYS_MS, needsFreshConnection, withDbRetry } from './prismaRetry';
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
 * Dos reglas de seguridad viven aquí y no en cada consulta:
 *
 *   1. **Qué se reintenta.** Un corte de conexión (P1017) puede repetirse sin
 *      efectos raros si la operación es una lectura pura o un `upsert`. En un
 *      `create`/`update`/`delete` no: la escritura puede haber llegado al
 *      servidor y el reintento la duplicaría. La lista es una **lista blanca**,
 *      no una lista negra, para que una operación nueva de Prisma no se
 *      reintente por olvido.
 *   2. **Cuándo se descarta el pool.** Nunca con consultas en vuelo ni con una
 *      transacción abierta: cerrar el pool ahí mata el trabajo de otra petición
 *      y puede dejar una transacción esperando una conexión que ya no existe.
 */

/**
 * Operaciones que se pueden repetir sin cambiar el resultado.
 *
 * `upsert` está porque su `where` es único: repetirlo no crea una segunda fila.
 * No están `create`, `createMany`, `update`, `updateMany`, `delete`,
 * `deleteMany` ni las operaciones `$executeRaw*`: si la red se corta después de
 * que PostgreSQL haya confirmado, repetirlas duplica o pisa datos.
 */
const RETRYABLE_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'upsert',
]);

/** Sin reintentos: se usa dentro de una transacción abierta. */
const NO_RETRIES: readonly number[] = [];

/**
 * Contexto de transacción por cadena asíncrona.
 *
 * La extensión de Prisma no puede interceptar `$transaction`, así que la única
 * forma de que sepa que una consulta va dentro de una transacción es este
 * almacén. Dentro de una transacción no se reintenta nada: un reintento suelto
 * rompe la atomicidad del conjunto (y el `reconnect` mataría la transacción).
 */
const transactionContext = new AsyncLocalStorage<Prisma.TransactionClient>();

/**
 * Marca «hay una transacción en curso» incluso cuando no tenemos el cliente de
 * la transacción (por ejemplo, una transacción del cliente acotado, cuyo `tx`
 * lo gestiona Prisma por dentro). Es lo que consulta la extensión para no
 * reintentar una consulta suelta ni cerrar el pool.
 */
const transactionScope = new AsyncLocalStorage<boolean>();

/** Transacciones abiertas en este proceso (para no cerrar el pool debajo). */
let activeTransactions = 0;

export function isInTransaction(): boolean {
  return transactionScope.getStore() === true || transactionContext.getStore() !== undefined;
}

/**
 * Ejecuta `start` marcando el proceso como «dentro de una transacción» y sin
 * permitir que el pool se cierre por debajo.
 *
 * Lo usa el cliente acotado (`db(userId).$transaction`): su transacción la
 * abre Prisma, pero las consultas que van dentro siguen pasando por la
 * extensión de reintentos y necesitan esta marca.
 */
export async function withTransactionFlag<T>(start: () => Promise<T>): Promise<T> {
  activeTransactions += 1;
  try {
    return await transactionScope.run(true, start);
  } finally {
    activeTransactions -= 1;
  }
}

/**
 * La URL ya normalizada para serverless (TLS, pooler, pgbouncer y
 * `connection_limit=1`). La normalización vive en `databaseDiagnostics.ts` para
 * poder usarla en `/api/salud` y `/diagnostico` sin cargar el motor de Prisma.
 *
 * Se prefiere `PRISMA_APP_DATABASE_URL`: es la cadena del rol de runtime
 * `prisma_app`, con permisos de DML y sin DDL. `DIRECT_URL` sigue siendo
 * exclusiva de `prisma migrate`; no se usa aquí.
 */
const databaseUrl = resolveRuntimeDatabaseUrl();

/**
 * Cuenta consultas en vuelo para que un cierre del pool espere (o se abstenga).
 *
 * El alcance es el proceso: todas las peticiones de esta función serverless
 * comparten el mismo cliente y el mismo pool.
 */
function createIdleTracker() {
  let inFlight = 0;
  const waiters = new Set<() => void>();

  return {
    enter() {
      inFlight += 1;
    },
    leave() {
      inFlight = Math.max(0, inFlight - 1);
      if (inFlight === 0) {
        for (const notify of waiters) notify();
        waiters.clear();
      }
    },
    /** Espera a que no quede ninguna consulta viva. `false` si no llega a tiempo. */
    wait(timeoutMs: number): Promise<boolean> {
      if (inFlight === 0) return Promise.resolve(true);

      return new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = (idle: boolean) => {
          clearTimeout(timer);
          waiters.delete(onIdle);
          resolve(idle);
        };
        const onIdle = () => finish(true);
        timer = setTimeout(() => finish(false), timeoutMs);
        waiters.add(onIdle);
      });
    },
  };
}

function createClient() {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    ...(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {}),
    // Las transacciones interactivas también tienen tope. En el pooler de
    // Supabase una transacción abierta ocupa una conexión del proyecto: si se
    // queda colgada, nadie más puede consultar hasta que el servidor la mate.
    // `maxWait` no supera el tope del pool (4 s) para que el fallo sea P2024 y
    // no una espera a ciegas. El rol `prisma_app` añade además
    // `idle_in_transaction_session_timeout = 10s` en PostgreSQL.
    transactionOptions: { maxWait: 4_000, timeout: 10_000 },
  });

  const tracker = createIdleTracker();

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
   *
   * Y nunca se cierra con trabajo en vuelo: si otra petición está consultando o
   * hay una transacción abierta, se deja el pool como está. El reintento fallará
   * y el error real llegará arriba, que es mejor que un interbloqueo.
   */
  let reconnecting: Promise<void> | null = null;
  const reconnect = (): Promise<void> => {
    if (!reconnecting) {
      reconnecting = (async () => {
        if (activeTransactions > 0) {
          console.warn(
            '[db] no se descarta el pool: hay una transacción abierta en este proceso'
          );
          return;
        }

        const idle = await tracker.wait(1_000);
        if (!idle) {
          console.warn('[db] no se descarta el pool: hay consultas en vuelo');
          return;
        }

        await base.$disconnect().catch(() => undefined);
      })().finally(() => {
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

        // Escrituras y operaciones desconocidas: sin reintento automático. El
        // deadline sigue puesto para que una conexión muda no cuelgue la vista.
        if (!RETRYABLE_OPERATIONS.has(operation)) {
          return withDbTimeout(query(args), label, DB_QUERY_TIMEOUT_MS);
        }

        // Dentro de una transacción, un fallo de conexión invalida el conjunto:
        // se propaga tal cual para que el llamador decida (y no se desconecta).
        const retryDelays = isInTransaction() ? NO_RETRIES : DB_RETRY_DELAYS_MS;

        // El deadline envuelve también los reintentos: una conexión muerta no
        // puede sumar 4,5 s por intento y dejar la vista colgada tres veces.
        return withDbTimeout(
          withDbRetry(
            async () => {
              tracker.enter();
              try {
                return await query(args);
              } finally {
                tracker.leave();
              }
            },
            {
              label,
              delays: retryDelays,
              reconnect: async (error) => {
                if (needsFreshConnection(error)) await reconnect();
              },
            }
          ),
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

/**
 * Transacción interactiva con contexto de seguridad.
 *
 * Existe para que la extensión de reintentos sepa que está dentro de una
 * transacción y **no reintente** una consulta suelta ni cierre el pool. Las
 * llamadas anidadas se unen a la transacción en curso en vez de abrir otra.
 *
 * Para datos de una cuenta se usa `db(userId).$transaction(...)` (el cliente
 * acotado aplica el filtro también a la transacción). Esta función es para el
 * código de infraestructura que aún trabaja con el cliente global (por ejemplo,
 * cierres nocturnos y migraciones de datos).
 */
export async function withTransaction<T>(
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { maxWait?: number; timeout?: number } = {}
): Promise<T> {
  const current = transactionContext.getStore();
  if (current) return run(current);

  // Dentro de una transacción del cliente acotado no tenemos su `tx` (Prisma
  // lo gestiona por dentro). Abrir otra con el cliente global tomaría otra
  // conexión y podría bloquearse contra la primera: se falla claro.
  if (transactionScope.getStore() === true) {
    throw new Error(
      'No se puede abrir una transacción global dentro de una transacción de db(userId). ' +
        'Usa el `tx` que recibe el callback de db(userId).$transaction.'
    );
  }

  activeTransactions += 1;
  try {
    return await prisma.$transaction(
      (tx) => {
        // El cliente de la transacción viene con las extensiones aplicadas, así
        // que su tipo es más rico que `Prisma.TransactionClient`. Se guarda con
        // ese tipo para que las consultas de dentro sigan viendo la extensión.
        const client = tx as unknown as Prisma.TransactionClient;
        return transactionScope.run(true, () =>
          transactionContext.run(client, () => run(client))
        );
      },
      options
    );
  } finally {
    activeTransactions -= 1;
  }
}

if (process.env.NODE_ENV === 'development') {
  const { host, port, connectionLimit, role, dedicatedRole } = databaseTarget();
  console.info(
    `[prisma] ${host ?? 'sin DATABASE_URL'}:${port ?? '5432'} · ` +
      `${connectionLimit ?? '—'} conexión(es) por proceso · rol ${role ?? '—'}`
  );
  if (!dedicatedRole) {
    console.warn(
      '[prisma] Falta PRISMA_APP_DATABASE_URL: la app está conectando con DATABASE_URL. ' +
        'Define la cadena del rol prisma_app (DML sin DDL, con statement_timeout=8s).'
    );
  }
} else if (!process.env.PRISMA_APP_DATABASE_URL) {
  console.warn(
    '[prisma] PRISMA_APP_DATABASE_URL no está definida: runtime usando DATABASE_URL. ' +
      'El rol de runtime prisma_app es el que limita DDL y tiempo de sentencia.'
  );
}
