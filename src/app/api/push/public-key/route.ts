import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Clave pública VAPID: no es secreta, pero solo se sirve dentro de la app. */
export async function GET() {
  const publicKey = (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '').trim();
  if (!publicKey) {
    return NextResponse.json(
      { ok: false, error: 'Web Push no está configurado en este servidor.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  return NextResponse.json(
    { ok: true, publicKey },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
