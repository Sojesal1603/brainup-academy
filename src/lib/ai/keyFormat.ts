import {
  PROVIDER_DESCRIPTORS,
  getProviderDescriptor,
  providerIds,
} from './providers';

/**
 * Formato aceptado para una clave de IA propia, por proveedor.
 *
 * La lista ya no está cerrada en este archivo: sale de `providers.json`. Lo que
 * no se admite son espacios, saltos de línea ni caracteres de control: esos no
 * forman parte de ninguna clave y suelen indicar un copiado sucio. La autoridad
 * real sigue siendo el endpoint del proveedor.
 */

/** Proveedores en los que un alumno puede pegar su propia clave. */
export const USER_KEY_PROVIDERS = providerIds();

export type UserKeyProvider = string;

/** Cómo se llama cada uno en la interfaz. */
export const USER_KEY_PROVIDER_LABEL: Record<string, string> = Object.fromEntries(
  PROVIDER_DESCRIPTORS.map((provider) => [provider.id, provider.label])
);

/** Dónde se saca una clave de cada proveedor (vacío en endpoints propios). */
export const USER_KEY_PROVIDER_SIGNUP: Record<string, string> = Object.fromEntries(
  PROVIDER_DESCRIPTORS.map((provider) => [provider.id, provider.signupUrl])
);

/** Pista del aspecto de una clave, para el marcador del campo. */
export const USER_KEY_PROVIDER_HINT: Record<string, string> = Object.fromEntries(
  PROVIDER_DESCRIPTORS.map((provider) => [provider.id, provider.keyHint])
);

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
  return getProviderDescriptor(raw) ? raw : null;
}

function formatPattern(provider: UserKeyProvider): RegExp {
  const descriptor = getProviderDescriptor(provider);
  const raw = descriptor?.keyFormat ?? AI_KEY_FORMAT.source;
  try {
    return new RegExp(raw);
  } catch {
    return AI_KEY_FORMAT;
  }
}

/** Devuelve el error de formato, o `null` si la clave tiene forma válida. */
export function providerKeyFormatError(provider: UserKeyProvider, value: string): string | null {
  const key = String(value ?? '').trim();
  const label = USER_KEY_PROVIDER_LABEL[provider] ?? 'tu proveedor';
  if (key.length === 0) return `Escribe la clave de ${label}.`;
  // El formato va antes que la longitud: un copiado con un salto de línea se
  // explica mejor como «sin espacios» que como «demasiado corta».
  if (!formatPattern(provider).test(key)) {
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
