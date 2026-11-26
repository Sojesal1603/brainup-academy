import modelsConfig from './models.json';

/**
 * Qué modelos usa el motor, en qué orden y para qué sirven.
 *
 * Los ids NO viven en el código: salen de `models.json` (editable) o de las
 * variables `AI_GEMINI_MODELS`, `AI_GROQ_MODELS`, `AI_OPENROUTER_MODELS` y
 * `AI_NVIDIA_MODELS` (lista separada por comas). El catálogo real del proveedor
 * solo completa la lista por detrás, para que un modelo nuevo no pase por
 * delante de los que ya sabemos que responden.
 *
 * `ALLOW_PREVIEW_MODELS=1` permite usar modelos `preview`/`experimental`. Por
 * defecto está a 0: en producción no se eligen modelos que Google puede retirar
 * o cambiar sin aviso. En local se activa para probar modelos nuevos.
 */

export type ModelProviderId = string;

export interface ModelConfigEntry {
  id: string;
  /** ¿Puede leer imágenes y PDF escaneados? Por defecto, solo Gemini. */
  vision?: boolean;
  /** Modelo no estable: solo con ALLOW_PREVIEW_MODELS=1. */
  preview?: boolean;
}

interface ProviderConfig {
  chain?: ModelConfigEntry[];
  exclude?: string[];
}

/** `AI_<ID>_MODELS`, también para proveedores que se añadan al catálogo. */
function envKeyFor(provider: string): string {
  return `AI_${provider.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MODELS`;
}

const RAW = modelsConfig as Record<string, ProviderConfig | string | undefined>;

function providerConfig(provider: ModelProviderId): ProviderConfig {
  const value = RAW[provider];
  return value && typeof value === 'object' ? value : {};
}

/** ¿Se permiten modelos preview/experimentales? Apagado por defecto. */
export function allowPreviewModels(): boolean {
  const raw = (process.env.ALLOW_PREVIEW_MODELS ?? '0').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'si' || raw === 'sí';
}

/** ¿Este id es de un modelo no estable? Se mira la marca y el propio nombre. */
export function isPreviewModel(id: string, entry?: ModelConfigEntry): boolean {
  return entry?.preview === true || /preview|experimental/i.test(id);
}

/**
 * La cadena configurada de un proveedor, ya filtrada.
 *
 * El orden del archivo (o de la variable) es el orden de preferencia. Un modelo
 * excluido o preview sin permiso no aparece.
 */
export function configuredModelChain(provider: ModelProviderId): ModelConfigEntry[] {
  const config = providerConfig(provider);
  const envValue = (process.env[envKeyFor(provider)] ?? '').trim();
  const fromEnv = envValue
    .split(/[\s,;]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const fromFile = Array.isArray(config.chain) ? config.chain : [];
  const raw: ModelConfigEntry[] =
    fromEnv.length > 0
      ? fromEnv.map((id) => fromFile.find((entry) => entry.id === id) ?? { id })
      : fromFile;
  const excluded = new Set(excludedModels(provider));
  const allowPreview = allowPreviewModels();
  const seen = new Set<string>();
  const chain: ModelConfigEntry[] = [];
  for (const entry of raw) {
    const id = String(entry?.id ?? '').trim();
    if (id.length === 0 || seen.has(id) || excluded.has(id)) continue;
    if (isPreviewModel(id, entry) && !allowPreview) continue;
    seen.add(id);
    chain.push({ ...entry, id });
  }
  return chain;
}

/** Ids vetados explícitamente (`exclude` del archivo). */
export function excludedModels(provider: ModelProviderId): string[] {
  const config = providerConfig(provider);
  return Array.isArray(config.exclude) ? config.exclude.map(String) : [];
}

/** La entrada configurada de un modelo concreto, si está en la cadena o vetado. */
export function modelConfigEntry(
  provider: ModelProviderId,
  model: string
): ModelConfigEntry | undefined {
  const config = providerConfig(provider);
  const chain = Array.isArray(config.chain) ? config.chain : [];
  return chain.find((entry) => String(entry?.id ?? '') === model);
}

/**
 * ¿Puede este modelo leer archivos?
 *
 * Gemini lee imágenes y PDF de forma nativa; en el resto solo si la
 * configuración lo dice (o si es un modelo multimodal conocido, que es lo que
 * usa el motor local de Ollama).
 */
export function modelHasVision(provider: string, model: string): boolean {
  if (provider === 'gemini') return true;
  if (provider === 'ollama' || provider === 'local') {
    return /vision|llava|moondream|pixtral|qwen[\d.]*-?vl|gemma3|gpt-4o|claude-3/i.test(model);
  }
  const entry = modelConfigEntry(provider, model);
  if (entry && typeof entry.vision === 'boolean') return entry.vision;
  return /vision|llava|moondream|pixtral|qwen[\d.]*-?vl|gemma3|gpt-4o|claude-3/i.test(model);
}
