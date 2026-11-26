import rawCatalog from './providers.json';
import { modelHasVision } from './modelCatalog';

/**
 * Catálogo de proveedores *data-driven*.
 *
 * Añadir OpenAI, Anthropic, Groq, un endpoint compatible o un proveedor nuevo
 * es editar `providers.json`: el motor, Ajustes y el router leen de aquí. Los
 * adaptadores son solo tres dialectos (`gemini-interactions`, `openai-chat`,
 * `anthropic-messages`); el resto es configuración.
 *
 * Este módulo es puro (solo importa el JSON y el catálogo de modelos), así que
 * `verify:router` puede probarlo sin base de datos ni red.
 */

export type AdapterKind = 'gemini-interactions' | 'openai-chat' | 'anthropic-messages';

export interface ProviderModelDescriptor {
  id: string;
  vision?: boolean;
  tools?: boolean;
  json?: boolean;
  /** El adaptador puede simular deltas aunque el proveedor no los dé. */
  streaming?: boolean;
  context?: number;
}

export interface ProviderDescriptor {
  id: string;
  label: string;
  adapter: AdapterKind;
  /** Raíz HTTPS del API (sin barra final). `custom` la aporta el alumno. */
  baseUrl?: string;
  /** Ruta de chat dentro de `baseUrl`; por defecto `/chat/completions`. */
  chatPath?: string;
  /** Si es true, la clave no basta: hace falta un baseUrl HTTPS del alumno. */
  requiresBaseUrl?: boolean;
  models: ProviderModelDescriptor[];
  keyFormat: string;
  keyHint: string;
  signupUrl: string;
  check: 'models' | 'chat-minimal' | 'key-endpoint';
}

export interface ProviderCapabilities {
  vision: boolean;
  tools: boolean;
  json: boolean;
  streaming: boolean;
}

interface CatalogFile {
  version: number;
  providers: ProviderDescriptor[];
}

const catalog = rawCatalog as CatalogFile;
const byId = new Map(catalog.providers.map((provider) => [provider.id, provider]));

/** Todos los descriptores, en el orden del catálogo (el orden por defecto). */
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = catalog.providers;

export function providerIds(): string[] {
  return PROVIDER_DESCRIPTORS.map((provider) => provider.id);
}

export function getProviderDescriptor(id: string): ProviderDescriptor | null {
  return byId.get(String(id ?? '').trim().toLowerCase()) ?? null;
}

export function providerLabelOf(id: string): string {
  return getProviderDescriptor(id)?.label ?? 'tu proveedor de IA';
}

export function providerSupportsBaseUrl(id: string): boolean {
  return getProviderDescriptor(id)?.requiresBaseUrl === true;
}

function modelDescriptor(provider: string, model: string): ProviderModelDescriptor | null {
  const descriptor = getProviderDescriptor(provider);
  if (!descriptor) return null;
  const id = String(model ?? '').trim();
  return descriptor.models.find((entry) => entry.id === id) ?? null;
}

/**
 * Capacidades reales de un modelo.
 *
 * Primero manda la entrada del catálogo; si el proveedor sirve un modelo que no
 * está declarado, se es conservador: solo se reconoce visión por el nombre (que
 * es lo que ya hacía el motor) y no se prometen tools/JSON. Mejor degradar de
 * forma honesta que enviar una imagen a un modelo ciego.
 */
export function modelCapabilities(provider: string, model: string): ProviderCapabilities {
  const descriptor = getProviderDescriptor(provider);
  const entry = modelDescriptor(provider, model);
  const adapter = descriptor?.adapter;
  const known = Boolean(entry);
  return {
    vision: entry?.vision ?? modelHasVision(provider, model),
    tools: entry?.tools ?? (known ? true : adapter === 'gemini-interactions'),
    json: entry?.json ?? (known ? true : adapter === 'gemini-interactions'),
    // Los tres adaptadores saben simular deltas: la UI no cambia.
    streaming: entry?.streaming ?? true,
  };
}

/** ¿Puede este modelo atender todo lo que exige el turno? */
export function supportsCapabilities(
  provider: string,
  model: string,
  required: Partial<ProviderCapabilities>
): boolean {
  const capabilities = modelCapabilities(provider, model);
  if (required.vision && !capabilities.vision) return false;
  if (required.tools && !capabilities.tools) return false;
  if (required.json && !capabilities.json) return false;
  if (required.streaming && !capabilities.streaming) return false;
  return true;
}

/**
 * Validación de un endpoint propio.
 *
 * Solo HTTPS, sin credenciales en la URL y sin direcciones privadas/loopback:
 * el servidor no puede convertirse en un proxy SSRF hacia la red del alumno o
 * de la plataforma. La barra final se elimina para componer rutas sin duplicar.
 */
export function normalizeProviderBaseUrl(value: string): { ok: true; url: string } | { ok: false; message: string } {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, message: 'Escribe la dirección HTTPS del endpoint.' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: 'La dirección del endpoint no es válida.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, message: 'El endpoint tiene que usar HTTPS.' };
  }
  if (url.username || url.password) {
    return { ok: false, message: 'No pongas usuario ni contraseña en la dirección.' };
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return { ok: false, message: 'Esa dirección es privada o local; usa un endpoint público con HTTPS.' };
  }
  const path = url.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${url.origin}${path}` };
}

/** Modelos de un endpoint propio: `AI_CUSTOM_MODELS` o el modelo declarado. */
export function customModelsFromEnv(): string[] {
  const raw = (process.env.AI_CUSTOM_MODELS ?? '').trim();
  if (raw) {
    return raw
      .split(/[\s,;]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return getProviderDescriptor('custom')?.models.map((entry) => entry.id) ?? [];
}
