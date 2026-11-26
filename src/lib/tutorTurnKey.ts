import { createHash } from 'node:crypto';

/**
 * Id determinista de una fila del turno del catedrático.
 *
 * El navegador genera una `clientKey` por turno y la reutiliza en los
 * reintentos. El servidor deriva de ella el id del mensaje del alumno y el de
 * la respuesta: un reintento tras perder la conexión cae en las MISMAS filas en
 * vez de duplicar el turno.
 *
 * El hash incluye el `userId` (dos alumnos con la misma clave no chocan) y la
 * parte (`user`/`reply`), pero no la clave en claro: el id no revela nada.
 */
export function turnRowId(userId: string, clientKey: string, part: 'user' | 'reply'): string {
  const hash = createHash('sha256')
    .update(`brainup-turn-v1:${userId}:${part}:${clientKey}`)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** ¿Tiene forma de UUID la clave derivada? (Prisma la acepta como id). */
export function isTurnRowId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
