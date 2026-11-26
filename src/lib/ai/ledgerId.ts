import { createHmac, randomBytes } from 'node:crypto';

/**
 * Identidad de libro de una clave PROPIA (BYOK).
 *
 * El motor apunta la salud, los enfriamientos y los contadores en mapas
 * indexados por «proveedor#libro». Antes, todas las claves propias usaban el
 * libro `usuario`, así que el 429 del alumno A enfriaba la clave que consultaba
 * el alumno B y sus contadores de uso se sumaban.
 *
 * Aquí se deriva un identificador **estable dentro del proceso** y distinto por
 * cuenta y proveedor:
 *
 *   ledgerId = 'u_' + HMAC-SHA256(SECRETS_KEY_V1, `${userId}:${provider}`)
 *
 * Nunca es reversible sin la clave del vault, no contiene la clave de IA y no
 * se envía al navegador (`AiEngineCard` sigue mostrando `envVar`, que para las
 * claves propias es literalmente `usuario`). Si el proceso no tiene
 * `SECRETS_KEY_V1` —desarrollo sin vault, scripts— se usa una sal aleatoria de
 * módulo: sigue siendo determinista durante toda la vida del proceso, que es
 * todo lo que necesitan los mapas en memoria, y no filtra nada.
 */

/** Sal de respaldo: estable por proceso, no persiste entre reinicios. */
const FALLBACK_SALT = randomBytes(32).toString('hex');

/** Identificador de libro de una clave propia. */
export function accountLedgerId(userId: string, provider: string): string {
  const secret = (process.env.SECRETS_KEY_V1 ?? '').trim() || FALLBACK_SALT;
  const digest = createHmac('sha256', secret)
    .update(`brainup-ledger-v1:${userId}:${provider}`)
    .digest('hex');
  return `u_${digest.slice(0, 16)}`;
}

/** Identificador de libro de una clave de plataforma: su variable de entorno. */
export function platformLedgerId(envVar: string): string {
  return envVar;
}
