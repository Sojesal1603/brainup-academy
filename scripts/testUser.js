/**
 * El UUID de la cuenta con la que corren los verificadores.
 *
 * Nunca se usa `user_default`: se toma de `BRAINUP_USER_ID` o, mientras solo
 * exista una cuenta, del único perfil de la base.
 */
const { PrismaClient } = require('@prisma/client');

let cached = null;

async function getTestUserId() {
  if (cached) return cached;

  const fromEnv = process.env.BRAINUP_USER_ID?.trim();
  if (fromEnv) {
    cached = fromEnv;
    return cached;
  }

  const prisma = new PrismaClient();
  try {
    const profiles = await prisma.userProfile.findMany({ select: { id: true }, take: 2 });
    if (profiles.length !== 1) {
      throw new Error(
        'No se puede resolver el usuario de prueba: define BRAINUP_USER_ID o deja un único UserProfile.'
      );
    }
    cached = profiles[0].id;
    return cached;
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { getTestUserId };
