import { NextResponse } from 'next/server';
import { AUTH_COOKIE } from '@/lib/authGate';

/**
 * Cerrar sesión: se borra la cookie y se vuelve al formulario.
 *
 * Se acepta GET además de POST porque el botón de la cabecera es un formulario
 * (POST), pero un enlace directo a esta dirección también debe dejar la sesión
 * cerrada en vez de dar un 405.
 */

export const dynamic = 'force-dynamic';

function cerrar(request: Request): NextResponse {
  const response = NextResponse.redirect(new URL('/login', request.url), 303);
  response.cookies.set({
    name: AUTH_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}

export async function POST(request: Request) {
  return cerrar(request);
}

export async function GET(request: Request) {
  return cerrar(request);
}
