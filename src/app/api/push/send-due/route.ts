import { NextResponse } from 'next/server';
import { sendDueReminders } from '@/lib/push';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Lo llama el cron local (`npm run push:cron`) cada minuto.
 *
 * Es una ruta pública para el proxy porque no tiene sesión de navegador; se
 * protege con `PUSH_CRON_SECRET`. Sin secreto configurado no hace nada.
 */
export async function POST(request: Request) {
  const secret = (process.env.PUSH_CRON_SECRET ?? '').trim();
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: 'Falta PUSH_CRON_SECRET en el servidor.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const auth = request.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json(
      { ok: false, error: 'No autorizado.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const result = await sendDueReminders();
    return NextResponse.json(
      { ok: true, ...result },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[push] fallo en el envío programado:', error);
    return NextResponse.json(
      { ok: false, error: 'No se han podido enviar los avisos.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
