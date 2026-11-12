import { cache } from 'react';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { parseTenantId } from './tenantValidation';

/**
 * Identidad de la petición, validada en el servidor con Supabase Auth.
 *
 * Lo que **no** hace, y es lo importante:
 *   - no acepta un `userId` de la URL, del cuerpo, de una cabecera ni de una
 *     cookie propia;
 *   - no usa `getSession()` del navegador: `getUser()` pregunta a Supabase Auth
 *     y valida el JWT contra el servidor (un token caducado o firmado con otra
 *     clave no pasa);
 *   - no cae en `user_default` cuando no hay sesión: lanza `AuthRequiredError`.
 *
 * Un Server Component, una Server Action o una Route Handler que necesite datos
 * del alumno empieza siempre así:
 *
 * ```ts
 * const user = await requireUser();
 * const notes = await db(user.id).note.findMany();
 * ```
 *
 * La sesión viaja en cookies de Supabase (`sb-<ref>-auth-token`). En una Server
 * Action o una Route Handler, `@supabase/ssr` puede refrescar el token y
 * reescribir la cookie; en un Server Component no (Next lo prohíbe), así que el
 * `setAll` de abajo se protege con try/catch y el refresco se hace en la
 * siguiente acción o en el proxy.
 */

export interface AuthUser {
  /** `sub` del JWT: el UUID que es dueño de las filas (`userId`). */
  id: string;
  email: string | null;
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

/** La petición no trae una sesión válida. */
export class AuthRequiredError extends Error {
  readonly code = 'AUTH_REQUIRED';

  constructor(message = 'Necesitas iniciar sesión para acceder a estos datos.') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

interface SupabaseAuthConfig {
  url: string;
  anonKey: string;
}

function readSupabaseAuthConfig(): SupabaseAuthConfig {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim();
  const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim();
  if (!url || !anonKey) throw new SupabaseAuthConfigError();

  try {
    // Falla al arrancar si la URL no es una URL: mejor un error claro aquí que
    // un `fetch` raro en mitad de la primera página.
    new URL(url);
  } catch {
    throw new SupabaseAuthConfigError();
  }

  return { url, anonKey };
}

/**
 * Cliente de Supabase para el servidor, atado a las cookies de esta petición.
 *
 * Se crea por petición (no es singleton): las cookies son parte del cliente.
 */
export async function createSupabaseServerClient() {
  const { url, anonKey } = readSupabaseAuthConfig();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Un Server Component no puede escribir cookies. El token se refresca
          // en la siguiente Server Action/Route Handler (o en el proxy); la
          // lectura actual ya ha validado el usuario con `getUser()`.
        }
      },
    },
  });
}

/**
 * Usuario de la petición, o `null` si no hay sesión válida.
 *
 * `cache()` lo memoiza por petición: el layout, la página y la acción pueden
 * pedirlo varias veces sin repetir la llamada a Supabase Auth.
 */
export const getOptionalUser = cache(async (): Promise<AuthUser | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    if (error && process.env.NODE_ENV === 'development') {
      console.warn(`[auth] sin sesión: ${error.message}`);
    }
    return null;
  }

  return {
    // Supabase garantiza un UUID. Validarlo aquí evita que un `sub` raro llegue
    // a `db()`, que también rechaza cualquier cosa que no sea UUID.
    id: parseTenantId(data.user.id),
    email: data.user.email ?? null,
  };
});

/**
 * Usuario obligatorio. Lanza `AuthRequiredError` si no hay sesión.
 *
 * No redirige: un redirect dentro de una Server Action o una Route Handler no
 * siempre es lo que se quiere (la API debe devolver 401). Cada capa decide:
 * una página puede usar `redirect('/login')`, una acción devolver el error y una
 * API responder con estado 401.
 */
export async function requireUser(): Promise<AuthUser> {
  const user = await getOptionalUser();
  if (!user) throw new AuthRequiredError();
  return user;
}
