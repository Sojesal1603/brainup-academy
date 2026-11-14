import { configuredModelChain } from './modelCatalog';
import type { UserAiKeyStatus } from './keyStatus';

/**
 * Comprobación real de una clave de Gemini contra Google.
 *
 * Se GENERA una respuesta mínima con el primer modelo de la cadena real del
 * motor, no se lista el catálogo. La diferencia importa: listar modelos solo
 * demuestra que la clave está activa, y el alumno veía «Clave comprobada:
 * Google la acepta» mientras el catedrático contestaba «Sin IA ahora mismo»
 * porque el modelo que el motor elegía no respondía. Aquí «válida» significa
 * que Google ha generado con la misma clave y el mismo modelo que se va a usar.
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

/** El modelo con el que se comprueba: el primero que probará el motor. */
function checkModel(): string {
  return configuredModelChain('gemini')[0]?.id ?? 'gemini-flash-latest';
}

export async function checkGeminiKey(key: string): Promise<GeminiKeyCheck> {
  let response: Response;
  try {
    response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        model: checkModel(),
        store: false,
        input: [{ type: 'user_input', content: 'Responde solo: ok' }],
      }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      cache: 'no-store',
    });
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
  if (response.status === 404) {
    return {
      status: 'sin_comprobar',
      error:
        'Google acepta la clave, pero el modelo configurado no está disponible ahora mismo. La clave se guarda; el motor usará el siguiente modelo de la cadena.',
      persist: true,
    };
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
