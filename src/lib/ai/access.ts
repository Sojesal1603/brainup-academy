import { NextResponse } from 'next/server';
import {
  AiKeyRequiredError,
  enterAiCredentialsForRequest,
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

export { enterAiCredentialsForRequest };

/**
 * Deja las credenciales activas o devuelve la respuesta 402 lista para enviar.
 *
 * Es la primera línea de una ruta de IA: si el usuario no tiene clave (y no es
 * de plataforma), la petición muere aquí y no se llega a construir ni un
 * cliente de IA. Un fallo que no sea de credenciales se propaga.
 */
export async function ensureAiAccess(userId: string): Promise<NextResponse | null> {
  try {
    await enterAiCredentialsForRequest(userId);
    return null;
  } catch (error) {
    const denied = aiKeyRequiredResponse(error);
    if (denied) return denied;
    if (error instanceof AiKeyStoreError) return aiKeyStoreErrorResponse(error);
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
