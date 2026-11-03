import { Suspense } from 'react';
import { prisma } from '@/lib/prisma';
import FocusRoom from '@/components/enfoque/FocusRoom';
import { Timer, History, CheckCircle2, AlertCircle, XCircle } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function FocusPage({
  searchParams,
}: {
  searchParams: Promise<{ block?: string }>;
}) {
  // Si se llega desde una sesión del plan, el bloque manda: tema, técnica,
  // duración y los minutos que ya se hicieron antes de pausarla.
  const { block: blockId } = await searchParams;
  const block = blockId
    ? await prisma.studyBlock.findUnique({
        where: { id: blockId },
        select: {
          id: true,
          topicId: true,
          technique: true,
          durationMinutes: true,
          spentMinutes: true,
          status: true,
        },
      })
    : null;

  const topics = (
    await prisma.topic.findMany({
      include: {
        subject: true,
      },
      orderBy: [{ subject: { order: 'asc' } }],
    })
  ).sort(
    // Primero lo que está medido y flojo; las unidades sin medir van después,
    // en el orden del temario (no son «lo peor», son lo que aún no se sabe).
    (a, b) =>
      (a.masterySource === 'sin_medir' ? 1 : 0) - (b.masterySource === 'sin_medir' ? 1 : 0) ||
      a.masteryLevel - b.masteryLevel ||
      (a.unitNumber ?? 999) - (b.unitNumber ?? 999)
  );

  const recentSessions = await prisma.studySession.findMany({
    take: 5,
    orderBy: { startedAt: 'desc' },
    include: {
      topic: {
        include: {
          subject: true,
        },
      },
    },
  });

  return (
    <div className="space-y-8">
      {/* Cabecera */}
      <div className="pb-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Timer className="w-6 h-6 text-emerald-400" />
          <h1 className="text-2xl font-black tracking-tight text-slate-100 uppercase font-mono">
            Modo Enfoque & Registro de Estudio
          </h1>
        </div>
        <p className="text-xs text-slate-400 mt-1">
          Espacio sin distracciones. Elige tu técnica activa, activa el temporizador y calibra tu dominio al terminar.
        </p>
      </div>

      {/* Sala de Enfoque Interactiva */}
      <Suspense fallback={<div className="p-8 text-center text-xs text-slate-500">Cargando sala de enfoque...</div>}>
        <FocusRoom
          topics={topics}
          initialBlock={
            block && !block.status.includes('completada')
              ? {
                  id: block.id,
                  topicId: block.topicId,
                  technique: block.technique,
                  durationMinutes: block.durationMinutes,
                  spentMinutes: block.spentMinutes,
                }
              : null
          }
        />
      </Suspense>

      {/* Historial Reciente de Sesiones */}
      <div className="p-6 rounded-2xl glass-card space-y-4">
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200 flex items-center gap-2">
          <History className="w-4 h-4 text-emerald-400" />
          <span>Últimas Sesiones Registradas</span>
        </h3>

        {recentSessions.length > 0 ? (
          <div className="space-y-2">
            {recentSessions.map((s) => (
              <div
                key={s.id}
                className="p-3 rounded-xl bg-[#080d17] border border-slate-800/80 flex items-center justify-between text-xs"
              >
                <div className="flex items-center gap-3">
                  {s.outcome === 'entendido' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : s.outcome === 'con_dudas' ? (
                    <AlertCircle className="w-4 h-4 text-amber-400" />
                  ) : (
                    <XCircle className="w-4 h-4 text-rose-400" />
                  )}

                  <div>
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[10px] font-bold px-1.5 py-0.5 rounded border"
                        style={{
                          backgroundColor: `${s.topic.subject.color}15`,
                          borderColor: `${s.topic.subject.color}40`,
                          color: s.topic.subject.color,
                        }}
                      >
                        {s.topic.subject.name}
                      </span>
                      <span className="font-semibold text-slate-200">
                        {s.topic.title}
                      </span>
                    </div>
                    {s.notes && (
                      <p className="text-[11px] text-slate-400 mt-0.5 italic">
                        &quot;{s.notes}&quot;
                      </p>
                    )}
                  </div>
                </div>

                <div className="text-right shrink-0 font-mono text-[11px]">
                  <span className="text-slate-300 font-bold">{s.minutesSpent} min</span>
                  <p className="text-slate-500">
                    {s.previousMastery}% &rarr;{' '}
                    <span
                      className={
                        s.newMastery >= s.previousMastery
                          ? 'text-emerald-400 font-bold'
                          : 'text-rose-400 font-bold'
                      }
                    >
                      {s.newMastery}%
                    </span>
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500 italic">
            Aún no has registrado ninguna sesión de estudio. Inicia un bloque arriba.
          </p>
        )}
      </div>
    </div>
  );
}
