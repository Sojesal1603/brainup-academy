
import Link from 'next/link';
import { AlertTriangle, Award, Brain, RotateCcw, Target } from 'lucide-react';
import MathText from './MathText';
import type { ExamBlock, ExamGrade } from '@/lib/examenTypes';
import { getEbauCommunity } from '@/lib/ebauCommunities';

/** Formatea números con coma decimal (estilo español). */
function fmt(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '').replace('.', ',');
}

/** Los apartados se corrigen en cuartos de punto: no se redondean a décimas. */
function fmtGrade(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, '').replace('.', ',');
}

function scoreColor(total: number): string {
  if (total >= 7) return 'text-emerald-400';
  if (total >= 5) return 'text-amber-400';
  return 'text-rose-400';
}

export default function ExamResults({
  subjectName,
  blocks,
  grade,
  answers,
  elapsedMinutes,
}: {
  subjectName: string;
  blocks: ExamBlock[];
  grade: ExamGrade;
  answers: string[];
  elapsedMinutes: number;
}) {
  const modeLabel =
    grade.mode === 'ai'
      ? `Corregido por IA${grade.model ? ` · ${grade.model}` : ''}`
      : 'Autoevaluación guiada';
  const communityLabel = grade.community ? getEbauCommunity(grade.community).name : null;

  return (
    <div className="space-y-6">
      {/* Cabecera con nota final */}
      <div className="p-6 rounded-2xl bg-gradient-to-r from-[#131825] to-[#0a1a14] border border-emerald-500/30 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center">
              <Award className="w-6 h-6 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-lg font-black text-slate-100 uppercase font-mono">
                Simulacro corregido · {subjectName}
              </h2>
              <p className="text-xs text-slate-400">
                {communityLabel ? `${communityLabel} · ` : ''}
                {modeLabel} · entregado en {elapsedMinutes} min
              </p>
            </div>
          </div>

          <div className="text-right">
            <div className="flex items-baseline gap-1 justify-end">
              <span className={`text-4xl font-black font-mono ${scoreColor(grade.total)}`}>
                {fmt(grade.total)}
              </span>
              <span className="text-sm text-slate-400">/ 10</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5">Nota del simulacro</p>
          </div>
        </div>

        <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${
              grade.total >= 7 ? 'bg-emerald-400' : grade.total >= 5 ? 'bg-amber-400' : 'bg-rose-400'
            }`}
            style={{ width: `${Math.min(100, (grade.total / 10) * 100)}%` }}
          />
        </div>

        {grade.globalFeedback && (
          <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-line border-l-2 border-emerald-500/50 pl-3">
            {grade.globalFeedback}
          </p>
        )}
      </div>

      {/* Auditoría: lo que ha entrado en el planificador */}
      {grade.audit && (grade.audit.errorsCreated > 0 || grade.audit.pillsCreated > 0) && (
        <div className="p-4 rounded-xl bg-emerald-500/[0.06] border border-emerald-500/30 space-y-1">
          <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-300">
            Auditoría del simulacro
          </p>
          <p className="text-xs text-emerald-100/90 leading-relaxed">
            {grade.audit.errorsCreated > 0
              ? `${grade.audit.errorsCreated} ficha(s) nueva(s) en el Banco de Errores. `
              : 'Sin fichas nuevas: los fallos ya estaban registrados. '}
            {grade.audit.pillsCreated > 0
              ? `${grade.audit.pillsCreated} píldora(s) de 15 min añadidas al plan de hoy.`
              : 'No ha hecho falta añadir píldoras nuevas al plan.'}
          </p>
        </div>
      )}

      {/* Temas débiles detectados */}
      {grade.weakTopicTitles.length > 0 && (
        <div className="p-4 rounded-xl bg-[#1a0f0d] border border-rose-500/30 space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-rose-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            <span>Temas débiles detectados (repaso obligatorio)</span>
          </h3>
          <div className="flex flex-wrap gap-2">
            {grade.weakTopicTitles.map((topic) => (
              <span
                key={topic}
                className="text-xs px-2.5 py-1 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-200"
              >
                {topic}
              </span>
            ))}
          </div>
          <p className="text-[11px] text-rose-400/80">
            El planificador los reordenará como prioridad en los próximos días.
          </p>
        </div>
      )}

      {/* Corrección bloque a bloque */}
      <div className="space-y-4">
        {blocks.map((block, index) => {
          const result = grade.blocks[index];
          const score = result?.score ?? 0;
          const ratio = block.points > 0 ? score / block.points : 0;
          const tone = ratio >= 0.85 ? 'emerald' : ratio >= 0.5 ? 'amber' : 'rose';

          return (
            <div
              key={index}
              className="p-5 glass-card rounded-2xl space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="w-7 h-7 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-xs font-bold text-slate-300 font-mono">
                    {index + 1}
                  </span>
                  <div>
                    <p className="text-xs font-bold text-slate-200">{block.topicTitle}</p>
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">
                      Bloque {index + 1} de {blocks.length}
                    </p>
                  </div>
                </div>
                <span
                  className={`text-sm font-black font-mono px-2.5 py-1 rounded-lg border ${
                    tone === 'emerald'
                      ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
                      : tone === 'amber'
                        ? 'text-amber-400 bg-amber-500/10 border-amber-500/30'
                        : 'text-rose-400 bg-rose-500/10 border-rose-500/30'
                  }`}
                >
                  {fmt(score)} / {fmt(block.points)}
                </span>
              </div>

              <div className="text-xs text-slate-300 leading-relaxed">
                <MathText text={block.prompt} />
              </div>

              {result?.feedback && (
                <div className="p-3 rounded-lg bg-[#080d18] border border-slate-800">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1 flex items-center gap-1.5">
                    <Target className="w-3 h-3 text-emerald-400" />
                    Comentario del corrector
                  </p>
                  <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-line">
                    {result.feedback}
                  </p>
                </div>
              )}

              {result?.apartados && result.apartados.length > 0 && (
                <div className="space-y-1.5 rounded-lg border border-slate-800 bg-[#080d18] p-3">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                    Desglose por apartados
                  </p>
                  {result.apartados.map((apartado, apartadoIndex) => (
                    <div
                      key={`${apartado.label}-${apartadoIndex}`}
                      className="flex items-center justify-between gap-2 text-[11px]"
                    >
                      <span className="truncate text-slate-300">{apartado.label}</span>
                      <span className="shrink-0 font-mono text-slate-400">
                        {fmtGrade(apartado.score)} / {fmtGrade(apartado.max)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {result?.notationIssues && result.notationIssues.length > 0 && (
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.05] p-3">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-amber-300">
                    Fallos de notación
                  </p>
                  <ul className="list-inside list-disc space-y-0.5 text-[11px] text-amber-100/85">
                    {result.notationIssues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )}

              {answers[index]?.trim() && (
                <details className="group">
                  <summary className="text-[11px] text-slate-500 hover:text-slate-300 cursor-pointer select-none">
                    Ver tu respuesta
                  </summary>
                  <p className="mt-2 text-xs text-slate-400 whitespace-pre-wrap font-mono bg-[#080d18] border border-slate-800 rounded-lg p-3 max-h-64 overflow-y-auto">
                    {answers[index]}
                  </p>
                </details>
              )}
            </div>
          );
        })}
      </div>

      {/* Acciones */}
      <div className="flex flex-col sm:flex-row gap-3">
        <Link
          href="/examinador"
          className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-sm font-bold transition-all shadow-md hover:scale-[1.01]"
        >
          <RotateCcw className="w-4 h-4 stroke-[2.5]" />
          <span>Lanzar otro simulacro</span>
        </Link>
        <Link
          href="/"
          className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl glass-card hover:bg-[#111827] border border-white/10 text-slate-200 text-sm font-bold transition-all"
        >
          <Brain className="w-4 h-4 text-emerald-400" />
          <span>Volver al Cuartel</span>
        </Link>
      </div>
    </div>
  );
}
