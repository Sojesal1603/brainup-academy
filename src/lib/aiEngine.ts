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
 */

export type AiProvider = 'gemini' | 'groq' | 'openrouter' | 'ollama' | 'local';

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
const GROQ_CHAT_ENDPOINT = `${GROQ_BASE}/chat/completions`;
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
const OPENROUTER_CHAT_ENDPOINT = `${OPENROUTER_BASE}/chat/completions`;
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
const COOLDOWN_MISSING_MS = 30 * 60 * 1000;
const COOLDOWN_ERROR_MS = 20 * 1000;
const COOLDOWN_AUTH_MS = 10 * 60 * 1000;

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

/** Los nombres de las variables de un proveedor, en orden de preferencia. */
function keyEnvNames(provider: AiProvider): string[] {
  if (provider === 'gemini') {
    return [
      'GEMINI_API_KEY',
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
  return ['OLLAMA_BASE_URL'];
}

/** La etiqueta de una variable: «principal» para la de siempre, «2», «3»… para el resto. */
function keyLabel(envVar: string): string {
  const numbered = envVar.match(/_KEY_(\d)$/);
  return numbered ? numbered[1] : 'principal';
}

export interface ProviderKey {
  label: string;
  envVar: string;
  key: string;
}

/**
 * Las claves de un proveedor, en orden: primero la de siempre y después las
 * extra. Se saltan las vacías y las repetidas (dos variables con la misma clave
 * serían dos intentos contra el mismo cupo).
 */
export function getProviderKeys(provider: AiProvider): ProviderKey[] {
  if (provider === 'ollama') {
    return [{ label: 'local', envVar: 'OLLAMA_BASE_URL', key: OLLAMA_BASE }];
  }
  const keys: ProviderKey[] = [];
  const seen = new Set<string>();
  for (const envVar of keyEnvNames(provider)) {
    const key = (process.env[envVar] || '').trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    keys.push({ label: keyLabel(envVar), envVar, key });
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

export function getConfiguredProviders(): AiProvider[] {
  const providers: AiProvider[] = [];
  if (getApiKey('gemini')) providers.push('gemini');
  if (getApiKey('groq')) providers.push('groq');
  // OpenRouter va DESPUÉS de Groq y antes del modelo local: es la tercera vía.
  if (getApiKey('openrouter')) providers.push('openrouter');
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
    if (keys.some((entry) => getKeyCooldownSeconds(provider, entry.envVar) === 0)) return true;
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
  if (provider === 'gemini') return true;
  return /vision|llava|moondream|pixtral|qwen[\d.]*-?vl|gemma3|gpt-4o|claude-3/i.test(model);
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
const GEMINI_VETO =
  /pro|image|tts|live|audio|omni|lyria|nano|banana|robotics|computer-use|deep-research|embedding|preview|experimental|antigravity/i;

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

/* ------------------------------------------------------------------ */
/* Catálogos reales (con caché)                                        */
/* ------------------------------------------------------------------ */

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

async function listGeminiModels(apiKey: string): Promise<string[]> {
  const cached = catalogCache.get('gemini');
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
    catalogCache.set('gemini', { at: Date.now(), list });
    return list;
  } catch (error) {
    console.warn(
      '[ia] Catálogo de Gemini no disponible; uso la cadena estática:',
      error instanceof Error ? error.message : String(error)
    );
    return GEMINI_STATIC_POOL;
  }
}

async function listGroqModels(apiKey: string): Promise<string[]> {
  const cached = catalogCache.get('groq');
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
    catalogCache.set('groq', { at: Date.now(), list });
    return list;
  } catch (error) {
    console.warn(
      '[ia] Catálogo de Groq no disponible; uso la cadena estática:',
      error instanceof Error ? error.message : String(error)
    );
    return GROQ_STATIC_POOL;
  }
}

async function listOpenRouterModels(apiKey: string): Promise<string[]> {
  const cached = catalogCache.get('openrouter');
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
    catalogCache.set('openrouter', { at: Date.now(), list });
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
  const apiKey = getApiKey(provider);
  if (!apiKey) return [];
  const listed =
    provider === 'gemini'
      ? await listGeminiModels(apiKey)
      : provider === 'groq'
        ? await listGroqModels(apiKey)
        : await listOpenRouterModels(apiKey);
  const scorer =
    provider === 'gemini'
      ? scoreGeminiModel
      : provider === 'groq'
        ? scoreGroqModel
        : scoreOpenRouterModel;
  const veto = provider === 'gemini' ? GEMINI_VETO : null;
  const seen = new Set<string>();
  const ranked: ModelCandidate[] = [];
  for (const model of listed) {
    if (seen.has(model)) continue;
    seen.add(model);
    if (veto && veto.test(model)) continue;
    const score = scorer(model);
    if (score === null) continue;
    ranked.push({ provider, model, score, key: candidateKey(provider, model) });
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

function keyId(provider: AiProvider, envVar: string): string {
  return `${provider}#${envVar}`;
}

function markKeyHealth(
  provider: AiProvider,
  envVar: string,
  status: string,
  detail?: string
): void {
  keyLedger.set(keyId(provider, envVar), {
    status,
    until: status === 'ok' ? 0 : Date.now() + cooldownFor(status, detail || ''),
    at: Date.now(),
    detail,
  });
}

/** Segundos que le quedan de enfriamiento a una clave (0 si está disponible). */
export function getKeyCooldownSeconds(provider: AiProvider, envVar: string): number {
  const entry = keyLedger.get(keyId(provider, envVar));
  if (!entry || entry.until === 0) return 0;
  return Math.max(0, Math.ceil((entry.until - Date.now()) / 1000));
}

/*
 * Cuánto se ha usado cada clave: es lo que hace que el reparto sea justo. Se
 * cuenta cada intento (salga bien o mal), porque un intento que se quedó sin
 * cupo también gastó su turno contra esa clave.
 */
const keyCalls = new Map<string, number>();

function noteKeyUse(provider: AiProvider, envVar: string): void {
  const id = keyId(provider, envVar);
  keyCalls.set(id, (keyCalls.get(id) ?? 0) + 1);
}

/** Intentos hechos con esta clave desde que arrancó la app (para el reparto). */
export function getKeyCallCount(provider: AiProvider, envVar: string): number {
  return keyCalls.get(keyId(provider, envVar)) ?? 0;
}

/*
 * EL CUPO ES DE CADA **MODELO**: se apunta al par «modelo#clave». Si un modelo
 * se queda sin cupo con la clave 1, ese modelo sigue teniendo cupo con la clave
 * 2, y los otros modelos siguen teniendo cupo con la clave 1.
 */
function pairId(modelKey: string, label: string): string {
  return `${modelKey}#${label}`;
}

function markPairHealth(modelKey: string, label: string, status: string, detail?: string): void {
  pairLedger.set(pairId(modelKey, label), {
    status,
    until: Date.now() + cooldownFor(status, detail || ''),
    at: Date.now(),
    detail,
  });
}

/** Segundos de enfriamiento de un modelo con una clave concreta (0 = libre). */
export function getPairCooldownSeconds(modelKey: string, label: string): number {
  const entry = pairLedger.get(pairId(modelKey, label));
  if (!entry || entry.until === 0) return 0;
  return Math.max(0, Math.ceil((entry.until - Date.now()) / 1000));
}

/** ¿Se puede intentar este modelo con esta clave ahora mismo? */
function isKeyFreeFor(modelKey: string, provider: AiProvider, entry: ProviderKey): boolean {
  return (
    getKeyCooldownSeconds(provider, entry.envVar) === 0 &&
    getPairCooldownSeconds(modelKey, entry.label) === 0
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
    (a, b) => getKeyCallCount(provider, a.envVar) - getKeyCallCount(provider, b.envVar)
  );
  if (usable.length < all.length) {
    const lastGoodLabel = lastGoodKeyByModel.get(modelKey);
    const index = ordered.findIndex((entry) => entry.label === lastGoodLabel);
    if (index > 0) {
      const [good] = ordered.splice(index, 1);
      ordered.unshift(good);
    }
  }
  return ordered;
}

/** Cuántos modelos de este proveedor están sin cupo con ESTA clave. */
function countModelsOutOfQuota(provider: AiProvider, label: string): number {
  let count = 0;
  for (const [id, entry] of pairLedger) {
    if (!id.startsWith(`${provider}:`) || !id.endsWith(`#${label}`)) continue;
    if (Math.max(0, entry.until - Date.now()) > 0) count += 1;
  }
  return count;
}

/** Por qué no hay nada que probar con este modelo (para el rastro del turno). */
function noKeysReason(modelKey: string, provider: AiProvider): string {
  const keys = getProviderKeys(provider);
  if (keys.length === 0) return `sin clave para ${provider}`;
  const allKeysCooling = keys.every((entry) => getKeyCooldownSeconds(provider, entry.envVar) > 0);
  if (allKeysCooling) return `todas las claves de ${provider} están en enfriamiento`;
  return `el cupo de ${modelKey} está agotado en todas las claves`;
}

/** Último modelo que respondió bien (se promociona al frente de la cadena). */
let lastGoodKey: string | null = null;

/**
 * Y con qué CLAVE respondió bien cada modelo: con cupo caído, volver a probar
 * el modelo por la clave que acaba de funcionar ahorra el turno entero.
 */
const lastGoodKeyByModel = new Map<string, string>();

export function getLastGoodKey(): string | null {
  return lastGoodKey;
}

/** El proveedor de un identificador de modelo («gemini:x-flash» → `gemini`). */
function providerOfModelKey(modelKey: string): AiProvider | null {
  if (modelKey.startsWith('gemini:')) return 'gemini';
  if (modelKey.startsWith('groq:')) return 'groq';
  if (modelKey.startsWith('openrouter:')) return 'openrouter';
  if (modelKey.startsWith('ollama:')) return 'ollama';
  return null;
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
      if (getKeyCooldownSeconds(provider, entry.envVar) === 0) freeKeys += 1;
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
  if (lastGoodKey) {
    const provider = providerOfModelKey(lastGoodKey);
    if (provider) {
      const free = getProviderKeys(provider).filter((entry) =>
        isKeyFreeFor(lastGoodKey as string, provider, entry)
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
  if (forced === 'gemini') return ['gemini'];
  if (forced === 'groq') return ['groq'];
  if (forced === 'openrouter') return ['openrouter'];
  if (forced === 'ollama') return ['ollama'];
  // Auto: Gemini primero, Groq de desbordamiento y OpenRouter como tercera vía.
  return getConfiguredProviders();
}

function forcedModel(provider: AiProvider): string | null {
  const raw =
    (provider === 'gemini'
      ? process.env.GEMINI_MODEL
      : provider === 'groq'
        ? process.env.GROQ_MODEL
        : provider === 'openrouter'
          ? process.env.OPENROUTER_MODEL
          : '') || '';
  const value = raw.trim();
  if (!value || value.toLowerCase() === 'auto') return null;
  return value;
}

/**
 * Cadena ordenada de modelos a intentar: el mejor primero, saltando los que
 * están en enfriamiento. Los modelos forzados por env van en cabeza.
 */
export async function getCandidateChain(): Promise<ModelCandidate[]> {
  // Antes de armar la cadena se mira (con caché) si hay modelo local.
  await probeOllama();
  const chain: ModelCandidate[] = [];
  const push = (candidate: ModelCandidate) => {
    if (!chain.some((c) => c.key === candidate.key)) chain.push(candidate);
  };
  for (const provider of configuredProviderOrder()) {
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
  // El último modelo que funcionó va primero: acierta casi siempre.
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
const TRANSIENT_RETRIES = 2;
const TRANSIENT_BACKOFF_MS = [700, 1800];

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
  if (process.env.NETLIFY) return 7_000;
  return 30_000;
}

export const AI_TEXT_BUDGET_MS = aiTurnBudgetMs();

/** Tope de un solo intento, aunque al turno le quede presupuesto de sobra. */
export const AI_ATTEMPT_MAX_MS = Math.min(16_000, AI_TEXT_BUDGET_MS);

/** Por debajo de esto no se empieza un intento nuevo: no daría tiempo a nada. */
const MIN_ATTEMPT_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return 'el modelo local (Ollama)';
}

/** La variable de entorno con la clave principal de un proveedor de nube. */
function mainKeyEnv(provider: AiProvider): string {
  if (provider === 'gemini') return 'GEMINI_API_KEY';
  if (provider === 'groq') return 'GROQ_API_KEY';
  if (provider === 'openrouter') return 'OPENROUTER_API_KEY';
  return 'OLLAMA_BASE_URL';
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
        'Ese modelo no está descargado en tu Ollama. Descárgalo con `ollama pull <modelo>` (npm run ollama:doctor te dice cuál te conviene y por qué).',
        404,
        providerMessage,
        kind
      );
    }
    return new TutorError(
      `Ollama ha contestado con un error (HTTP ${status}). Comprueba que el servicio está levantado con \`npm run ollama:doctor\`.`,
      502,
      providerMessage,
      kind
    );
  }
  if (status === 400 || status === 401 || status === 403) {
    const envVar = mainKeyEnv(provider);
    return new TutorError(
      `La clave de ${providerLabel(provider)} no es válida o no tiene permisos. Revisa ${envVar} en el archivo .env.`,
      502,
      providerMessage,
      kind
    );
  }
  if (status === 404) {
    return new TutorError('Modelo no disponible.', 404, providerMessage, kind);
  }
  return new TutorError(`El servicio de ${providerLabel(provider)} está fallando.`, 502, providerMessage, kind);
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
}

interface OpenAiChatPayload {
  choices?: Array<{ message?: { content?: string } }>;
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
      signal: AbortSignal.timeout(params.timeoutMs ?? AI_ATTEMPT_MAX_MS),
    });
  } catch (error) {
    throw new TutorError(
      'No se pudo contactar con el servicio de IA. Comprueba tu conexión e inténtalo de nuevo.',
      502,
      error instanceof Error ? error.message : String(error)
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
  provider: 'groq' | 'openrouter' | 'ollama',
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
      }),
      signal: AbortSignal.timeout(params.timeoutMs ?? AI_ATTEMPT_MAX_MS),
    });
  } catch (error) {
    const message =
      provider === 'ollama'
        ? 'No se pudo contactar con Ollama local. Comprueba que el servicio esté iniciado en el puerto 11434.'
        : 'No se pudo contactar con el servicio de IA. Comprueba tu conexión e inténtalo de nuevo.';
    throw new TutorError(message, 502, error instanceof Error ? error.message : String(error));
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
        ? 'Ollama no ha devuelto ninguna respuesta. Reinténtalo.'
        : 'El modelo no ha devuelto ninguna respuesta. Reinténtalo.';
    throw new TutorError(emptyMessage, 502, 'Respuesta vacía del proveedor');
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

/* ------------------------------------------------------------------ */
/* Turno                                                               */
/* ------------------------------------------------------------------ */

export async function runAiText(params: AiTextParams): Promise<AiTextResult> {
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
  const chain = await getCandidateChain();
  const attempts: Array<{ key: string; outcome: string; note?: string }> = [];
  // El reloj del turno: la cadena entera comparte un solo presupuesto.
  const budgetMs = Math.max(1_000, params.budgetMs ?? AI_TEXT_BUDGET_MS);
  const deadline = Date.now() + budgetMs;

  if (chain.length === 0) {
    const configured = getConfiguredProviders();
    const hasCloudKeys = Boolean(getApiKey('gemini') || getApiKey('groq') || getApiKey('openrouter'));
    const message = !hasCloudKeys
      ? 'El motor de IA no tiene por dónde funcionar: no hay ninguna clave en el .env (GEMINI_API_KEY, GROQ_API_KEY u OPENROUTER_API_KEY) y tampoco un modelo local levantado. Pon una clave gratuita o arranca Ollama (`npm run ollama:doctor`).'
      : 'Todos los modelos gratuitos están saturados ahora mismo. Espera un minuto y reinténtalo.';
    lastDecision = { at: Date.now(), provider: null, model: null, ranked: [], attempts };
    throw new TutorError(message, configured.length === 0 ? 503 : 429, 'Sin candidatos disponibles');
  }

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
      noteKeyUse(candidate.provider, keyEntry.envVar);
      /** Nivel de recorte del prompt de sistema (0 = sin apretar). */
      let compactLevel = 0;

      for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
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
        const systemWasCompacted = systemInstruction !== params.systemInstruction;

        try {
          let result: { text: string; steps?: unknown[] };
          if (candidate.provider === 'gemini') {
            result = await callGemini({
              apiKey,
              model: candidate.model,
              systemInstruction,
              // Se pasan las dos formas del historial: los pasos crudos cuando
              // los hay (llevan los adjuntos) y el chat para reconstruirlos
              // cuando el llamador solo manda `messages`.
              history: params.history ?? [],
              messages: params.messages ?? [],
              message: params.message,
              attachments: params.attachments ?? [],
              timeoutMs: attemptTimeoutMs,
            });
          } else if (candidate.provider === 'ollama') {
            result = await callOllama({
              model: candidate.model,
              systemInstruction,
              messages: params.messages ?? [],
              message: params.message,
              attachments: params.attachments ?? [],
              readableTextAttachments: params.readableTextAttachments,
              maxTokens: params.maxTokens,
              timeoutMs: attemptTimeoutMs,
            });
          } else if (candidate.provider === 'groq') {
            result = await callOpenAiCompatible('groq', GROQ_CHAT_ENDPOINT, {
              apiKey,
              model: candidate.model,
              systemInstruction,
              messages: params.messages ?? [],
              message: params.message,
              attachments: params.attachments ?? [],
              readableTextAttachments: params.readableTextAttachments,
              maxTokens: params.maxTokens,
              timeoutMs: attemptTimeoutMs,
            });
          } else {
            result = await callOpenAiCompatible('openrouter', OPENROUTER_CHAT_ENDPOINT, {
              apiKey,
              model: candidate.model,
              systemInstruction,
              messages: params.messages ?? [],
              message: params.message,
              attachments: params.attachments ?? [],
              readableTextAttachments: params.readableTextAttachments,
              maxTokens: params.maxTokens,
              timeoutMs: attemptTimeoutMs,
            });
          }

          markHealth(candidate.key, 'ok');
          markKeyHealth(candidate.provider, keyEntry.envVar, 'ok');
          lastGoodKey = candidate.key;
          lastGoodKeyByModel.set(candidate.key, keyEntry.label);
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
          if (
            statusKind === 'too_large' &&
            systemWasCompacted &&
            compactLevel < 2 &&
            attempt < TRANSIENT_RETRIES &&
            hasRoomToRetry(deadline, 0, othersLeft + keysLeft)
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
              markKeyHealth(candidate.provider, keyEntry.envVar, statusKind, detail);
              lastError = new TutorError(
                `La clave «${keyEntry.label}» de ${providerLabel(candidate.provider)} no es válida o no tiene permisos. Revisa ${keyEntry.envVar} en el archivo .env.`,
                502,
                detail
              );
            } else {
              markPairHealth(candidate.key, keyEntry.label, statusKind, detail);
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
          // Fallo del modelo o del proveedor entero: el de al lado pasa delante
          // y no se prueban más claves de este (el problema no está en la clave).
          if (statusKind === 'error') {
            promoteOtherProvider(queue, index);
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
        ? ' Si añades una clave extra gratis en .env (GEMINI_API_KEY_2), una de otro proveedor (GROQ_API_KEY) o una de OpenRouter (OPENROUTER_API_KEY, modelos gratis), la app reparte la carga entre ellas y esto deja de pasar.'
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
  for (const id of ['gemini', 'groq', 'openrouter', 'ollama'] as const) {
    const keys = getProviderKeys(id);
    const keyStatus = keys.map((entry) => ({
      label: entry.label,
      envVar: entry.envVar,
      coolingSeconds: getKeyCooldownSeconds(id, entry.envVar),
      modelsOutOfQuota: countModelsOutOfQuota(id, entry.label),
      used: getKeyCallCount(id, entry.envVar),
      lastStatus: keyLedger.get(keyId(id, entry.envVar))?.status ?? null,
    }));
    providers.push({
      id,
      name:
        id === 'gemini'
          ? 'Google Gemini'
          : id === 'groq'
            ? 'Groq Cloud'
            : id === 'openrouter'
              ? 'OpenRouter (modelos gratis)'
              : 'Ollama Local (Offline)',
      keyEnv: mainKeyEnv(id),
      configured: id === 'ollama' ? ollamaMode() === 'on' || ollamaUp : keys.length > 0,
      signupUrl:
        id === 'gemini'
          ? 'https://aistudio.google.com/api-keys'
          : id === 'groq'
            ? 'https://console.groq.com/keys'
            : id === 'openrouter'
              ? 'https://openrouter.ai/keys'
              : 'https://ollama.com/download',
      note:
        id === 'gemini'
          ? 'Proveedor primario. Tier gratuito de Google AI Studio, por clave.'
          : id === 'groq'
            ? 'Reserva de desbordamiento ultrarrápida con cuota gratuita propia.'
            : id === 'openrouter'
              ? 'Tercera vía de la nube: modelos gratuitos (:free) de otras familias. Su plan gratuito se cuenta por CUENTA (20 peticiones/minuto y 50 al día), así que aquí añadir claves no multiplica el cupo: es una vía más, no una más ancha.'
              : ollamaUp
                ? 'Modelo local levantado: entra solo como último recurso, así que los catedráticos siguen funcionando aunque se agote el cupo gratuito de Gemini y Groq. No tiene cupo ni cuesta dinero.'
                : 'Motor local (gratis e ilimitado) que evita quedarse sin IA cuando se agota el cupo de la nube. Para levantarlo: `npm run ollama:doctor` te dice qué instalar y qué modelo te conviene según tu ordenador.',
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
      const pairCooldowns = keys.map((entry) => getPairCooldownSeconds(candidate.key, entry.label));
      const modelCooldown = getCooldownSeconds(candidate.key);
      const somePairFree = keys.length === 0 || pairCooldowns.some((seconds) => seconds === 0);
      const pairCooling = pairCooldowns.length > 0 ? Math.max(...pairCooldowns) : 0;
      const lastPair = keys
        .map((entry) => pairLedger.get(pairId(candidate.key, entry.label)))
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
    lastGood: lastGoodKey,
    usage: getUsageToday(),
    lastDecision,
    quotaTight: isQuotaTight(),
  };
}
