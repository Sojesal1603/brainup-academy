'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock,
  Flame,
  Loader2,
  Pause,
  Play,
  ShieldAlert,
  Square,
} from 'lucide-react';
import clsx from 'clsx';
import { recordStudySession } from '@/lib/actions';
import {
  FOCUS_MIN_JUSTIFICATION,
  FOCUS_PRESETS,
  FOCUS_SESSION_STORAGE_KEY,
  focusEffectiveness,
  studyVsTutorRatio,
  type FocusPreset,
} from '@/lib/focusLock';
import {
  abandonFocusSession,
  completeFocusSession,
  startFocusSession,
  syncFocusSession,
} from '@/lib/focusActions';

type FocusPhase = 'idle' | 'running' | 'paused' | 'finished';

export interface FocusLockTopic {
  id: string;
  title: string;
  subjectName: string;
  color: string;
}

export interface FocusLockToday {
  focusedMinutes: number;
  tutorMinutes: number;
  abandoned: number;
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Focus & Lock del Cuartel.
 *
 * No es un Pomodoro decorativo: cada bloque guarda los segundos de estudio real,
 * los de pausa, las interrupciones y el tiempo que el alumno pasa consultando al
 * catedrático. Si se abandona sin justificación, el servidor sube la prioridad de
 * lo pendiente y añade repaso extra para mañana. El temporizador del navegador
 * solo mide; la penalización la decide `focusLock.ts` en el servidor.
 */
export default function FocusLock({
  topics,
  today,
}: {
  topics: FocusLockTopic[];
  today: FocusLockToday;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<FocusPhase>('idle');
  const [preset, setPreset] = useState<FocusPreset>(25);
  const [topicId, setTopicId] = useState<string>(topics[0]?.id ?? '');
  const [secondsLeft, setSecondsLeft] = useState<number>(25 * 60);
  const [focusedSeconds, setFocusedSeconds] = useState(0);
  const [pausedSeconds, setPausedSeconds] = useState(0);
  const [interruptions, setInterruptions] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [showAbandon, setShowAbandon] = useState(false);
  const [reason, setReason] = useState('');
  const sessionRef = useRef<string | null>(null);

  const currentTopic = topics.find((topic) => topic.id === topicId) ?? null;
  const plannedSeconds = preset * 60;
  const progress = Math.min(
    100,
    Math.max(0, ((plannedSeconds - secondsLeft) / (plannedSeconds || 1)) * 100)
  );

  const clearStoredSession = () => {
    try {
      localStorage.removeItem(FOCUS_SESSION_STORAGE_KEY);
    } catch {
      // Sin localStorage no hay nada que limpiar.
    }
  };

  const storeSession = (id: string, plannedMinutes: number) => {
    try {
      localStorage.setItem(
        FOCUS_SESSION_STORAGE_KEY,
        JSON.stringify({ id, plannedMinutes, startedAt: Date.now() })
      );
    } catch {
      // El bloque sigue funcionando aunque el navegador no deje guardar.
    }
  };

  /* ---- Cuenta atrás y tiempo efectivo ---- */
  useEffect(() => {
    if (phase !== 'running') return;
    const id = window.setInterval(() => {
      setSecondsLeft((previous) => Math.max(0, previous - 1));
      setFocusedSeconds((previous) => previous + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  /* ---- Tiempo en pausa ---- */
  useEffect(() => {
    if (phase !== 'paused') return;
    const id = window.setInterval(() => {
      setPausedSeconds((previous) => previous + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  /* ---- Fin del bloque: se pide la valoración antes de cerrar ---- */
  useEffect(() => {
    if (phase === 'running' && secondsLeft === 0) {
      setPhase('finished');
    }
  }, [phase, secondsLeft]);

  /* ---- Sincronización periódica: el servidor no pierde el avance ---- */
  useEffect(() => {
    if (!sessionId || (phase !== 'running' && phase !== 'paused')) return;
    const id = window.setInterval(() => {
      void syncFocusSession({
        sessionId,
        focusedSeconds,
        pausedSeconds,
        interruptions,
      });
    }, 20_000);
    return () => window.clearInterval(id);
  }, [sessionId, phase, focusedSeconds, pausedSeconds, interruptions]);

  /* ---- Guardia de salida: un bloque vivo no se cierra por accidente ---- */
  useEffect(() => {
    if (phase !== 'running' && phase !== 'paused') return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [phase]);

  /* ---- Cambiar de pestaña cuenta como interrupción, no como estudio ---- */
  useEffect(() => {
    if (phase !== 'running') return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        setPhase('paused');
        setInterruptions((previous) => previous + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [phase]);

  const resetCounters = () => {
    setFocusedSeconds(0);
    setPausedSeconds(0);
    setInterruptions(0);
    setSecondsLeft(preset * 60);
    setSessionId(null);
    setActiveBlockId(null);
    sessionRef.current = null;
  };

  const start = async () => {
    if (saving || !currentTopic) return;
    setSaving(true);
    setError('');
    setResult(null);
    try {
      const response = await startFocusSession({
        topicId: currentTopic.id,
        plannedMinutes: preset,
      });
      if (!response.success || !response.sessionId) {
        throw new Error(response.error || 'No se ha podido arrancar el bloque.');
      }
      setSessionId(response.sessionId);
      setActiveBlockId(response.blockId ?? null);
      sessionRef.current = response.sessionId;
      storeSession(response.sessionId, preset);
      setFocusedSeconds(0);
      setPausedSeconds(0);
      setInterruptions(0);
      setSecondsLeft(preset * 60);
      setShowAbandon(false);
      setReason('');
      setPhase('running');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se ha podido arrancar el bloque.');
    } finally {
      setSaving(false);
    }
  };

  const pause = () => {
    if (phase !== 'running') return;
    setPhase('paused');
  };

  const resume = () => {
    if (phase !== 'paused') return;
    setPhase('running');
  };

  const finish = async (outcome: 'entendido' | 'con_dudas' | 'fallado') => {
    if (!sessionId || saving) return;
    setSaving(true);
    setError('');
    try {
      const minutes = Math.max(1, Math.round(focusedSeconds / 60));
      if (currentTopic) {
        await recordStudySession({
          topicId: currentTopic.id,
          minutesSpent: minutes,
          techniqueUsed: 'active_recall',
          outcome,
          ...(activeBlockId ? { blockId: activeBlockId } : {}),
        });
      }
      await completeFocusSession({
        sessionId,
        focusedSeconds,
        pausedSeconds,
        interruptions,
      });
      setResult(
        `Bloque guardado: ${minutes} min efectivos. Nivel ${
          outcome === 'entendido' ? 'reforzado' : outcome === 'con_dudas' ? 'con dudas anotadas' : 'marcado para repaso'
        }.`
      );
      clearStoredSession();
      resetCounters();
      setPhase('idle');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se ha podido guardar el bloque.');
    } finally {
      setSaving(false);
    }
  };

  const abandon = async () => {
    if (!sessionId || saving) return;
    setSaving(true);
    setError('');
    try {
      const response = await abandonFocusSession({
        sessionId,
        reason,
        pendingTasks: secondsLeft > 0 ? 1 : 0,
        totalTasks: 1,
      });
      if (!response.success) {
        throw new Error(response.error || 'No se ha podido cerrar el bloque.');
      }
      setResult(response.message ?? 'Bloque abandonado: la penalización se ha aplicado.');
      clearStoredSession();
      resetCounters();
      setPhase('idle');
      setShowAbandon(false);
      setReason('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se ha podido cerrar el bloque.');
    } finally {
      setSaving(false);
    }
  };

  const todayRatio = studyVsTutorRatio(
    today.focusedMinutes * 60,
    today.tutorMinutes * 60
  );

  return (
    <div className="glass-card rounded-2xl border border-white/10 p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-300">
          <Flame className="h-4 w-4 text-orange-400" />
          Focus &amp; Lock
        </h2>
        <span className="font-mono text-[10px] text-slate-500">
          {today.abandoned > 0
            ? `${today.abandoned} bloque(s) abandonado(s) hoy`
            : 'Sin abandonos hoy'}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_auto] md:items-center">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {FOCUS_PRESETS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                disabled={phase !== 'idle'}
                onClick={() => {
                  setPreset(minutes);
                  setSecondsLeft(minutes * 60);
                }}
                className={clsx(
                  'rounded-lg border px-2.5 py-1.5 text-[11px] font-bold transition-colors disabled:opacity-50',
                  preset === minutes
                    ? 'border-orange-400/50 bg-orange-500/10 text-orange-300'
                    : 'border-white/10 text-slate-400 hover:border-white/25'
                )}
              >
                {minutes} min
              </button>
            ))}
            <select
              value={topicId}
              onChange={(event) => setTopicId(event.target.value)}
              disabled={phase !== 'idle'}
              className="min-w-0 flex-1 rounded-lg border border-slate-800 bg-[#070b14] px-2.5 py-1.5 text-[11px] text-slate-200 focus:border-orange-400 focus:outline-none disabled:opacity-60"
            >
              {topics.length === 0 && <option value="">Sin unidades disponibles</option>}
              {topics.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.subjectName} · {topic.title}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-4">
            <span className="font-mono text-4xl font-black tabular-nums text-slate-100">
              {formatClock(secondsLeft)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className={clsx(
                    'h-full rounded-full transition-all duration-500',
                    phase === 'paused' ? 'bg-amber-400' : 'bg-orange-400'
                  )}
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-1 text-[10px] text-slate-500">
                {phase === 'running'
                  ? 'Enfoque activo: pestaña oculta = interrupción.'
                  : phase === 'paused'
                    ? 'En pausa: el tiempo no cuenta como estudio.'
                    : phase === 'finished'
                      ? 'Bloque terminado: valora cómo ha ido.'
                      : 'Elige bloque y duración. El cronómetro no se puede pausar sin que quede registrado.'}
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 md:flex-col md:items-stretch">
          {phase === 'idle' && (
            <button
              type="button"
              onClick={() => void start()}
              disabled={saving || !currentTopic}
              className="flex items-center justify-center gap-1.5 rounded-xl bg-orange-500 px-4 py-2.5 text-xs font-black text-slate-950 transition-colors hover:bg-orange-400 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-slate-950" />}
              Empezar bloque
            </button>
          )}

          {phase === 'running' && (
            <>
              <button
                type="button"
                onClick={pause}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-300"
              >
                <Pause className="h-3.5 w-3.5" /> Pausar
              </button>
              <button
                type="button"
                onClick={() => setShowAbandon(true)}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-300"
              >
                <Square className="h-3.5 w-3.5" /> Abandonar
              </button>
            </>
          )}

          {phase === 'paused' && (
            <>
              <button
                type="button"
                onClick={resume}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500 px-3 py-2 text-xs font-black text-slate-950"
              >
                <Play className="h-3.5 w-3.5 fill-slate-950" /> Reanudar
              </button>
              <button
                type="button"
                onClick={() => setShowAbandon(true)}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-300"
              >
                <Square className="h-3.5 w-3.5" /> Abandonar
              </button>
            </>
          )}

          {phase === 'finished' && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                ¿Cómo ha ido?
              </p>
              <div className="flex flex-wrap gap-1.5 md:flex-col">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void finish('entendido')}
                  className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[10px] font-bold text-emerald-300 disabled:opacity-50"
                >
                  Lo he entendido
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void finish('con_dudas')}
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[10px] font-bold text-amber-300 disabled:opacity-50"
                >
                  Con dudas
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void finish('fallado')}
                  className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-[10px] font-bold text-rose-300 disabled:opacity-50"
                >
                  No me ha salido
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showAbandon && (
        <div className="space-y-2 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-bold text-rose-200">
            <ShieldAlert className="h-3.5 w-3.5" />
            Si lo dejas ahora, el Guardián Nocturno sube la prioridad y añade repaso.
          </p>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            placeholder={`¿Qué ha pasado? (mínimo ${FOCUS_MIN_JUSTIFICATION} caracteres para que cuente como justificación)`}
            className="w-full resize-y rounded-lg border border-slate-800 bg-[#080d18] p-2 text-[11px] text-slate-200 outline-none focus:border-rose-400/50"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void abandon()}
              disabled={saving}
              className="rounded-lg bg-rose-500 px-2.5 py-1.5 text-[10px] font-black text-slate-950 disabled:opacity-50"
            >
              {saving ? 'Cerrando…' : 'Abandonar y aplicar penalización'}
            </button>
            <button
              type="button"
              onClick={() => setShowAbandon(false)}
              disabled={saving}
              className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[10px] font-semibold text-slate-300"
            >
              Seguir estudiando
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="flex items-start gap-1.5 text-[11px] text-rose-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}

      {result && (
        <p className="flex items-start gap-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.05] p-2 text-[11px] text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {result}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 border-t border-white/[0.06] pt-3 sm:grid-cols-4">
        <div>
          <p className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-slate-500">
            <Clock className="h-3 w-3" /> Estudio hoy
          </p>
          <p className="font-mono text-sm font-bold text-emerald-300">{today.focusedMinutes} min</p>
        </div>
        <div>
          <p className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-slate-500">
            <Brain className="h-3 w-3" /> Tutor hoy
          </p>
          <p className="font-mono text-sm font-bold text-sky-300">{today.tutorMinutes} min</p>
        </div>
        <div>
          <p className="text-[9px] uppercase tracking-wider text-slate-500">Efectividad</p>
          <p className="font-mono text-sm font-bold text-slate-200">
            {focusEffectiveness(focusedSeconds, focusedSeconds + pausedSeconds)}%
          </p>
        </div>
        <div>
          <p className="text-[9px] uppercase tracking-wider text-slate-500">Estudio vs tutor</p>
          <p className="font-mono text-sm font-bold text-slate-200">{todayRatio}%</p>
        </div>
      </div>
    </div>
  );
}
