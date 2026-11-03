import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckCircle2, AlertTriangle, Database, Stethoscope, TriangleAlert } from 'lucide-react';
import { databaseHint, databaseTarget, prismaErrorCode } from '@/lib/databaseDiagnostics';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Diagnóstico de la base de datos | BrainUp Academy',
};

/**
 * ¿Por qué no pinta ninguna vista en producción?
 *
 * No consulta Prisma de forma estática: lo carga con `import()` dentro de un
 * try/catch. Así esta página se pinta **aunque el cliente de Prisma no exista o
 * el motor no cargue**, que es justo el caso en el que hace falta. Todo lo demás
 * (host, TLS, pooler) se deduce de `DATABASE_URL` sin conectar.
 *
 * Nunca imprime credenciales: del host solo se enseña el nombre.
 */
async function probeDatabase(): Promise<{
  ok: boolean;
  code: string | null;
  detail: string;
  ms: number;
  counts: { subjects: number; topics: number } | null;
}> {
  const started = Date.now();
  try {
    const { prisma } = await import('@/lib/prisma');
    const [subjects, topics] = await Promise.all([prisma.subject.count(), prisma.topic.count()]);
    return {
      ok: true,
      code: null,
      detail: '',
      ms: Date.now() - started,
      counts: { subjects, topics },
    };
  } catch (error) {
    return {
      ok: false,
      code: prismaErrorCode(error),
      detail: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
      counts: null,
    };
  }
}

function Fila({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/[0.06] py-2 last:border-0">
      <span className="text-[11px] uppercase tracking-wider text-slate-500">{etiqueta}</span>
      <span className="break-all font-mono text-[11px] text-slate-200">{valor}</span>
    </div>
  );
}

export default async function DiagnosticoPage() {
  const target = databaseTarget();
  const result = await probeDatabase();
  const hint = result.ok ? null : databaseHint(result.detail, result.code);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 border-b border-white/10 pb-4">
        <Stethoscope className="h-6 w-6 text-emerald-400" />
        <div>
          <h1 className="font-mono text-2xl font-black uppercase tracking-tight text-slate-100">
            Diagnóstico
          </h1>
          <p className="text-xs text-slate-400">
            Qué ve esta función de Netlify cuando intenta leer tu base de Supabase.
          </p>
        </div>
      </div>

      <div
        className={`rounded-2xl border p-5 ${
          result.ok
            ? 'border-emerald-500/30 bg-emerald-500/[0.06]'
            : 'border-rose-500/30 bg-rose-500/[0.06]'
        }`}
      >
        <div className="flex items-start gap-3">
          {result.ok ? (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
          ) : (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
          )}
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-bold text-slate-100">
              {result.ok ? 'La base responde' : 'La base no responde'}
            </p>
            <p className="text-xs text-slate-300">
              {result.ok
                ? `${result.counts?.subjects ?? 0} materias y ${result.counts?.topics ?? 0} unidades en ${result.ms} ms.`
                : result.detail.slice(0, 300)}
            </p>
            {result.ok && (result.counts?.subjects ?? 0) === 0 && (
              <p className="text-[11px] text-amber-300">
                Conecta, pero no hay datos: falta cargar el temario (`npm run db:seed`).
              </p>
            )}
          </div>
        </div>
      </div>

      {hint && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.08] p-4">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-amber-300">
            <TriangleAlert className="h-3.5 w-3.5" />
            {result.code ? `Error ${result.code}` : 'Qué hacer'}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-amber-100/90">{hint}</p>
        </div>
      )}

      <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
        <p className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          <Database className="h-3.5 w-3.5" />
          Lo que ve esta función
        </p>
        <Fila etiqueta="Entorno" valor={process.env.NODE_ENV ?? 'desconocido'} />
        <Fila
          etiqueta="DATABASE_URL"
          valor={target.configured ? 'definida' : 'NO definida'}
        />
        <Fila etiqueta="Host" valor={target.host ?? '—'} />
        <Fila etiqueta="Puerto" valor={target.port ?? 'por defecto (5432)'} />
        <Fila etiqueta="Pooler" valor={target.pooled ? 'sí (pgbouncer)' : 'no'} />
        <Fila
          etiqueta="Host directo Supabase"
          valor={target.supabaseDirect ? 'sí (solo IPv6)' : 'no'}
        />
        <Fila etiqueta="Consulta" valor={`${result.ms} ms`} />
      </div>

      <p className="text-[11px] leading-relaxed text-slate-500">
        Esta página no imprime credenciales: solo el host. La misma información en JSON está en{' '}
        <Link href="/api/salud" className="text-emerald-400 hover:text-emerald-300">
          /api/salud
        </Link>
        . Si el host es <code className="rounded bg-slate-800 px-1">db.&lt;ref&gt;.supabase.co</code>,
        Netlify no puede alcanzarlo: usa la cadena del pooler en{' '}
        <code className="rounded bg-slate-800 px-1">DATABASE_URL</code>.
      </p>
    </div>
  );
}
