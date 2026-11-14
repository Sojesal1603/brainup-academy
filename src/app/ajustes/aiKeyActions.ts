'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { checkGeminiKey } from '@/lib/ai/geminiKeyCheck';
import { consumeAiKeyAttempt, resetAiKeyAttempts } from '@/lib/ai/keyAttempts';
import {
  AiKeyStoreError,
  deleteUserAiKey,
  markUserAiKeyStatus,
  readDecryptedUserKey,
  saveUserAiKey,
} from '@/lib/ai/userKeyStore';
import type { AiKeyActionResult } from '@/lib/ai/keyStatus';

/**
 * Acciones de la clave de IA del alumno.
 *
 * Tres reglas que no se rompen:
 *   1. El `userId` sale de la sesión, nunca del formulario.
 *   2. La clave no se devuelve, no se registra y no se incluye en un error.
 *   3. Un fallo del vault (falta `SECRETS_KEY_V1`) se explica y no se disfraza
 *      de «no tienes clave».
 */

const saveSchema = z.object({
  provider: z.literal('gemini'),
  key: z
    .string()
    .trim()
    .min(20, 'La clave es demasiado corta para ser una clave de Google.')
    .max(200, 'La clave es demasiado larga.')
    .regex(
      /^[A-Za-z0-9_-]+$/,
      'La clave solo puede tener letras, números, guiones y guiones bajos (sin espacios).'
    ),
});

function storeFailure(error: unknown): AiKeyActionResult {
  if (error instanceof AiKeyStoreError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return {
    ok: false,
    message: 'No se pudo guardar la clave por un fallo del servidor. Inténtalo de nuevo.',
  };
}

export async function saveMyAiKey(formData: FormData): Promise<AiKeyActionResult> {
  const user = await requireUser();

  const limit = await consumeAiKeyAttempt(user.id);
  if (!limit.ok) {
    return {
      ok: false,
      code: 'too_many_attempts',
      retryAfterSeconds: limit.retryAfterSeconds,
      message: `Demasiados intentos seguidos. Espera ${Math.ceil(limit.retryAfterSeconds / 60)} minuto(s) y vuelve a probar.`,
    };
  }

  const parsed = saveSchema.safeParse({
    provider: String(formData.get('provider') ?? ''),
    key: String(formData.get('key') ?? ''),
  });
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'La clave no tiene un formato válido.',
    };
  }

  const check = await checkGeminiKey(parsed.data.key);
  if (!check.persist) {
    return { ok: false, code: 'not_checked', message: check.error ?? 'No se pudo comprobar la clave.' };
  }

  try {
    const summary = await saveUserAiKey({
      userId: user.id,
      provider: parsed.data.provider,
      key: parsed.data.key,
      status: check.status,
      lastError: check.error,
    });
    if (check.status === 'valida') await resetAiKeyAttempts(user.id);
    revalidatePath('/ajustes');
    return {
      ok: true,
      status: summary.status,
      last4: summary.last4,
      message:
        summary.status === 'valida'
          ? 'Clave comprobada y guardada cifrada. Ya se usa en tus peticiones.'
          : summary.status === 'sin_cuota'
            ? 'Clave guardada cifrada. Google dice que ahora no tiene cupo; se reintentará sola.'
            : 'Clave guardada, pero Google la ha rechazado. Revísala o bórrala.',
    };
  } catch (error) {
    console.error('[ai] fallo al guardar la clave:', error instanceof AiKeyStoreError ? error.code : 'error');
    return storeFailure(error);
  }
}

export async function deleteMyAiKey(): Promise<AiKeyActionResult> {
  const user = await requireUser();
  try {
    await deleteUserAiKey(user.id, 'gemini');
    revalidatePath('/ajustes');
    return {
      ok: true,
      message: 'Clave borrada. Las pantallas de IA volverán a pedirte una clave.',
    };
  } catch (error) {
    console.error('[ai] fallo al borrar la clave:', error instanceof Error ? error.name : 'error');
    return {
      ok: false,
      message: 'No se pudo borrar la clave. Inténtalo de nuevo.',
    };
  }
}

export async function recheckMyAiKey(): Promise<AiKeyActionResult> {
  const user = await requireUser();

  const limit = await consumeAiKeyAttempt(user.id);
  if (!limit.ok) {
    return {
      ok: false,
      code: 'too_many_attempts',
      retryAfterSeconds: limit.retryAfterSeconds,
      message: `Demasiados intentos seguidos. Espera ${Math.ceil(limit.retryAfterSeconds / 60)} minuto(s).`,
    };
  }

  let key: string | null;
  try {
    key = await readDecryptedUserKey(user.id, 'gemini');
  } catch (error) {
    return storeFailure(error);
  }
  if (!key) {
    return { ok: false, message: 'No tienes ninguna clave guardada que comprobar.' };
  }

  const check = await checkGeminiKey(key);
  if (!check.persist) {
    return { ok: false, code: 'not_checked', message: check.error ?? 'No se pudo comprobar la clave.' };
  }

  try {
    await markUserAiKeyStatus({
      userId: user.id,
      provider: 'gemini',
      status: check.status,
      lastError: check.error,
    });
    if (check.status === 'valida') await resetAiKeyAttempts(user.id);
    revalidatePath('/ajustes');
    return {
      ok: true,
      status: check.status,
      message: check.error ?? 'Clave comprobada: Google la acepta.',
    };
  } catch (error) {
    return storeFailure(error);
  }
}
