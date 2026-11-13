import { cache } from 'react';
import { requireUser, type AuthUser } from './auth';
import { db, type TenantPrisma } from './db';

/**
 * El dueño de la petición y su cliente acotado, memoizados por petición.
 *
 * `requireUser()` valida la sesión contra Supabase; `db(userId)` inyecta el
 * dueño en cada consulta. Al memoizarlo con `cache()` de React, el layout, la
 * página y la acción comparten la misma validación y el mismo cliente durante
 * una petición, sin repetir la llamada a Auth.
 *
 * Uso en una página, una acción o una ruta:
 *
 * ```ts
 * const { tenant, userId } = await currentTenant();
 * const notes = await tenant.note.findMany();
 * ```
 *
 * No se puede usar dentro de `unstable_cache`: ese callback puede ejecutarse
 * fuera de la petición. Ahí se pasa el `userId` como parte de la clave.
 */
export const currentTenant = cache(
  async (): Promise<{ user: AuthUser; userId: string; tenant: TenantPrisma }> => {
    const user = await requireUser();
    return { user, userId: user.id, tenant: db(user.id) };
  }
);
