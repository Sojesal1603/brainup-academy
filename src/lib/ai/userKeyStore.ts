import { db } from '../db';
import { decryptSecret, encryptSecret, VaultError } from '../security/vault';
import type { UserAiKeyStatus } from './keyStatus';
import { AiKeyStoreError } from './userKeyErrors';

export { AiKeyStoreError } from './userKeyErrors';

/**
 * Almacén de la clave de IA propia de cada usuario.
 *
 * La tabla solo guarda el sobre cifrado; la clave en claro no toca la base, ni
 * los logs, ni la respuesta de una ruta. `userId` es el AAD del vault: copiar
 * una fila a otra cuenta no sirve para descifrarla.
 *
 * `AiKeyStoreError` es un fallo de infraestructura, no «falta la clave»: la
 * pantalla lo enseña como «no se pudo leer tu clave» y pide revisar
 * `SECRETS_KEY_V1`, en vez de mentir diciendo que el alumno no tiene ninguna.
 */

export type { UserAiKeyStatus } from './keyStatus';

export interface UserAiKeySummary {
  provider: string;
  status: UserAiKeyStatus;
  /** Solo los cuatro últimos caracteres; nunca la clave. */
  last4: string;
  lastCheckedAt: string | null;
  lastError: string | null;
}


function isStatus(value: string): value is UserAiKeyStatus {
  return ['sin_comprobar', 'valida', 'invalida', 'sin_cuota'].includes(value);
}

/** La clave descifrada, o `null` si el usuario no tiene ninguna guardada. */
export async function readDecryptedUserKey(
  userId: string,
  provider: string
): Promise<string | null> {
  const row = await db(userId).userAiKey.findUnique({
    where: { userId_provider: { userId, provider } },
    select: { ciphertext: true },
  });
  if (!row) return null;

  try {
    return decryptSecret(row.ciphertext, userId);
  } catch (error) {
    // Solo el código: el mensaje del vault ya está saneado, pero el de OpenSSL
    // podría nombrar detalles internos. Nunca se registra la fila ni el AAD.
    console.error(
      '[ai] no se pudo descifrar la clave guardada:',
      error instanceof VaultError ? error.code : 'error desconocido'
    );
    throw new AiKeyStoreError();
  }
}

/** Cifra y guarda (o reemplaza) la clave de un proveedor. */
export async function saveUserAiKey(input: {
  userId: string;
  provider: string;
  key: string;
  status: UserAiKeyStatus;
  lastError: string | null;
}): Promise<UserAiKeySummary> {
  let ciphertext: string;
  try {
    ciphertext = encryptSecret(input.key, input.userId);
  } catch (error) {
    console.error(
      '[ai] no se pudo cifrar la clave:',
      error instanceof VaultError ? error.code : 'error desconocido'
    );
    throw new AiKeyStoreError(
      'No se pudo cifrar tu clave: falta SECRETS_KEY_V1 o no mide 32 bytes en base64. La clave no se ha guardado.'
    );
  }

  const last4 = input.key.slice(-4);
  const checkedAt = new Date();

  await db(input.userId).userAiKey.upsert({
    where: { userId_provider: { userId: input.userId, provider: input.provider } },
    create: {
      // `db()` vuelve a inyectarlo y rechaza cualquier otro dueño; se pasa aquí
      // para que Prisma use la forma «unchecked» y el tipo no exija la relación.
      userId: input.userId,
      provider: input.provider,
      ciphertext,
      last4,
      status: input.status,
      lastCheckedAt: checkedAt,
      lastError: input.lastError,
    },
    update: {
      ciphertext,
      last4,
      status: input.status,
      lastCheckedAt: checkedAt,
      lastError: input.lastError,
    },
  });

  return {
    provider: input.provider,
    status: input.status,
    last4,
    lastCheckedAt: checkedAt.toISOString(),
    lastError: input.lastError,
  };
}

/** Cambia solo el estado comprobado, sin volver a pedir la clave en claro. */
export async function markUserAiKeyStatus(input: {
  userId: string;
  provider: string;
  status: UserAiKeyStatus;
  lastError: string | null;
}): Promise<void> {
  await db(input.userId).userAiKey.update({
    where: { userId_provider: { userId: input.userId, provider: input.provider } },
    data: {
      status: input.status,
      lastCheckedAt: new Date(),
      lastError: input.lastError,
    },
  });
}

/** Borra la clave del usuario. Idempotente: si no había, no pasa nada. */
export async function deleteUserAiKey(userId: string, provider: string): Promise<void> {
  await db(userId).userAiKey.deleteMany({ where: { provider } });
}

/** Estado visible en Ajustes y en `/api/ia/mi-clave`; nunca incluye el sobre. */
export async function readUserAiKeySummary(
  userId: string,
  provider: string
): Promise<UserAiKeySummary | null> {
  const row = await db(userId).userAiKey.findUnique({
    where: { userId_provider: { userId, provider } },
    select: {
      provider: true,
      status: true,
      last4: true,
      lastCheckedAt: true,
      lastError: true,
    },
  });
  if (!row) return null;

  return {
    provider: row.provider,
    status: isStatus(row.status) ? row.status : 'sin_comprobar',
    last4: row.last4,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    lastError: row.lastError,
  };
}
