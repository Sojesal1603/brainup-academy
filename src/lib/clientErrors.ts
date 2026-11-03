/**
 * Los errores que pasan EN EL NAVEGADOR, apuntados donde alguien los lee.
 *
 * Hasta ahora, un componente de cliente que reventaba dejaba un mensaje rojo en
 * la consola del navegador y nada más: el servidor no se enteraba, `errores-app.log`
 * seguía limpio y el vigilante no tenía nada que revisar. Es decir, el error
 * existía para el alumno y no para el sistema.
 *
 * Esto manda el fallo a `/api/errores`, que escribe en el mismo
 * `data/logs/errores-app.log` que usa `src/instrumentation.ts`. Así entra en el
 * mismo circuito que ya existe (vigilante → taller de mantenimiento → incidencia),
 * sin inventar un segundo sistema de registro.
 *
 * Reglas que respeta a rajatabla:
 *   - NUNCA lanza. Si el aviso falla, se pierde el aviso, no la pantalla.
 *   - No manda nada del alumno: ni texto escrito, ni adjuntos, ni claves.
 *   - Deduplica: un error que se repite en bucle no inunda el log ni el servidor.
 *   - Si no hay `window` (render en el servidor), no hace nada.
 */

export interface ClientErrorPayload {
  /** Mensaje del error, ya recortado por quien llama si hace falta. */
  message: string;
  /** Pila del fallo (ayuda a saber qué componente fue). */
  stack?: string;
  /** De dónde viene: `error.tsx`, `window.onerror`, `window.unhandledrejection`… */
  source: string;
  /** Referencia que pone Next a los errores de render de servidor. */
  digest?: string;
  /** Ruta en la que estaba el alumno (sin parámetros sensibles). */
  url?: string;
}

/** Tope del mensaje: el mismo que usa el registro del servidor. */
const MAX_MESSAGE = 300;
/** Tope de la pila: suficiente para ubicarlo sin llenar el disco. */
const MAX_STACK = 1200;
/** Una ruta larga no aporta nada y puede llevar datos en la query. */
const MAX_URL = 200;
/** Ventana de deduplicación por mensaje + origen. */
const DEDUPE_MS = 60_000;

/** Lo ya avisado, para no repetir el mismo error en bucle. */
const recent = new Map<string, number>();

function safeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Quita los parámetros de la URL: el path basta para saber dónde pasó. */
function safeUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return safeText(window.location.pathname, MAX_URL) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Avisa del fallo. No devuelve nada y no se espera su resultado: la vista que
 * se está pintando no puede quedarse esperando a un log.
 */
export function reportClientError(payload: ClientErrorPayload): void {
  if (typeof window === 'undefined') return;

  try {
    const message = safeText(payload.message, MAX_MESSAGE);
    if (message.length === 0) return;

    const source = safeText(payload.source, 80) || 'cliente';
    const key = `${source}::${message}`;
    const now = Date.now();

    // Limpieza perezosa: el mapa no crece sin control aunque la app viva días.
    if (recent.size > 100) {
      for (const [entry, at] of recent) {
        if (now - at > DEDUPE_MS) recent.delete(entry);
      }
    }

    const last = recent.get(key);
    if (last !== undefined && now - last < DEDUPE_MS) return;
    recent.set(key, now);

    const body = {
      message,
      stack: safeText(payload.stack, MAX_STACK) || undefined,
      source,
      digest: safeText(payload.digest, 80) || undefined,
      url: safeText(payload.url ?? safeUrl(), MAX_URL) || undefined,
    };

    void fetch('/api/errores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Si el alumno cierra la pestaña justo después, mejor que salga igual.
      keepalive: true,
    }).catch(() => {
      // El aviso no puede generar un segundo fallo.
    });
  } catch {
    // Nunca lanza: registrar no es más importante que la pantalla.
  }
}
