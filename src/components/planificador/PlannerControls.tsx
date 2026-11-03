'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import clsx from 'clsx';

interface PlanSession {
  id: string;
  asignatura: string;
  tema: string;
  unidad: number | null;
  color: string;
  objetivo: string;
  duracionMinutos: number;
  descansoMinutos: number;
  tipoActividad: string;
  fase: string;
  motivo: string;
  estado: string;
  completada: boolean;
  minutosHechos: number;
  dominio: number;
  fuenteDominio: string;
}

interface DayReviewView {
  completedBlocks: number;
  completedMinutes: number;
  completedTopics: Array<{ title: string; subjectName: string; subjectColor: string }>;
  inProgressBlocks: number;
  inProgressMinutes: number;
  pendingBlocks: number;
  pendingMinutes: number;
  delayedBlocks: number;
  delayedMinutes: number;
  delayedTopics: Array<{
    title: string;
    subjectName: string;
    subjectColor: string;
    daysLate: number;
  }>;
  studiedMinutes: number;
  availableMinutes: number;
  remainingMinutes: number;
  dueReviews: number;
  openErrors: number;
  exams: Array<{
    id: string;
    subjectName: string;
    subjectColor: string;
    title: string;
    days: number;
    format: string;
  }>;
}

interface ReplanResponse {
  ok: boolean;
  error?: string;
  headline?: string;
  reason?: string;
  availableMinutes?: number;
  plannedMinutes?: number;
  created?: number;
  carried?: number;
  abandoned?: number;
  review?: DayReviewView;
  plan?: PlanSession[];
  generatedAt?: string;
}

const FORMAT_LABEL: Record<string, string> = {
  test: 'Test',
  desarrollo: 'Desarrollo',
  practico: 'Práctico',
};

function Stat({
  label,
  value,
  hint,
  tone = 'slate',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'emerald' | 'amber' | 'rose' | 'slate' | 'violet';
}) {
  const toneClass =
    tone === 'emerald'
      ? 'text-emerald-400'
      : tone === 'amber'
        ? 'text-amber-400'
        : tone === 'rose'
          ? 'text-rose-400'
          : tone === 'violet'
            ? 'text-violet-300'
            : 'text-slate-200';

  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
      <p className="text-[9px] font-mono uppercase tracking-wider text-slate-500">{label}</p>
      <p className={clsx('mt-1 text-lg font-black font-mono', toneClass)}>{value}</p>
      {hint && <p className="mt-0.5 text-[10px] leading-tight text-slate-500">{hint}</p>}
    </div>
  );
}

export default function PlannerControls() {
  const router = useRouter();
  const [availableMinutes, setAvailableMinutes] = useState(180);
  const [result, setResult] = useState<ReplanResponse | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updatePlan = async () => {
    setPlanLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/planner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ availableMinutes }),
      });
      const data = (await res.json()) as ReplanResponse;
      if (!res.ok || data.ok === false) {
        setError(data.error || data.reason || 'No se ha podido actualizar el plan.');
        setResult(null);
      } else {
        setResult(data);
        // El calendario de 7 días vive en el servidor: se refresca en el acto.
        router.refresh();
      }
    } catch {
      setError('No se ha podido contactar con el planificador. Revisa la conexión.');
    } finally {
      setPlanLoading(false);
    }
  };

  const review = result?.review;
  const sessions = result?.plan ?? [];

  return (
    <div className="space-y-4">
      <div className="glass-card p-4 rounded-2xl">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-100 uppercase tracking-wider">
              Tiempo disponible hoy
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Pon tu techo de hoy: el plan nunca pedirá más de lo que queda de verdad.
            </p>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="metric-glow text-2xl font-black text-emerald-500 font-mono">
              {availableMinutes}
            </span>
            <span className="text-xs text-slate-400">minutos</span>
          </div>
        </div>

        <div className="mt-4">
          <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
            <div
              className="h-full rounded-full bg-emerald-600 transition-all duration-300"
              style={{ width: `${Math.min(100, (availableMinutes / 300) * 100)}%` }}
            />
          </div>

          {/* En pantalla táctil los presets son botones grandes, no un deslizador
              diminuto: se acierta con el pulgar. */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
            {[60, 120, 180, 240].map((minutes) => (
              <button
                key={minutes}
                type="button"
                onClick={() => setAvailableMinutes(minutes)}
                aria-pressed={availableMinutes === minutes}
                className={`min-h-[44px] rounded-xl border text-xs font-semibold transition-colors ${
                  availableMinutes === minutes
                    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                    : 'border-white/10 bg-white/[0.02] text-slate-300 hover:border-white/20'
                }`}
              >
                {minutes / 60}h
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={updatePlan}
          disabled={planLoading}
          className="mt-4 flex w-full items-center justify-center gap-2 min-h-[48px] rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-3 text-sm font-bold text-slate-950 transition-all hover:from-emerald-500 hover:to-teal-500 disabled:opacity-60 sm:w-auto"
        >
          {planLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          {planLoading ? 'Recalculando…' : 'Actualizar Plan de Hoy'}
        </button>
        <p className="mt-2 text-[11px] text-slate-500">
          Revisa lo completado y lo retrasado, descuenta lo ya estudiado y reparte lo que queda entre
          tus exámenes y el temario activo. Lo que ya has hecho no se toca.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
          {error}
        </div>
      )}

      {result && review && (
        <div className="glass-card p-5 rounded-2xl space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-100">
                Plan actualizado
              </h2>
              <p className="mt-1 text-xs text-slate-300">{result.headline}</p>
              {result.reason && <p className="mt-0.5 text-[11px] text-slate-500">{result.reason}</p>}
            </div>
            <span className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-mono font-semibold text-emerald-300">
              <Sparkles className="h-3 w-3" />
              motor de sesiones
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="Completado hoy"
              value={`${review.completedBlocks}`}
              hint={`${review.completedMinutes} min cerrados`}
              tone="emerald"
            />
            <Stat
              label="Pendiente hoy"
              value={`${review.pendingBlocks + review.inProgressBlocks}`}
              hint={`${review.remainingMinutes} min por hacer`}
              tone="amber"
            />
            <Stat
              label="Retrasado"
              value={`${review.delayedBlocks}`}
              hint={
                review.delayedBlocks > 0
                  ? `${result.carried ?? 0} tema(s) vuelven al plan`
                  : 'nada de días anteriores'
              }
              tone={review.delayedBlocks > 0 ? 'rose' : 'slate'}
            />
            <Stat
              label="Tiempo real hoy"
              value={`${review.availableMinutes} min`}
              hint={`techo declarado: ${availableMinutes} min`}
              tone="violet"
            />
          </div>

          {(result.abandoned ?? 0) > 0 && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-2.5 text-[11px] text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Se han cerrado {result.abandoned} bloque(s) antiguos que ya no cabían. No se acumulan
              como deuda: lo que merecía la pena ha vuelto al plan de hoy.
            </p>
          )}

          {review.completedTopics.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-slate-500">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                Temas trabajados hoy
              </p>
              <div className="flex flex-wrap gap-1.5">
                {review.completedTopics.slice(0, 6).map((topic) => (
                  <span
                    key={`${topic.subjectName}-${topic.title}`}
                    className="rounded-lg border px-2 py-1 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${topic.subjectColor}14`,
                      borderColor: `${topic.subjectColor}40`,
                      color: topic.subjectColor,
                    }}
                  >
                    {topic.subjectName}: {topic.title}
                  </span>
                ))}
              </div>
            </div>
          )}

          {review.delayedTopics.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-slate-500">
                <Clock className="h-3.5 w-3.5 text-rose-400" />
                Se quedó atrás
              </p>
              <div className="space-y-1">
                {review.delayedTopics.map((topic) => (
                  <div
                    key={`${topic.subjectName}-${topic.title}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5"
                  >
                    <span className="truncate text-[11px] text-slate-300">
                      <span style={{ color: topic.subjectColor }}>{topic.subjectName}</span>:{' '}
                      {topic.title}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-rose-400">
                      {topic.daysLate}d
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {review.exams.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-mono uppercase tracking-wider text-slate-500">
                Exámenes que mandan en el reparto
              </p>
              <div className="flex flex-wrap gap-1.5">
                {review.exams.map((exam) => (
                  <span
                    key={exam.id}
                    className="rounded-lg border border-white/10 bg-white/[0.02] px-2 py-1 text-[10px] text-slate-300"
                  >
                    <span style={{ color: exam.subjectColor }}>{exam.subjectName}</span> ·{' '}
                    {FORMAT_LABEL[exam.format] ?? 'Test'} ·{' '}
                    <span className={exam.days <= 7 ? 'text-rose-400' : 'text-amber-400'}>
                      {exam.days}d
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="mb-2 text-[10px] font-mono uppercase tracking-wider text-slate-500">
              Sesiones de lo que queda
            </p>
            {sessions.length === 0 ? (
              <p className="text-xs text-slate-500">
                No queda trabajo pendiente: el plan de hoy está cerrado.
              </p>
            ) : (
              <div className="space-y-2">
                {sessions.map((session) => (
                  <Link
                    key={session.id}
                    href={`/enfoque?block=${session.id}`}
                    className={clsx(
                      'block rounded-xl border p-3 transition-colors',
                      session.completada
                        ? 'border-emerald-500/25 bg-emerald-500/[0.06]'
                        : session.estado === 'parcial'
                          ? 'border-amber-500/25 bg-amber-500/[0.06] hover:border-amber-500/50'
                          : 'border-white/[0.08] bg-[#080d17] hover:border-emerald-500/40'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-xs font-bold" style={{ color: session.color }}>
                        {session.asignatura}: {session.tema}
                        {session.unidad !== null && (
                          <span className="ml-1.5 font-mono text-[10px] text-slate-500">
                            U{session.unidad}
                          </span>
                        )}
                      </h3>
                      <span className="shrink-0 font-mono text-[10px] text-slate-400">
                        {session.duracionMinutos} min
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-300">{session.objetivo}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">{session.motivo}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[9px] font-mono uppercase tracking-wider">
                      <span className="rounded border border-white/10 px-1.5 py-0.5 text-slate-400">
                        {session.tipoActividad}
                      </span>
                      <span className="rounded border border-white/10 px-1.5 py-0.5 text-slate-500">
                        {session.fase}
                      </span>
                      {session.descansoMinutos > 0 && (
                        <span className="text-slate-600">+{session.descansoMinutos}m descanso</span>
                      )}
                      {session.completada && (
                        <span className="text-emerald-400">completada</span>
                      )}
                      {session.estado === 'parcial' && (
                        <span className="text-amber-400">
                          en pausa · {session.minutosHechos}/{session.duracionMinutos} min
                        </span>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
