import { AsyncLocalStorage } from 'node:async_hooks';

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
export type AiKeyProvider = 'gemini' | 'groq' | 'openrouter' | 'nvidia';

export const AI_KEY_PROVIDERS: readonly AiKeyProvider[] = [
  'gemini',
  'groq',
  'openrouter',
  'nvidia',
];

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
   * Identificador estable para los libros de salud/enfriamiento. Para la clave
   * del alumno es `usuario`; para la de plataforma, el nombre real de la
   * variable (así se siguen repartiendo las claves `_2`, `_3`… sin mezclar
   * usuarios).
   */
  envVar: string;
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
  return ['NVIDIA_API_KEY', 'NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3', 'NVIDIA_API_KEY_4'];
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
    });
  }
  return credentials;
}

/**
 * La clave propia del usuario.
 *
 * El almacenamiento cifrado (`UserAiKey`) llega en el paso 1; hasta entonces no
 * hay clave propia que leer y esta función devuelve `null` (nunca inventa una ni
 * cae a la de plataforma). La política de arriba ya está completa: en cuanto el
 * paso 1 conecte la lectura, el resto de la app no cambia.
 */
async function readOwnKey(_userId: string, _provider: AiKeyProvider): Promise<string | null> {
  return null;
}

/**
 * Credenciales de un proveedor para ESTE usuario, aplicando la política.
 *
 * Se llama una vez por petición y proveedor; no se cachea entre peticiones.
 */
export async function resolveAiCredentials(
  userId: string,
  provider: AiKeyProvider
): Promise<AiCredential> {
  const ownKey = (await readOwnKey(userId, provider))?.trim() ?? '';
  if (ownKey.length > 0) {
    return {
      provider,
      key: ownKey,
      source: 'usuario',
      label: 'principal',
      envVar: 'usuario',
    };
  }

  if (isPlatformAiUser(userId)) {
    const platformKey = platformCredentialsFor(provider)[0];
    if (platformKey) return platformKey;
  }

  throw new AiKeyRequiredError(AI_KEY_REQUIRED_MESSAGE, provider);
}

/**
 * Todas las credenciales disponibles para el usuario: primero las suyas y, si
 * está autorizado, las de plataforma de los proveedores que no tenga.
 *
 * Devuelve `[]` (no lanza) cuando no hay ninguna; las rutas deciden si eso es un
 * 402. Es a propósito: así el estado de Ajustes puede decir «te falta la clave»
 * sin tratar el caso como una excepción.
 */
export async function resolveAllAiCredentials(userId: string): Promise<AiCredential[]> {
  const credentials: AiCredential[] = [];
  const platformAllowed = isPlatformAiUser(userId);

  for (const provider of AI_KEY_PROVIDERS) {
    const ownKey = (await readOwnKey(userId, provider))?.trim() ?? '';
    if (ownKey.length > 0) {
      credentials.push({
        provider,
        key: ownKey,
        source: 'usuario',
        label: 'principal',
        envVar: 'usuario',
      });
      continue;
    }
    if (platformAllowed) credentials.push(...platformCredentialsFor(provider));
  }

  return credentials;
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
 * Resuelve las credenciales del usuario y las deja activas para el resto de la
 * petición (await incluidos). Lanza `AiKeyRequiredError` si no tiene ninguna.
 *
 * Se usa al principio de una ruta de IA; el motor nunca lee el entorno.
 */
export async function enterAiCredentialsForRequest(userId: string): Promise<readonly AiCredential[]> {
  const credentials = await resolveAllAiCredentials(userId);
  if (credentials.length === 0) throw new AiKeyRequiredError();
  credentialStorage.enterWith(credentials);
  return credentials;
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
