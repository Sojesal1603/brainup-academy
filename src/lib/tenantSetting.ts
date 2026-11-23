/**
 * Nombre del ajuste de PostgreSQL que identifica a la cuenta dueña de la
 * transacción.
 *
 * Vive en su propio módulo porque lo usan las dos puertas a la base: el cliente
 * acotado (`db.ts`) y `withTransaction` (`prisma.ts`). Si cada uno tuviera su
 * propia cadena, un cambio de nombre en uno dejaría al otro fijando un ajuste
 * que las políticas RLS ya no miran —y el aislamiento caería en silencio—.
 */
export const TENANT_SETTING = 'app.user_id';
