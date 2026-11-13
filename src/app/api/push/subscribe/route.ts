import { NextResponse } from 'next/server';
import { currentTenant } from '@/lib/tenantContext';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SubscriptionBody {
  subscription?: {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  endpoint?: unknown;
}

function readSubscription(body: SubscriptionBody) {
  const raw = body.subscription ?? body;
  const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : '';
  const p256dh =
    typeof (raw as { keys?: { p256dh?: unknown } }).keys?.p256dh === 'string'
      ? String((raw as { keys: { p256dh: string } }).keys.p256dh)
      : '';
  const auth =
    typeof (raw as { keys?: { auth?: unknown } }).keys?.auth === 'string'
      ? String((raw as { keys: { auth: string } }).keys.auth)
      : '';

  if (!/^https:\/\//i.test(endpoint) || !p256dh || !auth) return null;
  return { endpoint, p256dh, auth };
}

/** Guarda la suscripción de este dispositivo (idempotente por endpoint). */
export async function POST(request: Request) {
  let body: SubscriptionBody;
  try {
    body = (await request.json()) as SubscriptionBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  const subscription = readSubscription(body);
  if (!subscription) {
    return NextResponse.json(
      { ok: false, error: 'La suscripción push no tiene el formato esperado.' },
      { status: 400 }
    );
  }

  const { tenant: prisma, user } = await currentTenant();
  const userAgent = request.headers.get('user-agent')?.slice(0, 300) ?? null;

  try {
    const existing = await prisma.pushSubscription.findFirst({
      where: { endpoint: subscription.endpoint },
    });

    if (existing) {
      await prisma.pushSubscription.update({
        where: { id: existing.id },
        data: {
          p256dh: subscription.p256dh,
          auth: subscription.auth,
          userAgent,
        },
      });
    } else {
      await prisma.pushSubscription.create({
        data: { ...subscription, userId: user.id, userAgent },
      });
    }

    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[push] no se pudo guardar la suscripción:', error);
    return NextResponse.json(
      { ok: false, error: 'No se ha podido guardar este dispositivo.' },
      { status: 500 }
    );
  }
}

/** Baja de este dispositivo. */
export async function DELETE(request: Request) {
  let body: SubscriptionBody;
  try {
    body = (await request.json()) as SubscriptionBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Cuerpo inválido.' }, { status: 400 });
  }

  const endpoint =
    typeof body.endpoint === 'string'
      ? body.endpoint
      : typeof body.subscription?.endpoint === 'string'
        ? body.subscription.endpoint
        : '';
  if (!endpoint) {
    return NextResponse.json({ ok: false, error: 'Falta el endpoint.' }, { status: 400 });
  }

  const { tenant: prisma } = await currentTenant();
  await prisma.pushSubscription.deleteMany({ where: { endpoint } });
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
