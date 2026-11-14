/**
 * Límite de intentos al pegar o comprobar una clave de IA.
 *
 * Es una defensa contra el sondeo de claves desde una cuenta con sesión: no se
 * puede probar un diccionario de claves a base de POST. La ventana es corta (5
 * intentos cada 10 minutos). El contador vive en memoria del proceso; en
 * serverless cada instancia lleva el suyo, así que es una barrera, no una
 * garantía criptográfica. La validación real la pone Google y la clave sigue
 * cifrada en la base.
 */

const WINDOW_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

interface AttemptState {
  at: number[];
}

const globalForAttempts = globalThis as unknown as {
  __brainupAiKeyAttempts?: Map<string, AttemptState>;
};

const attempts = globalForAttempts.__brainupAiKeyAttempts ?? new Map<string, AttemptState>();
globalForAttempts.__brainupAiKeyAttempts = attempts;

export interface AttemptResult {
  ok: boolean;
  /** Segundos que faltan para poder volver a intentarlo (solo si `ok=false`). */
  retryAfterSeconds: number;
}

/** Cuenta un intento y dice si se permite. */
export function consumeAiKeyAttempt(userId: string, now = Date.now()): AttemptResult {
  const state = attempts.get(userId) ?? { at: [] };
  const recent = state.at.filter((stamp) => now - stamp < WINDOW_MS);

  if (recent.length >= MAX_ATTEMPTS) {
    attempts.set(userId, { at: recent });
    const oldest = recent[0] ?? now;
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
    };
  }

  recent.push(now);
  attempts.set(userId, { at: recent });
  return { ok: true, retryAfterSeconds: 0 };
}

/** Limpia el contador tras una comprobación correcta. */
export function resetAiKeyAttempts(userId: string): void {
  attempts.delete(userId);
}

/** Solo para las pruebas: deja el contador como recién arrancado. */
export function clearAiKeyAttempts(): void {
  attempts.clear();
}
