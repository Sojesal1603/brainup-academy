import { PrismaClient } from '@prisma/client';
import { resolveDatabaseUrl } from './databaseDiagnostics';

/**
 * El cliente de Prisma, uno solo por proceso.
 *
 * En Netlify cada función serverless levanta su propia instancia: reutilizar el
 * cliente entre peticiones de la misma instancia evita abrir una conexión nueva
 * por cada render (con el pooler de Supabase, eso es la diferencia entre
 * funcionar y agotar el cupo del plan gratuito).
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * La URL ya normalizada para serverless (TLS y pooler). La normalización vive en
 * `databaseDiagnostics.ts` para poder usarla en `/api/salud` y `/diagnostico`
 * sin cargar el motor de Prisma.
 */
const databaseUrl = resolveDatabaseUrl();

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    ...(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {}),
  });

globalForPrisma.prisma = prisma;
