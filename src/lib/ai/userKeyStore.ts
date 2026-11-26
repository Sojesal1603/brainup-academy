import { db } from '../db';
import { decryptSecret, encryptSecret, VaultError } from '../security/vault';
import type { UserAiKeyStatus } from './keyStatus';
import { invalidateUserAiProfile } from './profileCache';
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


/**
 * Contexto (AAD) de una clave: cuenta **y** proveedor.
 *
 * Antes solo era el userId. Ahora una fila de Gemini copiada a la de Groq
 * tampoco descifra: el proveedor forma parte del sobre. El formato es estable y
 * se usa también en el camino de compatibilidad de las claves ya guardadas.
 */
export function userAiKeyAad(userId: string, provider: string): string {
  return `${userId}:${provider}`;
}

function isStatus(value: string): value is UserAiKeyStatus {
  return ['sin_comprobar', 'valida', 'invalida', 'sin_cuota'].includes(value);
}

/**
 * Descifra UNA fila, con el camino de compatibilidad para los sobres creados
 * antes de que el proveedor entrara en el AAD.
 */
async function decryptRow(userId: string, provider: string, ciphertext: string): Promise<string> {
  try {
    return decryptSecret(ciphertext, userAiKeyAad(userId, provider));
  } catch (error) {
    // No se pierde ninguna clave: si el sobre viejo abre, se vuelve a cifrar con
    // el contexto nuevo en la misma lectura.
    try {
      const legacy = decryptSecret(ciphertext, userId);
      const reencrypted = encryptSecret(legacy, userAiKeyAad(userId, provider));
      await db(userId).userAiKey.update({
        where: { userId_provider: { userId, provider } },
        data: { ciphertext: reencrypted },
      });
      return legacy;
    } catch {
      // Solo el código: el mensaje del vault ya está saneado, pero el de OpenSSL
      // podría nombrar detalles internos. Nunca se registra la fila ni el AAD.
      console.error(
        '[ai] no se pudo descifrar la clave guardada:',
        error instanceof VaultError ? error.code : 'error desconocido'
      );
      throw new AiKeyStoreError();
    }
  }
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
  return decryptRow(userId, provider, row.ciphertext);
}

/** Resultado de leer todas las claves propias de una cuenta de una vez. */
export interface DecryptedUserAiKeys {
  /** Proveedor → clave en claro. Solo en memoria del servidor. */
  keys: Map<string, string>;
  /** `updatedAt` máximo de las filas leídas (epoch ms); 0 si no hay ninguna. */
  updatedAtMs: number;
  /** Proveedores cuyo sobre no se pudo abrir en modo tolerante. */
  failedProviders: string[];
  /** Endpoint propio por proveedor (solo `custom`), si está guardado. */
  baseUrls: Map<string, string>;
}

/**
 * Todas las claves propias de una cuenta, en **una** consulta y con los
 * descifrados en paralelo.
 *
 * Antes se hacía un `findUnique` por proveedor y un `await` dentro del bucle:
 * cuatro viajes a la base y cuatro descifrados secuenciales antes de llamar al
 * modelo, en cada turno. Mismo resultado, una sola ida y vuelta.
 *
 * `tolerateErrors` solo lo usan las pantallas de estado: si el vault no puede
 * abrir un sobre, ese proveedor se omite y se anota en `failedProviders` en vez
 * de tumbar la página. Las rutas de IA NO lo usan: allí el fallo es un 503.
 */
export async function readDecryptedUserKeys(
  userId: string,
  options: { tolerateErrors?: boolean } = {}
): Promise<DecryptedUserAiKeys> {
  let rows: Array<{ provider: string; ciphertext: string; updatedAt: Date; baseUrl?: string | null }>;
  try {
    rows = await db(userId).userAiKey.findMany({
      select: { provider: true, ciphertext: true, updatedAt: true, baseUrl: true },
    });
  } catch (error) {
    // Antes de aplicar la migración de la Fase 3 no existe `baseUrl`: las
    // claves normales deben seguir funcionando igual.
    if ((error as { code?: string } | null)?.code !== 'P2022') throw error;
    rows = await db(userId).userAiKey.findMany({
      select: { provider: true, ciphertext: true, updatedAt: true },
    });
  }

  let updatedAtMs = 0;
  for (const row of rows) {
    updatedAtMs = Math.max(updatedAtMs, row.updatedAt.getTime());
  }

  const keys = new Map<string, string>();
  const baseUrls = new Map<string, string>();
  const failedProviders: string[] = [];
  for (const row of rows) {
    if (row.baseUrl) baseUrls.set(row.provider, row.baseUrl);
  }
  await Promise.all(
    rows.map(async (row) => {
      try {
        keys.set(row.provider, await decryptRow(userId, row.provider, row.ciphertext));
      } catch (error) {
        if (options.tolerateErrors && error instanceof AiKeyStoreError) {
          failedProviders.push(row.provider);
          return;
        }
        throw error;
      }
    })
  );

  return { keys, updatedAtMs, failedProviders, baseUrls };
}

/** Cifra y guarda (o reemplaza) la clave de un proveedor. */
export async function saveUserAiKey(input: {
  userId: string;
  provider: string;
  key: string;
  status: UserAiKeyStatus;
  lastError: string | null;
  /** Solo para endpoints compatibles OpenAI; ya validado por la acción. */
  baseUrl?: string | null;
}): Promise<UserAiKeySummary> {
  let ciphertext: string;
  try {
    ciphertext = encryptSecret(input.key, userAiKeyAad(input.userId, input.provider));
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
      baseUrl: input.baseUrl ?? null,
    },
    update: {
      ciphertext,
      last4,
      status: input.status,
      lastCheckedAt: checkedAt,
      lastError: input.lastError,
      baseUrl: input.baseUrl ?? null,
    },
  });

  // La caché del perfil contiene la clave ANTERIOR: se tira en el acto para que
  // el siguiente turno use la que el alumno acaba de guardar.
  invalidateUserAiProfile(input.userId);

  return {
    provider: input.provider,
    status: input.status,
    last4,
    lastCheckedAt: checkedAt.toISOString(),
    lastError: input.lastError,
  };
}

/** Endpoint guardado de una clave (solo `custom`), sin exponer la clave. */
export async function readUserAiKeyBaseUrl(
  userId: string,
  provider: string
): Promise<string | null> {
  try {
    const row = await db(userId).userAiKey.findUnique({
      where: { userId_provider: { userId, provider } },
      select: { baseUrl: true },
    });
    return row?.baseUrl ?? null;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'P2022') return null;
    throw error;
  }
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
  // Una clave borrada no puede seguir respondiendo desde la caché del perfil.
  invalidateUserAiProfile(userId);
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
