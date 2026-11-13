import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/auth';
import { hasSupabaseAuthConfig } from '@/lib/supabaseConfig';
import { appUrl, safeNextPath } from '@/lib/requestUrl';

/**
 * El botón «Entrar» del formulario de `/login`.
 *
 * Es un POST de formulario normal (no una acción de servidor) para que funcione
 * sin JavaScript. Supabase Auth valida el email y la contraseña y deja su cookie
 * de sesión; aquí no se guarda la contraseña ni se devuelve en la respuesta.
 */

export const dynamic = 'force-dynamic';

/** Intentos fallidos permitidos por IP antes de la pausa. */
const MAX_FAILS = 10;
const WINDOW_MS = 10 * 60 * 1000;

/**
 * El contador vive en la memoria de la instancia. En Netlify cada función
 * arranca en frío, así que no es un muro: es un freno para el que insiste.
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

function backToLogin(request: Request, reason: string, next: string): NextResponse {
  const url = appUrl(request, '/login');
  url.searchParams.set('error', reason);
  if (next !== '/') url.searchParams.set('next', next);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: Request) {
  if (!hasSupabaseAuthConfig()) return backToLogin(request, 'config', '/');

  const now = Date.now();
  const key = clientKey(request);
  if (isBlocked(key, now)) return backToLogin(request, 'limite', '/');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return backToLogin(request, '1', '/');
  }

  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const destino = safeNextPath(form.get('next'));

  if (!email || !password) {
    registerFail(key, now);
    return backToLogin(request, '1', destino);
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      registerFail(key, now);
      console.warn(`[auth] login rechazado para ${email.slice(0, 3)}…: ${error.message}`);
      return backToLogin(request, '1', destino);
    }

    attempts.delete(key);
    return NextResponse.redirect(appUrl(request, destino), 303);
  } catch (error) {
    console.error(
      '[auth] no se ha podido iniciar sesión:',
      error instanceof Error ? error.message : error
    );
    return backToLogin(request, 'conexion', destino);
  }
}
