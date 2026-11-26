import { configuredModelChain } from './modelCatalog';
import type { UserAiKeyStatus } from './keyStatus';
import type { UserKeyProvider } from './keyFormat';
import { USER_KEY_PROVIDER_LABEL } from './keyFormat';
import {
  customModelsFromEnv,
  getProviderDescriptor,
  normalizeProviderBaseUrl,
} from './providers';

/**
 * Comprobación real de una clave contra el endpoint del proveedor.
 *
 * La comprobación la elige el catálogo (`check` del descriptor), no una lista
 * cerrada de ramas. Para generar texto se pide una respuesta mínima con el
 * primer modelo real; para catálogos fiables se consulta el endpoint
 * autenticado. La clave viaja en cabecera, nunca en la URL.
 *
 * Del error **no** se devuelve el cuerpo: puede incluir la URL, cabeceras o
 * detalles de la petición. El mensaje de interfaz sí puede nombrar al
 * proveedor: esta pantalla es el único sitio donde la marca blanca lo permite.
 */

export interface ProviderKeyCheck {
  status: UserAiKeyStatus;
  error: string | null;
  persist: boolean;
}

export type GeminiKeyCheck = ProviderKeyCheck;

const CHECK_TIMEOUT_MS = 8_000;

function label(provider: UserKeyProvider): string {
  return USER_KEY_PROVIDER_LABEL[provider] ?? 'tu proveedor';
}

function firstModel(provider: UserKeyProvider, fallback: string): string {
  return (
    configuredModelChain(provider)[0]?.id ??
    (provider === 'custom' ? customModelsFromEnv()[0] : undefined) ??
    getProviderDescriptor(provider)?.models[0]?.id ??
    fallback
  );
}

function invalid(provider: UserKeyProvider): ProviderKeyCheck {
  return {
    status: 'invalida',
    error: `${label(provider)} ha rechazado esta clave. Revísala y vuelve a pegarla.`,
    persist: true,
  };
}

function quota(provider: UserKeyProvider): ProviderKeyCheck {
  return {
    status: 'sin_cuota',
    error: `${label(provider)} acepta la clave, pero ahora mismo no tiene cupo disponible (429). Se guarda y se reintentará cuando se recupere.`,
    persist: true,
  };
}

function missingModel(provider: UserKeyProvider): ProviderKeyCheck {
  return {
    status: 'sin_comprobar',
    error: `${label(provider)} acepta la clave, pero el modelo configurado no está disponible ahora mismo. La clave se guarda; el motor usará el siguiente modelo de la cadena.`,
    persist: true,
  };
}

function unreachable(provider: UserKeyProvider): ProviderKeyCheck {
  return {
    status: 'sin_comprobar',
    error: `No se pudo contactar con ${label(provider)} para comprobar la clave. No se ha guardado nada; inténtalo en un minuto.`,
    persist: false,
  };
}

function failing(provider: UserKeyProvider): ProviderKeyCheck {
  return {
    status: 'sin_comprobar',
    error: `${label(provider)} está fallando ahora mismo. No se ha guardado nada; inténtalo más tarde.`,
    persist: false,
  };
}

function fromStatus(provider: UserKeyProvider, status: number): ProviderKeyCheck {
  if (status === 404) return missingModel(provider);
  if (status === 429) return quota(provider);
  if (status === 400 || status === 401 || status === 403) return invalid(provider);
  if (status >= 500) return failing(provider);
  return {
    status: 'sin_comprobar',
    error: `No se pudo comprobar la clave (HTTP ${status}). No se ha guardado nada.`,
    persist: false,
  };
}

async function call(url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    return null;
  }
}

async function checkGemini(key: string): Promise<ProviderKeyCheck> {
  const response = await call('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      model: firstModel('gemini', 'gemini-flash-latest'),
      store: false,
      input: [{ type: 'user_input', content: 'Responde solo: ok' }],
    }),
  });
  if (!response) return unreachable('gemini');
  if (response.ok) return { status: 'valida', error: null, persist: true };
  return fromStatus('gemini', response.status);
}

async function checkGroq(key: string): Promise<ProviderKeyCheck> {
  const response = await call('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: firstModel('groq', 'openai/gpt-oss-120b'),
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ok' }],
    }),
  });
  if (!response) return unreachable('groq');
  if (response.ok) return { status: 'valida', error: null, persist: true };
  return fromStatus('groq', response.status);
}

async function checkOpenRouter(key: string): Promise<ProviderKeyCheck> {
  const response = await call('https://openrouter.ai/api/v1/key', {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response) return unreachable('openrouter');
  if (response.ok) return { status: 'valida', error: null, persist: true };
  return fromStatus('openrouter', response.status);
}

async function checkModelsEndpoint(
  provider: UserKeyProvider,
  key: string,
  baseUrl: string,
  headers: Record<string, string>
): Promise<ProviderKeyCheck> {
  const response = await call(`${baseUrl.replace(/\/+$/, '')}/models`, {
    method: 'GET',
    headers,
  });
  if (!response) return unreachable(provider);
  if (response.ok) return { status: 'valida', error: null, persist: true };
  return fromStatus(provider, response.status);
}

function baseFor(provider: UserKeyProvider, raw?: string): string | null {
  const descriptor = getProviderDescriptor(provider);
  if (descriptor?.requiresBaseUrl) {
    const normalized = normalizeProviderBaseUrl(raw ?? '');
    return normalized.ok ? normalized.url : null;
  }
  return descriptor?.baseUrl ?? null;
}

/** Comprueba la clave del proveedor indicado contra su endpoint real. */
export async function checkProviderKey(
  provider: UserKeyProvider,
  key: string,
  options: { baseUrl?: string } = {}
): Promise<ProviderKeyCheck> {
  const descriptor = getProviderDescriptor(provider);
  if (!descriptor) {
    return { status: 'sin_comprobar', error: 'Ese proveedor de IA no está soportado.', persist: false };
  }

  if (provider === 'gemini') return checkGemini(key);

  const base = baseFor(provider, options.baseUrl);
  if (descriptor.requiresBaseUrl && !base) {
    return {
      status: 'sin_comprobar',
      error: 'Escribe una dirección HTTPS pública para comprobar la clave del endpoint.',
      persist: false,
    };
  }

  if (provider === 'groq') return checkGroq(key);
  if (provider === 'openrouter') return checkOpenRouter(key);

  if (provider === 'anthropic') {
    return checkModelsEndpoint(provider, key, base ?? 'https://api.anthropic.com/v1', {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    });
  }

  if (base) {
    return checkModelsEndpoint(provider, key, base, { Authorization: `Bearer ${key}` });
  }

  return { status: 'sin_comprobar', error: 'No se pudo comprobar la clave: falta el endpoint.', persist: false };
}

/** Compatibilidad con la tarjeta anterior, que solo tenía Gemini. */
export function checkGeminiKey(key: string): Promise<ProviderKeyCheck> {
  return checkGemini(key);
}
