import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  databaseHint,
  databaseTarget,
  prismaErrorCode,
} from '@/lib/databaseDiagnostics';
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
 *
 * OJO CON EL POOL Y CON EL TIEMPO. La base remota (Supabase, pooler, EU-North)
 * tiene **un solo hueco** de conexión y tarda entre 1 y 3 s por consulta. Antes
 * este endpoint hacía seis consultas seguidas: competía con el turno del
 * catedrático, se pasaba de los 8 s, `sirve.js` lo leía como «servidor zombi» y
 * lo mataba **en mitad de la generación**. El navegador lo enseñaba como
 * «Failed to fetch». Ahora:
 *
 *   1. La respuesta se sirve SIEMPRE desde caché en cuanto hay una (milisegundos).
 *   2. Si la caché está caducada, se contesta igual y se refresca por detrás.
 *   3. La sonda en frío es UNA consulta (`SELECT 1`) con tope duro.
 *   4. Cuentas y memoria se cargan aparte, sin retener la respuesta.
 *
 * Con esto, el lanzador sabe si la app está en pie sin esperar a la base, y una
 * generación larga nunca se lleva por delante el proceso.
 */

export const dynamic = 'force-dynamic';

/** Lo que se reutiliza sin volver a sondear (la respuesta se sirve igualmente). */
const HEALTH_CACHE_MS = 12_000;
/** Tope de la sonda mínima en frío. */
const PROBE_TIMEOUT_MS = 5_000;
/** Tope de los detalles (cuentas + memoria), que nunca bloquean la respuesta. */
const DETAIL_TIMEOUT_MS = 4_000;

interface Counts {
  subjects: number;
  topics: number;
  notes: number;
}

interface HealthMemory {
  days: number;
  scopes: number;
  latest: { scope: string; day: string; chars: number; writtenBy: string } | null;
}

interface DatabaseSnapshot {
  ok: boolean;
  detail: string;
  code: string | null;
  counts: Counts | null;
  probeMs: number;
}

interface HealthSnapshot {
  at: number;
  database: DatabaseSnapshot;
  memory: HealthMemory | null;
}

let cache: HealthSnapshot | null = null;

/** Lo último que se pudo leer de la base, aunque sea de hace un minuto. */
const details: { counts: Counts | null; memory: HealthMemory | null } = {
  counts: null,
  memory: null,
};

let loadingDetails = false;

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

/** Un tope de tiempo que no deja colgada la respuesta aunque la consulta siga. */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label}: sin respuesta en ${ms} ms`));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

/** La sonda mínima: ¿hay una conexión viva y capaz de ejecutar algo? */
async function probeDatabase(): Promise<DatabaseSnapshot> {
  const startedAt = Date.now();
  try {
    await withDeadline(prisma.$queryRaw`SELECT 1`, PROBE_TIMEOUT_MS, 'base de datos');
    return { ok: true, detail: '', code: null, counts: null, probeMs: Date.now() - startedAt };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      detail,
      code: prismaErrorCode(error),
      counts: null,
      probeMs: Date.now() - startedAt,
    };
  }
}

/**
 * Cuentas y memoria, por detrás. Es información de adorno para el parte: si
 * tarda o falla, se conserva lo último leído y la respuesta ya ha salido.
 */
async function refreshDetails(): Promise<void> {
  if (loadingDetails) return;
  loadingDetails = true;
  try {
    const [counts, memory] = await Promise.allSettled([
      withDeadline(
        Promise.all([prisma.subject.count(), prisma.topic.count(), prisma.note.count()]),
        DETAIL_TIMEOUT_MS,
        'cuentas de la base'
      ).then(([subjects, topics, notes]): Counts => ({ subjects, topics, notes })),
      withDeadline(
        (async (): Promise<HealthMemory> => {
          const [days, latest, scopes] = await Promise.all([
            prisma.agentMemory.count(),
            prisma.agentMemory.findFirst({
              orderBy: { updatedAt: 'desc' },
              select: { scope: true, day: true, summary: true, writtenBy: true },
            }),
            prisma.agentMemory.findMany({ distinct: ['scope'], select: { scope: true } }),
          ]);
          return {
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
        })(),
        DETAIL_TIMEOUT_MS,
        'memoria de la IA'
      ),
    ]);

    if (counts.status === 'fulfilled') details.counts = counts.value;
    if (memory.status === 'fulfilled') details.memory = memory.value;

    // El parte que ya está en caché se completa sin volver a sondear: la
    // siguiente petición trae las cuentas y la memoria al día.
    if (cache && cache.database.ok) {
      cache.database.counts = details.counts;
      cache.memory = details.memory;
    }
  } catch (error) {
    console.warn('[salud] no se han podido leer los detalles:', error);
  } finally {
    loadingDetails = false;
  }
}

function render(snapshot: HealthSnapshot, startedAt: number, fromCache: boolean) {
  const database = snapshot.database;
  const providers = getConfiguredProviders();

  return NextResponse.json(
    {
      // `ok` sigue significando «la base responde», que es lo que enseña la
      // pantalla de error. Que la app esté en pie se demuestra contestando esto.
      ok: database.ok,
      service: 'brainup-academy',
      /** Compilación en marcha (null en desarrollo, donde no hay BUILD_ID). */
      build: currentBuildId(),
      checkedAt: new Date().toISOString(),
      responseMs: Date.now() - startedAt,
      cached: fromCache,
      database: {
        ok: database.ok,
        code: database.code ?? undefined,
        detail: database.detail || undefined,
        // Qué hacer, en castellano: es lo que enseña la pantalla de error.
        hint: database.ok ? undefined : databaseHint(database.detail, database.code),
        target: databaseTarget(),
        counts: database.counts,
        probeMs: database.probeMs,
      },
      memory: snapshot.memory,
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

export async function GET() {
  const startedAt = Date.now();

  // Con caché, se contesta ya. Si está caducada, se refresca por detrás sin que
  // nadie espere: el lanzador pregunta cada 20 s y no puede quedarse 8 s
  // colgado, porque entonces mataría el servidor en mitad de una respuesta.
  if (cache) {
    if (Date.now() - cache.at >= HEALTH_CACHE_MS) void refreshDetails();
    return render(cache, startedAt, true);
  }

  // Primera pregunta desde que arrancó el proceso: una sola sonda, con tope.
  const database = await probeDatabase();

  // Si la base ha contestado rápido, se espera un momento a los detalles para
  // que el primer parte ya venga completo. Si no, se entregan cuando lleguen.
  if (database.ok && database.probeMs < 1_200) await refreshDetails();

  const snapshot: HealthSnapshot = {
    at: Date.now(),
    database,
    memory: details.memory,
  };
  database.counts = details.counts;
  cache = snapshot;

  if (!details.memory) void refreshDetails();

  return render(snapshot, startedAt, false);
}
