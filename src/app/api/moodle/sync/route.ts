import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { syncMoodleFeed } from '@/lib/moodle';

interface MoodleSyncBody {
  url?: unknown;
}

export async function POST(request: Request) {
  let body: MoodleSyncBody;
  try {
    body = (await request.json()) as MoodleSyncBody;
  } catch {
    body = {};
  }

  const providedUrl = typeof body.url === 'string' ? body.url.trim() : '';

  const user = await prisma.userProfile.findUnique({ where: { id: 'user_default' } });
  const feedUrl = providedUrl || (user?.moodleFeedUrl || '').trim();

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
    const stats = await syncMoodleFeed(feedUrl);
    const lastSync = new Date();

    // Solo guardamos el enlace cuando la sincronización ha funcionado.
    await prisma.userProfile.update({
      where: { id: 'user_default' },
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
