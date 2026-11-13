import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/auth';
import { appUrl } from '@/lib/requestUrl';

/**
 * Cerrar sesión: Supabase invalida el refresh token y borra sus cookies.
 *
 * Se acepta GET además de POST porque el botón de la cabecera es un formulario
 * (POST), pero un enlace directo a esta dirección también debe dejar la sesión
 * cerrada en vez de dar un 405.
 */

export const dynamic = 'force-dynamic';

async function cerrar(request: Request): Promise<NextResponse> {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  } catch (error) {
    // Si Supabase no está configurado o no responde, la sesión local se va
    // igualmente: el proxy no dejará pasar sin un getUser válido.
    console.warn(
      '[auth] no se ha podido cerrar la sesión remota:',
      error instanceof Error ? error.message : error
    );
  }

  return NextResponse.redirect(appUrl(request, '/login'), 303);
}

export async function POST(request: Request) {
  return cerrar(request);
}

export async function GET(request: Request) {
  return cerrar(request);
}
