import type { Prisma } from '@prisma/client';
import { cache } from 'react';
import { prisma } from './prisma';

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

/**
 * Devuelve el perfil, creándolo si la base está recién migrada.
 *
 * `cache()` lo memoiza **por petición**: el Header del layout y la página que
 * se está pintando lo piden a la vez, y así la base recibe una sola consulta en
 * vez de dos idénticas. No cachea entre peticiones: si cambias tus ajustes, el
 * siguiente render lo ve al instante.
 */
export const ensureUserProfile = cache(async () => {
  return prisma.userProfile.upsert({
    where: { id: DEFAULT_PROFILE_ID },
    // Si ya existe no se toca nada: es un «find or create» atómico.
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
  return prisma.userProfile.update({
    where: { id: DEFAULT_PROFILE_ID },
    data,
  });
}
