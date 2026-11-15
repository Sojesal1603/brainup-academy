/**
 * Formato aceptado para una clave de IA propia, por proveedor.
 *
 * La regla es deliberadamente ancha: Google ha emitido claves con prefijo
 * `AIza…` y también con prefijo `AQ.`, OpenRouter empieza por `sk-or-v1-`,
 * Groq por `gsk_` y NVIDIA por `nvapi-`, pero los prefijos cambian y la
 * autoridad real es el endpoint del proveedor. Lo que no se admite son
 * espacios, saltos de línea ni caracteres de control: esos no forman parte de
 * ninguna clave y suelen indicar un copiado sucio.
 *
 * La misma función la usan el formulario y el servidor. El servidor sigue
 * mandando: el `pattern` del navegador es una ayuda, no una puerta.
 */

/** Proveedores en los que un alumno puede pegar su propia clave. */
export const USER_KEY_PROVIDERS = ['gemini', 'groq', 'openrouter', 'nvidia'] as const;

export type UserKeyProvider = (typeof USER_KEY_PROVIDERS)[number];

/** Cómo se llama cada uno en la interfaz. */
export const USER_KEY_PROVIDER_LABEL: Record<UserKeyProvider, string> = {
  gemini: 'Google Gemini',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  nvidia: 'NVIDIA',
};

/** Dónde se saca una clave gratuita de cada proveedor. */
export const USER_KEY_PROVIDER_SIGNUP: Record<UserKeyProvider, string> = {
  gemini: 'https://aistudio.google.com/api-keys',
  groq: 'https://console.groq.com/keys',
  openrouter: 'https://openrouter.ai/keys',
  nvidia: 'https://build.nvidia.com/',
};

/** Pista del aspecto de una clave, para el marcador del campo. */
export const USER_KEY_PROVIDER_HINT: Record<UserKeyProvider, string> = {
  gemini: 'AIza… o AQ.…',
  groq: 'gsk_…',
  openrouter: 'sk-or-v1-…',
  nvidia: 'nvapi-…',
};

export const AI_KEY_FORMAT = /^[A-Za-z0-9._-]+$/;

export const AI_KEY_FORMAT_MESSAGE =
  'La clave solo puede tener letras, números, puntos, guiones y guiones bajos (sin espacios).';

/**
 * El proveedor que pide el formulario, normalizado.
 *
 * `google` es el nombre que usa Google en su consola y aparece en enlaces
 * antiguos; se acepta como alias de `gemini`, que es el id guardado. Cualquier
 * otro valor se rechaza: el proveedor nunca sale del cliente sin validar.
 */
export function normalizeUserKeyProvider(value: string): UserKeyProvider | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'google' || raw === 'google-ai' || raw === 'googleai') return 'gemini';
  return (USER_KEY_PROVIDERS as readonly string[]).includes(raw) ? (raw as UserKeyProvider) : null;
}

/** Devuelve el error de formato, o `null` si la clave tiene forma válida. */
export function providerKeyFormatError(provider: UserKeyProvider, value: string): string | null {
  const key = String(value ?? '').trim();
  const label = USER_KEY_PROVIDER_LABEL[provider];
  if (key.length === 0) return `Escribe la clave de ${label}.`;
  // El formato va antes que la longitud: un copiado con un salto de línea se
  // explica mejor como «sin espacios» que como «demasiado corta».
  if (!AI_KEY_FORMAT.test(key)) {
    return `La clave de ${label} solo puede tener letras, números, puntos, guiones y guiones bajos (sin espacios).`;
  }
  if (key.length < 20) return `La clave de ${label} es demasiado corta (mínimo 20 caracteres).`;
  if (key.length > 200) return 'La clave es demasiado larga.';
  return null;
}

/** Compatibilidad: la tarjeta solo admitía Gemini cuando se escribió esto. */
export function aiKeyFormatError(value: string): string | null {
  return providerKeyFormatError('gemini', value);
}
