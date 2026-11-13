import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getOptionalUser } from '@/lib/auth';
import { db } from '@/lib/db';
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
/**
 * Cuentas y memoria de UNA cuenta. No se guarda en la caché compartida del
 * parte: el proceso sirve a varias cuentas y estos números son suyos.
 */
async function refreshDetails(
  userId: string
): Promise<{ counts: Counts | null; memory: HealthMemory | null }> {
  const scoped = db(userId);
  const [counts, memory] = await Promise.allSettled([
    withDeadline(
      Promise.all([scoped.subject.count(), scoped.topic.count(), scoped.note.count()]),
      DETAIL_TIMEOUT_MS,
      'cuentas de la base'
    ).then(([subjects, topics, notes]): Counts => ({ subjects, topics, notes })),
    withDeadline(
      (async (): Promise<HealthMemory> => {
        const [days, latest, scopes] = await Promise.all([
          scoped.agentMemory.count(),
          scoped.agentMemory.findFirst({
            orderBy: { updatedAt: 'desc' },
            select: { scope: true, day: true, summary: true, writtenBy: true },
          }),
          scoped.agentMemory.findMany({ distinct: ['scope'], select: { scope: true } }),
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

  return {
    counts: counts.status === 'fulfilled' ? counts.value : null,
    memory: memory.status === 'fulfilled' ? memory.value : null,
  };
}

function render(
  snapshot: HealthSnapshot,
  startedAt: number,
  fromCache: boolean,
  details: { counts: Counts | null; memory: HealthMemory | null } | null
) {
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
        counts: details?.counts ?? null,
        probeMs: database.probeMs,
      },
      memory: details?.memory ?? null,
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
  const authUser = await getOptionalUser();

  // Son los datos de una cuenta: solo se leen si hay sesión. El parte público
  // (lanzador, vigilante, pantalla de error) sigue diciendo si la base responde.
  const details = authUser ? await refreshDetails(authUser.id) : null;

  // Con caché, se contesta ya. La caché solo guarda la sonda de la base, nunca
  // las cuentas ni la memoria de nadie.
  if (cache && Date.now() - cache.at < HEALTH_CACHE_MS) {
    return render(cache, startedAt, true, details);
  }

  if (cache) {
    const database = await probeDatabase();
    cache = { at: Date.now(), database, memory: null };
    return render(cache, startedAt, true, details);
  }

  // Primera pregunta desde que arrancó el proceso: una sola sonda, con tope.
  const database = await probeDatabase();

  const snapshot: HealthSnapshot = {
    at: Date.now(),
    database,
    memory: null,
  };
  cache = snapshot;

  return render(snapshot, startedAt, false, details);
}
