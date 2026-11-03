import { prisma } from '@/lib/prisma';
import CreateErrorModal from '@/components/errores/CreateErrorModal';
import ErrorCard from '@/components/errores/ErrorCard';
import { AlertOctagon, ShieldCheck, AlertTriangle, Filter, Sparkles } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function ErrorsPage({
  searchParams,
}: {
  searchParams: Promise<{ subjectId?: string; cause?: string }>;
}) {
  const { subjectId, cause } = await searchParams;

  const subjects = await prisma.subject.findMany({
    include: {
      topics: {
        select: { id: true, title: true },
      },
    },
    orderBy: { order: 'asc' },
  });

  const errors = await prisma.errorLog.findMany({
    where: {
      ...(subjectId ? { subjectId } : {}),
      ...(cause ? { rootCause: cause } : {}),
    },
    include: {
      subject: true,
      topic: true,
    },
    orderBy: [
      { isMastered: 'asc' }, // Primero los errores pendientes
      { createdAt: 'desc' },
    ],
  });

  const totalErrors = await prisma.errorLog.count();
  const unmasteredCount = await prisma.errorLog.count({ where: { isMastered: false } });
  const masteredCount = totalErrors - unmasteredCount;

  return (
    <div className="space-y-8">
      {/* Cabecera */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-white/10">
        <div>
          <div className="flex items-center gap-2">
            <AlertOctagon className="w-6 h-6 text-rose-400" />
            <h1 className="text-2xl font-black tracking-tight text-slate-100 uppercase font-mono">
              Banco de Errores Quirúrgico
            </h1>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Cada error es un punto ganado en la Selectividad si se analiza la causa raíz y se aplica la regla correctiva.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/enfoque?technique=error_fix&duration=35"
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition-all border border-slate-700 hover:scale-105"
          >
            <Sparkles className="w-3.5 h-3.5 text-rose-400" />
            <span>Repasar Errores en Enfoque</span>
          </Link>
          <CreateErrorModal subjects={subjects} />
        </div>
      </div>

      {/* Métricas Rápidas del Banco */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="glass-card p-4 rounded-2xl flex items-center justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase text-slate-400">Total Registrados</p>
            <p className="text-2xl font-black text-slate-100 font-mono mt-0.5">{totalErrors}</p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-slate-800/60 border border-slate-700 flex items-center justify-center text-slate-300">
            <AlertOctagon className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-[#140c17] border border-rose-900/40 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase text-rose-400">Pendientes de Dominar</p>
            <p className="text-2xl font-black text-rose-400 font-mono mt-0.5">{unmasteredCount}</p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
            <AlertTriangle className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-[#091515] border border-emerald-900/40 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase text-emerald-400">Superados & Asimilados</p>
            <p className="text-2xl font-black text-emerald-400 font-mono mt-0.5">{masteredCount}</p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
            <ShieldCheck className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Barra de Filtros */}
      <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-[#0b101c] border border-white/10 text-xs">
        <div className="flex items-center gap-1.5 text-slate-400 mr-2">
          <Filter className="w-3.5 h-3.5" />
          <span className="font-semibold uppercase text-[10px]">Filtrar por:</span>
        </div>

        <Link
          href="/errores"
          className={`px-2.5 py-1 rounded-lg transition-all ${
            !subjectId && !cause
              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Todos
        </Link>

        {subjects.map((s) => (
          <Link
            key={s.id}
            href={`/errores?subjectId=${s.id}${cause ? `&cause=${cause}` : ''}`}
            className={`px-2.5 py-1 rounded-lg transition-all ${
              subjectId === s.id
                ? 'bg-slate-800 text-slate-100 border border-slate-600 font-bold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {s.name}
          </Link>
        ))}
      </div>

      {/* Listado de Tarjetas de Errores */}
      <div className="space-y-4">
        {errors.length > 0 ? (
          errors.map((err) => <ErrorCard key={err.id} error={err} />)
        ) : (
          <div className="p-12 rounded-2xl border border-dashed border-slate-800 text-center bg-[#0a0f1d]/50 space-y-2">
            <ShieldCheck className="w-10 h-10 text-emerald-400 mx-auto" />
            <h3 className="text-sm font-bold text-slate-200">
              No hay errores con los filtros actuales
            </h3>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              ¡Gran trabajo! Si cometes algún fallo durante tus sesiones o simulacros, regístralo arriba con &quot;Registrar Error Quirúrgico&quot;.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
