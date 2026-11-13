/**
 * Cómo se entra en Moodle: por clave de Web Services o por sesión web.
 *
 * Hay dos puertas y no siempre se puede usar la buena. La clave de Web Services
 * es la limpia (no hace falta la contraseña), pero el centro tiene que permitir
 * crearla al alumnado, y muchos no lo permiten. La otra puerta es entrar como el
 * navegador, con el usuario y la contraseña de siempre: eso funciona en cualquier
 * Moodle con formulario de acceso, a cambio de quedarse con la contraseña.
 *
 * Aquí vive esa decisión: qué vía está elegida, y la contraseña **cifrada** con
 * la clave local del equipo (`localSecrets.ts`) para que la app pueda reconectar
 * sola cada mañana sin pedirle nada al alumno. En claro no se guarda nunca.
 */

import { db } from './db';
import { normalizeMoodleBaseUrl } from './moodleWs';
import { canSealSecrets, openSecret, sealSecret } from './localSecrets';

export type MoodleAuthMode = 'token' | 'sesion';

export interface MoodleSessionAuth {
  baseUrl: string;
  username: string;
  password: string;
}

export interface MoodleCredentialState {
  mode: MoodleAuthMode;
  username: string | null;
  /** Hay contraseña guardada y este equipo puede leerla. */
  passwordSaved: boolean;
  /** ¿Se puede cifrar en este equipo? Si no, no se guarda la contraseña. */
  canSeal: boolean;
}

function modeOf(value: string | null | undefined): MoodleAuthMode {
  return value === 'sesion' ? 'sesion' : 'token';
}

/** La vía elegida ahora mismo. */
export async function getMoodleAuthMode(userId: string): Promise<MoodleAuthMode> {
  const user = await db(userId).userProfile.findUnique({
    where: { id: userId },
    select: { moodleAuthMode: true },
  });
  return modeOf(user?.moodleAuthMode);
}

/** Estado de las credenciales para pintarlo en Ajustes (sin la contraseña). */
export async function getMoodleCredentialState(userId: string): Promise<MoodleCredentialState> {
  const user = await db(userId).userProfile.findUnique({
    where: { id: userId },
    select: { moodleAuthMode: true, moodleUsername: true, moodlePasswordSealed: true },
  });

  return {
    mode: modeOf(user?.moodleAuthMode),
    username: (user?.moodleUsername ?? '').trim() || null,
    passwordSaved: openSecret(user?.moodlePasswordSealed) !== null,
    canSeal: canSealSecrets(),
  };
}

/**
 * Las credenciales de la vía de sesión, listas para entrar. Devuelve `null` si
 * falta algo (dirección, usuario o contraseña legible): en ese caso hay que
 * volver a conectarlo a mano, y eso la app lo dice.
 */
export async function getMoodleSessionAuth(userId: string): Promise<MoodleSessionAuth | null> {
  const user = await db(userId).userProfile.findUnique({
    where: { id: userId },
    select: { moodleBaseUrl: true, moodleUsername: true, moodlePasswordSealed: true },
  });

  const baseUrl = normalizeMoodleBaseUrl(user?.moodleBaseUrl ?? '');
  const username = (user?.moodleUsername ?? '').trim();
  const password = openSecret(user?.moodlePasswordSealed);

  if (!baseUrl || !username || !password) return null;
  return { baseUrl, username, password };
}

/**
 * Guarda la vía de sesión: el sitio, el usuario y —si el alumno lo permite— la
 * contraseña cifrada. Con `seal: false` no se guarda nada de la contraseña: la
 * app entra y sincroniza, pero mañana volverá a pedirla.
 */
export async function saveMoodleSessionAuth(userId: string, params: {
  baseUrl: string;
  username: string;
  password: string;
  siteName?: string | null;
  userId?: number | null;
  seal: boolean;
}): Promise<void> {
  const baseUrl = normalizeMoodleBaseUrl(params.baseUrl);
  if (!baseUrl) return;

  await db(userId).userProfile.update({
    where: { id: userId },
    data: {
      moodleBaseUrl: baseUrl,
      moodleAuthMode: 'sesion',
      moodleUsername: params.username.trim().slice(0, 120),
      moodlePasswordSealed: params.seal ? sealSecret(params.password) : null,
      moodleSiteName: params.siteName ?? undefined,
      moodleUserId: typeof params.userId === 'number' ? params.userId : undefined,
      moodleSessionAt: new Date(),
      // Acaba de entrar de verdad: la comprobación está hecha.
      moodleTokenState: 'ok',
      moodleCheckedAt: new Date(),
    },
  });
}

/** Borra la contraseña guardada (el resto de la conexión se queda). */
export async function forgetMoodleSessionPassword(userId: string): Promise<void> {
  await db(userId).userProfile.update({
    where: { id: userId },
    data: { moodlePasswordSealed: null },
  });
}
