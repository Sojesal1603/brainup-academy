import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getConfiguredProviders, hasAiProvider, localModelMemory } from '@/lib/aiEngine';

/**
 * «¿Estás bien?» — el parte de salud de la app.
 *
 * Existe para que el vigilante (`npm run vigilante`) y el taller de
 * mantenimiento puedan preguntar sin adivinar: que el puerto esté abierto no
 * significa que la base responda. Aquí se toca la base de verdad y se dice si
 * hay motor de IA configurado.
 *
 * Nunca devuelve 500 por un fallo interno: contesta 200 con `ok: false` y el
 * motivo, que es lo que necesita quien vigila (un 500 no dice nada y llena el
 * log de ruido).
 */

export const dynamic = 'force-dynamic';

/**
 * Identificador de la compilación que está sirviendo la app.
 *
 * Lo usa la propia interfaz para saber si la pestaña que tienes abierta es de
 * antes de un cambio: entonces el HTML/JS que corre en tu navegador y el que
 * sirve el servidor ya no dicen lo mismo, y React avisa de que «hydration failed»
 * (un error que asusta y que se arregla recargando). Con esto se te avisa con un
 * botón en vez de dejarte adivinando.
 */
function currentBuildId(): string | null {
  // En desarrollo no hay una compilación única: `next build` puede dejar un
  // BUILD_ID en `.next` mientras el servidor de desarrollo sirve otra cosa. Si
  // se publicara, cada compilación haría creer al navegador que la app cambió
  // (aviso de versión nueva, recargas y comparaciones que no significan nada).
  if (process.env.NODE_ENV !== 'production') return null;
  try {
    return readFileSync(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export async function GET() {
  const startedAt = Date.now();

  let database = false;
  let databaseDetail = '';
  let counts: { subjects: number; topics: number; notes: number } | null = null;

  try {
    const [subjects, topics, notes] = await Promise.all([
      prisma.subject.count(),
      prisma.topic.count(),
      prisma.note.count(),
    ]);
    database = true;
    counts = { subjects, topics, notes };
  } catch (error) {
    databaseDetail = error instanceof Error ? error.message : String(error);
  }

  const providers = getConfiguredProviders();

  // La memoria entre días, en una línea: cuántos días recuerda cada IA y qué
  // recordó por última vez. Lo escribe el tutor al contestar (`after`), así que
  // verlo aquí es ver que la memoria se está apuntando de verdad.
  let memory: {
    days: number;
    scopes: number;
    latest: { scope: string; day: string; chars: number; writtenBy: string } | null;
  } | null = null;

  try {
    const [days, latest] = await Promise.all([
      prisma.agentMemory.count(),
      prisma.agentMemory.findFirst({
        orderBy: { updatedAt: 'desc' },
        select: { scope: true, day: true, summary: true, writtenBy: true },
      }),
    ]);
    const scopes = await prisma.agentMemory.findMany({ distinct: ['scope'], select: { scope: true } });
    memory = {
      days,
      scopes: scopes.length,
      latest: latest
        ? {
            scope: latest.scope,
            day: latest.day,
            chars: latest.summary.length,
            writtenBy: latest.writtenBy,
          }
        : null,
    };
  } catch (error) {
    // Que la memoria falle no hace que la app esté mal: se dice y ya.
    console.warn('[salud] no se ha podido leer la memoria de la IA:', error);
  }

  return NextResponse.json(
    {
      ok: database,
      service: 'brainup-academy',
      /** Compilación en marcha (null en desarrollo, donde no hay BUILD_ID). */
      build: currentBuildId(),
      checkedAt: new Date().toISOString(),
      responseMs: Date.now() - startedAt,
      database: { ok: database, detail: databaseDetail || undefined, counts },
      memory,
      ai: {
        configured: hasAiProvider(),
        providers,
        // RAM libre y margen para el modelo local: si no cabe, no se carga.
        localModel: localModelMemory(),
        note: hasAiProvider()
          ? undefined
          : 'Sin claves de IA: el resto de la app funciona y la puesta a punto responde en modo local.',
      },
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}
