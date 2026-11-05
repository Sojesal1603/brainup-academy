/**
 * La puerta: ninguna página ni API de BrainUp responde sin sesión abierta.
 *
 * En Next 16 este archivo se llama `proxy.ts` (antes `middleware.ts`) y corre en
 * el runtime de Node. Aquí no se toca la base ni el disco: solo se mira la cookie
 * firmada que deja el formulario de `/login` (`src/lib/authGate.ts`).
 *
 * Lo que se queda abierto, y por qué:
 *   - `/login` y `/api/auth/*`: sin esto no habría forma de entrar.
 *   - `/api/salud`: es el parte de salud que consultan el lanzador del icono, el
 *     vigilante y el taller (`scripts/abre.js`, `scripts/vigilante.js`). Sin él,
 *     el arranque local se quedaría esperando a que la app conteste.
 *   - Los archivos que el navegador necesita para pintar la propia puerta y para
 *     poder instalarla en el móvil (manifest, iconos, service worker).
 *
 * Si faltan `AUTH_USER`/`AUTH_PASSWORD` la puerta no se pone (y se avisa una vez
 * en la consola): así una instalación recién clonada sigue funcionando, mientras
 * que en Netlify basta con definir las dos variables para que quede cerrada.
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  AUTH_COOKIE,
  isAuthDisabled,
  readAuthConfig,
  verifySessionToken,
} from '@/lib/authGate';

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

let warnedMissingConfig = false;

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();
  if (isAuthDisabled()) return NextResponse.next();

  const config = readAuthConfig();
  if (!config) {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      console.warn(
        '[auth] Sin AUTH_USER/AUTH_PASSWORD: la app está abierta a quien llegue. ' +
          'Define las dos variables en el entorno (en Netlify: Site configuration → Environment variables).'
      );
    }
    return NextResponse.next();
  }

  const token = request.cookies.get(AUTH_COOKIE)?.value;
  if (await verifySessionToken(token, config)) {
    return NextResponse.next();
  }

  // Una llamada a la API recibe un 401 en JSON; una página, el formulario.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { ok: false, error: 'Sesión no iniciada. Entra en /login.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.search = '';
  if (pathname !== '/') {
    loginUrl.searchParams.set('next', `${pathname}${search}`);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Los archivos estáticos de la compilación no necesitan pasar por la puerta:
  // son los mismos para todo el mundo y no cuentan nada de nadie.
  matcher: ['/((?!_next/static|_next/image).*)'],
};
