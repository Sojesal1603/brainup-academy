/**
 * La puerta: ninguna página ni API de BrainUp responde sin sesión de Supabase.
 *
 * En Next 16 este archivo se llama `proxy.ts` (antes `middleware.ts`). Hace dos
 * cosas y ninguna más:
 *
 *   1. Refresca la sesión de Supabase en cada petición. `getUser()` valida el
 *      JWT contra el servidor de Auth; no se acepta un `userId` de la URL, del
 *      cuerpo ni de una cabecera.
 *   2. Corta lo que no tiene sesión: las páginas van a `/login` y las rutas de
 *      API responden 401 en JSON.
 *
 * Lo que se queda abierto: `/login`, las rutas de Auth, el parte de salud y los
 * archivos que el navegador necesita para pintar la puerta o instalar la PWA.
 * Son públicos por necesidad, no porque tengan datos de nadie.
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { hasSupabaseAuthConfig, readSupabaseAuthConfig } from '@/lib/supabaseConfig';
import { appUrl, safeNextPath } from '@/lib/requestUrl';

/** Rutas exactas que nunca se protegen. */
const PUBLIC_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/salud',
  '/manifest.json',
  '/sw.js',
  '/favicon.ico',
  '/icon.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/logo-brainup.png',
  '/brainup.ico',
  '/robots.txt',
]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Los recursos que genera Next (JS, CSS, tipografías, imágenes optimizadas).
  return pathname.startsWith('/_next/') || pathname.startsWith('/__nextjs');
}

/** Una redirección conserva las cookies que Supabase acaba de refrescar. */
function redirectWithCookies(url: URL, response: NextResponse): NextResponse {
  const redirect = NextResponse.redirect(url);
  for (const cookie of response.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }
  return redirect;
}

function jsonWithCookies(
  body: Record<string, unknown>,
  status: number,
  response: NextResponse
): NextResponse {
  const json = NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
  for (const cookie of response.cookies.getAll()) {
    json.cookies.set(cookie);
  }
  return json;
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // Los estáticos no necesitan pasar por Auth ni por la base.
  if (pathname.startsWith('/_next/') || pathname.startsWith('/__nextjs')) {
    return NextResponse.next();
  }

  if (!hasSupabaseAuthConfig()) {
    const message =
      'La app está cerrada porque falta la configuración de Supabase Auth. ' +
      'Define NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY.';
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { ok: false, error: message },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    if (pathname === '/login') return NextResponse.next();
    const loginUrl = appUrl(request, '/login');
    loginUrl.searchParams.set('error', 'config');
    return NextResponse.redirect(loginUrl);
  }

  // El cliente se crea por petición: las cookies son parte de la sesión.
  let response = NextResponse.next({ request });
  const { url, anonKey } = readSupabaseAuthConfig();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // No metas código entre crear el cliente y getUser(): el refresco de tokens
  // depende de que esta sea la primera llamada.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (pathname === '/login') {
    if (!user) return response;
    const destino = safeNextPath(request.nextUrl.searchParams.get('next'));
    return redirectWithCookies(appUrl(request, destino), response);
  }

  if (PUBLIC_PATHS.has(pathname)) return response;

  if (!user) {
    if (pathname.startsWith('/api/')) {
      return jsonWithCookies(
        { ok: false, error: 'Sesión no iniciada. Entra en /login.' },
        401,
        response
      );
    }

    const loginUrl = appUrl(request, '/login');
    if (pathname !== '/') {
      loginUrl.searchParams.set('next', `${pathname}${search}`);
    }
    return redirectWithCookies(loginUrl, response);
  }

  return response;
}

export const config = {
  // Los archivos estáticos de la compilación no necesitan pasar por la puerta:
  // son los mismos para todo el mundo y no cuentan nada de nadie.
  matcher: ['/((?!_next/static|_next/image).*)'],
};
