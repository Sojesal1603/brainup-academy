'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { checkProviderKey } from '@/lib/ai/providerKeyCheck';
import { consumeAiKeyAttempt, resetAiKeyAttempts } from '@/lib/ai/keyAttempts';
import {
  AiKeyStoreError,
  deleteUserAiKey,
  markUserAiKeyStatus,
  readDecryptedUserKey,
  readUserAiKeyBaseUrl,
  saveUserAiKey,
} from '@/lib/ai/userKeyStore';
import { saveProviderOrder, sanitizeProviderOrder } from '@/lib/ai/providerOrder';
import {
  getProviderDescriptor,
  normalizeProviderBaseUrl,
} from '@/lib/ai/providers';
import type { AiKeyActionResult } from '@/lib/ai/keyStatus';
import {
  USER_KEY_PROVIDER_LABEL,
  normalizeUserKeyProvider,
  providerKeyFormatError,
  type UserKeyProvider,
} from '@/lib/ai/keyFormat';

/**
 * Acciones de las claves de IA del alumno (Gemini, Groq, OpenRouter, NVIDIA).
 *
 * Cuatro reglas que no se rompen:
 *   1. El `userId` sale de la sesión, nunca del formulario.
 *   2. El proveedor se normaliza aquí; un valor raro no llega al almacén.
 *   3. La clave no se devuelve, no se registra y no se incluye en un error.
 *   4. Un fallo del vault (falta `SECRETS_KEY_V1`) se explica y no se disfraza
 *      de «no tienes clave».
 *
 * El AAD del sobre incluye `userId:provider`, así que la clave de un proveedor
 * no se puede descifrar como la de otro aunque se copie la fila.
 */

const saveSchema = z.object({
  provider: z.string(),
  key: z.string().trim().min(1, 'Escribe la clave.').max(200, 'La clave es demasiado larga.'),
  baseUrl: z.string().trim().max(300).optional(),
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

/** Resuelve el proveedor del formulario o devuelve el error para la tarjeta. */
function readProvider(
  raw: unknown
): { ok: true; provider: UserKeyProvider } | { ok: false; message: string } {
  const provider = normalizeUserKeyProvider(String(raw ?? ''));
  if (!provider) {
    return { ok: false, message: 'Ese proveedor de IA no está soportado.' };
  }
  return { ok: true, provider };
}

export async function saveMyAiKey(formData: FormData): Promise<AiKeyActionResult> {
  const user = await requireUser();

  const parsed = saveSchema.safeParse({
    provider: String(formData.get('provider') ?? ''),
    key: String(formData.get('key') ?? ''),
    baseUrl: String(formData.get('baseUrl') ?? ''),
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'La clave no es válida.' };
  }

  const read = readProvider(parsed.data.provider);
  if (!read.ok) return { ok: false, message: read.message };
  const provider = read.provider;
  const label = USER_KEY_PROVIDER_LABEL[provider];

  const formatError = providerKeyFormatError(provider, parsed.data.key);
  if (formatError) return { ok: false, message: formatError };

  // Un endpoint propio se valida ANTES de la red: HTTPS público, sin
  // credenciales en la URL y sin direcciones privadas (SSRF).
  const descriptor = getProviderDescriptor(provider);
  let baseUrl: string | null = null;
  if (descriptor?.requiresBaseUrl) {
    const normalized = normalizeProviderBaseUrl(parsed.data.baseUrl ?? '');
    if (!normalized.ok) return { ok: false, message: normalized.message };
    baseUrl = normalized.url;
  }

  // Se gasta un intento solo cuando la petición va a salir a la red: un error
  // de formato no debe consumir el cupo de comprobaciones.
  const limit = await consumeAiKeyAttempt(user.id);
  if (!limit.ok) {
    return {
      ok: false,
      code: 'too_many_attempts',
      retryAfterSeconds: limit.retryAfterSeconds,
      message: `Demasiados intentos seguidos. Espera ${Math.ceil(limit.retryAfterSeconds / 60)} minuto(s) y vuelve a probar.`,
    };
  }

  const check = await checkProviderKey(provider, parsed.data.key, { baseUrl: baseUrl ?? undefined });
  if (!check.persist) {
    return { ok: false, code: 'not_checked', message: check.error ?? 'No se pudo comprobar la clave.' };
  }

  try {
    const summary = await saveUserAiKey({
      userId: user.id,
      provider,
      key: parsed.data.key,
      status: check.status,
      lastError: check.error,
      baseUrl,
    });
    if (check.status === 'valida') await resetAiKeyAttempts(user.id);
    revalidatePath('/ajustes');
    return {
      ok: true,
      provider,
      status: summary.status,
      last4: summary.last4,
      message:
        summary.status === 'valida'
          ? `Clave de ${label} comprobada y guardada cifrada. Ya se usa en tus peticiones.`
          : summary.status === 'sin_cuota'
            ? `Clave de ${label} guardada cifrada. El proveedor dice que ahora no tiene cupo; se reintentará sola.`
            : `Clave de ${label} guardada, pero el proveedor la ha rechazado. Revísala o bórrala.`,
    };
  } catch (error) {
    console.error('[ai] fallo al guardar la clave:', error instanceof AiKeyStoreError ? error.code : 'error');
    return storeFailure(error);
  }
}

export async function deleteMyAiKey(providerRaw: string): Promise<AiKeyActionResult> {
  const user = await requireUser();
  const read = readProvider(providerRaw);
  if (!read.ok) return { ok: false, message: read.message };
  const provider = read.provider;
  try {
    await deleteUserAiKey(user.id, provider);
    revalidatePath('/ajustes');
    return {
      ok: true,
      provider,
      message: `Clave de ${USER_KEY_PROVIDER_LABEL[provider]} borrada. Las pantallas de IA volverán a pedirte una clave para ese proveedor.`,
    };
  } catch (error) {
    console.error('[ai] fallo al borrar la clave:', error instanceof Error ? error.name : 'error');
    return { ok: false, provider, message: 'No se pudo borrar la clave. Inténtalo de nuevo.' };
  }
}

export async function saveMyProviderOrder(order: string[]): Promise<AiKeyActionResult> {
  const user = await requireUser();
  const clean = sanitizeProviderOrder(order);
  try {
    await saveProviderOrder(user.id, clean);
    revalidatePath('/ajustes');
    return {
      ok: true,
      message:
        clean.length > 0
          ? 'Orden de proveedores guardado. El próximo turno usará primero tu primera elección.'
          : 'Orden restablecido al del catálogo.',
    };
  } catch (error) {
    console.error('[ai] no se pudo guardar el orden de proveedores:', error instanceof Error ? error.message : 'error');
    return { ok: false, message: 'No se pudo guardar el orden de proveedores. Inténtalo de nuevo.' };
  }
}

export async function recheckMyAiKey(providerRaw: string): Promise<AiKeyActionResult> {
  const user = await requireUser();
  const read = readProvider(providerRaw);
  if (!read.ok) return { ok: false, message: read.message };
  const provider = read.provider;
  const label = USER_KEY_PROVIDER_LABEL[provider];

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
    key = await readDecryptedUserKey(user.id, provider);
  } catch (error) {
    return storeFailure(error);
  }
  if (!key) {
    return { ok: false, provider, message: `No tienes ninguna clave de ${label} guardada que comprobar.` };
  }

  const storedBaseUrl = getProviderDescriptor(provider)?.requiresBaseUrl
    ? await readUserAiKeyBaseUrl(user.id, provider)
    : null;
  const check = await checkProviderKey(provider, key, { baseUrl: storedBaseUrl ?? undefined });
  if (!check.persist) {
    return { ok: false, code: 'not_checked', provider, message: check.error ?? 'No se pudo comprobar la clave.' };
  }

  try {
    await markUserAiKeyStatus({
      userId: user.id,
      provider,
      status: check.status,
      lastError: check.error,
    });
    if (check.status === 'valida') await resetAiKeyAttempts(user.id);
    revalidatePath('/ajustes');
    return {
      ok: true,
      provider,
      status: check.status,
      message: check.error ?? `Clave de ${label} comprobada: el proveedor la acepta.`,
    };
  } catch (error) {
    return storeFailure(error);
  }
}
