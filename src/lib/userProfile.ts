import type { Prisma } from '@prisma/client';
import { cache } from 'react';
import { unstable_cache, updateTag } from 'next/cache';
import { prisma } from './prisma';
import { db } from './db';

/**
 * --- Multiusuario ---
 *
 * `ensureTenantProfile(userId)` es la versión nueva: recibe el UUID de la sesión
 * (el `id` de `requireUser()`) y trabaja siempre a través de `db(userId)`, así
 * que no puede leer ni crear el perfil de otra cuenta. Se llama en el primer
 * acceso del alumno (tras el login de Supabase), no en cada consulta.
 *
 * El resto de funciones de este archivo siguen usando el perfil singleton
 * histórico (`user_default`) mientras las rutas terminan de migrarse. No se
 * usan desde código nuevo.
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

/**
 * El perfil es un singleton (`user_default`), pero **no nace con la migración**:
 * `prisma migrate deploy` deja las tablas vacías y el seed es opcional.
 *
 * Eso hacía que la primera puesta a punto contra una base recién migrada
 * reventara con un `P2025` («Record to update not found») en cuanto el
 * coordinador intentaba guardar las horas, el ritmo o el horario: el perfil no
 * existía. El error llegaba al usuario como «Error inesperado de la puesta a
 * punto», sin decir nada de la causa.
 *
 * Aquí se crea la fila la primera vez que hace falta, sin inventar datos: todos
 * los campos tienen su valor por defecto en el esquema y la puesta a punto los
 * sobrescribe con lo que diga el alumno.
 */
export const DEFAULT_PROFILE_ID = 'user_default';

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
 * Perfil de cabecera cacheado entre peticiones.
 *
 * La cabecera se monta en todas las rutas y no puede consultar la base en cada
 * clic: con el pooler de Supabase en otra región, un `findUnique` puede costar
 * más de dos segundos. Esta lectura es de solo campos ligeros y se invalida con
 * la etiqueta `perfil` desde las acciones que cambian el perfil.
 */
export const getCachedProfileSummary = unstable_cache(
  async (): Promise<ProfileSummary | null> => {
    return prisma.userProfile.findUnique({
      where: { id: DEFAULT_PROFILE_ID },
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
  ['profile-summary-v1'],
  { revalidate: 10, tags: ['perfil'] }
);

/**
 * Devuelve el perfil, creándolo si la base está recién migrada.
 *
 * `cache()` lo memoiza **por petición**: el Header del layout y la página que
 * se está pintando lo piden a la vez, y así la base recibe una sola consulta en
 * vez de dos idénticas. No cachea entre peticiones: si cambias tus ajustes, el
 * siguiente render lo ve al instante.
 *
 * La ruta normal es un `findUnique` y NO un `upsert`: el upsert escribía (o al
 * menos bloqueaba una fila) en cada carga de cada página, y el Header se monta
 * en todas. La escritura solo ocurre la primera vez, cuando la fila no existe.
 */
export const ensureUserProfile = cache(async () => {
  const existing = await prisma.userProfile.findUnique({
    where: { id: DEFAULT_PROFILE_ID },
  });
  if (existing) return existing;

  return prisma.userProfile.upsert({
    where: { id: DEFAULT_PROFILE_ID },
    update: {},
    create: { id: DEFAULT_PROFILE_ID },
  });
});

/**
 * Actualiza el perfil creándolo antes si hace falta.
 *
 * Se usa en todo lo que guarda ajustes del alumno (horas, ritmo, horario,
 * cierre de la puesta a punto…). Nunca puede fallar por «no hay perfil»: la
 * base puede estar recién migrada y el alumno tiene que poder montar su curso
 * igualmente.
 */
export async function updateDefaultProfile(data: Prisma.UserProfileUpdateInput) {
  await ensureUserProfile();
  const updated = await prisma.userProfile.update({
    where: { id: DEFAULT_PROFILE_ID },
    data,
  });
  // La cabecera y el Cuartel leen esta foto cacheada: que el cambio se vea ya.
  updateTag('perfil');
  return updated;
}
