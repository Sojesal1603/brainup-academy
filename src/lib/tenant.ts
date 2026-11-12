/**
 * ¿De quién son los datos que se leen o se escriben?
 *
 * ⚠️ LEGADO. La identidad nueva es `requireUser()` (`src/lib/auth.ts`) y el
 * acceso a datos es `db(userId)` (`src/lib/db.ts`). Esta función solo existe
 * para las rutas que todavía no se han migrado (memoria de la IA y Moodle);
 * devuelve la cuenta histórica `user_default` y **no se puede usar en código
 * nuevo**.
 *
 * Por qué no se cambia aquí y ya está: estas consultas no tienen sesión que
 * leer en su contexto (las llama el vigilante y rutas antiguas), y devolver un
 * UUID inventado mezclaría los datos de la cuenta histórica con los de un
 * alumno real. La migración correcta es pasar el `userId` desde la ruta que sí
 * tiene `requireUser()` y sustituir estas llamadas por `db(userId)`.
 */
export const SINGLE_USER_ID = 'user_default';

/**
 * Id del dueño de la fila.
 *
 * En la Fase 2 leerá la sesión firmada (`sub` de Supabase Auth) y devolverá ese
 * id; hoy devuelve la cuenta única. Es una función, no una constante, para que
 * el cambio no obligue a tocar cada llamada.
 */
export function currentUserId(): string {
  return SINGLE_USER_ID;
}
