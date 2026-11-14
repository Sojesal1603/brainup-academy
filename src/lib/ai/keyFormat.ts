/**
 * Formato aceptado para una clave de Google AI Studio.
 *
 * La regla es deliberadamente ancha: Google ha emitido claves con prefijo
 * `AIza…` y también con prefijo `AQ.`, y algunas incluyen puntos. Lo que no se
 * admite son espacios, saltos de línea ni caracteres de control: esos no forman
 * parte de ninguna clave y suelen indicar un copiado sucio.
 *
 * La misma función la usan el formulario y el servidor. El servidor sigue
 * mandando: el `pattern` del navegador es una ayuda, no una puerta.
 */

export const AI_KEY_FORMAT = /^[A-Za-z0-9._-]+$/;

export const AI_KEY_FORMAT_MESSAGE =
  'La clave solo puede tener letras, números, puntos, guiones y guiones bajos (sin espacios).';

/** Devuelve el error de formato, o `null` si la clave tiene forma válida. */
export function aiKeyFormatError(value: string): string | null {
  const key = String(value ?? '').trim();
  if (key.length === 0) return 'Escribe la clave de Google AI Studio.';
  if (!AI_KEY_FORMAT.test(key)) return AI_KEY_FORMAT_MESSAGE;
  return null;
}
