import { NextResponse } from 'next/server';
import {
  AUTH_COOKIE,
  createSessionToken,
  readAuthConfig,
  safeNextPath,
  sessionMaxAgeSeconds,
  verifyCredentials,
} from '@/lib/authGate';

/**
 * El botón «Entrar» del formulario de `/login`.
 *
 * Es un POST de formulario normal (no una acción de servidor) justo para que
 * funcione sin JavaScript: en el móvil, con la app recién instalada, no hay que
 * esperar a que hidrate nada para poder entrar.
 *
 * Cuatro cosas que hace a propósito:
 *   - Contesta 303, así que el navegador cambia el POST por un GET a la página
 *     pedida y recargar no reenvía la contraseña.
 *   - Solo la pone en la cookie si las credenciales son correctas, y nunca la
 *     devuelve en la respuesta ni en un mensaje de error.
 *   - Cuenta los intentos fallidos por IP: sin esto, una contraseña corta se
 *     prueba sola desde internet.
 *   - Si no hay credenciales configuradas, lo dice en la propia página en vez de
 *     dejar un formulario que no puede acertar nunca.
 */

export const dynamic = 'force-dynamic';

/** Intentos fallidos permitidos por IP antes de la pausa. */
const MAX_FAILS = 10;
const WINDOW_MS = 10 * 60 * 1000;

/**
 * El contador vive en la memoria de la instancia. En Netlify cada función
 * arranca en frío, así que no es un muro: es un freno para el que insiste. Con
 * una contraseña larga (la que se genera en `.env`) eso basta.
 */
const attempts = new Map<string, { count: number; resetAt: number }>();

function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for') ?? '';
  const first = forwarded.split(',')[0].trim();
  return first || request.headers.get('x-real-ip') || 'desconocido';
}

function isBlocked(key: string, now: number): boolean {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (entry.resetAt <= now) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILS;
}

function registerFail(key: string, now: number): void {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function isHttps(request: Request): boolean {
  const proto = (request.headers.get('x-forwarded-proto') ?? '').split(',')[0].trim();
  if (proto) return proto === 'https';
  return new URL(request.url).protocol === 'https:';
}

function backToLogin(request: Request, reason: string, next: string): NextResponse {
  const url = new URL('/login', request.url);
  url.searchParams.set('error', reason);
  if (next !== '/') url.searchParams.set('next', next);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: Request) {
  const config = readAuthConfig();
  if (!config) return backToLogin(request, 'config', '/');

  const now = Date.now();
  const key = clientKey(request);
  if (isBlocked(key, now)) return backToLogin(request, 'limite', '/');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return backToLogin(request, '1', '/');
  }

  const usuario = String(form.get('usuario') ?? '');
  const contrasena = String(form.get('contrasena') ?? '');
  const destino = safeNextPath(form.get('next'));

  if (!(await verifyCredentials(config, usuario, contrasena))) {
    registerFail(key, now);
    return backToLogin(request, '1', destino);
  }

  attempts.delete(key);

  const response = NextResponse.redirect(new URL(destino, request.url), 303);
  response.cookies.set({
    name: AUTH_COOKIE,
    value: await createSessionToken(config, now),
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps(request),
    path: '/',
    maxAge: sessionMaxAgeSeconds(config),
  });
  return response;
}
