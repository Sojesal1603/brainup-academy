import { prisma } from './prisma';

/**
 * El userId de los procesos que corren sin una petición de usuario (el
 * vigilante, los scripts de verificación). En la app todo sale de la sesión;
 * aquí se admite `BRAINUP_USER_ID` o, mientras solo exista una cuenta, el
 * único perfil de la base. Nunca se usa `user_default`.
 */
export async function resolveBackgroundUserId(): Promise<string> {
  const fromEnv = process.env.BRAINUP_USER_ID?.trim();
  if (fromEnv) return fromEnv;

  const profiles = await prisma.userProfile.findMany({
    select: { id: true },
    take: 2,
  });

  if (profiles.length !== 1) {
    throw new Error(
      'No se puede resolver el usuario de fondo: define BRAINUP_USER_ID o deja un único UserProfile.'
    );
  }

  return profiles[0].id;
}
