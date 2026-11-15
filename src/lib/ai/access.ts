import { NextResponse } from 'next/server';
import {
  AiKeyRequiredError,
  resolveAllAiCredentials,
  runWithAiCredentials,
  type AiCredential,
} from './credentials';
import { AiKeyStoreError } from './userKeyErrors';

/**
 * La puerta de las rutas de IA.
 *
 * No hay ninguna ruta que llame al motor sin pasar por aquí: o el usuario tiene
 * su clave, o está en `PLATFORM_AI_USER_IDS`, o recibe 402 con el código
 * `ai_key_required`. El motor nunca lee la clave de plataforma por su cuenta.
 */

export { activateAiCredentials } from './credentials';

/**
 * Lo que devuelve la puerta: o una respuesta para enviar, o las credenciales
 * que la ruta debe activar en SU propio marco.
 */
export interface AiAccess {
  /** Respuesta 402/503 si no se puede usar la IA; `null` si todo está bien. */
  denied: NextResponse | null;
  /** Credenciales del usuario, ya resueltas. Vacías si `denied` no es `null`. */
  credentials: readonly AiCredential[];
}

/**
 * Resuelve las credenciales de la ruta (402 si no hay, 503 si el vault falla).
 *
 * NO activa el ámbito: eso lo hace `activateAiCredentials` en la ruta. Es
 * deliberado —`enterWith` desde otra función no llega al llamante— y es
 * exactamente el fallo que dejaba al catedrático sin motor teniendo clave.
 *
 * La forma de usarla, en la primera línea de una ruta de IA:
 *
 * ```ts
 * const ai = await ensureAiAccess(user.id);
 * if (ai.denied) return ai.denied;
 * activateAiCredentials(ai.credentials);
 * ```
 */
export async function ensureAiAccess(userId: string): Promise<AiAccess> {
  try {
    const credentials = await resolveAllAiCredentials(userId);
    if (credentials.length === 0) throw new AiKeyRequiredError();
    return { denied: null, credentials };
  } catch (error) {
    const denied = aiKeyRequiredResponse(error);
    if (denied) return { denied, credentials: [] };
    if (error instanceof AiKeyStoreError) {
      return { denied: aiKeyStoreErrorResponse(error), credentials: [] };
    }
    throw error;
  }
}

/** Resuelve las credenciales y ejecuta el trabajo dentro del ámbito de la petición. */
export async function withAiAccess<T>(userId: string, work: () => Promise<T>): Promise<T> {
  const credentials = await resolveAllAiCredentials(userId);
  if (credentials.length === 0) throw new AiKeyRequiredError();
  return runWithAiCredentials(credentials, work);
}

/** Respuesta 402 uniforme, o `null` si el error es de otro tipo. */
export function aiKeyRequiredResponse(error: unknown): NextResponse | null {
  if (!(error instanceof AiKeyRequiredError)) return null;
  return NextResponse.json(
    {
      ok: false,
      code: error.code,
      error: error.message,
      /** La interfaz enseña el botón «Añadir mi clave» con esto. */
      action: 'settings_ai_key',
    },
    { status: error.status, headers: { 'Cache-Control': 'no-store' } }
  );
}

/** Fallo del almacén cifrado: se explica y no se finge que falta la clave. */
export function aiKeyStoreErrorResponse(error: AiKeyStoreError): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      code: error.code,
      error: error.message,
      action: 'settings_ai_key',
    },
    { status: error.status, headers: { 'Cache-Control': 'no-store' } }
  );
}

/** Credenciales del usuario, sin lanzar (para pantallas de estado). */
export async function aiCredentialsForStatus(userId: string): Promise<AiCredential[]> {
  return resolveAllAiCredentials(userId, { tolerateVaultErrors: true });
}
