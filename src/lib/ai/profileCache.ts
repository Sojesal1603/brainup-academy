/**
 * Caché en memoria del perfil BYOK de cada alumno.
 *
 * Resolver el perfil costaba una lectura por proveedor y un descifrado por
 * clave en CADA turno. Con esta caché, los turnos consecutivos de una misma
 * cuenta pagan cero base de datos y cero descifrados, y el perfil se refresca
 * como mucho cada 60 s.
 *
 * Reglas:
 *
 *  - La clave es el `userId`; el valor guarda también el `updatedAt` máximo de
 *    las filas leídas, para poder auditar la antigüedad del dato.
 *  - Un guardado o un borrado llama a `invalidateUserAiProfile` en el acto: la
 *    siguiente petición del mismo proceso lee la base. Es la invalidación
 *    exacta que pide el contrato.
 *  - Un perfil VACÍO se cachea solo 5 s. Si el alumno acaba de pegar su primera
 *    clave en otra instancia, no se le puede contestar «te falta la clave»
 *    durante un minuto entero.
 *  - En varias instancias (serverless) la invalidación es local; el TTL de 60 s
 *    acota la ventana. No se cachea nada sensible fuera de memoria.
 *
 * Módulo puro a propósito: no importa Prisma ni el vault, así que lo pueden
 * usar el almacén (para invalidar), las credenciales (para leer/escribir) y la
 * verificación, sin ciclos.
 */

const OWN_TTL_MS = 60_000;
const EMPTY_TTL_MS = 5_000;
/**
 * Tope de cuentas cacheadas. Con más, se van primero las que antes caducan.
 *
 * Sin tope, un proceso longevo acumularía una entrada por alumno que pasara
 * por el chat; y sin barrido, las claves de quien no vuelve se quedarían en
 * memoria para siempre. El barrido se hace al escribir (una vez por lectura
 * fría), no en cada petición.
 */
const MAX_ENTRIES = 2_000;

export interface CachedOwnKeys {
  /** Proveedor → clave en claro. Solo vive en memoria del servidor. */
  keys: ReadonlyMap<string, string>;
  /** `updatedAt` máximo de las filas leídas (epoch ms); 0 si no había filas. */
  updatedAtMs: number;
  /** Orden explícito de proveedores elegido por el alumno. */
  order: string[];
  /** Endpoint propio por proveedor (solo `custom`), ya validado. */
  baseUrls: ReadonlyMap<string, string>;
  /** Instante en que caduca esta entrada. */
  expiresAt: number;
}

const cache = new Map<string, CachedOwnKeys>();

/** La entrada vigente de esta cuenta, o `null` si no hay o ya caducó. */
export function readCachedOwnKeys(userId: string, now = Date.now()): CachedOwnKeys | null {
  const entry = cache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(userId);
    return null;
  }
  return entry;
}

/** Barre caducadas y aplica el tope. Se llama antes de insertar. */
function sweep(now: number): void {
  for (const [id, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(id);
  }
  if (cache.size < MAX_ENTRIES) return;
  const oldest = Array.from(cache.entries())
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    .slice(0, cache.size - MAX_ENTRIES + 1);
  for (const [id] of oldest) cache.delete(id);
}

/** Guarda el perfil leído. `updatedAtMs` es el máximo de las filas. */
export function writeCachedOwnKeys(
  userId: string,
  keys: ReadonlyMap<string, string>,
  updatedAtMs: number,
  now = Date.now(),
  order: string[] = [],
  baseUrls: ReadonlyMap<string, string> = new Map()
): void {
  sweep(now);
  const ttl = keys.size > 0 ? OWN_TTL_MS : EMPTY_TTL_MS;
  cache.set(userId, {
    keys: new Map(keys),
    updatedAtMs,
    order: [...order],
    baseUrls: new Map(baseUrls),
    expiresAt: now + ttl,
  });
}

/**
 * Invalida el perfil de una cuenta. Se llama al guardar y al borrar una clave,
 * para que la siguiente lectura vea el cambio sin esperar al TTL.
 */
export function invalidateUserAiProfile(userId: string): void {
  cache.delete(userId);
}

/** Solo pruebas: deja la caché como recién arrancada. */
export function clearAiProfileCache(): void {
  cache.clear();
}

/** Solo pruebas/diagnóstico: cuántas cuentas hay cacheadas ahora mismo. */
export function aiProfileCacheSize(): number {
  return cache.size;
}

/** Solo pruebas: fuerza el barrido con un reloj dado. */
export function sweepAiProfileCache(now = Date.now()): void {
  sweep(now);
}

/** TTL efectivo de un perfil con claves (expuesto para la documentación). */
export const AI_PROFILE_CACHE_TTL_MS = OWN_TTL_MS;
