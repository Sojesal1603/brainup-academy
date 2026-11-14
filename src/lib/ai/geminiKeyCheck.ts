import type { UserAiKeyStatus } from './keyStatus';

/**
 * Comprobación real de una clave de Gemini contra Google.
 *
 * Se manda la clave en la cabecera `x-goog-api-key` (nunca en la URL, para que
 * no acabe en un log de proxy) y solo se mira el estado HTTP. **No** se devuelve
 * el cuerpo del error: puede incluir la URL, cabeceras o detalles de la
 * petición, y la clave del alumno no puede aparecer en un mensaje.
 */

export interface GeminiKeyCheck {
  status: UserAiKeyStatus;
  /** Mensaje corto y saneado para la interfaz. */
  error: string | null;
  /** ¿Se puede guardar? Un fallo de red no debe pisar una clave buena. */
  persist: boolean;
}

const CHECK_TIMEOUT_MS = 8_000;

export async function checkGeminiKey(key: string): Promise<GeminiKeyCheck> {
  let response: Response;
  try {
    response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      {
        method: 'GET',
        headers: { 'x-goog-api-key': key },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        cache: 'no-store',
      }
    );
  } catch {
    // El error de `fetch` puede nombrar la URL; no se propaga.
    return {
      status: 'sin_comprobar',
      error:
        'No se pudo contactar con Google para comprobar la clave. No se ha guardado nada; inténtalo en un minuto.',
      persist: false,
    };
  }

  if (response.ok) {
    return { status: 'valida', error: null, persist: true };
  }
  if (response.status === 429) {
    return {
      status: 'sin_cuota',
      error:
        'Google acepta la clave, pero ahora mismo no tiene cupo disponible (429). Se guarda y se reintentará cuando se recupere.',
      persist: true,
    };
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    return {
      status: 'invalida',
      error: 'Google ha rechazado esta clave. Revísala y vuelve a pegarla.',
      persist: true,
    };
  }
  if (response.status >= 500) {
    return {
      status: 'sin_comprobar',
      error: 'Google está fallando ahora mismo. No se ha guardado nada; inténtalo más tarde.',
      persist: false,
    };
  }
  return {
    status: 'sin_comprobar',
    error: `No se pudo comprobar la clave (HTTP ${response.status}). No se ha guardado nada.`,
    persist: false,
  };
}
