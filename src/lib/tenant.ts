/**
 * ¿De quién son los datos que se leen o se escriben?
 *
 * Fase 1 del multiusuario: la base ya está preparada (`userId` en todas las
 * tablas, uniques compuestos), pero la autenticación real —Supabase Auth, una
 * cuenta por alumno— llega en la Fase 2. Mientras tanto, aquí se devuelve la
 * cuenta única que existe hoy. **Este es el único sitio que hay que cambiar**
 * cuando la sesión traiga identidad: el resto del código ya pregunta por ella.
 *
 * Ningún dato se filtra por cuenta todavía: con una sola cuenta no hay nada que
 * separar. En cuanto exista una segunda, toda consulta que no pase por aquí (o
 * que no filtre por `userId`) mezclará alumnos, y las políticas RLS de Supabase
 * no ayudan si Prisma sigue conectando con el rol dueño de la base.
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
