import { AsyncLocalStorage } from 'node:async_hooks';
import { accountLedgerId, platformLedgerId } from './ledgerId';
import {
  readCachedOwnKeys,
  writeCachedOwnKeys,
} from './profileCache';
import type { DecryptedUserAiKeys } from './userKeyStore';
import { providerIds, providerLabelOf } from './providers';

/**
 * De dónde sale la clave de IA de una petición.
 *
 * Regla de la casa, sin excepciones:
 *
 *   1. Si el usuario tiene su propia clave guardada, se usa ESA.
 *   2. Si no la tiene y su id está en `PLATFORM_AI_USER_IDS`, se usa la de la
 *      plataforma (la del `.env`). Es la única puerta por la que se gasta.
 *   3. Cualquier otro caso lanza `AiKeyRequiredError` y la ruta responde 402
 *      `ai_key_required`. **Nunca** se cae a la clave de la plataforma.
 *
 * Los procesos sin usuario (cron, vigilante, trabajos de fondo) también tienen
 * que resolver credenciales para un usuario concreto antes de llamar al motor.
 * Si ese usuario no tiene clave ni está en la lista, la tarea se salta y se
 * registra; no se usa la clave de plataforma «por si acaso».
 *
 * Este archivo es el ÚNICO sitio de `src/` que lee las variables de entorno de
 * claves de IA. El motor recibe una credencial ya resuelta y construye el
 * cliente por llamada: no hay cliente global con una clave compartida que
 * pudiera filtrar el gasto entre usuarios.
 */

/** Proveedores que se autentican con una clave del alumno o de la plataforma. */
export type AiKeyProvider = string;

/** Sale del catálogo: añadir un proveedor no toca esta lista. */
export const AI_KEY_PROVIDERS: readonly AiKeyProvider[] = providerIds();

export type AiCredentialSource = 'usuario' | 'plataforma';

/** Una clave concreta, ya resuelta para ESTA petición. */
export interface AiCredential {
  provider: AiKeyProvider;
  /** La clave en claro. Solo existe en memoria del servidor durante la petición. */
  key: string;
  source: AiCredentialSource;
  /** Etiqueta para la interfaz y para el reparto de carga: «principal», «2»… */
  label: string;
  /**
   * Nombre de la variable de entorno. Para la clave del alumno es literalmente
   * `usuario` y se conserva por compatibilidad con las pantallas de Ajustes.
   * NO es la identidad del libro: dos alumnos comparten ese texto.
   */
  envVar: string;
  /**
   * Identidad del libro de salud, enfriamientos y contadores.
   *
   * Para una clave propia es un HMAC de `userId:provider` (nunca la clave ni el
   * `userId` en claro); para una de plataforma, su variable de entorno. Es lo
   * que impide que un 429 de un alumno enfríe la clave de otro.
   */
  ledgerId: string;
  /** Orden explícito del alumno; menor = antes. */
  priority: number;
  /** Endpoint propio ya validado (solo proveedores que lo admiten). */
  baseUrl?: string;
}

/** Mensaje único que ven las pantallas cuando falta la clave. */
export const AI_KEY_REQUIRED_MESSAGE =
  'Añade tu clave de IA en Ajustes para usar esta función. Se guarda cifrada y solo se usa en tus peticiones.';

/** La petición no tiene ninguna credencial de IA legítima para este usuario. */
export class AiKeyRequiredError extends Error {
  /** Código estable que las rutas devuelven en el cuerpo y la interfaz reconoce. */
  readonly code = 'ai_key_required';
  /** HTTP 402: falta el pago/credencial del usuario, no es un fallo del servidor. */
  readonly status = 402;
  readonly provider: AiKeyProvider | null;

  constructor(message = AI_KEY_REQUIRED_MESSAGE, provider: AiKeyProvider | null = null) {
    super(message);
    this.name = 'AiKeyRequiredError';
    this.provider = provider;
  }
}

/**
 * Nombres de las variables de la clave de plataforma, por proveedor y en orden
 * de preferencia. Se usan para leer el `.env` (solo aquí) y para mostrar el
 * estado en Ajustes.
 */
function platformKeyEnvNames(provider: AiKeyProvider): string[] {
  if (provider === 'gemini') {
    return [
      'GEMINI_API_KEY',
      // Las dos formas que usan los SDK de Google: si el `.env` guarda la clave
      // con otro nombre, el motor también la encuentra.
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GOOGLE_GENAI_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY_2',
      'GEMINI_API_KEY_3',
      'GEMINI_API_KEY_4',
    ];
  }
  if (provider === 'groq') {
    return ['GROQ_API_KEY', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3', 'GROQ_API_KEY_4'];
  }
  if (provider === 'openrouter') {
    return [
      'OPENROUTER_API_KEY',
      'OPENROUTER_API_KEY_2',
      'OPENROUTER_API_KEY_3',
      'OPENROUTER_API_KEY_4',
    ];
  }
  if (provider === 'nvidia') {
    return ['NVIDIA_API_KEY', 'NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3', 'NVIDIA_API_KEY_4'];
  }
  if (provider === 'openai') {
    return ['OPENAI_API_KEY', 'OPENAI_API_KEY_2', 'OPENAI_API_KEY_3', 'OPENAI_API_KEY_4'];
  }
  if (provider === 'anthropic') {
    return [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_API_KEY_2',
      'ANTHROPIC_API_KEY_3',
      'ANTHROPIC_API_KEY_4',
    ];
  }
  if (provider === 'custom') {
    return [
      'OPENAI_COMPATIBLE_API_KEY',
      'OPENAI_COMPATIBLE_API_KEY_2',
      'OPENAI_COMPATIBLE_API_KEY_3',
      'OPENAI_COMPATIBLE_API_KEY_4',
    ];
  }
  // Proveedor nuevo del catálogo: convención única, sin tocar este archivo.
  const base = provider.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return [1, 2, 3, 4].map((index) => `${base}_API_KEY${index === 1 ? '' : `_${index}`}`);
}

/** Nombres de variables de un proveedor (también para pintar el estado). */
export function keyEnvNames(provider: string): string[] {
  if (provider === 'ollama' || provider === 'local') return ['OLLAMA_BASE_URL'];
  return platformKeyEnvNames(provider as AiKeyProvider);
}

/** La variable principal de un proveedor (la que se nombra en los mensajes). */
export function mainKeyEnv(provider: string): string {
  if (provider === 'ollama' || provider === 'local') return 'OLLAMA_BASE_URL';
  return platformKeyEnvNames(provider as AiKeyProvider)[0] ?? 'OLLAMA_BASE_URL';
}

/** `_KEY_2` → «2»; la principal → «principal». */
function labelForEnv(envVar: string): string {
  const numbered = envVar.match(/_KEY_(\d)$/);
  return numbered ? numbered[1] : 'principal';
}

/** Ids autorizados a gastar la clave de plataforma (coma o espacio). */
export function platformAiUserIds(): string[] {
  return (process.env.PLATFORM_AI_USER_IDS ?? '')
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** ¿Este usuario puede usar la clave de plataforma? */
export function isPlatformAiUser(userId: string): boolean {
  const id = String(userId ?? '').trim();
  if (id.length === 0) return false;
  return platformAiUserIds().includes(id);
}

/**
 * Las claves de plataforma de un proveedor, leídas del entorno. Solo se llama
 * desde este archivo y solo cuando el usuario está en la lista.
 */
function platformCredentialsFor(provider: AiKeyProvider): AiCredential[] {
  const credentials: AiCredential[] = [];
  const seen = new Set<string>();
  for (const envVar of platformKeyEnvNames(provider)) {
    const key = (process.env[envVar] ?? '').trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    credentials.push({
      provider,
      key,
      source: 'plataforma',
      label: labelForEnv(envVar),
      envVar,
      ledgerId: platformLedgerId(envVar),
      priority: 100,
    });
  }
  return credentials;
}

/**
 * Las claves propias del usuario, en UNA consulta y con los descifrados en
 * paralelo.
 *
 * La carga del almacén es diferida a propósito: importar el motor no debe abrir
 * Prisma hasta que de verdad haya que leer una clave guardada. Si el vault no
 * puede descifrar una fila, lanza `AiKeyStoreError` (o la omite en modo
 * tolerante): es un fallo de configuración del servidor, no una excusa para
 * caer a la clave de plataforma.
 */
async function readOwnKeysForProfile(
  userId: string,
  options: { tolerateVaultErrors?: boolean }
): Promise<DecryptedUserAiKeys> {
  const { readDecryptedUserKeys } = await import('./userKeyStore');
  return readDecryptedUserKeys(userId, { tolerateErrors: options.tolerateVaultErrors });
}

/** Credencial de una clave propia, con libro aislado por cuenta. */
function ownCredential(
  userId: string,
  provider: AiKeyProvider,
  key: string,
  priority: number,
  baseUrl?: string
): AiCredential {
  return {
    provider,
    key,
    source: 'usuario',
    label: 'principal',
    envVar: 'usuario',
    ledgerId: accountLedgerId(userId, provider),
    priority,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/** El perfil de IA resuelto para una cuenta. */
export interface UserAiProfile {
  userId: string;
  /** Credenciales utilizables, en el orden estable del catálogo. */
  credentials: AiCredential[];
  /** Proveedores que el alumno tiene guardados (aunque ahora fallen). */
  ownProviders: AiKeyProvider[];
  /** `updatedAt` máximo de las filas leídas; `null` si vino de caché sin fila. */
  updatedAtMs: number | null;
  /** Orden explícito del alumno (ids del catálogo). */
  providerOrder: string[];
  /** ¿Se ha servido de la caché en memoria? Útil para medir y verificar. */
  fromCache: boolean;
}

/**
 * Credenciales que corresponden a un mapa de claves propias.
 *
 * La regla de la casa sigue intacta: si el alumno tiene ALGUNA clave propia,
 * solo se usan las suyas (no se completa con proveedores de plataforma). Si no
 * tiene ninguna y está autorizado, se usan las de plataforma.
 */
function credentialsForProfile(
  userId: string,
  ownKeys: ReadonlyMap<string, string>,
  order: string[] = [],
  baseUrls: ReadonlyMap<string, string> = new Map()
): AiCredential[] {
  const own: AiCredential[] = [];
  for (const provider of AI_KEY_PROVIDERS) {
    const key = ownKeys.get(provider)?.trim() ?? '';
    if (key.length > 0) {
      const index = order.indexOf(provider);
      own.push(
        ownCredential(
          userId,
          provider,
          key,
          index < 0 ? 1000 : index,
          baseUrls.get(provider)
        )
      );
    }
  }
  own.sort((a, b) => a.priority - b.priority);
  if (own.length > 0) return own;
  if (!isPlatformAiUser(userId)) return [];
  return AI_KEY_PROVIDERS.flatMap((provider) => platformCredentialsFor(provider));
}

function providersOf(keys: ReadonlyMap<string, string>): AiKeyProvider[] {
  return AI_KEY_PROVIDERS.filter((provider) => (keys.get(provider)?.trim() ?? '').length > 0);
}

/**
 * Resuelve el perfil de IA del alumno: sus claves, una sola lectura y caché de
 * 60 s (5 s si está vacío).
 *
 * Se llama una vez por petición (la puerta `ensureAiAccess` lo hace por ti). El
 * orden de `credentials` es estable, así que la cadena de proveedores no cambia
 * entre turnos por azar del `Map`.
 *
 * La caché se invalida en el acto al guardar o borrar una clave
 * (`saveUserAiKey`/`deleteUserAiKey` llaman a `invalidateUserAiProfile`). En
 * varias instancias, el TTL acota la ventana a 60 s.
 */
export async function resolveUserAiProfile(
  userId: string,
  options: { tolerateVaultErrors?: boolean } = {}
): Promise<UserAiProfile> {
  const cached = readCachedOwnKeys(userId);
  if (cached) {
    return {
      userId,
      credentials: credentialsForProfile(userId, cached.keys, cached.order, cached.baseUrls),
      ownProviders: providersOf(cached.keys),
      updatedAtMs: cached.updatedAtMs,
      providerOrder: cached.order,
      fromCache: true,
    };
  }

  const [read, order] = await Promise.all([
    readOwnKeysForProfile(userId, options),
    (async () => {
      const { readProviderOrder } = await import('./providerOrder');
      return readProviderOrder(userId).catch(() => []);
    })(),
  ]);
  const ownKeys = new Map<string, string>();
  for (const provider of AI_KEY_PROVIDERS) {
    const key = read.keys.get(provider)?.trim() ?? '';
    if (key.length > 0) ownKeys.set(provider, key);
  }

  // No se cachea una lectura a medias: si el vault falló en un proveedor, la
  // pantalla de estado debe poder reintentarlo en la siguiente carga.
  if (read.failedProviders.length === 0) {
    writeCachedOwnKeys(userId, ownKeys, read.updatedAtMs, Date.now(), order, read.baseUrls);
  }

  return {
    userId,
    credentials: credentialsForProfile(userId, ownKeys, order, read.baseUrls),
    ownProviders: providersOf(ownKeys),
    updatedAtMs: read.updatedAtMs,
    providerOrder: order,
    fromCache: false,
  };
}

export async function resolveAiCredentials(
  userId: string,
  provider: AiKeyProvider
): Promise<AiCredential> {
  const profile = await resolveUserAiProfile(userId);
  const own = profile.credentials.find(
    (credential) => credential.provider === provider && credential.source === 'usuario'
  );
  if (own) return own;

  if (profile.ownProviders.length > 0) {
    // Tiene claves propias, pero no de este proveedor: no se le completa con la
    // de plataforma. Se le dice qué falta, en vez de gastar otra cuenta.
    throw new AiKeyRequiredError(
      'Esa clave no está guardada y no se usa la de plataforma cuando tienes claves propias. Añádela en Ajustes si quieres usar ese proveedor.',
      provider
    );
  }

  const platform = profile.credentials.find(
    (credential) => credential.provider === provider && credential.source === 'plataforma'
  );
  if (platform) return platform;

  throw new AiKeyRequiredError(AI_KEY_REQUIRED_MESSAGE, provider);
}

/** Nombre del proveedor para los mensajes. */
export function providerLabel(provider: AiKeyProvider): string {
  return providerLabelOf(provider);
}

/**
 * Todas las credenciales disponibles para el usuario: primero las suyas y, si
 * está autorizado, las de plataforma de los proveedores que no tenga.
 *
 * Devuelve `[]` (no lanza) cuando no hay ninguna; las rutas deciden si eso es un
 * 402. Es a propósito: así el estado de Ajustes puede decir «te falta la clave»
 * sin tratar el caso como una excepción.
 */
export async function resolveAllAiCredentials(
  userId: string,
  options: { tolerateVaultErrors?: boolean } = {}
): Promise<AiCredential[]> {
  const profile = await resolveUserAiProfile(userId, options);
  return profile.credentials;
}

/**
 * El ámbito de credenciales de la petición.
 *
 * `AsyncLocalStorage` es por ejecución asíncrona, no global: dos peticiones
 * simultáneas de dos usuarios no comparten claves. No guarda clientes ni
 * resultados, solo la lista de credenciales ya resueltas.
 */
const credentialStorage = new AsyncLocalStorage<readonly AiCredential[]>();

/** Ejecuta `work` con estas credenciales visibles para el motor. */
export function runWithAiCredentials<T>(
  credentials: readonly AiCredential[],
  work: () => T
): T {
  return credentialStorage.run(credentials, work);
}

/**
 * Deja estas credenciales activas para el resto del contexto actual.
 *
 * TIENE QUE LLAMARSE EN LA MISMA FUNCIÓN QUE VA A USAR EL MOTOR (la ruta),
 * justo después de resolverlas. No vale llamarlo desde un ayudante:
 * `AsyncLocalStorage.enterWith` cambia el contexto del recurso asíncrono que
 * está ejecutando AHORA, y el llamante que espera a un ayudante sigue en el
 * suyo, sin ámbito. Ese fue el bug del catedrático: la puerta entraba con las
 * credenciales dentro de su propia función, la ruta se quedaba sin ellas y
 * `hasAiProviderAsync()` contestaba «no hay ningún motor» aunque la clave
 * propia fuera válida.
 */
export function activateAiCredentials(credentials: readonly AiCredential[]): void {
  credentialStorage.enterWith(credentials);
}

/** Credenciales activas en este contexto, o `null` si no hay ámbito. */
export function currentAiCredentials(): readonly AiCredential[] | null {
  return credentialStorage.getStore() ?? null;
}

/**
 * SOLO para los scripts de verificación que simulan claves mutando `process.env`.
 *
 * No es un camino de producción: exige `BRAINUP_AI_TEST_MODE=1` y se niega con
 * `NODE_ENV=production`. En la app, un contexto sin ámbito no tiene credenciales
 * y el motor se niega a llamar a nadie.
 */
export function platformCredentialsForTests(): AiCredential[] | null {
  if (process.env.BRAINUP_AI_TEST_MODE !== '1') return null;
  if (process.env.NODE_ENV === 'production') return null;
  return AI_KEY_PROVIDERS.flatMap((provider) => platformCredentialsFor(provider));
}
