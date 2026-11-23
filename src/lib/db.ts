import { AsyncLocalStorage } from 'node:async_hooks';
import { isInTransaction, prisma, withTransactionFlag } from './prisma';
import { TENANT_SETTING } from './tenantSetting';
import {
  NestedTenantWriteError,
  parseTenantId,
  TenantScopeError,
} from './tenantValidation';

/**
 * Ajuste de PostgreSQL en el que se fija la cuenta de la transacción.
 *
 * Las políticas RLS lo leen con `current_setting('app.user_id', true)`. Se fija
 * con `set_config(..., true)`, así que es **local a la transacción**: al terminar
 * vuelve a estar vacío y no se queda pegado a la conexión del pooler. Eso es lo
 * que impide que la conexión de un usuario atienda a otro con el rol antiguo.
 */
export { TENANT_SETTING };

/**
 * `db(userId)`: el único camino permitido a los datos de una cuenta.
 *
 * El problema que resuelve: un `where` olvidado no da error, devuelve filas de
 * otro alumno. En una app multiusuario eso es una fuga silenciosa. Aquí el
 * `userId` se inyecta **después** de los argumentos del llamador y no se puede
 * pisar:
 *
 *   - las lecturas (`findUnique`, `findMany`, `findFirst`, `count`, `aggregate`,
 *     `groupBy`) llevan siempre `userId` (o `id`, en `UserProfile`);
 *   - `create`/`createMany` reciben el dueño aunque el llamador no lo pase;
 *   - `update`/`delete`/`upsert` llevan el dueño en el `where`, así que tocar
 *     una fila ajena termina en P2025 («no encontrada»), no en una escritura;
 *   - cambiar `userId`/`user`/`id` a mano lanza `TenantScopeError`.
 *
 * Reglas que hay que respetar al usarlo:
 *
 *   1. El `userId` sale **siempre** de `requireUser()` (`src/lib/auth.ts`), nunca
 *      de una cabecera, un formulario o el navegador.
 *   2. El `user_default` histórico no es válido: `db()` exige un UUID de
 *      Supabase Auth. Los datos de la cuenta antigua se migran una vez a la
 *      cuenta real.
 *   3. **No hay escrituras anidadas.** `db(userId).subject.create({ data: { topics: { create: … } } })`
 *      se rechaza: la fila hija nacería con el dueño por defecto. Cada fila se
 *      crea con su propia llamada, y las relaciones se enlazan por id validado.
 *   4. Las operaciones `$queryRaw*`/`$executeRaw*` no pasan por este filtro. Solo
 *      se usan en infraestructura (diagnóstico y migraciones), nunca en una
 *      Server Action con datos de una cuenta.
 *   5. `$transaction` se envuelve para marcar la transacción como abierta: dentro
 *      de ella no hay reintentos ni se cierra el pool. Se puede usar tanto la
 *      forma interactiva (callback) como la de lote.
 *
 * Modo estricto (`TENANT_RLS_STRICT=1`): cada consulta se ejecuta dentro de una
 * transacción con `SET LOCAL app.user_id`, no solo las que abren `$transaction`.
 * Es el requisito para que las políticas de `prisma/sql/rls_strict_tenant.sql`
 * sean obligatorias (sin el ajuste niegan todo) y no una red decorativa. Sin el
 * flag, el comportamiento es el de siempre: manda el filtro de la extensión y
 * las políticas siguen siendo permisivas cuando no hay ajuste.
 */

type JsonObject = Record<string, unknown>;

/**
 * Modo estricto de RLS: fija `app.user_id` en **cada** consulta acotada.
 *
 * Se activa junto con `prisma/sql/rls_strict_tenant.sql` (ver el encabezado de
 * ese archivo). Apagado, cada consulta suelta no fija el ajuste y las políticas
 * permisivas dejan pasar: el aislamiento depende solo de la extensión de Prisma.
 */
export const TENANT_RLS_STRICT = (process.env.TENANT_RLS_STRICT ?? '').trim() === '1';

interface AmbientTenantTransaction {
  ownerId: string;
  client: unknown;
}

/**
 * Transacción de una cuenta abierta en esta cadena asíncrona.
 *
 * Sirve para que un `db(mismo usuario)` llamado dentro de una transacción se
 * una a ella en vez de abrir otra: con `connection_limit=1` la segunda se
 * quedaría esperando a la primera hasta agotar el tiempo. Y un `db(otra cuenta)`
 * dentro de una transacción es un error de programación, no una consulta más.
 */
const ambientTenantTransaction = new AsyncLocalStorage<AmbientTenantTransaction>();

type RawTransactionClient = {
  $executeRawUnsafe: (query: string, ...values: unknown[]) => unknown;
};

/**
 * Fija la cuenta de la transacción actual para RLS.
 *
 * Es la segunda capa: `scopeOperation` ya inyecta el dueño en cada consulta de
 * Prisma. Esta capa cubre lo que la extensión no ve —`$queryRaw*`,
 * `$executeRaw*` y cualquier SQL escrito a mano dentro de la transacción— y
 * hace que una fila de otra cuenta no se pueda leer ni escribir aunque el
 * llamador se equivoque.
 */
async function setTenantContext(client: unknown, ownerId: string): Promise<void> {
  const executor = client as RawTransactionClient;
  await executor.$executeRawUnsafe(
    `SELECT set_config('${TENANT_SETTING}', $1, true)`,
    ownerId
  );
}

/** Modelos que se aíslan por `userId` (todos los de contenido). */
const TENANT_MODELS: ReadonlySet<string> = new Set([
  'Subject',
  'Topic',
  'Exam',
  'StudyBlock',
  'StudySession',
  'ErrorLog',
  'Habit',
  'HabitLog',
  'AiAgent',
  'AiConversation',
  'AiMessage',
  'AiAttachment',
  'PauExamSession',
  'Note',
  'ClassPeriod',
  'MoodleTask',
  'MoodleCourse',
  'MoodleMaterial',
  'SrsReview',
  'WeeklyChallenge',
  'SystemIssue',
  'AgentMemory',
  'ReviewCard',
  'FocusSession',
  'PlanState',
  'PlanConstraint',
  'TutorSessionOutcome',
  'PushSubscription',
  'UserAiKey',
  'AiKeyAttempt',
  // Fase 16: fuentes persistentes y apuntes modulares. Sin estas entradas, una
  // consulta a `noteSection`/`noteBlock` no llevaría el dueño y el RLS sería la
  // única defensa (y con `app.user_id` sin fijar, no habría ninguna).
  'SourceDocument',
  'DocumentChunk',
  'NoteSection',
  'NoteBlock',
  'StudyJob',
]);

/** Operaciones de lectura: se les añade el dueño al `where`. */
const READ_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** Operaciones que escriben varias filas con `data` en forma de array. */
const CREATE_MANY_OPERATIONS: ReadonlySet<string> = new Set([
  'createMany',
  'createManyAndReturn',
]);

/**
 * Claves de Prisma que significan «escritura de una relación». Se rechazan en
 * el payload: el cliente acotado no puede demostrar quién es el dueño de la
 * fila hija desde aquí.
 */
const NESTED_WRITE_KEYS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'connect',
  'connectOrCreate',
  'disconnect',
  'set',
  'delete',
  'deleteMany',
]);

function isPlainObject(value: unknown): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function asObject(value: unknown): JsonObject {
  return isPlainObject(value) ? { ...value } : {};
}

/**
 * Recorre el payload y lanza si aparece una escritura de relación en cualquier
 * profundidad. Es una lista de claves, no de modelos, porque el dueño de una
 * fila hija se decide en el modelo, y Prisma no expone aquí a qué modelo
 * pertenece cada relación.
 */
function assertNoNestedWrites(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoNestedWrites(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (NESTED_WRITE_KEYS.has(key)) throw new NestedTenantWriteError(`${path}.${key}`);
    assertNoNestedWrites(child, `${path}.${key}`);
  }
}

/** El dueño de una fila no se cambia ni se «conecta» a mano. */
function assertOwnerUntouched(data: unknown, ownerField: string, ownerId: string): void {
  const payload = asObject(data);

  if ('user' in payload) {
    throw new TenantScopeError(
      'La relación `user` no se escribe a mano: el dueño lo inyecta db(userId).',
      'TENANT_SCOPE_VIOLATION'
    );
  }

  const given = payload[ownerField];
  if (given !== undefined && given !== ownerId) {
    throw new TenantScopeError(
      `No se puede cambiar el dueño de la fila (${ownerField}: ${String(given)}).`,
      'TENANT_SCOPE_VIOLATION'
    );
  }
}

/** Añade el dueño al `where` sin permitir que el llamador lo cambie. */
function scopeWhere(rawWhere: unknown, ownerField: string, ownerId: string): JsonObject {
  const where = asObject(rawWhere);

  if (ownerField === 'id') {
    // UserProfile se identifica por `id`, no por `userId`.
    if (typeof where.id === 'string' && where.id !== ownerId) {
      throw new TenantScopeError(
        'La consulta intenta leer o modificar el perfil de otra cuenta.',
        'TENANT_SCOPE_VIOLATION'
      );
    }
    return { ...where, id: ownerId };
  }

  if (typeof where.userId === 'string' && where.userId !== ownerId) {
    throw new TenantScopeError(
      'La consulta intenta leer o modificar filas de otra cuenta.',
      'TENANT_SCOPE_VIOLATION'
    );
  }

  // Se sobrescribe `userId` en el nivel superior, sin envolver en `AND`.
  //
  // No es un detalle: `findUnique`, `update`, `delete` y `upsert` exigen que el
  // `where` conserve su clave única en el primer nivel (`id` o el compuesto
  // `userId_scope_day`). Envolverlo todo en `AND` lo dejaría sin clave única y
  // Prisma lo rechazaría en runtime. En Prisma los campos del primer nivel se
  // combinan con AND, así que la condición del dueño sigue siendo obligatoria
  // aunque el llamador traiga un `OR` o un `NOT`.
  return { ...where, userId: ownerId };
}

/** Prepara el `data` de un create/upsert.create con el dueño inyectado. */
function ownerData(rawData: unknown, ownerField: string, ownerId: string): JsonObject {
  const data = asObject(rawData);
  assertNoNestedWrites(data, 'data');
  assertOwnerUntouched(data, ownerField, ownerId);
  return { ...data, [ownerField]: ownerId };
}

/** Valida el `data` de una actualización y no toca el dueño. */
function updateData(rawData: unknown, ownerField: string, ownerId: string): JsonObject {
  const data = asObject(rawData);
  assertNoNestedWrites(data, 'data');
  assertOwnerUntouched(data, ownerField, ownerId);
  return data;
}

/**
 * Reescribe los argumentos de UNA operación para que no pueda salirse de la
 * cuenta. Es una función pura: no consulta la base ni conoce el resultado.
 */
function scopeOperation(
  model: string,
  operation: string,
  rawArgs: unknown,
  ownerId: string
): JsonObject {
  const isProfile = model === 'UserProfile';
  if (!isProfile && !TENANT_MODELS.has(model)) {
    throw new TenantScopeError(
      `El modelo «${model}» no está declarado como dato de una cuenta; ` +
        'añádelo a TENANT_MODELS o no uses db(userId) para él.',
      'TENANT_SCOPE_VIOLATION'
    );
  }

  const ownerField = isProfile ? 'id' : 'userId';
  const args = asObject(rawArgs);

  if (READ_OPERATIONS.has(operation)) {
    args.where = scopeWhere(args.where, ownerField, ownerId);
    return args;
  }

  if (operation === 'create') {
    args.data = ownerData(args.data, ownerField, ownerId);
    return args;
  }

  if (CREATE_MANY_OPERATIONS.has(operation)) {
    const rows = Array.isArray(args.data) ? args.data : [args.data];
    args.data = rows.map((row) => ownerData(row, ownerField, ownerId));
    return args;
  }

  if (operation === 'update' || operation === 'updateMany' || operation === 'updateManyAndReturn') {
    args.where = scopeWhere(args.where, ownerField, ownerId);
    args.data = updateData(args.data, ownerField, ownerId);
    return args;
  }

  if (operation === 'upsert') {
    // `create` es una fila nueva: lleva dueño. `update` actúa sobre una fila que
    // el `where` ya ha acotado: no puede cambiar de dueño.
    args.where = scopeWhere(args.where, ownerField, ownerId);
    args.create = ownerData(args.create, ownerField, ownerId);
    args.update = updateData(args.update, ownerField, ownerId);
    return args;
  }

  if (operation === 'delete' || operation === 'deleteMany') {
    args.where = scopeWhere(args.where, ownerField, ownerId);
    return args;
  }

  // Cualquier operación nueva de Prisma se rechaza hasta revisarla. Fallar
  // cerrado es lo único que impide que una actualización del ORM abra un agujero.
  throw new TenantScopeError(
    `Operación «${operation}» no soportada por db(userId). Revísala antes de usarla.`,
    'TENANT_SCOPE_VIOLATION'
  );
}

/**
 * Envuelve el cliente de una transacción para poder pasarlo a `db()`.
 *
 * Abrir otra transacción desde dentro de una abierta no tiene sentido (y con el
 * pooler puede bloquearse), así que `$transaction` se sustituye por un error
 * claro en vez de dejar que Prisma intente lo imposible.
 */
function transactionClientProxy(tx: unknown): unknown {
  return new Proxy(tx as object, {
    get(target, prop) {
      if (prop === '$transaction') {
        return () => {
          throw new TenantScopeError(
            'Dentro de una transacción de db(userId) se usa el `tx` que recibe el callback: no se abre otra.',
            'TENANT_SCOPE_VIOLATION'
          );
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Cliente de Prisma acotado a una cuenta.
 *
 * Devuelve un cliente extendido normal (se usan sus métodos como siempre), pero
 * cada consulta pasa por `scopeOperation`. Se crea por petición; el motor y el
 * pool se comparten con el cliente global.
 *
 * ```ts
 * const user = await requireUser();
 * const notes = await db(user.id).note.findMany({ where: { isPinned: true } });
 * ```
 */
export function db(userId: string) {
  const ownerId = parseTenantId(userId);

  // Ya hay una transacción de esta cuenta en la cadena asíncrona: se reutiliza.
  const ambient = ambientTenantTransaction.getStore();
  if (ambient) {
    if (ambient.ownerId !== ownerId) {
      throw new TenantScopeError(
        'Dentro de la transacción de una cuenta no se puede consultar otra cuenta.',
        'TENANT_SCOPE_VIOLATION'
      );
    }
    // El cliente de la transacción trae las mismas extensiones (incluido el
    // filtro por cuenta), así que su forma es la del cliente acotado.
    return ambient.client as typeof scoped;
  }

  const scoped = prisma.$extends({
    name: 'brainup-tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const scopedArgs = scopeOperation(model, operation, args, ownerId);

          // Fuera del modo estricto, o dentro de una transacción que ya fijó el
          // ajuste, la consulta se ejecuta tal cual sobre su conexión.
          if (!TENANT_RLS_STRICT || isInTransaction()) {
            return query(scopedArgs as typeof args);
          }

          // Modo estricto: el ajuste tiene que ir en la MISMA transacción y en la
          // MISMA conexión que la consulta. Por eso se envía en un lote con
          // `set_config(..., true)` delante: al confirmar, la conexión vuelve al
          // pool sin la cuenta anterior pegada.
          const delegate = (
            prisma as unknown as Record<string, Record<string, (arg: unknown) => unknown>>
          )[model];
          const runBatch = prisma.$transaction as unknown as (
            queries: unknown[]
          ) => Promise<unknown[]>;

          return withTransactionFlag(async () => {
            const [, result] = await runBatch([
              prisma.$executeRawUnsafe(
                `SELECT set_config('${TENANT_SETTING}', $1, true)`,
                ownerId
              ),
              delegate[operation](scopedArgs),
            ]);
            return result as never;
          });
        },
      },
    },
  });

  /**
   * `$transaction` necesita una capa extra: Prisma abre la transacción, pero la
   * extensión de reintentos de `prisma.ts` no puede saber que las consultas de
   * dentro van en ella. Sin esta marca, un P1017 en una lectura podría hacer
   * que se cerrara el pool con la transacción viva.
   *
   * El resto de propiedades se leen del cliente acotado tal cual; las funciones
   * se ligan al cliente real para que no pierdan su `this`.
   */
  return new Proxy(scoped, {
    get(target, prop) {
      if (prop === '$transaction') {
        return (input: unknown, options?: unknown) =>
          withTransactionFlag(() => {
            if (typeof input === 'function') {
              // Hay que conservar el `this`: el cliente extendido guarda ahí su
              // motor y, sin él, Prisma falla con «_engineConfig undefined».
              const start = (target.$transaction as unknown as (
                run: (tx: unknown) => unknown,
                opts?: unknown
              ) => Promise<unknown>).bind(target);

              // La cuenta se fija antes del callback: sus consultas, incluidas
              // las de `$queryRaw`, ven el ajuste desde la primera sentencia.
              return start(async (tx) => {
                await setTenantContext(tx, ownerId);
                const scopedTx = transactionClientProxy(tx);
                return ambientTenantTransaction.run({ ownerId, client: scopedTx }, () =>
                  (input as (tx: unknown) => unknown)(scopedTx)
                );
              }, options);
            }

            const start = (target.$transaction as unknown as (
              queries: unknown,
              opts?: unknown
            ) => Promise<unknown>).bind(target);

            // En la forma de lote, el `set_config` va como primera consulta de
            // la misma transacción. Prisma las ejecuta en orden y todas ven el
            // ajuste local.
            const context = (target as unknown as RawTransactionClient).$executeRawUnsafe(
              `SELECT set_config('${TENANT_SETTING}', $1, true)`,
              ownerId
            );
            return start([context, ...(input as unknown[])], options);
          });
      }

      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Tipo del cliente acotado (incluye el filtro de la cuenta). */
export type TenantPrisma = ReturnType<typeof db>;
