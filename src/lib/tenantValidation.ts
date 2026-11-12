import { z } from 'zod';

/**
 * Validación de identidad y de propiedad de filas para el modo multiusuario.
 *
 * Dos capas, a propósito:
 *
 *   1. **Zod** valida lo que entra desde una Server Action (ids, zona horaria,
 *      referencias a materias/temas…) antes de tocar la base. Un id con la forma
 *      equivocada no llega a Prisma.
 *   2. **`assertOwnedRecord`** valida lo que vuelve de la base: una consulta que
 *      cruza dos cuentas no puede pasar por buena aunque el filtro se haya
 *      olvidado en algún sitio.
 *
 * El `userId` de esta app es el `sub` de Supabase Auth, que siempre es un UUID.
 * El antiguo `user_default` **no** es válido aquí: el cliente acotado
 * (`src/lib/db.ts`) no puede leer ni escribir datos de la cuenta compartida.
 */

/** Identificador de cuenta (UUID de Supabase Auth). */
export const tenantIdSchema = z.uuid({
  message: 'El identificador de usuario debe ser el UUID de Supabase Auth.',
});

/** Identificador de una fila propia (materia, tema, bloque, apunte…). */
export const ownedIdSchema = z.uuid({
  message: 'El identificador de la fila debe ser un UUID válido.',
});

/**
 * Zona horaria IANA (`Europe/Madrid`, `Atlantic/Canary`…).
 *
 * No basta con que sea una cadena: `Intl.DateTimeFormat` es la única fuente que
 * sabe si la zona existe de verdad en el runtime. Un valor inventado haría que
 * las rachas y los hábitos se calculen en UTC sin avisar.
 */
export const timeZoneSchema = z
  .string()
  .min(1, 'La zona horaria no puede estar vacía.')
  .max(64, 'La zona horaria es demasiado larga.')
  .refine((value) => isValidTimeZone(value), {
    message: 'La zona horaria no existe (usa un identificador IANA, p. ej. Europe/Madrid).',
  });

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('es-ES', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** Códigos estables para que las Server Actions decidan qué devolver. */
export type TenantErrorCode =
  | 'TENANT_INVALID_ID'
  | 'TENANT_SCOPE_VIOLATION'
  | 'TENANT_NESTED_WRITE'
  | 'TENANT_OWNERSHIP_MISMATCH';

/**
 * Error de aislamiento entre cuentas.
 *
 * Es un error de programación, no de datos: significa que una consulta ha
 * intentado salirse de su cuenta. Nunca se debe convertir en un «no encontrado»
 * silencioso, porque eso esconde el fallo y deja la fuga sin corregir.
 */
export class TenantScopeError extends Error {
  readonly code: TenantErrorCode;

  constructor(message: string, code: TenantErrorCode = 'TENANT_SCOPE_VIOLATION') {
    super(message);
    this.name = 'TenantScopeError';
    this.code = code;
  }
}

/** El cliente acotado no admite escrituras anidadas: no puede garantizar su dueño. */
export class NestedTenantWriteError extends TenantScopeError {
  constructor(path: string) {
    super(
      `Escritura anidada en «${path}»: el cliente acotado no puede garantizar el dueño de las filas hijas. ` +
        'Crea o actualiza cada fila con su propia llamada a db(userId).',
      'TENANT_NESTED_WRITE'
    );
    this.name = 'NestedTenantWriteError';
  }
}

/** Normaliza y valida el id de la cuenta. Lanza si no es un UUID de Supabase. */
export function parseTenantId(value: unknown): string {
  const result = tenantIdSchema.safeParse(value);
  if (!result.success) {
    throw new TenantScopeError(
      result.error.issues[0]?.message ?? 'Identificador de usuario no válido.',
      'TENANT_INVALID_ID'
    );
  }
  return result.data;
}

/**
 * Comprueba que una fila leída pertenece a la cuenta de la petición.
 *
 * Se usa en las Server Actions después de una lectura con `include`, sobre todo
 * cuando la fila se ha obtenido por una relación (un `topic` de un `subject`, un
 * `block` de un `topic`…). Si la fila no existe o es de otra cuenta, devuelve
 * `null`: el llamador decide si eso es un 404 o un error.
 */
export function ownedRecord<T extends { userId: string }>(
  record: T | null | undefined,
  userId: string
): T | null {
  if (!record) return null;
  if (record.userId !== userId) {
    throw new TenantScopeError(
      `La fila consultada pertenece a otra cuenta (esperada ${userId}, recibida ${record.userId}).`,
      'TENANT_OWNERSHIP_MISMATCH'
    );
  }
  return record;
}

/**
 * Igual que `ownedRecord`, pero para el perfil: la clave es `id`, no `userId`.
 */
export function ownedProfile<T extends { id: string }>(
  record: T | null | undefined,
  userId: string
): T | null {
  if (!record) return null;
  if (record.id !== userId) {
    throw new TenantScopeError(
      'El perfil consultado pertenece a otra cuenta.',
      'TENANT_OWNERSHIP_MISMATCH'
    );
  }
  return record;
}
