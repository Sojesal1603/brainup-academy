/**
 * BrainUp — Motor de IA multiproveedor con selección automática de modelo.
 *
 * Objetivo: que la app use SIEMPRE el mejor modelo que la API permita en ese
 * momento, sin sustos en la factura:
 *
 *  - Solo entran en la rotación modelos con tier gratuito. Los "pro" de pago,
 *    los de imagen/audio y los experimentales quedan fuera por política.
 *  - El catálogo real se consulta a la propia API (con caché de 10 min), así
 *    que si aparece un modelo mejor se empieza a usar solo, sin tocar código.
 *  - Cada modelo recuerda su salud: si agota cupo (429) entra en enfriamiento
 *    y se salta durante un rato, en lugar de reintentarlo en cada mensaje.
 *  - Gemini es el proveedor primario; **Groq** actúa de desbordamiento
 *    gratuito cuando la cuota de Gemini se satura, y **OpenRouter** es el
 *    tercer motor: un agregador OpenAI-compatible con modelos gratuitos
 *    (`:free`) de otras familias, con su propia cuota (opcional: solo si existe
 *    `OPENROUTER_API_KEY`).
 *  - Ollama, si está levantado, es la última red: no tiene cupo ni cuesta nada.
 *  - Si no hay ninguna clave o todos los modelos fallan, se lanza TutorError y
 *    la app degrada a sus plantillas locales.
 *
 * Variables de entorno:
 *   GEMINI_API_KEY      clave de Google AI Studio (gratuita).
 *   GROQ_API_KEY        clave de Groq (gratuita, opcional).
 *   OPENROUTER_API_KEY  clave de OpenRouter (gratuita, opcional).
 *   GEMINI_API_KEY_2..4 claves EXTRA del mismo proveedor (opcional, hasta 4).
 *   GROQ_API_KEY_2..4   claves EXTRA de Groq (opcional, hasta 4).
 *   OPENROUTER_API_KEY_2..4  claves EXTRA de OpenRouter (opcional, hasta 4).
 *   GEMINI_MODEL        fuerza un modelo concreto de Gemini (por defecto "auto").
 *   GROQ_MODEL          fuerza un modelo concreto de Groq (por defecto "auto").
 *   OPENROUTER_MODEL    fuerza un modelo concreto de OpenRouter (por defecto "auto").
 *   AI_PROVIDER         "auto" (Gemini primero), "gemini", "groq", "openrouter" u "ollama".
 *   ALLOW_PREVIEW_MODELS  1 permite elegir modelos preview sin forzar proveedor
 *                       (por defecto 0; en producción debe quedarse a 0).
 *   AI_<PROVEEDOR>_MODELS  cadena de modelos separada por comas; manda sobre
 *                       `src/lib/ai/models.json`, que es el sitio normal donde
 *                       se cambia el orden sin tocar código.
 */

import {
  AiKeyRequiredError,
  currentAiCredentials,
  keyEnvNames,
  mainKeyEnv,
  platformCredentialsForTests,
  type AiCredential,
} from './ai/credentials';
import {
  allowPreviewModels,
  configuredModelChain,
  excludedModels,
  isPreviewModel,
} from './ai/modelCatalog';
import {
  customModelsFromEnv,
  getProviderDescriptor,
  modelCapabilities,
  providerIds,
} from './ai/providers';
import {
  capabilityDegradationMessage,
  planRoute,
  type RoutableModel,
} from './ai/router';

export type AiProvider = string;

/** Un turno de conversación tal y como lo entienden los proveedores OpenAI. */
export interface ChatMessage {
  role: string;
  content: string;
}

/** Archivo que viaja al modelo: solo visión (capturas y escaneos). */
export interface AiAttachmentPart {
  name: string;
  mimeType: string;
  data: string;
}

/** Resultado unificado de un turno, sea cual sea el proveedor que conteste. */
export interface AiTextResult {
  text: string;
  steps: unknown[];
  model: string;
  provider: AiProvider;
}

/** Petición de un turno. */
export interface AiTextParams {
  systemInstruction: string;
  message: string;
  /** Historial en formato OpenAI (Groq, OpenRouter y Ollama). */
  messages?: ChatMessage[];
  /** Historial en pasos crudos de Gemini (se reenvía tal cual). */
  history?: unknown[];
  attachments?: AiAttachmentPart[];
  /**
   * Capacidades que exige el turno, además de la visión que se deduce de los
   * adjuntos. El router filtra antes de llamar y, si ninguna clave del alumno
   * las cubre, degrada con un mensaje neutro.
   */
  requiresVision?: boolean;
  requiresTools?: boolean;
  requiresJson?: boolean;
  /**
   * Nombres de adjuntos cuyo TEXTO ya viaja en el prompt (PDF, Word…): no hay
   * que avisar de que «no se han podido leer» solo porque sus bytes no viajen.
   */
  readableTextAttachments?: string[];
  maxTokens?: number;
  budgetMs?: number;
  attemptMs?: number;
  /**
   * «fondo» = trabajo que no está esperando nadie (rondas del vigilante,
   * memoria, auditoría). Con el cupo justo cede el turno al alumno.
   */
  priority?: 'alumno' | 'fondo';
  /**
   * Fuerza ESTE proveedor y ninguno más.
   *
   * Lo usa la comparativa de apuntes: el alumno pide la misma unidad a Gemini y
   * a Groq para quedarse con la versión que mejor le sienta. Sin esto, la cadena
   * elegiría por él y las dos pestañas podrían acabar escritas por el mismo
   * motor (o por otro distinto del que dice la pestaña).
   */
  provider?: AiProvider;
  /**
   * Hedge dentro del perfil: a los ~700 ms del campeón se lanza otro proveedor
   * de las MISMAS claves; gana el primero que contesta y el otro se aborta.
   * Se desactiva en trabajos de fondo y en la comparativa forzada.
   */
  hedge?: boolean;
}

export interface ModelCandidate {
  provider: AiProvider;
  model: string;
  score: number;
  key: string;
}

export interface SelectionTrace {
  at: number;
  provider: AiProvider | null;
  model: string | null;
  ranked: string[];
  attempts: Array<{ key: string; outcome: string; note?: string }>;
}

export interface EngineModelStatus {
  key: string;
  provider: AiProvider;
  model: string;
  coolingSeconds: number;
  lastStatus: string | null;
}

export interface EngineProviderStatus {
  id: AiProvider;
  name: string;
  keyEnv: string;
  configured: boolean;
  signupUrl: string;
  note: string;
  keys: Array<{
    label: string;
    envVar: string;
    coolingSeconds: number;
    modelsOutOfQuota: number;
    used: number;
    lastStatus: string | null;
  }>;
  keysAvailable: number;
  extraKeyEnv: string[];
}

export interface EngineStatus {
  providers: EngineProviderStatus[];
  ranked: EngineModelStatus[];
  nextKey: string | null;
  selected: string | null;
  lastGood: string | null;
  usage: {
    day: string;
    calls: number;
    failures: number;
    byProvider: Record<string, number>;
  };
  lastDecision: SelectionTrace | null;
  quotaTight: boolean;
}

/**
 * Tipo de parte que espera la API para cada archivo. Comprobado contra la API
 * real: la parte NO se llama `file`; un PDF va como `document` y una captura
 * como `image`, y solo admite los campos `mime_type` y `data` (en base64 puro,
 * sin el prefijo `data:`). Cualquier otro nombre de campo se rechaza.
 */
export function attachmentMediaKind(mimeType: string): 'document' | 'image' {
  return mimeType === 'application/pdf' ? 'document' : 'image';
}

/**
 * Paso de entrada del alumno tal y como lo espera la API de Interactions.
 * Sin adjuntos es el texto de siempre; con adjuntos, el contenido pasa a ser
 * una lista de partes: el texto primero y un archivo por cada adjunto.
 */
export function buildUserInputStep(
  message: string,
  attachments: AiAttachmentPart[] = []
): { type: 'user_input'; content: string | Array<Record<string, string>> } {
  if (attachments.length === 0) return { type: 'user_input', content: message };

  return {
    type: 'user_input',
    content: [
      { type: 'text', text: message },
      ...attachments.map((attachment) => ({
        type: attachmentMediaKind(attachment.mimeType),
        mime_type: attachment.mimeType,
        data: attachment.data,
      })),
    ],
  };
}

/**
 * Aviso honesto para los proveedores que no leen archivos: nombra lo que se ha
 * adjuntado y prohíbe dar por hecho que lo ha visto.
 */
export function attachmentsNotReadableNote(attachments: AiAttachmentPart[]): string {
  if (attachments.length === 0) return '';
  const names = attachments.map((attachment) => `«${attachment.name}»`).join(', ');
  return `\n\n(Aviso interno: el alumno ha adjuntado ${names}, pero el proveedor de IA que te ejecuta ahora mismo NO puede leer archivos, así que no los has visto. No supongas su contenido: pídele que te pegue el texto o que te lo cuente.)`;
}

/**
 * Tope de caracteres del prompt de sistema. Groq mide el cupo por tokens por
 * minuto y rechaza la petición ENTERA si no cabe (ITPM), así que un PDF de
 * 45 000 caracteres dejaba al alumno sin respuesta. Se recorta conservando la
 * cabecera (los documentos) y el final (el protocolo socrático).
 */
const SYSTEM_PROMPT_MAX_CHARS = 16_000;

/** Aprieta el recorte: nivel 0 = 16 000, nivel 1 = 8 000, nivel 2 = 4 000. */
export function compactSystemInstruction(text: string, level = 0): string {
  const cap =
    level === 0
      ? SYSTEM_PROMPT_MAX_CHARS
      : Math.max(4_000, Math.floor(SYSTEM_PROMPT_MAX_CHARS / 2 ** level));
  if (text.length <= cap) return text;
  // Se conserva casi todo el tope: la cabecera (documentos) y el final (el
  // protocolo). Recortar de más tira contexto útil sin necesidad.
  const head = Math.floor(cap * 0.35);
  const tail = Math.floor(cap * 0.6);
  return `${text.slice(0, head)}\n\n[…documentos recortados para que la petición quepa en el modelo…]\n\n${text.slice(text.length - tail)}`;
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_INTERACTIONS_ENDPOINT = `${GEMINI_BASE}/interactions`;
const GEMINI_MODELS_ENDPOINT = `${GEMINI_BASE}/models`;
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const GROQ_MODELS_ENDPOINT = `${GROQ_BASE}/models`;

/*
 * EL TERCER PROVEEDOR DE LA NUBE: OpenRouter.
 *
 * Gemini y Groq son gratis pero cada uno tiene SU cupo, y un día de estudio
 * intenso los seca a los dos. OpenRouter enruta a modelos de varias familias
 * (DeepSeek, Qwen, Llama…) y tiene su propia cuota gratuita.
 *
 * OJO CON SU CUPO: en el plan gratuito son 20 peticiones/minuto y 50 al día
 * **por cuenta**, no por clave. Añadir claves extra no multiplica su cupo; lo
 * que se gana es independencia: cuando Gemini y Groq están secos, aquí siguen
 * habiendo modelos gratuitos.
 */
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const OPENROUTER_MODELS_ENDPOINT = `${OPENROUTER_BASE}/models`;

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
const OLLAMA_CHAT_ENDPOINT = `${OLLAMA_BASE}/v1/chat/completions`;
const OLLAMA_MODELS_ENDPOINT = `${OLLAMA_BASE}/api/tags`;

/*
 * EL MOTOR LOCAL.
 *
 * Ollama corre en el propio ordenador: no tiene cupo, no cuesta dinero y no
 * depende de que internet vaya bien. Se enciende **solo**: si hay un Ollama
 * levantado con algún modelo, entra como último recurso de la cadena. Si no
 * está, no se nota: la comprobación está cacheada.
 *
 * `OLLAMA_ENABLED=false` lo apaga del todo; `true` lo obliga.
 */
let ollamaUp = false;
let ollamaProbedAt = 0;
const OLLAMA_PROBE_TTL_MS = 5 * 60 * 1000;

/**
 * RAM libre mínima para cargar el modelo local. Un `0` explícito se respeta:
 * es lo que usan las verificaciones para no depender de la memoria del equipo.
 * Sin variable (o con un valor inválido) se exigen 1 200 MB.
 */
const OLLAMA_MIN_FREE_MB = (() => {
  const raw = process.env.OLLAMA_MIN_FREE_MB;
  if (raw !== undefined && raw.trim() !== '') {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 1200;
})();
/** RAM libre por debajo de esto después de responder: se descarga ya. */
const OLLAMA_TIGHT_FREE_MB = 500;
/** Rato sin usar el motor local antes de descargar el modelo. */
const OLLAMA_IDLE_UNLOAD_MS = Math.max(
  30_000,
  Number(process.env.OLLAMA_IDLE_UNLOAD_MS) || 3 * 60 * 1000
);

/** La RAM libre del sistema en MB, o null si el runtime no la puede dar. */
function freeMemoryMb(): number | null {
  try {
    const get = (
      process as unknown as {
        getBuiltinModule?: (id: string) => { freemem?: () => number } | undefined;
      }
    ).getBuiltinModule;
    if (typeof get !== 'function') return null;
    const os = get('os');
    if (!os || typeof os.freemem !== 'function') return null;
    return Math.round(os.freemem() / (1024 * 1024));
  } catch {
    return null;
  }
}

/** ¿Hay memoria suficiente para cargar un modelo local ahora mismo? */
export function hasRoomForLocalModel(): boolean {
  const free = freeMemoryMb();
  // Si el runtime no sabe decirlo, no se bloquea el motor local por una duda.
  if (free === null) return true;
  return free >= OLLAMA_MIN_FREE_MB;
}

/** Estado de memoria para Ajustes y para el parte de salud. */
export function localModelMemory(): { freeMb: number | null; minFreeMb: number; room: boolean } {
  const freeMb = freeMemoryMb();
  return {
    freeMb,
    minFreeMb: OLLAMA_MIN_FREE_MB,
    room: freeMb === null ? true : freeMb >= OLLAMA_MIN_FREE_MB,
  };
}

/** Cola de un solo carril: una generación local a la vez. */
let ollamaQueue: Promise<unknown> = Promise.resolve();
let ollamaLastUsed = 0;
let ollamaLoadedModel: string | null = null;
let ollamaUnloadTimer: NodeJS.Timeout | null = null;

/**
 * Descarga el modelo de la memoria de Ollama con `keep_alive: 0`. Es el gesto
 * que evita que el portátil se quede sin RAM.
 */
async function unloadOllamaModel(model: string): Promise<void> {
  if (!model) return;
  try {
    await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(2500),
    });
    console.log(`[ia] modelo local descargado de la memoria: ${model}`);
  } catch {
    // Si no se puede descargar, el keep_alive de Ollama lo hará por su cuenta.
  } finally {
    if (ollamaLoadedModel === model) ollamaLoadedModel = null;
  }
}

/** Programa la descarga del modelo tras un rato sin usarlo. */
function scheduleOllamaUnload(model: string): void {
  if (ollamaUnloadTimer) clearTimeout(ollamaUnloadTimer);
  const timer = setTimeout(() => {
    if (Date.now() - ollamaLastUsed < OLLAMA_IDLE_UNLOAD_MS) {
      scheduleOllamaUnload(model);
      return;
    }
    void unloadOllamaModel(model);
  }, OLLAMA_IDLE_UNLOAD_MS);
  // `unref` evita que este temporizador retrase el cierre del proceso.
  timer.unref?.();
  ollamaUnloadTimer = timer;
}

/** Encola una llamada al motor local: nunca dos a la vez. */
async function withOllamaLock<T>(task: () => Promise<T>): Promise<T> {
  const run = ollamaQueue.then(task, task);
  // La cola no debe quedarse rechazada por un fallo del turno anterior.
  ollamaQueue = run.catch(() => undefined);
  return run;
}

/** Cómo está configurado el motor local: «auto» (por defecto), «true» o «false». */
function ollamaMode(): 'auto' | 'on' | 'off' {
  const raw = (process.env.OLLAMA_ENABLED || 'auto').trim().toLowerCase();
  if (raw === 'false' || raw === 'off' || raw === 'no' || raw === '0') return 'off';
  if (raw === 'true' || raw === 'on' || raw === 'si' || raw === 'sí' || raw === '1') return 'on';
  if ((process.env.AI_PROVIDER || '').trim().toLowerCase() === 'ollama') return 'on';
  return 'auto';
}

/** ¿Hay un modelo local disponible? Se comprueba de verdad, con caché. */
async function probeOllama(force = false): Promise<boolean> {
  const mode = ollamaMode();
  if (mode === 'off') {
    ollamaUp = false;
    return false;
  }
  if (mode === 'on') {
    ollamaUp = true;
    return true;
  }
  if (!force && ollamaProbedAt !== 0 && Date.now() - ollamaProbedAt < OLLAMA_PROBE_TTL_MS) {
    return ollamaUp;
  }
  ollamaProbedAt = Date.now();
  // Antes de mirar modelos se mira la RAM: un modelo local sin memoria libre no
  // es una red de seguridad, es la app arrastrándose.
  if (!hasRoomForLocalModel()) {
    ollamaUp = false;
    const memory = localModelMemory();
    console.log(
      `[ia] motor local en espera: quedan ${memory.freeMb ?? '?'} MB libres y se piden ${memory.minFreeMb} MB (OLLAMA_MIN_FREE_MB).`
    );
    return false;
  }
  const models = await listOllamaModels();
  ollamaUp = models.length > 0;
  if (ollamaUp) {
    console.log(`[ia] modelo local disponible (Ollama): ${models.slice(0, 3).join(', ')}`);
  }
  return ollamaUp;
}

/** ¿Está el motor local levantado ahora mismo? (lo último comprobado). */
export function isOllamaAvailable(): boolean {
  return ollamaUp;
}

/** Nº máximo de mensajes de historial que se reenvían al modelo. */
export const TUTOR_MAX_HISTORY_MESSAGES = 24;

/** Caché del catálogo de modelos de cada proveedor. */
const CATALOG_TTL_MS = 10 * 60 * 1000;

/** Enfriamientos según el tipo de fallo. */
const COOLDOWN_QUOTA_MS = 3 * 60 * 1000;
const COOLDOWN_QUOTA_DAILY_MS = 6 * 60 * 60 * 1000;
// Un 404 de «este modelo ya no existe» no se arregla solo: se aparta una hora.
const COOLDOWN_MISSING_MS = 60 * 60 * 1000;
// «High demand» de un modelo concreto dura minutos, no segundos. Con 20 s se
// volvía a probar el mismo modelo saturado en el turno siguiente y otra vez se
// comía el presupuesto antes de llegar a los que sí responden.
const COOLDOWN_ERROR_MS = 3 * 60 * 1000;
const COOLDOWN_AUTH_MS = 10 * 60 * 1000;

/**
 * MODELO PREFERENTE DE LA APP: Gemini 1.5 Flash.
 *
 * Es el motor que queremos por defecto: tier gratuito, ventana de contexto
 * enorme (cabe el temario, los apuntes y los documentos) y respuesta casi
 * instantánea. Ahora bien, Google ha retirado `gemini-1.5-flash` de la API
 * pública (devuelve 404), así que solo se usa si el catálogo real todavía lo
 * sirve o si se fuerza con `GEMINI_MODEL=gemini-1.5-flash`. Cuando no está, la
 * cadena cae al mejor Flash disponible del catálogo: mismo proveedor, misma
 * latencia y mismo tier gratuito, sin gastar un intento en un 404.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-1.5-flash';

/** Cadena estática de respaldo si el catálogo de Gemini no se puede consultar. */
const GEMINI_STATIC_POOL = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
];

/** Cadena estática de respaldo si el catálogo de Groq no se puede consultar. */
const GROQ_STATIC_POOL = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
  'llama-3.3-70b-versatile',
];

/**
 * Cadena estática de respaldo si el catálogo de OpenRouter no se puede consultar.
 * Solo modelos con sufijo `:free`: esta app no gasta dinero en IA.
 */
const OPENROUTER_STATIC_POOL = [
  'deepseek/deepseek-chat-v3.1:free',
  'qwen/qwen3-32b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
];

/* ------------------------------------------------------------------ */
/* Claves y disponibilidad                                             */
/* ------------------------------------------------------------------ */

/** Máximo de claves por proveedor: las extra se numeran hasta aquí. */
export const MAX_KEYS_PER_PROVIDER = 4;

/**
 * Lo que se le responde a un turno de FONDO que se aparta por cupo justo. Lleva
 * su propio texto porque no es un fallo: es la app cediendo el turno.
 */
export const BACKGROUND_YIELD_MESSAGE =
  'Cupo de IA justo en este momento: este trabajo de fondo cede el turno para no quitarle el cupo al alumno. Se reanuda solo en la próxima ronda.';

export interface ProviderKey {
  label: string;
  envVar: string;
  key: string;
  /**
   * Identidad del libro de salud/enfriamiento. En BYOK es un HMAC por cuenta y
   * proveedor, no el literal `usuario`: dos alumnos nunca comparten libro.
   */
  ledgerId: string;
  /** De dónde sale la clave; decide el alcance del cupo por modelo. */
  source: AiCredential['source'];
  /** Endpoint propio (solo proveedores que lo admiten). */
  baseUrl?: string;
}

/**
 * Las claves de un proveedor, en orden: primero la de siempre y después las
 * extra. Se saltan las vacías y las repetidas (dos variables con la misma clave
 * serían dos intentos contra el mismo cupo).
 */
/**
 * Las credenciales de IA de ESTE contexto.
 *
 * Sin ámbito (una ruta que se olvidó de resolverlas, un cron sin usuario) no hay
 * ninguna: el motor no lee el `.env` por su cuenta. `BRAINUP_AI_TEST_MODE` es la
 * única excepción y está apagada en producción.
 */
function scopedCredentials(): readonly AiCredential[] {
  const scoped = currentAiCredentials();
  if (scoped !== null) return scoped;
  return platformCredentialsForTests() ?? [];
}

/** ¿Puede usarse el motor local? Solo si la petición trae credenciales válidas. */
function localEngineAllowed(): boolean {
  const scoped = currentAiCredentials();
  if (scoped !== null) return scoped.length > 0;
  return platformCredentialsForTests() !== null;
}

/**
 * Las claves de un proveedor, ya resueltas para la petición: la del usuario o, si
 * está autorizado, las de plataforma. Nunca se leen variables de entorno aquí.
 */
export function getProviderKeys(provider: AiProvider): ProviderKey[] {
  if (provider === 'ollama') {
    if (!localEngineAllowed()) return [];
    return [
      {
        label: 'local',
        envVar: 'OLLAMA_BASE_URL',
        key: OLLAMA_BASE,
        ledgerId: 'OLLAMA_BASE_URL',
        source: 'plataforma',
      },
    ];
  }
  const keys: ProviderKey[] = [];
  const seen = new Set<string>();
  for (const credential of scopedCredentials()) {
    if (credential.provider !== provider) continue;
    if (credential.key.length === 0 || seen.has(credential.key)) continue;
    seen.add(credential.key);
    keys.push({
      label: credential.label,
      envVar: credential.envVar,
      key: credential.key,
      ledgerId: credential.ledgerId,
      source: credential.source,
      ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}),
    });
  }
  return keys.slice(0, MAX_KEYS_PER_PROVIDER);
}

export function getGeminiKey(): string | null {
  return getProviderKeys('gemini')[0]?.key ?? null;
}

export function getGroqKey(): string | null {
  return getProviderKeys('groq')[0]?.key ?? null;
}

export function getOpenRouterKey(): string | null {
  return getProviderKeys('openrouter')[0]?.key ?? null;
}

export function getNvidiaKey(): string | null {
  return getProviderKeys('nvidia')[0]?.key ?? null;
}

/** Un motor disponible, con el nombre que ve el alumno en la interfaz. */
export interface EngineOption {
  id: AiProvider;
  name: string;
}

/** Motores que pueden escribir ahora mismo (los que tienen clave o local vivo). */
export function getConfiguredEngines(): EngineOption[] {
  return getConfiguredProviders().map((id) => ({ id, name: engineDisplayName(id) }));
}

/** Cómo se llama cada motor en la interfaz, sin tecnicismos. */
function engineDisplayName(provider: AiProvider): string {
  if (provider === 'ollama' || provider === 'local') return 'Modelo local';
  return getProviderDescriptor(provider)?.label ?? provider;
}

/**
 * Proveedores que pueden contestar con las credenciales de ESTA petición.
 *
 * Sale del catálogo, así que añadir uno nuevo no toca esta función. Un
 * proveedor con endpoint propio solo entra si su credencial trae la URL ya
 * validada: una clave sin endpoint no puede llamar a ninguna parte.
 */
export function getConfiguredProviders(): AiProvider[] {
  const providers: AiProvider[] = [];
  for (const descriptor of providerIds()) {
    const keys = getProviderKeys(descriptor);
    if (keys.length === 0) continue;
    if (getProviderDescriptor(descriptor)?.requiresBaseUrl && !keys.some((key) => key.baseUrl)) {
      continue;
    }
    providers.push(descriptor);
  }
  // El motor local va SIEMPRE el último: la nube escribe mejor.
  const mode = ollamaMode();
  if (mode === 'on') providers.push('ollama');
  else if (mode === 'auto' && ollamaUp) providers.push('ollama');
  return providers;
}

/** ¿Hay al menos un proveedor de IA utilizable? */
export function hasAiProvider(): boolean {
  return getConfiguredProviders().length > 0;
}

/**
 * ¿Hay IA de verdad en ESTE proceso?
 *
 * `hasAiProvider()` es síncrona y solo sabe lo que ya está en memoria. En un
 * proceso recién arrancado —o en cada instancia serverless, que arranca de
 * cero— todavía no se ha sondeado Ollama, así que con el motor local levantado
 * y sin claves de nube la app contestaba «no hay IA» y se quedaba en modo
 * local. Las rutas de chat usan esta versión, que sondea antes de decidir.
 */
export async function hasAiProviderAsync(): Promise<boolean> {
  if (hasAiProvider()) return true;
  // `probeOllama` está cacheado: como mucho cuesta ~1 s una vez cada 90 s.
  await probeOllama();
  return getConfiguredProviders().length > 0;
}

/**
 * ¿Queda alguna vía con cupo? Es lo que evita encadenar treinta intentos
 * condenados a 429 (apuntes) o avisar de un enfriamiento que no existe.
 */
export function hasAnyFreeKey(): boolean {
  for (const provider of getConfiguredProviders()) {
    if (provider === 'ollama') return true;
    const keys = getProviderKeys(provider);
    if (keys.some((entry) => getKeyCooldownSeconds(provider, entry.ledgerId) === 0)) return true;
  }
  return false;
}

function getApiKey(provider: AiProvider): string | null {
  return getProviderKeys(provider)[0]?.key ?? null;
}

function candidateKey(provider: AiProvider, model: string): string {
  return `${provider}:${model}`;
}

/**
 * ¿Puede este modelo leer imágenes? Gemini sí, siempre. En el resto solo los
 * multimodales conocidos: decir que sí de más acaba en una disculpa inventada.
 */
export function modelSupportsVision(provider: AiProvider, model: string): boolean {
  return modelCapabilities(provider, model).vision;
}

/* ------------------------------------------------------------------ */
/* Puntuación de modelos                                               */
/* ------------------------------------------------------------------ */

/**
 * Puntuación de idoneidad de un modelo de Gemini para tutoría.
 * `null` si el modelo no entra en el pool automático (solo familia Flash y
 * Gemma con tier gratuito).
 */
function scoreGeminiModel(name: string): number | null {
  // Gemini 1.5 Flash manda cuando el catálogo lo sirve: es el preferente de la
  // casa y puntúa por encima de cualquier otro. Si ya no aparece, la cadena usa
  // el mejor Flash del catálogo sin intentar un modelo retirado.
  if (name === DEFAULT_GEMINI_MODEL || name === `${DEFAULT_GEMINI_MODEL}-001`) return 20_000;
  if (name === `${DEFAULT_GEMINI_MODEL}-8b` || name === `${DEFAULT_GEMINI_MODEL}-8b-001`) return 19_900;
  const flashLite = name.match(/^gemini-(\d+)\.(\d+)-flash-lite$/);
  if (flashLite) {
    return 9000 + Number(flashLite[1]) * 100 + Number(flashLite[2]) * 10 + 1;
  }
  const flash = name.match(/^gemini-(\d+)\.(\d+)-flash$/);
  if (flash) {
    return 10000 + Number(flash[1]) * 100 + Number(flash[2]) * 10 + 5;
  }
  // gemma-4-31b-it / gemma-4-26b-a4b-it
  const gemma = name.match(/^gemma-(\d+)-(\d+)b(-a\d+b)?-it$/);
  if (gemma) {
    return 5000 + Number(gemma[1]) * 100 + Number(gemma[2]);
  }
  // Alias flotantes (último recurso: apuntan al último modelo estable).
  if (name === 'gemini-flash-latest') return 4000;
  if (name === 'gemini-flash-lite-latest') return 3900;
  return null;
}

/** Modelos de Gemini vetados: pago, multimodal no textual o experimental. */
// Los `preview`/`experimental` NO se vetan aquí: su permiso lo decide
// `ALLOW_PREVIEW_MODELS` en `modelCatalog` (así se pueden probar sin tocar el
// código, y en producción siguen fuera por defecto).
const GEMINI_VETO =
  /pro|image|tts|live|audio|omni|lyria|nano|banana|robotics|computer-use|deep-research|embedding|antigravity/i;

/**
 * Puntuación de idoneidad de un modelo de Groq (endpoint OpenAI-compatible).
 * Solo modelos de texto de propósito general; fuera audio, guard y visión.
 */
function scoreGroqModel(name: string): number | null {
  if (/whisper|tts|guard|audio|vision|embedding|preview|orpheus|canopylabs/i.test(name)) return null;
  // qwen/qwen3.8-27b (activo y ultra-rápido en Groq)
  if (name.includes('qwen')) return 12500;
  // openai/gpt-oss-120b → 12012, openai/gpt-oss-20b → 12002
  const oss = name.match(/^openai\/gpt-oss-(\d+)b$/);
  if (oss) return 12000 + Number(oss[1]) / 10;
  // llama-3.3-70b-versatile
  const llama = name.match(/^llama-(\d+)\.(\d+)-(\d+)b(-instant|-versatile)?$/);
  if (llama) {
    return 10000 + Number(llama[1]) * 100 + Number(llama[2]) * 10 + Number(llama[3]);
  }
  if (/^allam-/.test(name)) return 5000;
  return 6000;
}

/**
 * Puntuación de un modelo de OpenRouter (mismo dialecto que Groq).
 * Solo gratuitos (`:free`), fuera lo que no es texto general, y puntúan más las
 * familias que escriben bien en español y aguantan redacción larga.
 */
function scoreOpenRouterModel(name: string): number | null {
  if (!name.endsWith(':free')) return null;
  if (/whisper|tts|guard|audio|vision|image|embedding|rerank/i.test(name)) return null;
  if (/deepseek/i.test(name)) return 13500;
  if (/qwen/i.test(name)) return 13000;
  if (/mistral|mixtral/i.test(name)) return 12500;
  if (/llama-3\.3|llama-4/i.test(name)) return 12000;
  if (/gpt-oss/i.test(name)) return 11500;
  if (/nvidia\/nemotron/i.test(name)) return 12500;
  return 9000;
}

function scoreOllamaModel(name: string): number | null {
  if (/whisper|guard|embed/i.test(name)) return null;
  // Modelos ligeros idóneos para 8 GB RAM en CPU sin saturar memoria.
  if (/1\.5b|1b|tiny/i.test(name)) return 8500;
  if (/3b/i.test(name)) return 7000;
  if (/7b|8b/i.test(name)) return 4500;
  return 5000;
}

/** Puntuación de un modelo NVIDIA (Nemotron y familia) desde su endpoint propio.
 * El modelo estándar es `nvidia/nemotron:free` en OpenRouter, pero cuando se
 * usa la clave NVIDIA_API_KEY directamente contra `https://integrate.api.nvidia.com/v1`
 * también entran modelos como `nemotron` o `NVIDIA/nvidia-research`.
 */
function scoreNvidiaModel(name: string): number | null {
  if (!name.toLowerCase().includes('nemotron')) return null;
  if (/whisper|tts|guard|audio|vision|image|embedding/i.test(name)) return null;
  // Nemotron usualmente escribe bien y aguanta redacción larga.
  return 12500;
}

/* ------------------------------------------------------------------ */
/* Catálogos reales (con caché)                                        */

interface GeminiModelsPayload {
  models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
}
interface OpenAiModelsPayload {
  data?: Array<{ id?: string }>;
}
interface OllamaModelsPayload {
  models?: Array<{ name?: string }>;
}

const catalogCache = new Map<string, { at: number; list: string[] }>();

async function listGeminiModels(apiKey: string, cacheId: string): Promise<string[]> {
  // El catálogo se cachea por CREDENCIAL, no por proveedor: la lista que ve el
  // usuario A no se reutiliza para la clave del usuario B.
  const cacheKey = `gemini#${cacheId}`;
  const cached = catalogCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.list;
  try {
    const res = await fetch(`${GEMINI_MODELS_ENDPOINT}?pageSize=200`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as GeminiModelsPayload;
    const list = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((name) => name.length > 0);
    catalogCache.set(cacheKey, { at: Date.now(), list });
    return list;
  } catch (error) {
    console.warn(
      '[ia] Catálogo de Gemini no disponible; uso la cadena estática:',
      error instanceof Error ? error.message : String(error)
    );
    return GEMINI_STATIC_POOL;
  }
}

async function listGroqModels(apiKey: string, cacheId: string): Promise<string[]> {
  const cacheKey = `groq#${cacheId}`;
  const cached = catalogCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.list;
  try {
    const res = await fetch(GROQ_MODELS_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as OpenAiModelsPayload;
    const list = (data.data || [])
      .map((m) => String(m.id || '').trim())
      .filter((id) => id.length > 0);
    if (list.length === 0) throw new Error('Catálogo vacío');
    catalogCache.set(cacheKey, { at: Date.now(), list });
    return list;
  } catch (error) {
    console.warn(
      '[ia] Catálogo de Groq no disponible; uso la cadena estática:',
      error instanceof Error ? error.message : String(error)
    );
    return GROQ_STATIC_POOL;
  }
}

async function listOpenRouterModels(apiKey: string, cacheId: string): Promise<string[]> {
  const cacheKey = `openrouter#${cacheId}`;
  const cached = catalogCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.list;
  try {
    const res = await fetch(OPENROUTER_MODELS_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as OpenAiModelsPayload;
    const list = (data.data || [])
      .map((m) => String(m.id || '').trim())
      .filter((id) => id.endsWith(':free'));
    if (list.length === 0) throw new Error('Catálogo gratuito vacío');
    catalogCache.set(cacheKey, { at: Date.now(), list });
    return list;
  } catch (error) {
    console.warn(
      '[ia] Catálogo de OpenRouter no disponible; uso la cadena estática:',
      error instanceof Error ? error.message : String(error)
    );
    return OPENROUTER_STATIC_POOL;
  }
}

/**
 * Cuánto se recuerda que el motor local NO está. Corto a propósito: si lo
 * arrancas mientras estudias, entra solo en el turno siguiente.
 */
const OLLAMA_DOWN_TTL_MS = 90 * 1000;

async function listOllamaModels(): Promise<string[]> {
  const cached = catalogCache.get('ollama');
  if (cached) {
    const ttl = cached.list.length === 0 ? OLLAMA_DOWN_TTL_MS : CATALOG_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.list;
  }
  try {
    const res = await fetch(OLLAMA_MODELS_ENDPOINT, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as OllamaModelsPayload;
    const list = (data.models || [])
      .map((m) => String(m.name || '').trim())
      .filter((id) => id.length > 0);
    catalogCache.set('ollama', { at: Date.now(), list });
    return list;
  } catch {
    catalogCache.set('ollama', { at: Date.now(), list: [] });
    return [];
  }
}

/** Modelos de un proveedor ordenados de mejor a peor para nuestra tarea. */
export async function rankModels(provider: AiProvider): Promise<ModelCandidate[]> {
  if (provider === 'ollama') {
    const listed = await listOllamaModels();
    const ranked: ModelCandidate[] = [];
    // Con poca RAM no se ofrece un 7B ni un 13B aunque esté descargado.
    const free = freeMemoryMb();
    const tight = free !== null && free < 2600;
    for (const model of listed) {
      if (tight && /(^|[^0-9])(7|8|13|14|32|70|72)b/i.test(model)) continue;
      const score = scoreOllamaModel(model);
      if (score === null) continue;
      ranked.push({ provider: 'ollama', model, score, key: candidateKey('ollama', model) });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }
  const descriptor = getProviderDescriptor(provider);
  if (!descriptor) return [];
  const keyEntry = getProviderKeys(provider)[0];
  if (!keyEntry) return [];
  const ranked: ModelCandidate[] = [];
  const seen = new Set<string>();
  const vetoed = new Set(excludedModels(provider));
  const allowPreview = allowPreviewModels();

  // 1) La cadena CONFIGURADA manda. Es la que sabe qué modelos responden hoy:
  //    el catálogo de Google anunciaba `3.8-flash` y `3.7-flash` mientras los
  //    dos se quedaban colgados hasta el timeout; como puntuaban más alto, el
  //    turno entero se gastaba en ellos y el alumno veía «Sin IA» teniendo
  //    `3.6-flash` y `3.5-flash` sanos. El orden sale de `models.json` o de
  //    `AI_<PROVEEDOR>_MODELS`, no de este archivo.
  const configured = configuredModelChain(provider);
  const declared =
    configured.length > 0
      ? configured
      : (provider === 'custom' ? customModelsFromEnv() : descriptor.models.map((entry) => entry.id)).map(
          (id) => ({ id })
        );
  declared.forEach((entry, index) => {
    seen.add(entry.id);
    ranked.push({
      provider,
      model: entry.id,
      score: 100_000 - index,
      key: candidateKey(provider, entry.id),
    });
  });

  // 2) El catálogo real completa por detrás: un modelo nuevo entra solo, pero
  //    nunca por delante de los que ya sabemos que contestan. Los adaptadores
  //    nuevos usan su catálogo declarado; no se inventan ids.
  if (provider === 'gemini' || provider === 'groq' || provider === 'openrouter') {
    const apiKey = keyEntry.key;
    const listed =
      // El catálogo se cachea por LIBRO, no por `envVar`: en BYOK todas las
      // claves propias se llaman `usuario` y el catálogo de un alumno no debe
      // decidir el de otro.
      provider === 'gemini'
        ? await listGeminiModels(apiKey, keyEntry.ledgerId)
        : provider === 'groq'
          ? await listGroqModels(apiKey, keyEntry.ledgerId)
          : await listOpenRouterModels(apiKey, keyEntry.ledgerId);
    const scorer =
      provider === 'gemini'
        ? scoreGeminiModel
        : provider === 'groq'
          ? scoreGroqModel
          : scoreOpenRouterModel;
    const veto = provider === 'gemini' ? GEMINI_VETO : null;
    for (const model of listed) {
      if (seen.has(model) || vetoed.has(model)) continue;
      if (isPreviewModel(model) && !allowPreview) continue;
      seen.add(model);
      if (veto && veto.test(model)) continue;
      const score = scorer(model);
      if (score === null) continue;
      ranked.push({ provider, model, score, key: candidateKey(provider, model) });
    }
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/* ------------------------------------------------------------------ */
/* Salud de modelos y claves                                           */
/* ------------------------------------------------------------------ */

interface LedgerEntry {
  status: string;
  until: number;
  at: number;
  detail?: string;
}

const healthLedger = new Map<string, LedgerEntry>();
const keyLedger = new Map<string, LedgerEntry>();
const pairLedger = new Map<string, LedgerEntry>();

function cooldownFor(status: string, detail: string): number {
  switch (status) {
    case 'quota_daily':
      return COOLDOWN_QUOTA_DAILY_MS;
    case 'quota':
      // Algunos 429 son por minuto; si el texto huele a límite diario, se alarga.
      return detail.match(/per day|daily|RPD|TPD/i) !== null
        ? COOLDOWN_QUOTA_DAILY_MS
        : COOLDOWN_QUOTA_MS;
    case 'missing':
      return COOLDOWN_MISSING_MS;
    case 'auth':
      return COOLDOWN_AUTH_MS;
    default:
      return COOLDOWN_ERROR_MS;
  }
}

function markHealth(key: string, status: string, detail?: string): void {
  healthLedger.set(key, {
    status,
    until: status === 'ok' ? 0 : Date.now() + cooldownFor(status, detail || ''),
    at: Date.now(),
    detail,
  });
}

/** Segundos restantes de enfriamiento (0 si está disponible). */
export function getCooldownSeconds(key: string): number {
  const entry = healthLedger.get(key);
  if (!entry || entry.until === 0) return 0;
  return Math.max(0, Math.ceil((entry.until - Date.now()) / 1000));
}

function isCoolingDown(key: string): boolean {
  return getCooldownSeconds(key) > 0;
}

/**
 * Identidad de una clave en el libro: proveedor + `ledgerId`.
 *
 * `ledgerId` es la variable de entorno para una clave de plataforma y un HMAC
 * por cuenta para una clave propia. Antes, TODAS las claves propias llegaban
 * con `envVar: 'usuario'`, así que este id era `gemini#usuario` para todo el
 * mundo: el 429 de un alumno enfriaba la clave de los demás.
 */
function keyId(provider: AiProvider, ledgerId: string): string {
  return `${provider}#${ledgerId}`;
}

function markKeyHealth(
  provider: AiProvider,
  ledgerId: string,
  status: string,
  detail?: string
): void {
  keyLedger.set(keyId(provider, ledgerId), {
    status,
    until: status === 'ok' ? 0 : Date.now() + cooldownFor(status, detail || ''),
    at: Date.now(),
    detail,
  });
}

/**
 * Segundos que le quedan de enfriamiento a una clave (0 si está disponible).
 *
 * El segundo argumento es el `ledgerId` de la clave (ver `ProviderKey`), no el
 * `envVar` visible: en BYOK son distintos a propósito.
 */
export function getKeyCooldownSeconds(provider: AiProvider, ledgerId: string): number {
  const entry = keyLedger.get(keyId(provider, ledgerId));
  if (!entry || entry.until === 0) return 0;
  return Math.max(0, Math.ceil((entry.until - Date.now()) / 1000));
}

/*
 * Cuánto se ha usado cada clave: es lo que hace que el reparto sea justo. Se
 * cuenta cada intento (salga bien o mal), porque un intento que se quedó sin
 * cupo también gastó su turno contra esa clave.
 */
const keyCalls = new Map<string, number>();

function noteKeyUse(provider: AiProvider, ledgerId: string): void {
  const id = keyId(provider, ledgerId);
  keyCalls.set(id, (keyCalls.get(id) ?? 0) + 1);
}

/**
 * Intentos hechos con esta clave desde que arrancó la app (para el reparto).
 * Recibe el `ledgerId`, así que el contador es de esa cuenta y no de todos los
 * alumnos que usen el mismo proveedor.
 */
export function getKeyCallCount(provider: AiProvider, ledgerId: string): number {
  return keyCalls.get(keyId(provider, ledgerId)) ?? 0;
}

/*
 * EL CUPO ES DE CADA **MODELO**: se apunta al par «modelo#clave». Si un modelo
 * se queda sin cupo con la clave 1, ese modelo sigue teniendo cupo con la clave
 * 2, y los otros modelos siguen teniendo cupo con la clave 1.
 */
function pairId(modelKey: string, scope: string): string {
  return `${modelKey}#${scope}`;
}

function markPairHealth(modelKey: string, scope: string, status: string, detail?: string): void {
  pairLedger.set(pairId(modelKey, scope), {
    status,
    until: Date.now() + cooldownFor(status, detail || ''),
    at: Date.now(),
    detail,
  });
}

/**
 * Alcance del cupo «modelo + clave».
 *
 * En plataforma la etiqueta («principal», «2»…) ya es única por proveedor. En
 * BYOK todas las claves propias se llaman «principal», así que el alcance tiene
 * que ser el libro de la cuenta: si no, el cupo de un modelo se compartiría
 * entre alumnos.
 */
function pairScope(entry: ProviderKey): string {
  return entry.source === 'usuario' ? entry.ledgerId : entry.label;
}

/** Segundos de enfriamiento de un modelo con una clave concreta (0 = libre). */
export function getPairCooldownSeconds(modelKey: string, scope: string): number {
  const entry = pairLedger.get(pairId(modelKey, scope));
  if (!entry || entry.until === 0) return 0;
  return Math.max(0, Math.ceil((entry.until - Date.now()) / 1000));
}

/** ¿Se puede intentar este modelo con esta clave ahora mismo? */
function isKeyFreeFor(modelKey: string, provider: AiProvider, entry: ProviderKey): boolean {
  return (
    getKeyCooldownSeconds(provider, entry.ledgerId) === 0 &&
    getPairCooldownSeconds(modelKey, pairScope(entry)) === 0
  );
}

/**
 * EL REPARTO DE CARGA ENTRE CLAVES: con qué clave se empieza este turno.
 *
 * Probar siempre por el mismo orden hace que la primera clave se coma todo el
 * consumo hasta agotarse. Aquí, con el cupo intacto va primero la clave **menos
 * usada**; con cupo ya caído, va primero la que **más recientemente funcionó**.
 */
function keysForTurn(modelKey: string, provider: AiProvider): ProviderKey[] {
  const all = getProviderKeys(provider);
  const usable = all.filter((entry) => isKeyFreeFor(modelKey, provider, entry));
  if (usable.length <= 1) return usable;
  const ordered = [...usable].sort(
    (a, b) => getKeyCallCount(provider, a.ledgerId) - getKeyCallCount(provider, b.ledgerId)
  );
  if (usable.length < all.length) {
    const lastGoodScope = lastGoodKeyByModel.get(`${ledgerScope()}|${modelKey}`);
    const index = ordered.findIndex((entry) => pairScope(entry) === lastGoodScope);
    if (index > 0) {
      const [good] = ordered.splice(index, 1);
      ordered.unshift(good);
    }
  }
  return ordered;
}

/** Cuántos modelos de este proveedor están sin cupo con ESTE ámbito de clave. */
function countModelsOutOfQuota(provider: AiProvider, scope: string): number {
  let count = 0;
  for (const [id, entry] of pairLedger) {
    if (!id.startsWith(`${provider}:`) || !id.endsWith(`#${scope}`)) continue;
    if (Math.max(0, entry.until - Date.now()) > 0) count += 1;
  }
  return count;
}

/** Por qué no hay nada que probar con este modelo (para el rastro del turno). */
function noKeysReason(modelKey: string, provider: AiProvider): string {
  const keys = getProviderKeys(provider);
  if (keys.length === 0) return `sin clave para ${provider}`;
  const allKeysCooling = keys.every((entry) => getKeyCooldownSeconds(provider, entry.ledgerId) > 0);
  if (allKeysCooling) return `todas las claves de ${provider} están en enfriamiento`;
  return `el cupo de ${modelKey} está agotado en todas las claves`;
}

/**
 * Alcance del «último modelo bueno» para el juego de credenciales actual.
 *
 * Con BYOK, el modelo que le fue bien al alumno A no puede reordenar la cadena
 * del alumno B. El alcance sale de los propios `ledgerId` de la petición: para
 * claves propias es el HMAC de la cuenta; para plataforma, sus variables.
 */
function ledgerScope(): string {
  const ids = Array.from(new Set(scopedCredentials().map((entry) => entry.ledgerId))).sort();
  return ids.length > 0 ? ids.join('|') : 'sin-ambito';
}

/** Último modelo que respondió bien EN ESTA CUENTA (se promociona al frente). */
const lastGoodKeyByScope = new Map<string, string>();

/**
 * Y con qué CLAVE respondió bien cada modelo: con cupo caído, volver a probar
 * el modelo por la clave que acaba de funcionar ahorra el turno entero.
 * La clave del mapa es «alcance|modelo»; el valor, el ámbito de la clave.
 */
const lastGoodKeyByModel = new Map<string, string>();

export function getLastGoodKey(): string | null {
  return lastGoodKeyByScope.get(ledgerScope()) ?? null;
}

/** El proveedor de un identificador de modelo («gemini:x-flash» → `gemini`). */
function providerOfModelKey(modelKey: string): AiProvider | null {
  const index = modelKey.indexOf(':');
  return index > 0 ? modelKey.slice(0, index) : null;
}

/**
 * ¿Está el cupo tan justo que el trabajo de FONDO debe apartarse?
 *
 * Lo usan las tareas que no tienen a nadie esperando (rondas del vigilante,
 * memoria de los agentes, auditoría del temario): si se ejecutan con el cupo
 * gratuito en las últimas, le quitan la respuesta al alumno.
 */
export function isQuotaTight(): boolean {
  // Con el modelo local levantado no hay escasez que proteger.
  if (ollamaUp) return false;
  const providers = getConfiguredProviders().filter((provider) => provider !== 'ollama');
  if (providers.length === 0) return false;
  let freeKeys = 0;
  let cooling = false;
  for (const provider of providers) {
    for (const entry of getProviderKeys(provider)) {
      if (getKeyCooldownSeconds(provider, entry.ledgerId) === 0) freeKeys += 1;
      else cooling = true;
    }
  }
  const now = Date.now();
  for (const entry of pairLedger.values()) {
    if (entry.until > now) {
      cooling = true;
      break;
    }
  }
  if (freeKeys === 0) return true;
  if (freeKeys === 1 && cooling) return true;
  // El modelo en uso sin ninguna clave libre: la siguiente llamada de fondo ya
  // no tendría por dónde salir, así que no se le da el turno.
  const lastGoodKey = getLastGoodKey();
  if (lastGoodKey) {
    const provider = providerOfModelKey(lastGoodKey);
    if (provider) {
      const free = getProviderKeys(provider).filter((entry) =>
        isKeyFreeFor(lastGoodKey, provider, entry)
      ).length;
      if (free === 0) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Contabilidad del día                                                */
/* ------------------------------------------------------------------ */

let usage: { day: string; calls: number; failures: number; byProvider: Record<string, number> } = {
  day: '',
  calls: 0,
  failures: 0,
  byProvider: {},
};
let lastDecision: SelectionTrace | null = null;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function noteCall(provider: AiProvider | null, ok: boolean): void {
  const day = today();
  if (usage.day !== day) {
    usage = { day, calls: 0, failures: 0, byProvider: {} };
  }
  usage.calls += 1;
  if (!ok) usage.failures += 1;
  if (provider && ok) {
    usage.byProvider[provider] = (usage.byProvider[provider] ?? 0) + 1;
  }
}

export function getLastDecision(): SelectionTrace | null {
  return lastDecision;
}

export function getUsageToday(): {
  day: string;
  calls: number;
  failures: number;
  byProvider: Record<string, number>;
} {
  const day = today();
  if (usage.day !== day) {
    usage = { day, calls: 0, failures: 0, byProvider: {} };
  }
  return usage;
}

/* ------------------------------------------------------------------ */
/* Cadena de candidatos                                                */
/* ------------------------------------------------------------------ */

function configuredProviderOrder(): AiProvider[] {
  const forced = (process.env.AI_PROVIDER || 'auto').trim().toLowerCase();
  if (forced !== 'auto') {
    // Un despliegue puede fijar un proveedor para pruebas; sigue sin salirse
    // de las credenciales de la petición (si no hay, la cadena queda vacía).
    return getConfiguredProviders().filter((provider) => provider === forced);
  }

  const order = getConfiguredProviders();
  const priorities = new Map<string, number>();
  for (const credential of scopedCredentials()) {
    const current = priorities.get(credential.provider);
    const next = Number.isFinite(credential.priority) ? credential.priority : 1000;
    if (current === undefined || next < current) priorities.set(credential.provider, next);
  }
  return [...order].sort((a, b) => {
    if (a === 'ollama') return 1;
    if (b === 'ollama') return -1;
    return (priorities.get(a) ?? 1000) - (priorities.get(b) ?? 1000);
  });
}

function forcedModel(provider: AiProvider): string | null {
  const envName =
    provider === 'custom'
      ? 'AI_CUSTOM_MODEL'
      : `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MODEL`;
  const raw = process.env[envName] || '';
  const value = raw.trim();
  if (!value || value.toLowerCase() === 'auto') return null;
  return value;
}

/**
 * Cadena ordenada de modelos a intentar: el mejor primero, saltando los que
 * están en enfriamiento. Los modelos forzados por env van en cabeza.
 */
export async function getCandidateChain(only?: AiProvider): Promise<ModelCandidate[]> {
  // Antes de armar la cadena se mira (con caché) si hay modelo local.
  await probeOllama();
  const chain: ModelCandidate[] = [];
  const push = (candidate: ModelCandidate) => {
    if (!chain.some((c) => c.key === candidate.key)) chain.push(candidate);
  };
  for (const provider of configuredProviderOrder()) {
    if (only && provider !== only) continue;
    const forced = forcedModel(provider);
    if (forced) {
      push({
        provider,
        model: forced,
        score: Number.MAX_SAFE_INTEGER,
        key: candidateKey(provider, forced),
      });
    }
    for (const candidate of await rankModels(provider)) {
      if (isCoolingDown(candidate.key)) continue;
      push(candidate);
    }
  }
  // El último modelo que funcionó EN ESTA CUENTA va primero: acierta casi siempre.
  const lastGoodKey = getLastGoodKey();
  if (lastGoodKey) {
    const index = chain.findIndex((c) => c.key === lastGoodKey);
    if (index > 0) {
      const [good] = chain.splice(index, 1);
      chain.unshift(good);
    }
  }
  return chain;
}

/* ------------------------------------------------------------------ */
/* Errores                                                             */
/* ------------------------------------------------------------------ */

export class TutorError extends Error {
  status: number;
  detail?: string;
  kind?: string;

  constructor(message: string, status = 500, detail?: string, kind?: string) {
    super(message);
    this.name = 'TutorError';
    this.status = status;
    this.detail = detail;
    this.kind = kind;
  }
}

/**
 * Reintentos ante fallos TRANSITORIOS.
 *
 * Un 502 de «high demand», un 503 o un timeout no significan que el modelo esté
 * roto: significa que la petición ha llegado en mal momento. Los cupos agotados
 * (429) NO se reintentan: esperar un segundo no devuelve la cuota.
 */
/**
 * Intentos por modelo.
 *
 * Tres huecos, pero solo UNO espera y reintenta: insistir a un 5xx saturado no
 * lo descongestiona y le quita el turno a los modelos que sí están sanos. El
 * hueco extra es para el recorte de prompt (413/ITPM), que no necesita esperar.
 */
const MAX_ATTEMPTS_PER_MODEL = 3;
const TRANSIENT_RETRIES = 1;
const TRANSIENT_BACKOFF_MS = [600];

/**
 * El presupuesto de tiempo de un turno de IA (toda la cadena de modelos).
 * Con tope, el que llama sabe cuánto espera como mucho y puede responder en
 * local en vez de dejar al alumno mirando el chat.
 *
 * En Netlify la función se corta a los pocos segundos (10 s en el plan
 * gratuito, 26 s en el de pago). Un presupuesto mayor no da más tiempo: la
 * plataforma mata la petición y el alumno no recibe ni la respuesta ni el
 * respaldo local. Por eso allí se conforma con 7 s, que es lo que tarda un
 * flash en contestar cuando el proveedor va bien.
 */
function aiTurnBudgetMs(): number {
  const raw = Number(process.env.AI_BUDGET_MS);
  if (Number.isFinite(raw) && raw >= 2_000) return raw;
  if (process.env.NETLIFY) return 8_000;
  return 30_000;
}

export const AI_TEXT_BUDGET_MS = aiTurnBudgetMs();

/**
 * Tope de UN intento (un modelo con una clave).
 *
 * Antes eran 16 s: un modelo saturado que no contesta se comía el turno entero
 * y los modelos sanos que venían detrás no llegaban a probarse nunca. Ahora un
 * intento callado se corta pronto para que la cadena siga.
 */
export const AI_ATTEMPT_MAX_MS = Math.min(process.env.NETLIFY ? 4_000 : 7_000, AI_TEXT_BUDGET_MS);

/**
 * Por debajo de esto no se empieza un intento nuevo: no daría tiempo a nada.
 *
 * Con 4 s, en Netlify (presupuesto de 8 s) un modelo lento dejaba el turno sin
 * margen para el proveedor de al lado y la cadena se rendía. Un proveedor sano
 * contesta en medio segundo, así que basta con 1,5 s para intentarlo.
 */
const MIN_ATTEMPT_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ¿El fallo ha sido el reloj (timeout) y no el proveedor? */
function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  return name === 'TimeoutError' || name === 'AbortError';
}

function classifyStatus(status: number, providerMessage: string): string {
  if (status === 429) return /per day|daily|RPD|TPD/i.test(providerMessage) ? 'quota_daily' : 'quota';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'missing';
  return 'error';
}

/** Cómo se llama cada motor cuando hay que explicárselo al alumno. */
function providerLabel(provider: AiProvider): string {
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'groq') return 'Groq';
  if (provider === 'openrouter') return 'OpenRouter';
  if (provider === 'nvidia') return 'NVIDIA';
  return 'el modelo local';
}

function describeHttpError(provider: AiProvider, status: number, providerMessage: string): TutorError {
  // «Request too large … (ITPM): Limit 7000, Requested 9000» NO es una caída del
  // proveedor: es que la petición no cabe. Reintentarla igual es perder el turno
  // tres veces para acabar en el mismo sitio.
  if (
    status === 413 ||
    /request too large|tokens per minute|ITPM|context length|maximum context|reduce your message size|too many tokens/i.test(
      providerMessage
    )
  ) {
    return new TutorError(
      'La petición no cabe en este modelo (demasiado texto para su cupo por minuto). Se recorta y se reintenta.',
      413,
      providerMessage,
      'too_large'
    );
  }
  const kind = classifyStatus(status, providerMessage);
  if (status === 429) {
    return new TutorError('Este modelo ha agotado su cupo gratuito por ahora.', 429, providerMessage, kind);
  }
  // El motor local no tiene claves ni permisos: un 401/403 aquí es una puerta
  // cerrada del propio Ollama, y un 404, un modelo que no está descargado.
  if (provider === 'ollama') {
    if (status === 404) {
      return new TutorError(
        'Ese modelo no está descargado en tu motor local. Descárgalo desde la guía de Ajustes (te dice cuál te conviene y por qué).',
        404,
        providerMessage,
        kind
      );
    }
    return new TutorError(
      `El modelo local ha contestado con un error (HTTP ${status}). Comprueba que el servicio esté levantado.`,
      502,
      providerMessage,
      kind
    );
  }
  if (status === 400 || status === 401 || status === 403) {
    return new TutorError(
      'La clave de IA no es válida o no tiene permisos. Revísala en Ajustes.',
      502,
      providerMessage,
      kind
    );
  }
  if (status === 404) {
    return new TutorError('Modelo no disponible.', 404, providerMessage, kind);
  }
  return new TutorError('El servicio de IA está fallando.', 502, providerMessage, kind);
}

/** Aplana la respuesta de la API de Interactions para quedarnos con el texto. */
/**
 * Historial de chat → pasos de la API de Interactions (Gemini).
 *
 * No todos los llamadores mandan `history` (la puesta a punto solo reenviaba
 * `messages`), y Gemini, al no recibir nada, contestaba como si cada mensaje
 * fuera el primero de la conversación: repetía preguntas ya respondidas y se
 * olvidaba de las correcciones del turno anterior. Con esto, cualquier ruta
 * que pase historial en formato chat tiene memoria en TODOS los proveedores.
 */
function chatMessagesToSteps(messages: ChatMessage[]): unknown[] {
  const steps: unknown[] = [];
  for (const message of messages) {
    const content = String(message?.content ?? '').trim();
    if (content.length === 0) continue;
    if (message.role === 'user') {
      steps.push(buildUserInputStep(content));
    } else if (message.role === 'assistant') {
      steps.push({ type: 'model_output', content: [{ type: 'text', text: content }] });
    }
  }
  return steps;
}

export function extractTutorText(steps: unknown[]): string {
  const chunks: string[] = [];
  for (const step of steps) {
    const candidate = step as { type?: string; content?: unknown };
    if (candidate?.type !== 'model_output' || !Array.isArray(candidate.content)) continue;
    for (const item of candidate.content) {
      const part = item as { type?: string; text?: string };
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        chunks.push(part.text.trim());
      }
    }
  }
  return chunks.join('\n\n').trim();
}

/* ------------------------------------------------------------------ */
/* Transportes                                                         */
/* ------------------------------------------------------------------ */

interface TransportParams {
  apiKey?: string;
  model: string;
  systemInstruction: string;
  message: string;
  messages?: ChatMessage[];
  history?: unknown[];
  attachments?: AiAttachmentPart[];
  readableTextAttachments?: string[];
  maxTokens?: number;
  timeoutMs?: number;
  /** Señal externa del hedge: aborta al perdedor sin tocar su timeout propio. */
  signal?: AbortSignal;
}

/** Timeout del intento + cancelación del hedge, en una sola señal. */
function attemptSignal(timeoutMs: number | undefined, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs ?? AI_ATTEMPT_MAX_MS);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

interface OpenAiChatPayload {
  choices?: Array<{
    message?: { content?: string; reasoning?: string };
    finish_reason?: string;
  }>;
  error?: { message?: string } | string;
}
interface GeminiPayload {
  steps?: unknown[];
  /** Texto plano, por si la API deja de devolver `steps`. */
  output_text?: string;
  /** Formato clásico de GenerateContent, por si se cae a ese endpoint. */
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
}

/**
 * El texto del modelo, mirando las tres formas en que puede llegar.
 * Antes solo se leían los `steps`: si el proveedor cambiaba de sobre, la app
 * lo interpretaba como «respuesta vacía» y se degradaba sin motivo.
 */
function extractGeminiText(payload: GeminiPayload | null): string {
  const fromSteps = extractTutorText(Array.isArray(payload?.steps) ? payload.steps : []);
  if (fromSteps) return fromSteps;
  const flat = typeof payload?.output_text === 'string' ? payload.output_text.trim() : '';
  if (flat) return flat;
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('').trim();
}

async function callGemini(params: TransportParams): Promise<{ text: string; steps: unknown[] }> {
  // Si el llamador ya manda pasos crudos, esos mandan (llevan los adjuntos del
  // turno). Si no, se reconstruye la conversación desde el historial de chat.
  const history =
    params.history && params.history.length > 0
      ? params.history
      : chatMessagesToSteps(params.messages ?? []);
  const input = [...history, buildUserInputStep(params.message, params.attachments ?? [])];
  let res: Response;
  try {
    res = await fetch(GEMINI_INTERACTIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': params.apiKey ?? '',
      },
      body: JSON.stringify({
        model: params.model,
        system_instruction: params.systemInstruction,
        store: false,
        input,
      }),
      signal: attemptSignal(params.timeoutMs, params.signal),
    });
  } catch (error) {
    // Un modelo lento NO se reintenta: el reintento vuelve a esperar los mismos
    // segundos por el mismo modelo y se come el turno de los que sí contestan.
    const timedOut = isTimeoutError(error);
    throw new TutorError(
      timedOut
        ? 'Tu proveedor de IA ha tardado demasiado en contestar. Se prueba el siguiente modelo.'
        : 'No se pudo contactar con el servicio de IA. Comprueba tu conexión e inténtalo de nuevo.',
      timedOut ? 504 : 502,
      error instanceof Error ? error.message : String(error),
      timedOut ? 'timeout' : undefined
    );
  }
  const payload = (await res.json().catch(() => null)) as GeminiPayload | null;
  if (!res.ok) {
    throw describeHttpError('gemini', res.status, payload?.error?.message || `HTTP ${res.status}`);
  }
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  const text = extractGeminiText(payload);
  if (!text) {
    throw new TutorError('El modelo no ha devuelto ninguna respuesta. Reinténtalo.', 502, 'Respuesta vacía del proveedor');
  }
  return { text, steps };
}

type OpenAiContentPart = Record<string, unknown>;

interface OpenAiMessage {
  role: string;
  content: string | OpenAiContentPart[];
}

function isImageAttachment(part: AiAttachmentPart): boolean {
  return /^image\//i.test(part.mimeType);
}

/**
 * Construye los mensajes del dialecto OpenAI (Groq, OpenRouter, Ollama).
 * Las capturas van como `image_url` en data URL SOLO si el modelo elegido lee
 * imágenes; el resto se nombra en el aviso honesto. Y un PDF cuyo texto ya está
 * en el prompt no se marca como «no leído»: su contenido sí viaja.
 */
function openAiMessages(params: TransportParams, provider: AiProvider): OpenAiMessage[] {
  const attachments = params.attachments ?? [];
  const readable = new Set(params.readableTextAttachments ?? []);
  const visionAttachments = attachments.filter(
    (attachment) => isImageAttachment(attachment) && modelSupportsVision(provider, params.model)
  );
  const notReadable = attachments.filter(
    (attachment) => !readable.has(attachment.name) && !visionAttachments.includes(attachment)
  );
  const note = attachmentsNotReadableNote(notReadable);

  const base: OpenAiMessage[] = [
    { role: 'system', content: params.systemInstruction },
    ...(params.messages ?? []).map((message) => ({ role: message.role, content: message.content })),
  ];

  if (visionAttachments.length === 0) {
    return [...base, { role: 'user', content: params.message + note }];
  }

  return [
    ...base,
    {
      role: 'user',
      content: [
        { type: 'text', text: params.message + note },
        ...visionAttachments.map((attachment) => ({
          type: 'image_url',
          image_url: { url: `data:${attachment.mimeType};base64,${attachment.data}` },
        })),
      ],
    },
  ];
}

async function callOpenAiCompatible(
  provider: AiProvider,
  endpoint: string,
  params: TransportParams
): Promise<{ text: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider !== 'ollama') headers.Authorization = `Bearer ${params.apiKey ?? ''}`;
  // Cabeceras de cortesía de OpenRouter: identifican la app que llama.
  if (provider === 'openrouter') headers['X-Title'] = 'BrainUp Academy';

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: params.model,
        messages: openAiMessages(params, provider),
        temperature: 0.4,
        max_tokens: params.maxTokens ?? 2048,
        // Los gpt-oss de Groq son modelos de razonamiento: con `reasoning_effort`
        // alto se gastan el cupo de salida pensando y devuelven `content` vacío
        // (el log estaba lleno de «Respuesta vacía del proveedor»). En una app
        // de tutoría no hace falta razonar tan profundo para contestar.
        ...(provider !== 'ollama' && /gpt-oss/i.test(params.model)
          ? { reasoning_effort: 'low' }
          : {}),
      }),
      signal: attemptSignal(params.timeoutMs, params.signal),
    });
  } catch (error) {
    const timedOut = isTimeoutError(error);
    const message =
      provider === 'ollama'
        ? 'No se pudo contactar con el modelo local. Comprueba que el servicio esté iniciado en el puerto 11434.'
        : timedOut
          ? 'Tu proveedor de IA ha tardado demasiado en contestar. Se prueba el siguiente modelo.'
          : 'No se pudo contactar con el servicio de IA. Comprueba tu conexión e inténtalo de nuevo.';
    throw new TutorError(
      message,
      timedOut ? 504 : 502,
      error instanceof Error ? error.message : String(error),
      timedOut ? 'timeout' : undefined
    );
  }

  const payload = (await res.json().catch(() => null)) as OpenAiChatPayload | null;
  if (!res.ok) {
    const providerMessage =
      typeof payload?.error === 'object'
        ? payload?.error?.message
        : typeof payload?.error === 'string'
          ? payload.error
          : undefined;
    throw describeHttpError(provider, res.status, providerMessage || `HTTP ${res.status}`);
  }
  const text = (payload?.choices?.[0]?.message?.content || '').trim();
  if (!text) {
    const emptyMessage =
      provider === 'ollama'
        ? 'El modelo local no ha devuelto ninguna respuesta. Reinténtalo.'
        : 'El modelo no ha devuelto ninguna respuesta. Reinténtalo.';
    const finish = payload?.choices?.[0]?.finish_reason ?? 'desconocido';
    throw new TutorError(
      emptyMessage,
      502,
      `Respuesta vacía del proveedor (finish_reason: ${finish})`
    );
  }
  return { text };
}

interface AnthropicPayload {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

function anthropicMessages(params: TransportParams): Array<Record<string, unknown>> {
  const history = (params.messages ?? [])
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, content: message.content }));
  const attachments = (params.attachments ?? []).filter(
    (attachment) => isImageAttachment(attachment) && modelSupportsVision('anthropic', params.model)
  );
  if (attachments.length === 0) return [...history, { role: 'user', content: params.message }];
  return [
    ...history,
    {
      role: 'user',
      content: [
        { type: 'text', text: params.message },
        ...attachments.map((attachment) => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: attachment.mimeType,
            data: attachment.data,
          },
        })),
      ],
    },
  ];
}

async function callAnthropic(params: TransportParams, endpoint: string): Promise<{ text: string }> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': params.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.maxTokens ?? 2048,
        system: params.systemInstruction,
        messages: anthropicMessages(params),
      }),
      signal: attemptSignal(params.timeoutMs, params.signal),
    });
  } catch (error) {
    const timedOut = isTimeoutError(error);
    throw new TutorError(
      timedOut
        ? 'Tu proveedor de IA ha tardado demasiado en contestar. Se prueba el siguiente modelo.'
        : 'No se pudo contactar con el servicio de IA. Comprueba tu conexión e inténtalo de nuevo.',
      timedOut ? 504 : 502,
      error instanceof Error ? error.message : String(error),
      timedOut ? 'timeout' : undefined
    );
  }
  const payload = (await res.json().catch(() => null)) as AnthropicPayload | null;
  if (!res.ok) {
    throw describeHttpError('anthropic', res.status, payload?.error?.message || `HTTP ${res.status}`);
  }
  const text = (payload?.content ?? [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('')
    .trim();
  if (!text) {
    throw new TutorError('El modelo no ha devuelto ninguna respuesta. Reinténtalo.', 502, 'Respuesta vacía del proveedor');
  }
  return { text };
}

/** Una sola generación local a la vez, y solo si hay memoria para ella. */
async function callOllama(params: TransportParams): Promise<{ text: string }> {
  return withOllamaLock(async () => {
    if (!hasRoomForLocalModel()) {
      const memory = localModelMemory();
      throw new TutorError(
        'El modelo local no cabe ahora mismo en la memoria del ordenador, así que no se ha cargado. Cierra alguna pestaña o programa y reinténtalo.',
        503,
        `RAM libre ${memory.freeMb ?? '?'} MB < ${memory.minFreeMb} MB`
      );
    }
    const result = await callOpenAiCompatible('ollama', OLLAMA_CHAT_ENDPOINT, params);
    ollamaLastUsed = Date.now();
    ollamaLoadedModel = params.model;
    // Si la respuesta ha dejado el equipo sin aire, se descarga ya. Si no, se
    // deja cargado para el turno siguiente.
    if (!hasRoomForLocalModel()) {
      await unloadOllamaModel(params.model);
    } else {
      scheduleOllamaUnload(params.model);
    }
    return result;
  });
}

/**
 * ¿Cabe otro intento del MISMO modelo dejando margen a los que vienen detrás?
 * Cada candidato que queda necesita al menos `MIN_ATTEMPT_MS` para contestar.
 */
function hasRoomToRetry(deadline: number, backoffMs: number, othersLeft: number): boolean {
  const leftAfterBackoff = deadline - Date.now() - backoffMs;
  return leftAfterBackoff - othersLeft * MIN_ATTEMPT_MS >= MIN_ATTEMPT_MS;
}

/**
 * Pone delante el primer candidato de OTRO proveedor que quede detrás en la
 * cola. Un 502 de «high demand», un 503 o un tiempo agotado hablan del
 * proveedor, no del modelo.
 */
function promoteOtherProvider(queue: ModelCandidate[], index: number): ModelCandidate | null {
  const failed = queue[index];
  if (!failed) return null;
  const other = queue.findIndex((c, i) => i > index && c.provider !== failed.provider);
  if (other < 0 || other === index + 1) return null;
  const [promoted] = queue.splice(other, 1);
  queue.splice(index + 1, 0, promoted);
  console.warn(`[ia] ${failed.key} no responde (fallo del proveedor): se prueba antes ${promoted.key}`);
  return promoted;
}

type KeyOutcome = AiTextResult | 'next-key' | 'stop';

/** Endpoint de chat del adaptador, con el baseUrl de la credencial si lo hay. */
function chatEndpoint(provider: AiProvider, baseUrl?: string): string | null {
  const descriptor = getProviderDescriptor(provider);
  if (!descriptor) return null;
  const base = (baseUrl ?? descriptor.baseUrl ?? '').replace(/\/+$/, '');
  if (!base) return null;
  const defaultPath = descriptor.adapter === 'anthropic-messages' ? '/messages' : '/chat/completions';
  return `${base}${descriptor.chatPath ?? defaultPath}`;
}

/**
 * Un intento de transporte, con el adaptador que diga el catálogo.
 *
 * Es el único sitio que traduce `provider` a dialecto. Lo usan el bucle normal
 * y el hedge, así que una mejora en un adaptador vale para los dos.
 */
async function dispatchCandidate(input: {
  candidate: ModelCandidate;
  apiKey: string;
  baseUrl?: string;
  systemInstruction: string;
  params: AiTextParams;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ text: string; steps?: unknown[] }> {
  const { candidate, apiKey, systemInstruction, params, timeoutMs, signal } = input;
  if (candidate.provider === 'ollama') {
    return callOllama({
      model: candidate.model,
      systemInstruction,
      messages: params.messages ?? [],
      message: params.message,
      attachments: params.attachments ?? [],
      readableTextAttachments: params.readableTextAttachments,
      maxTokens: params.maxTokens,
      timeoutMs,
      signal,
    });
  }

  const adapter = getProviderDescriptor(candidate.provider)?.adapter;
  if (adapter === 'gemini-interactions') {
    return callGemini({
      apiKey,
      model: candidate.model,
      systemInstruction,
      history: params.history ?? [],
      messages: params.messages ?? [],
      message: params.message,
      attachments: params.attachments ?? [],
      timeoutMs,
      signal,
    });
  }

  const endpoint = chatEndpoint(candidate.provider, input.baseUrl);
  if (!endpoint) {
    throw new TutorError(
      'Esa clave no tiene un endpoint válido configurado. Revísala en Ajustes.',
      502,
      `sin endpoint para ${candidate.provider}`
    );
  }

  if (adapter === 'anthropic-messages') {
    return callAnthropic(
      {
        apiKey,
        model: candidate.model,
        systemInstruction,
        messages: params.messages ?? [],
        message: params.message,
        attachments: params.attachments ?? [],
        readableTextAttachments: params.readableTextAttachments,
        maxTokens: params.maxTokens,
        timeoutMs,
        signal,
      },
      endpoint
    );
  }
  if (adapter === 'openai-chat') {
    return callOpenAiCompatible(candidate.provider, endpoint, {
      apiKey,
      model: candidate.model,
      systemInstruction,
      messages: params.messages ?? [],
      message: params.message,
      attachments: params.attachments ?? [],
      readableTextAttachments: params.readableTextAttachments,
      maxTokens: params.maxTokens,
      timeoutMs,
      signal,
    });
  }
  throw new TutorError(
    'Ese proveedor de IA no está soportado por este motor.',
    502,
    `adaptador desconocido para ${candidate.provider}`
  );
}

/* ------------------------------------------------------------------ */
/* Turno                                                               */
/* ------------------------------------------------------------------ */

export async function runAiText(params: AiTextParams): Promise<AiTextResult> {
  // Sin credenciales resueltas para ESTA petición no se llama a nadie. Es la
  // última red: aunque una ruta se olvidara de la puerta, el motor no lee el
  // `.env` ni gasta la clave de plataforma por su cuenta.
  const scoped = currentAiCredentials();
  if (scoped === null && platformCredentialsForTests() === null) {
    throw new AiKeyRequiredError(
      'Esta petición no trae credenciales de IA de ningún usuario. No se usa la clave de plataforma por defecto.'
    );
  }
  if (scoped !== null && scoped.length === 0) throw new AiKeyRequiredError();

  // El trabajo de fondo cede el turno cuando el cupo está justo: ni se consulta
  // el catálogo ni se gasta un intento.
  if (params.priority === 'fondo' && isQuotaTight()) {
    throw new TutorError(
      BACKGROUND_YIELD_MESSAGE,
      429,
      'cupo justo: el turno de fondo cede el cupo al alumno',
      'quota'
    );
  }
  let chain = await getCandidateChain(params.provider);
  const attempts: Array<{ key: string; outcome: string; note?: string }> = [];
  // El reloj del turno: la cadena entera comparte un solo presupuesto.
  const budgetMs = Math.max(1_000, params.budgetMs ?? AI_TEXT_BUDGET_MS);
  const deadline = Date.now() + budgetMs;
  const requiresVision = params.requiresVision === true || (params.attachments ?? []).length > 0;

  // Sin ninguna credencial/candidato no hay nada que filtrar: se conserva el
  // mensaje que ya explicaba las dos salidas (clave o modelo local).
  if (chain.length === 0) {
    const configured = getConfiguredProviders();
    const hasCloudKeys = configured.some((provider) => provider !== 'ollama');
    const forcedNote = params.provider
      ? ' El motor elegido no tiene ahora mismo ningún modelo con cupo disponible.'
      : '';
    const message =
      (!hasCloudKeys
        ? 'El motor de IA no tiene por dónde funcionar: esta cuenta no tiene ninguna clave de IA disponible y tampoco hay un modelo local activo. Añade tu clave en Ajustes o activa el modelo local.'
        : 'Todos los modelos gratuitos están saturados ahora mismo. Espera un minuto y reinténtalo.') +
      forcedNote;
    lastDecision = { at: Date.now(), provider: null, model: null, ranked: [], attempts };
    throw new TutorError(message, configured.length === 0 ? 503 : 429, 'Sin candidatos disponibles');
  }

  /**
   * ENRUTADO POR CAPACIDAD, ANTES DE LLAMAR.
   *
   * La cadena ya sale solo de las credenciales de este perfil. Aquí se filtra
   * por lo que el turno exige de verdad (visión para imágenes/PDF, tools, JSON)
   * y se elige campeón + hedge dentro de esos candidatos. Si nada cubre una
   * capacidad, no se envía la petición: se degrada con un mensaje de producto.
   */
  const requiredCapabilities = {
    vision: requiresVision,
    tools: params.requiresTools === true,
    json: params.requiresJson === true,
  };
  const routing = planRoute({
    models: chain.map((candidate) => ({
      provider: candidate.provider,
      model: candidate.model,
      key: candidate.key,
    })),
    required: requiredCapabilities,
  });
  if (routing.ranked.length === 0) {
    lastDecision = { at: Date.now(), provider: null, model: null, ranked: [], attempts: [] };
    throw new TutorError(
      capabilityDegradationMessage(routing.missing),
      422,
      `capacidades no cubiertas: ${routing.missing.join(', ') || 'sin candidatos'}`
    );
  }
  chain = routing.ranked.map((candidate) => ({
    provider: candidate.provider,
    model: candidate.model,
    score: 0,
    key: candidate.key ?? candidateKey(candidate.provider, candidate.model),
  }));
  lastDecision = {
    at: Date.now(),
    provider: null,
    model: null,
    ranked: chain.map((c) => c.key),
    attempts,
  };
  const decision = lastDecision;
  /** Se ha visto un 429 de verdad del proveedor. */
  let sawQuota = false;
  /** No se ha llegado a pedir nada porque el cupo estaba en enfriamiento. */
  let quotaSkipped = false;
  let lastError: TutorError | null = null;
  // Copia mutable: el orden puede cambiar sobre la marcha.
  const queue = [...chain];
  /**
   * Fallos seguidos de cada proveedor en ESTE turno. Distingue un modelo
   * saturado (se prueba el siguiente del mismo proveedor) de un proveedor
   * caído (se adelanta otro).
   */
  const providerFailures = new Map<AiProvider, number>();

  /**
   * HEDGE DENTRO DEL PERFIL.
   *
   * El campeón sale ya; a los 700 ms se lanza el primer modelo de OTRO
   * proveedor de las mismas claves. Gana el primero que contesta y el otro se
   * aborta. Nunca se añade un proveedor que no esté en la cadena del alumno.
   * Fuera del chat (trabajo de fondo) o con un proveedor forzado no se hace.
   */
  if (params.hedge !== false && params.priority !== 'fondo' && queue.length > 1) {
    const champion = queue[0];
    const hedgeIndex = queue.findIndex(
      (candidate, index) => index > 0 && candidate.provider !== champion.provider
    );
    const hedge = hedgeIndex > 0 ? queue[hedgeIndex] : null;
    if (hedge && champion.provider !== 'ollama' && hedge.provider !== 'ollama') {
      const championKey = keysForTurn(champion.key, champion.provider)[0];
      const hedgeKey = keysForTurn(hedge.key, hedge.provider)[0];
      if (championKey && hedgeKey) {
        const controller = new AbortController();
        const run = async (
          candidate: ModelCandidate,
          key: ProviderKey,
          delayMs: number
        ): Promise<{ candidate: ModelCandidate; key: ProviderKey; text: { text: string; steps?: unknown[] } }> => {
          if (delayMs > 0) await sleep(delayMs);
          if (controller.signal.aborted) throw new Error('hedge abortado');
          const left = deadline - Date.now();
          if (left <= MIN_ATTEMPT_MS) throw new Error('sin tiempo para el hedge');
          const text = await dispatchCandidate({
            candidate,
            apiKey: key.key,
            baseUrl: key.baseUrl,
            systemInstruction: params.systemInstruction,
            params,
            timeoutMs: Math.max(MIN_ATTEMPT_MS, Math.min(left, params.attemptMs ?? AI_ATTEMPT_MAX_MS)),
            signal: controller.signal,
          });
          return { candidate, key, text };
        };

        try {
          const winner = await Promise.any([
            run(champion, championKey, 0),
            run(hedge, hedgeKey, 700),
          ]);
          controller.abort();
          providerFailures.delete(winner.candidate.provider);
          markHealth(winner.candidate.key, 'ok');
          markKeyHealth(winner.candidate.provider, winner.key.ledgerId, 'ok');
          lastGoodKeyByScope.set(ledgerScope(), winner.candidate.key);
          lastGoodKeyByModel.set(`${ledgerScope()}|${winner.candidate.key}`, pairScope(winner.key));
          noteCall(winner.candidate.provider, true);
          attempts.push({
            key: `${winner.candidate.key}#${winner.key.label}`,
            outcome: 'ok',
            note: 'hedge',
          });
          decision.provider = winner.candidate.provider;
          decision.model = winner.candidate.model;
          return {
            text: winner.text.text,
            steps: winner.text.steps ?? [],
            model: winner.candidate.model,
            provider: winner.candidate.provider,
          };
        } catch {
          // Los dos fallaron o se quedaron sin tiempo: sigue el bucle normal,
          // que sabe clasificar el error y probar las claves restantes.
          controller.abort();
        }
      }
    }
  }
  for (let index = 0; index < queue.length; index++) {
    const candidate = queue[index];
    /** Candidatos que quedan por probar detrás de este (sin contarlo a él). */
    const othersLeft = queue.length - index - 1;

    // Las claves de este proveedor que ahora se pueden usar. Si no queda
    // ninguna, no se recorren sus modelos para nada: se apunta y se pasa al
    // proveedor siguiente.
    const keys = keysForTurn(candidate.key, candidate.provider);
    if (keys.length === 0) {
      const reason = noKeysReason(candidate.key, candidate.provider);
      if (!reason.startsWith('sin clave')) quotaSkipped = true;
      attempts.push({ key: candidate.key, outcome: 'skipped', note: reason });
      continue;
    }

    // Se acabó el tiempo del turno: no se empieza otro modelo para nada.
    if (deadline - Date.now() <= MIN_ATTEMPT_MS) {
      attempts.push({ key: candidate.key, outcome: 'budget', note: 'sin tiempo en el turno' });
      lastError = new TutorError(
        'La IA ha tardado más de lo que se le da de tiempo para este turno. Vuelve a intentarlo: suele ser cosa de la saturación del momento.',
        503,
        `presupuesto de ${budgetMs} ms agotado antes de probar ${candidate.key}`
      );
      break;
    }

    /**
     * Prueba ESTE modelo con UNA clave, con sus reintentos transitorios.
     * Devuelve la respuesta, `'next-key'` (lo que falla es la clave) o `'stop'`
     * (lo que falla es el modelo o el proveedor).
     */
    const tryKey = async (keyEntry: ProviderKey, keysLeft: number): Promise<KeyOutcome> => {
      const apiKey = keyEntry.key;
      const attemptKey = `${candidate.key}#${keyEntry.label}`;
      noteKeyUse(candidate.provider, keyEntry.ledgerId);
      /** Nivel de recorte del prompt de sistema (0 = sin apretar). */
      let compactLevel = 0;

      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_MODEL; attempt++) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= MIN_ATTEMPT_MS) {
          attempts.push({
            key: attemptKey,
            outcome: 'budget',
            note: attempt > 0 ? `sin tiempo para el intento ${attempt + 1}` : 'sin tiempo en el turno',
          });
          return 'stop';
        }
        // Cada intento tiene su propio tope, y nunca más que lo que le queda al
        // turno: un proveedor colgado no se come el presupuesto de los demás.
        const attemptTimeoutMs = Math.max(
          MIN_ATTEMPT_MS,
          Math.min(remainingMs, params.attemptMs ?? AI_ATTEMPT_MAX_MS)
        );
        // Un PDF enorme no se manda entero: se recorta lo justo para que quepa.
        const systemInstruction = compactSystemInstruction(params.systemInstruction, compactLevel);

        try {
          const result = await dispatchCandidate({
            candidate,
            apiKey,
            baseUrl: keyEntry.baseUrl,
            systemInstruction,
            params,
            timeoutMs: attemptTimeoutMs,
          });

          providerFailures.delete(candidate.provider);
          markHealth(candidate.key, 'ok');
          markKeyHealth(candidate.provider, keyEntry.ledgerId, 'ok');
          // Solo esta cuenta recuerda que este modelo le fue bien.
          lastGoodKeyByScope.set(ledgerScope(), candidate.key);
          lastGoodKeyByModel.set(`${ledgerScope()}|${candidate.key}`, pairScope(keyEntry));
          noteCall(candidate.provider, true);
          attempts.push({
            key: attemptKey,
            outcome: 'ok',
            note: attempt > 0 ? `al intento ${attempt + 1}` : undefined,
          });
          decision.provider = candidate.provider;
          decision.model = candidate.model;
          return {
            text: result.text,
            steps: result.steps ?? [],
            model: candidate.model,
            provider: candidate.provider,
          };
        } catch (error) {
          const tutorError =
            error instanceof Error
              ? error
              : new TutorError('Error inesperado de IA.', 500, String(error));
          const detail = 'detail' in tutorError ? String(tutorError.detail ?? '') : '';
          const status = 'status' in tutorError ? Number(tutorError.status) : 500;
          // El transporte ya sabe qué pasó de verdad: si lo dice, se usa su
          // clasificación; si no, se deduce del estado que ha llegado.
          const statusKind =
            tutorError instanceof TutorError && tutorError.kind
              ? tutorError.kind
              : classifyStatus(status, detail);

          // La petición no cabía: si el recorte ha cambiado algo, se aprieta y se
          // reintenta el MISMO modelo. Si ya venía recortada y aun así no cabe, no
          // se insiste: el problema es del modelo, no del tamaño.
          // La petición no cabía (413/ITPM). ANTES se exigía que ya viniera
          // recortada, así que el primer 413 —el caso normal: Groq mide 7 000
          // tokens por minuto y el prompt del tutor ronda 4 500— se rendía sin
          // recortar nada y el alumno acababa en modo local. Ahora se recorta y
          // se reintenta siempre que quede un nivel de recorte.
          if (
            statusKind === 'too_large' &&
            compactLevel < 2 &&
            attempt < MAX_ATTEMPTS_PER_MODEL - 1 &&
            // Recortar no es reintentar a ciegas: cuesta una llamada y suele
            // acertar. Se exige solo tiempo para ESE intento, no para toda la
            // cola (que era lo que en Netlify lo bloqueaba siempre).
            deadline - Date.now() > MIN_ATTEMPT_MS
          ) {
            compactLevel += 1;
            continue;
          }

          // Transitorio y aún quedan intentos: se espera un poco y se repite el
          // MISMO modelo con la MISMA clave. Solo si al turno le sobra tiempo
          // para el reintento **y para lo que queda detrás**.
          if (
            statusKind === 'error' &&
            attempt < TRANSIENT_RETRIES &&
            hasRoomToRetry(deadline, TRANSIENT_BACKOFF_MS[attempt] ?? 1500, othersLeft + keysLeft)
          ) {
            await sleep(TRANSIENT_BACKOFF_MS[attempt] ?? 1500);
            continue;
          }

          // El cupo es de cada modelo con cada clave; la clave inválida lo es
          // para todo. Se apunta lo que corresponda y se sigue con la siguiente
          // clave en vez de rendirse.
          if (statusKind === 'quota' || statusKind === 'quota_daily' || statusKind === 'auth') {
            if (statusKind === 'auth') {
              markKeyHealth(candidate.provider, keyEntry.ledgerId, statusKind, detail);
              lastError = new TutorError(
                'La clave de IA no es válida o no tiene permisos. Revísala en Ajustes.',
                502,
                detail
              );
            } else {
              markPairHealth(candidate.key, pairScope(keyEntry), statusKind, detail);
              sawQuota = true;
            }
            console.warn(
              `[ia] ${candidate.key} con la clave «${keyEntry.label}» ${statusKind === 'auth' ? 'rechazada' : 'sin cupo'}${
                keysLeft > 0
                  ? `: se prueba con la clave «${keys[keys.length - keysLeft].label}»`
                  : ': no quedan más claves para este modelo'
              }`
            );
            attempts.push({ key: attemptKey, outcome: statusKind, note: detail.slice(0, 160) });
            noteCall(candidate.provider, false);
            return 'next-key';
          }

          markHealth(candidate.key, statusKind, detail);
          console.warn(
            `[ia] ${candidate.key} falló (${statusKind}, HTTP ${status})${attempt > 0 ? ` tras ${attempt + 1} intentos` : ''}: ${detail.slice(0, 200)}`
          );
          lastError = tutorError instanceof TutorError ? tutorError : null;
          attempts.push({ key: attemptKey, outcome: statusKind, note: detail.slice(0, 160) });
          noteCall(candidate.provider, false);
          // Un modelo saturado NO significa que el proveedor esté caído: casi
          // siempre el modelo de al lado responde. Por eso no se adelanta el
          // otro proveedor hasta que este lleve TRES fallos seguidos. Antes
          // bastaba uno: Gemini devolvía 503 en `3.8-flash`, el turno saltaba a
          // Groq (con su cupo por minuto mucho más estrecho), Groq devolvía 413
          // y el alumno veía «Sin IA» teniendo `3.6-flash` disponible.
          if (statusKind === 'error') {
            const streak = (providerFailures.get(candidate.provider) ?? 0) + 1;
            providerFailures.set(candidate.provider, streak);
            if (streak >= 3) promoteOtherProvider(queue, index);
          }
          return 'stop';
        }
      }
      // Se agotaron los reintentos de esta clave sin respuesta clara.
      return 'stop';
    };

    // Se prueban las claves de este proveedor una detrás de otra: la que se
    // queda sin cupo no arrastra a las demás.
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      const outcome = await tryKey(keys[keyIndex], keys.length - keyIndex - 1);
      if (outcome === 'next-key') continue;
      if (outcome === 'stop') break;
      return outcome;
    }
  }

  lastDecision.attempts = attempts;
  if (sawQuota || (quotaSkipped && lastError === null)) {
    const keysInPlay = getConfiguredProviders().map((provider) => getProviderKeys(provider).length);
    const totalKeys = keysInPlay.reduce((total, count) => total + count, 0);
    const advice =
      totalKeys <= 1
        ? ' Puedes añadir otra clave de IA en Ajustes (o una de otro proveedor) para repartir la carga; mientras tanto, se reanuda sola cuando termine el enfriamiento.'
        : ` Tienes ${totalKeys} claves configuradas y todas están sin cupo: se reanudan solas cuando su enfriamiento termine.`;
    throw new TutorError(
      `Todos los modelos gratuitos disponibles tienen el cupo saturado en este momento. Espera un par de minutos y reinténtalo.${advice}`,
      429,
      attempts.map((a) => `${a.key}: ${a.outcome}`).join(' | ')
    );
  }
  throw (
    lastError ??
    new TutorError(
      'No hay modelos compatibles disponibles con las claves configuradas.',
      502,
      attempts.map((a) => `${a.key}: ${a.outcome}`).join(' | ')
    )
  );
}

/**
 * Etiqueta visible del modo de modelo. Con "auto" la app elige el mejor modelo
 * gratuito disponible en cada momento entre los proveedores configurados.
 */
export function getConfiguredModelLabel(): string {
  const forcedGemini = forcedModel('gemini');
  const forcedGroq = forcedModel('groq');
  if (forcedGemini && forcedGroq) return `${forcedGemini} + ${forcedGroq}`;
  if (forcedGemini) return forcedGemini;
  if (forcedGroq) return forcedGroq;
  const providers = configuredProviderOrdersForLabel().filter((provider) => provider !== 'ollama');
  if (providers.length === 0) return 'sin configurar';
  if (providers.length === 1 && providers[0] === 'gemini') return 'auto';
  return `auto (${providers.map((provider) => providerLabel(provider)).join(' + ')})`;
}

function configuredProviderOrdersForLabel(): AiProvider[] {
  try {
    return configuredProviderOrder();
  } catch {
    return [];
  }
}

export async function getEngineStatus(): Promise<EngineStatus> {
  // Se comprueba el motor local (con caché) para poder decir la verdad en
  // Ajustes: si Ollama está levantado, aparece como red de seguridad real.
  await probeOllama();
  const providers: EngineProviderStatus[] = [];
  for (const id of [...providerIds(), 'ollama']) {
    const descriptor = getProviderDescriptor(id);
    const keys = getProviderKeys(id);
    const keyStatus = keys.map((entry) => ({
      label: entry.label,
      envVar: entry.envVar,
      coolingSeconds: getKeyCooldownSeconds(id, entry.ledgerId),
      modelsOutOfQuota: countModelsOutOfQuota(id, pairScope(entry)),
      used: getKeyCallCount(id, entry.ledgerId),
      lastStatus: keyLedger.get(keyId(id, entry.ledgerId))?.status ?? null,
    }));
    const hasEndpoint = !descriptor?.requiresBaseUrl || keys.some((entry) => entry.baseUrl);
    providers.push({
      id,
      name: descriptor?.label ?? 'Ollama Local (Offline)',
      keyEnv: mainKeyEnv(id),
      configured:
        id === 'ollama' ? ollamaMode() === 'on' || ollamaUp : keys.length > 0 && hasEndpoint,
      signupUrl: descriptor?.signupUrl || 'https://ollama.com/download',
      note:
        id === 'ollama'
          ? ollamaUp
            ? 'Modelo local levantado: entra solo como último recurso, así que los catedráticos siguen funcionando aunque se agote el cupo gratuito de la nube. No tiene cupo ni cuesta dinero.'
            : 'Motor local (gratis e ilimitado) que evita quedarse sin IA cuando se agota el cupo de la nube. Para levantarlo: `npm run ollama:doctor` te dice qué instalar y qué modelo te conviene según tu ordenador.'
          : descriptor?.requiresBaseUrl
            ? 'Endpoint compatible OpenAI: la dirección HTTPS la pones tú y se valida antes de guardarla.'
            : 'Proveedor del catálogo BYOK. Se usa solo si tú has guardado su clave; nunca se completa con una cuenta ajena.',
      keys: keyStatus,
      keysAvailable: keyStatus.filter((entry) => entry.coolingSeconds === 0).length,
      extraKeyEnv:
        id === 'ollama'
          ? []
          : keyEnvNames(id)
              .filter((envVar) => !envVar.startsWith('GOOGLE_'))
              .slice(1, MAX_KEYS_PER_PROVIDER)
              .map((envVar) => `${envVar}=…`),
    });
  }

  // Los mejores de CADA proveedor, no solo del primero.
  const ranked: EngineModelStatus[] = [];
  for (const provider of configuredProviderOrder()) {
    const top = (await rankModels(provider)).slice(0, 5);
    for (const candidate of top) {
      // El enfriamiento de un modelo viene de dos sitios: del propio modelo o
      // del cupo del par modelo#clave. Se enseña lo que de verdad bloquea.
      const keys = getProviderKeys(provider);
      const pairCooldowns = keys.map((entry) =>
        getPairCooldownSeconds(candidate.key, pairScope(entry))
      );
      const modelCooldown = getCooldownSeconds(candidate.key);
      const somePairFree = keys.length === 0 || pairCooldowns.some((seconds) => seconds === 0);
      const pairCooling = pairCooldowns.length > 0 ? Math.max(...pairCooldowns) : 0;
      const lastPair = keys
        .map((entry) => pairLedger.get(pairId(candidate.key, pairScope(entry))))
        .filter((entry): entry is LedgerEntry => Boolean(entry))
        .sort((a, b) => b.at - a.at)[0];
      ranked.push({
        key: candidate.key,
        provider,
        model: candidate.model,
        coolingSeconds: modelCooldown > 0 ? modelCooldown : somePairFree ? 0 : pairCooling,
        lastStatus: healthLedger.get(candidate.key)?.status ?? lastPair?.status ?? null,
      });
    }
  }

  const chain = await getCandidateChain();
  return {
    providers,
    ranked,
    nextKey: chain[0]?.key ?? null,
    selected: lastDecision?.model ?? null,
    lastGood: getLastGoodKey(),
    usage: getUsageToday(),
    lastDecision,
    quotaTight: isQuotaTight(),
  };
}
