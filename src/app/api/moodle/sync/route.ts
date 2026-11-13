import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { syncMoodleFeed } from '@/lib/moodle';

interface MoodleSyncBody {
  url?: unknown;
}

export async function POST(request: Request) {
  const user = await requireUser();
  const prisma = db(user.id);
  let body: MoodleSyncBody;
  try {
    body = (await request.json()) as MoodleSyncBody;
  } catch {
    body = {};
  }

  const providedUrl = typeof body.url === 'string' ? body.url.trim() : '';

  const profile = await prisma.userProfile.findUnique({ where: { id: user.id } });
  const feedUrl = providedUrl || (profile?.moodleFeedUrl || '').trim();

  if (!feedUrl) {
    return NextResponse.json(
      {
        error:
          'Pega primero tu enlace de suscripción iCal de Moodle (Calendario → Exportar calendario → URL de suscripción).',
      },
      { status: 400 }
    );
  }

  try {
    const stats = await syncMoodleFeed(user.id, feedUrl);
    const lastSync = new Date();

    // Solo guardamos el enlace cuando la sincronización ha funcionado.
    await prisma.userProfile.update({
      where: { id: user.id },
      data: {
        ...(providedUrl ? { moodleFeedUrl: providedUrl } : {}),
        lastMoodleSync: lastSync,
      },
    });

    return NextResponse.json({ ok: true, stats, lastSync: lastSync.toISOString() });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Error inesperado al sincronizar con Moodle.';
    console.error('[moodle]', message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
