import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { FileCheck2, Clock, BookOpen, Sparkles, History, AlertTriangle } from 'lucide-react';
import StartSimulacroButton from '@/components/examen/StartSimulacroButton';

export const dynamic = 'force-dynamic';

/** Formatea números con coma decimal (estilo español). */
function fmt(value: number): string {
  return value.toFixed(1).replace('.0', '').replace('.', ',');
}

function scoreTone(score: number): string {
  if (score >= 7) return 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10';
  if (score >= 5) return 'text-amber-400 border-amber-500/30 bg-amber-500/10';
  return 'text-rose-400 border-rose-500/30 bg-rose-500/10';
}

/** Detecta si un informe guardado proviene de autoevaluación guiada. */
function isSelfGraded(raw: string | null): boolean {
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as { mode?: string }).mode === 'self';
  } catch {
    return false;
  }
}

export default async function ExaminerPage() {
  const subjects = await prisma.subject.findMany({
    include: {
      topics: true,
      exams: true,
    },
    orderBy: { order: 'asc' },
  });

  const history = await prisma.pauExamSession.findMany({
    where: { isCompleted: true },
    orderBy: { createdAt: 'desc' },
    take: 6,
  });

  return (
    <div className="space-y-8">
      {/* Cabecera */}
      <div className="pb-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <FileCheck2 className="w-6 h-6 text-emerald-400" />
          <h1 className="text-2xl font-black tracking-tight text-slate-100 uppercase font-mono">
            Examinador PAU & Simulacros
          </h1>
        </div>
        <p className="text-xs text-slate-400 mt-1">
          Simulación real de Selectividad. Pruebas cronometradas de 90 minutos con corrección por
          rúbrica e informe de puntos débiles.
        </p>
      </div>

      {/* Cómo funciona */}
      <div className="glass-card p-4 rounded-2xl flex items-start gap-3">
        <Sparkles className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
        <p className="text-xs text-slate-400 leading-relaxed">
          Cada simulacro se genera con IA sobre tus <strong className="text-slate-200">temas más
          débiles</strong> y se corrige con rúbrica oficial PAU (rigor 40%, desarrollo 30%,
          resultado 20%, notación 10%). Si la IA no está disponible (sin cupo o sin clave), el
          examen usa plantillas locales y la corrección pasa a autoevaluación guiada: la app{' '}
          <strong className="text-slate-200">nunca se queda sin funcionar</strong>.
        </p>
      </div>

      {/* Grid de Asignaturas para Lanzar Simulacro */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {subjects.map((sub) => {
          // Sin inventar debilidades: primero lo medido (más flojo antes) y, si
          // no hay mediciones, unidades del temario que ya tocan.
          const focusTopics = [...sub.topics]
            .sort(
              (a, b) =>
                (a.masterySource === 'sin_medir' ? 1 : 0) - (b.masterySource === 'sin_medir' ? 1 : 0) ||
                a.masteryLevel - b.masteryLevel ||
                (a.unitNumber ?? 999) - (b.unitNumber ?? 999)
            )
            .slice(0, 2)
            .map((t) => ({
              title: t.title,
              measured: t.masterySource !== 'sin_medir',
              masteryLevel: t.masteryLevel,
            }));
          const anyMeasured = focusTopics.some((t) => t.measured);

          return (
            <div
              key={sub.id}
              className="p-5 rounded-2xl glass-card space-y-4 flex flex-col justify-between"
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span
                    className="text-xs font-bold px-2 py-0.5 rounded border"
                    style={{
                      backgroundColor: `${sub.color}15`,
                      borderColor: `${sub.color}40`,
                      color: sub.color,
                    }}
                  >
                    {sub.name}
                  </span>
                  {sub.pauWeight > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 font-mono">
                      Pondera x{sub.pauWeight}
                    </span>
                  )}
                </div>

                <div>
                  <h3 className="text-sm font-bold text-slate-100">Simulacro Oficial PAU</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    {sub.topics.length} temas disponibles en el banco.
                  </p>
                </div>

                <div className="flex items-center gap-4 text-xs text-slate-400 pt-1">
                  <div className="flex items-center gap-1.5 font-mono">
                    <Clock className="w-3.5 h-3.5 text-amber-400" />
                    <span>90 min</span>
                  </div>
                  <div className="flex items-center gap-1.5 font-mono">
                    <BookOpen className="w-3.5 h-3.5 text-blue-400" />
                    <span>4 Bloques / 10 pts</span>
                  </div>
                </div>

                {focusTopics.length > 0 && (
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    {anyMeasured ? 'Se priorizarán tus niveles medidos más bajos: ' : 'Aún no hay mediciones de tu nivel: se priorizarán unidades de tu temario: '}
                    {focusTopics
                      .map((t) => `«${t.title}»${t.measured ? ` (${t.masteryLevel}%)` : ''}`)
                      .join(' y ')}
                    .
                  </p>
                )}
              </div>

              <div className="pt-3 border-t border-slate-800">
                <StartSimulacroButton
                  subjectId={sub.id}
                  subjectName={sub.name}
                  disabled={sub.topics.length === 0}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Historial de simulacros corregidos */}
      {history.length > 0 && (
        <div className="p-5 rounded-2xl glass-card space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
            <History className="w-4 h-4 text-emerald-400" />
            <span>Historial de simulacros corregidos</span>
          </h3>

          <div className="space-y-2">
            {history.map((session) => {
              const weak = session.weakTopicsJson
                ? (JSON.parse(session.weakTopicsJson) as string[])
                : [];
              return (
                <Link
                  key={session.id}
                  href={`/examinador/${session.id}`}
                  className="flex items-center justify-between gap-3 p-3 rounded-xl bg-[#080d18] border border-slate-800 hover:border-emerald-500/40 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-200 truncate">
                      {session.subjectName}
                    </p>
                    <p className="text-[10px] text-slate-500 font-mono">
                      {new Date(session.createdAt).toLocaleDateString('es-ES', {
                        day: '2-digit',
                        month: 'short',
                      })}{' '}
                      · {session.elapsedMinutes} min de 90 ·{' '}
                      {isSelfGraded(session.rubricFeedback) ? 'autoevaluación' : 'corrección IA'}
                    </p>
                    {weak.length > 0 && (
                      <p className="text-[10px] text-rose-400/80 mt-0.5 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        <span className="truncate">{weak.join(' · ')}</span>
                      </p>
                    )}
                  </div>
                  <span
                    className={`shrink-0 text-sm font-black font-mono px-2.5 py-1 rounded-lg border ${scoreTone(
                      session.finalScore ?? 0
                    )}`}
                  >
                    {fmt(session.finalScore ?? 0)}/10
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
