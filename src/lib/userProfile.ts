import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { db } from './db';

/**
 * --- Multiusuario ---
 *
 * `ensureTenantProfile(userId)` es la versión nueva: recibe el UUID de la sesión
 * (el `id` de `requireUser()`) y trabaja siempre a través de `db(userId)`, así
 * que no puede leer ni crear el perfil de otra cuenta. Se llama en el primer
 * acceso del alumno (tras el login de Supabase), no en cada consulta.
 *
 * Todas las funciones de este archivo reciben el UUID de la sesión.
 */

export interface TenantProfileSummary extends ProfileSummary {
  timezone: string;
}

/**
 * Perfil del alumno autenticado, creado si es su primer acceso.
 *
 * El `upsert` no duplica: `db(userId)` acota el `where` y el `create` al UUID
 * de la sesión. La lectura previa evita escribir en cada visita (el perfil se
 * pide en el layout y en el Cuartel).
 */
export async function ensureTenantProfile(userId: string) {
  const scoped = db(userId);
  const existing = await scoped.userProfile.findUnique({ where: { id: userId } });
  if (existing) return existing;

  return scoped.userProfile.upsert({
    where: { id: userId },
    update: {},
    create: {},
  });
}

/** Datos ligeros del alumno autenticado (sin fechas ni credenciales). */
export async function getTenantProfileSummary(userId: string): Promise<TenantProfileSummary | null> {
  return db(userId).userProfile.findUnique({
    where: { id: userId },
    select: {
      name: true,
      modality: true,
      targetGradePau: true,
      studyMode: true,
      streakCurrent: true,
      challengeXp: true,
      timezone: true,
    },
  });
}

/** Campos que necesitan la cabecera y el Cuartel, sin fechas ni datos pesados. */
export interface ProfileSummary {
  name: string;
  modality: string;
  targetGradePau: number;
  studyMode: string;
  streakCurrent: number;
  challengeXp: number;
}

/**
 * Perfil de cabecera cacheado entre peticiones, por cuenta.
 *
 * La cabecera se monta en todas las rutas y no puede consultar la base en cada
 * clic: con el pooler de Supabase en otra región, un `findUnique` puede costar
 * más de dos segundos. Esta lectura es de solo campos ligeros y se invalida con
 * la etiqueta `perfil` desde las acciones que cambian el perfil.
 */
const loadCachedProfileSummary = unstable_cache(
  async (userId: string): Promise<ProfileSummary | null> => {
    return db(userId).userProfile.findUnique({
      where: { id: userId },
      select: {
        name: true,
        modality: true,
        targetGradePau: true,
        studyMode: true,
        streakCurrent: true,
        challengeXp: true,
      },
    });
  },
  ['profile-summary-v2'],
  { revalidate: 10, tags: ['perfil'] }
);

export function getCachedProfileSummary(userId: string) {
  return loadCachedProfileSummary(userId);
}

/**
 * Devuelve el perfil de la cuenta, creándolo si la base está recién migrada.
 *
 * `cache()` lo memoiza **por petición**: el Header del layout y la página que
 * se está pintando lo piden a la vez, y así la base recibe una sola consulta en
 * vez de dos idénticas. No cachea entre peticiones: si cambias tus ajustes, el
 * siguiente render lo ve al instante.
 */
export const ensureUserProfile = cache(async (userId: string) => {
  const existing = await db(userId).userProfile.findUnique({ where: { id: userId } });
  if (existing) return existing;

  return db(userId).userProfile.upsert({
    where: { id: userId },
    update: {},
    create: {},
  });
});
