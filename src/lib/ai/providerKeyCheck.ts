import { configuredModelChain } from './modelCatalog';
import type { UserAiKeyStatus } from './keyStatus';
import type { UserKeyProvider } from './keyFormat';
import { USER_KEY_PROVIDER_LABEL } from './keyFormat';

/**
 * Comprobación real de una clave contra el endpoint del proveedor.
 *
 * Para generar texto (Gemini, Groq) se GENERA una respuesta mínima con el primer
 * modelo de la cadena real del motor, no se lista el catálogo: listar solo
 * demuestra que la clave está activa, y el alumno veía «Clave comprobada»
 * mientras el catedrático decía que no había IA porque el modelo elegido no
 * respondía. Para OpenRouter y NVIDIA, cuyo catálogo sí es fiable y cuya cadena
 * puede estar vacía (NVIDIA no tiene modelos de chat accesibles con la cuenta
 * actual), se consulta su endpoint autenticado de claves/modelos.
 *
 * Se manda la clave en la cabecera (`x-goog-api-key` o `Authorization`) y nunca
 * en la URL, para que no acabe en el log de un proxy. Del error **no** se
 * devuelve el cuerpo: puede incluir la URL, cabeceras o detalles de la
 * petición, y la clave del alumno no puede aparecer en un mensaje.
 */

export interface ProviderKeyCheck {
  status: UserAiKeyStatus;
  /** Mensaje corto y saneado para la interfaz. */
  error: string | null;
  /** ¿Se puede guardar? Un fallo de red no debe pisar una clave buena. */
  persist: boolean;
}

/** Alias histórico: la tarjeta solo tenía Gemini. */
export type GeminiKeyCheck = ProviderKeyCheck;

const CHECK_TIMEOUT_MS = 8_000;

/** El modelo con el que se comprueba: el primero que probará el motor. */
function firstModel(provider: UserKeyProvider, fallback: string): string {
  return configuredModelChain(provider)[0]?.id ?? fallback;
}

function invalid(provider: UserKeyProvider): ProviderKeyCheck {
  return {
    status: 'invalida',
    error: `${USER_KEY_PROVIDER_LABEL[provider]} ha rechazado esta clave. Revísala y vuelve a pegarla.`,
    persist: true,
  };
}

function quota(provider: UserKeyProvider): ProviderKeyCheck {
  return {
    status: 'sin_cuota',
    error: `${USER_KEY_PROVIDER_LABEL[provider]} acepta la clave, pero ahora mismo no tiene cupo disponible (429). Se guarda y se reintentará cuando se recupere.`,
    persist: true,
  };
}

function missingModel(provider: UserKeyProvider): ProviderKeyCheck {
  return {
    status: 'sin_comprobar',
    error: `${USER_KEY_PROVIDER_LABEL[provider]} acepta la clave, pero el modelo configurado no está disponible ahora mismo. La clave se guarda; el motor usará el siguiente modelo de la cadena.`,
    persist: true,
  };
}

function unreachable(provider: UserKeyProvider): ProviderKeyCheck {
  return {
    status: 'sin_comprobar',
    error: `No se pudo contactar con ${USER_KEY_PROVIDER_LABEL[provider]} para comprobar la clave. No se ha guardado nada; inténtalo en un minuto.`,
    persist: false,
  };
}

function failing(provider: UserKeyProvider): ProviderKeyCheck {
  return {
    status: 'sin_comprobar',
    error: `${USER_KEY_PROVIDER_LABEL[provider]} está fallando ahora mismo. No se ha guardado nada; inténtalo más tarde.`,
    persist: false,
  };
}

/** Traduce el estado HTTP a lo que la interfaz sabe enseñar. */
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
    // El error de `fetch` puede nombrar la URL; no se propaga.
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

/** OpenRouter publica el estado de la propia clave: no gasta generación. */
async function checkOpenRouter(key: string): Promise<ProviderKeyCheck> {
  const response = await call('https://openrouter.ai/api/v1/key', {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response) return unreachable('openrouter');
  if (response.ok) return { status: 'valida', error: null, persist: true };
  return fromStatus('openrouter', response.status);
}

/** NVIDIA no tiene cadena de chat utilizable: se valida la clave con su catálogo. */
async function checkNvidia(key: string): Promise<ProviderKeyCheck> {
  const response = await call('https://integrate.api.nvidia.com/v1/models', {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response) return unreachable('nvidia');
  if (response.ok) return { status: 'valida', error: null, persist: true };
  return fromStatus('nvidia', response.status);
}

const CHECKS: Record<UserKeyProvider, (key: string) => Promise<ProviderKeyCheck>> = {
  gemini: checkGemini,
  groq: checkGroq,
  openrouter: checkOpenRouter,
  nvidia: checkNvidia,
};

/** Comprueba la clave del proveedor indicado contra su endpoint real. */
export function checkProviderKey(
  provider: UserKeyProvider,
  key: string
): Promise<ProviderKeyCheck> {
  return CHECKS[provider](key);
}

/** Compatibilidad con la tarjeta anterior, que solo tenía Gemini. */
export function checkGeminiKey(key: string): Promise<ProviderKeyCheck> {
  return checkGemini(key);
}
