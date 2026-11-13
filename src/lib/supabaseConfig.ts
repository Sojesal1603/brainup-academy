/**
 * Configuración pública de Supabase Auth.
 *
 * Vive en un módulo aparte de `auth.ts` porque el proxy (el antiguo middleware)
 * también la necesita y no puede importar `next/headers`. Solo contiene la URL
 * del proyecto y la anon key, que son públicas y viajan al navegador.
 */

export interface SupabaseAuthConfig {
  url: string;
  anonKey: string;
}

/** Falta configuración de Supabase Auth en el entorno. */
export class SupabaseAuthConfigError extends Error {
  readonly code = 'SUPABASE_AUTH_CONFIG';

  constructor() {
    super(
      'Falta la configuración de Supabase Auth. Define NEXT_PUBLIC_SUPABASE_URL y ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY en el entorno del servidor.'
    );
    this.name = 'SupabaseAuthConfigError';
  }
}

export function readSupabaseAuthConfig(): SupabaseAuthConfig {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim();
  const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim();
  if (!url || !anonKey) throw new SupabaseAuthConfigError();

  try {
    new URL(url);
  } catch {
    throw new SupabaseAuthConfigError();
  }

  return { url, anonKey };
}

/** ¿Está configurada la identidad? Sirve para pintar un aviso claro en /login. */
export function hasSupabaseAuthConfig(): boolean {
  try {
    readSupabaseAuthConfig();
    return true;
  } catch {
    return false;
  }
}
