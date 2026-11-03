import Link from 'next/link';
import { Clock, Coffee, Sparkles, AlertTriangle, Target, ArrowRight, Info } from 'lucide-react';
import type { DayPlan } from '@/lib/dayPlan';
import { SESSION_BUCKETS, SESSION_STAGES, bucketForMinutes } from '@/lib/sessionEngine';
import SessionActions, { RecalculatePlanButton } from './SessionActions';
import { STUDY_TECHNIQUES, StudyTechnique } from '@/lib/types';

/**
 * «Hoy toca esto»: lo primero que se ve al abrir la app.
 *
 * No es una lista de títulos: cada sesión trae objetivo, duración real, descanso
 * y el motivo por el que toca hoy. Se lee en diez segundos y se empieza con un
 * botón. El plan lo ha decidido el motor (`dayPlan.ts`); aquí solo se pinta.
 */
export default function HoyTocaEsto({ plan }: { plan: DayPlan }) {
  const active = plan.sessions.filter(
    (session) => !session.isCompleted && session.status !== 'abandonada'
  );
  const done = plan.sessions.filter((session) => session.isCompleted);

  return (
    <div className="fade-up rounded-2xl border border-emerald-500/30 bg-[#0a121f] shadow-[0_0_25px_rgba(16,185,129,0.06)] overflow-hidden">
      {/* Cabecera: cuánto tiempo hay y de dónde sale */}
      <div className="p-5 border-b border-slate-800/80 bg-gradient-to-r from-emerald-950/40 to-transparent">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center shrink-0">
              <Target className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-lg font-black tracking-tight text-slate-100">Hoy toca esto</h2>
              <p className="text-xs text-slate-300 mt-0.5">{plan.headline}</p>
              <p className="text-[11px] text-slate-500 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  Ventana: {plan.windowLabel}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Coffee className="w-3 h-3" />
                  {plan.breakMinutes} min de descanso
                </span>
                <span className="font-mono text-slate-400">energía: {plan.energy}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <RecalculatePlanButton compact />
            <Link
              href="/planificador"
              className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-semibold"
            >
              <span>Ver semana</span>
              <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
        </div>

        <p className="text-[11px] text-slate-500 mt-3 flex items-start gap-1.5">
          <Info className="w-3 h-3 mt-0.5 shrink-0" />
          <span>{plan.availabilityReason}</span>
        </p>
      </div>

      {/* Plan de recuperación: se dice, no se esconde */}
      {plan.recovery.active && (
        <div className="px-5 py-3 border-b border-amber-500/20 bg-amber-500/5 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <p className="text-[11px] text-amber-200/90">
            <span className="font-bold">{plan.recovery.headline}.</span> {plan.recovery.detail}
          </p>
        </div>
      )}

      {/* Sesiones */}
      <div className="p-4 space-y-2">
        {active.length === 0 && done.length === 0 && (
          <div className="p-6 rounded-xl border border-dashed border-slate-800 text-center">
            <Sparkles className="w-6 h-6 text-slate-600 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-300">Nada agendado ahora mismo</p>
            <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">{plan.emptyReason}</p>
          </div>
        )}

        {active.map((session) => {
          const bucket = bucketForMinutes(session.durationMinutes);
          const stage = SESSION_STAGES[session.stage];
          const tech = STUDY_TECHNIQUES[session.technique as StudyTechnique];
          const remaining = Math.max(1, session.durationMinutes - session.spentMinutes);

          return (
            <div
              key={session.id}
              className="hover-lift rounded-xl border border-slate-800 glass-card p-3.5 hover:border-slate-700"
            >
              <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                    <span
                      className="text-[10px] font-semibold px-1.5 py-0.5 rounded border"
                      style={{
                        backgroundColor: `${session.subjectColor}15`,
                        borderColor: `${session.subjectColor}40`,
                        color: session.subjectColor,
                      }}
                    >
                      {session.subjectName}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800/60 text-slate-300 font-mono">
                      {session.unitNumber ? `U${session.unitNumber} · ` : ''}
                      {session.topicTitle}
                    </span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${
                        SESSION_BUCKETS[bucket].badgeColor
                      }`}
                    >
                      {session.durationMinutes} min
                      {session.breakMinutes > 0 ? ` + ${session.breakMinutes} descanso` : ''}
                    </span>
                    {session.status === 'parcial' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-300 font-mono">
                        pausada · quedan {remaining} min
                      </span>
                    )}
                  </div>

                  <p className="text-sm font-semibold text-slate-100 leading-snug">
                    {session.objective}
                  </p>

                  <p className="text-[11px] text-slate-400 mt-1 flex items-start gap-1.5">
                    <span className="text-emerald-400 font-semibold shrink-0">Por qué hoy:</span>
                    <span>{session.reason}</span>
                  </p>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[10px] text-slate-500">
                    <span>{stage?.label ?? session.stage}</span>
                    <span>· {tech?.label ?? session.technique}</span>
                    {session.material && <span title={session.material}>· {session.material}</span>}
                    {session.origin === 'reprogramada' && (
                      <span className="text-amber-400/80">· venía de ayer</span>
                    )}
                    {session.origin === 'recuperacion' && (
                      <span className="text-amber-400/80">· plan de recuperación</span>
                    )}
                  </div>
                </div>

                <div className="shrink-0">
                  <SessionActions
                    blockId={session.id}
                    status={session.status}
                    durationMinutes={session.durationMinutes}
                    spentMinutes={session.spentMinutes}
                    isCompleted={session.isCompleted}
                  />
                </div>
              </div>
            </div>
          );
        })}

        {/* Lo hecho, sin ruido pero visible */}
        {done.length > 0 && (
          <div className="pt-1">
            <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">
              Hecho hoy · {plan.completedMinutes} min
            </p>
            <div className="flex flex-wrap gap-1.5">
              {done.map((session) => (
                <span
                  key={session.id}
                  className="text-[10px] px-2 py-1 rounded border border-slate-800 bg-slate-900/60 text-slate-500 line-through"
                >
                  {session.durationMinutes} min · {session.topicTitle}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Si sobra tiempo: microtareas, nunca trabajo nuevo */}
      {plan.micro.length > 0 && (
        <div className="px-5 py-3 border-t border-slate-800/80 bg-[#080d18]">
          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">
            Si te sobra tiempo o terminas antes
          </p>
          <div className="flex flex-wrap gap-2">
            {plan.micro.slice(0, 3).map((task) => (
              <span
                key={task.label}
                title={task.reason}
                className="text-[11px] px-2.5 py-1 rounded-lg border border-cyan-500/25 bg-cyan-500/5 text-cyan-200"
              >
                {task.minutes} min · {task.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
