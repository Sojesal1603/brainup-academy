'use client';

import { useState, useEffect, useRef, useTransition, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Play,
  Pause,
  RotateCcw,
  Maximize2,
  Minimize2,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Sparkles,
  Volume2,
  VolumeX,
  Waves,
} from 'lucide-react';
import { recordStudySession, pauseSession, startSession } from '@/lib/actions';
import { STUDY_TECHNIQUES, StudyTechnique } from '@/lib/types';
import clsx from 'clsx';

type BinauralWave = 'off' | 'beta' | 'alpha' | 'theta' | 'delta';

/**
 * Ondas binaurales de concentración. Cada oído recibe una frecuencia distinta;
 * la diferencia (el «beat») es la que marca el estado. Se generan con el propio
 * navegador: sin archivos, sin descargas y sin mandar nada a ningún sitio.
 */
const BINAURAL_WAVES: Record<BinauralWave, { label: string; hz: number; description: string }> = {
  off: { label: 'Sin ondas', hz: 0, description: 'Silencio: solo la sala de estudio.' },
  beta: {
    label: 'Beta 14 Hz',
    hz: 14,
    description: 'Concentración activa: problemas, cálculo y simulacros.',
  },
  alpha: {
    label: 'Alpha 10 Hz',
    hz: 10,
    description: 'Estudio tranquilo: memorización y repaso sostenido.',
  },
  theta: {
    label: 'Theta 6 Hz',
    hz: 6,
    description: 'Repaso creativo: conectar ideas y consolidar.',
  },
  delta: { label: 'Delta 2 Hz', hz: 2, description: 'Descanso profundo entre bloques.' },
};

interface FocusRoomProps {
  topics: Array<{
    id: string;
    title: string;
    masteryLevel: number;
    masterySource?: string | null;
    subject: {
      id: string;
      name: string;
      color: string;
    };
  }>;
  /** Sesión del plan desde la que se ha entrado (si la hay). */
  initialBlock?: {
    id: string;
    topicId: string;
    technique: string;
    durationMinutes: number;
    spentMinutes: number;
  } | null;
}

export default function FocusRoom({ topics, initialBlock = null }: FocusRoomProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // Params desde la URL si viene de un bloque específico
  const paramTopicId = searchParams.get('topicId');
  const paramTechnique = searchParams.get('technique') as StudyTechnique;

  // Si la sesión viene del plan, manda el bloque: tema, técnica y los minutos
  // que faltan (no se repite lo ya trabajado al continuar una sesión pausada).
  const blockTopicId = initialBlock?.topicId ?? null;
  const blockTechnique = (initialBlock?.technique ?? null) as StudyTechnique | null;
  const blockMinutes = initialBlock
    ? Math.max(5, initialBlock.durationMinutes - initialBlock.spentMinutes)
    : null;
  const paramDuration = blockMinutes ?? (Number(searchParams.get('duration')) || 25);

  const initialTopic =
    topics.find((t) => t.id === (blockTopicId ?? paramTopicId)) || topics[0] || null;

  const [selectedTopicId, setSelectedTopicId] = useState<string>(
    initialTopic ? initialTopic.id : ''
  );
  const [selectedTechnique, setSelectedTechnique] = useState<StudyTechnique>(
    blockTechnique && STUDY_TECHNIQUES[blockTechnique]
      ? blockTechnique
      : paramTechnique && STUDY_TECHNIQUES[paramTechnique]
        ? paramTechnique
        : 'active_recall'
  );

  // Temporizador
  const [totalSeconds, setTotalSeconds] = useState<number>(paramDuration * 60);
  const [timeLeft, setTimeLeft] = useState<number>(paramDuration * 60);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  /** Onda binaural elegida para este bloque. */
  const [wave, setWave] = useState<BinauralWave>('off');
  const audioContextRef = useRef<AudioContext | null>(null);

  // Modal de Evaluación al terminar
  const [isEvaluationOpen, setIsEvaluationOpen] = useState<boolean>(false);
  const [sessionNotes, setSessionNotes] = useState<string>('');
  const [recordedResult, setRecordedResult] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // Ondas binaurales: dos osciladores, uno por oído, separados por el «beat»
  // elegido. Suenan solo mientras la sesión está en marcha y el sonido no está
  // silenciado, así que pausar el enfoque también calla el tono.
  useEffect(() => {
    if (wave === 'off' || !isRunning || isMuted) return;

    let gain: GainNode | null = null;
    let oscL: OscillatorNode | null = null;
    let oscR: OscillatorNode | null = null;

    try {
      const AudioCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof window.AudioContext }).webkitAudioContext;
      if (!AudioCtor) return;

      const ctx = audioContextRef.current ?? new AudioCtor();
      audioContextRef.current = ctx;
      if (ctx.state === 'suspended') void ctx.resume();

      gain = ctx.createGain();
      gain.gain.value = 0.035;

      const baseHz = 200;
      const beat = BINAURAL_WAVES[wave].hz;
      const panL = ctx.createStereoPanner();
      const panR = ctx.createStereoPanner();
      panL.pan.value = -1;
      panR.pan.value = 1;

      oscL = ctx.createOscillator();
      oscR = ctx.createOscillator();
      oscL.type = 'sine';
      oscR.type = 'sine';
      oscL.frequency.value = baseHz - beat / 2;
      oscR.frequency.value = baseHz + beat / 2;

      oscL.connect(panL).connect(gain);
      oscR.connect(panR).connect(gain);
      gain.connect(ctx.destination);
      oscL.start();
      oscR.start();
    } catch {
      // Audio bloqueado por el navegador: el temporizador sigue funcionando.
      return;
    }

    return () => {
      try {
        oscL?.stop();
        oscR?.stop();
      } catch {
        // Ya estaban parados.
      }
      try {
        gain?.disconnect();
      } catch {
        // Nada que desconectar.
      }
    };
  }, [wave, isRunning, isMuted]);

  // Web Audio Beep sintético (sin archivos externos).
  //
  // Va en `useCallback` porque lo usa el temporizador desde su efecto: sin una
  // función estable, o el efecto se queda con la versión vieja del silencio, o
  // hay que volver a montarlo en cada render. Con `isMuted` como única
  // dependencia, el pitido siempre respeta el ajuste actual.
  const playBeep = useCallback(() => {
    if (isMuted) return;
    try {
      const AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof window.AudioContext }).webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime); // La 5
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.8);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.8);
    } catch {
      // Audio no permitido por política de navegador sin interacción
    }
  }, [isMuted]);

  // Timer Tick
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (isRunning && timeLeft > 0) {
      interval = setInterval(() => {
        setTimeLeft((prev) => prev - 1);
      }, 1000);
    } else if (isRunning && timeLeft === 0) {
      setIsRunning(false);
      playBeep();
      setIsEvaluationOpen(true);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRunning, timeLeft, playBeep]);

  // Manejo de presets de tiempo
  const setPresetMinutes = (minutes: number) => {
    setIsRunning(false);
    setTotalSeconds(minutes * 60);
    setTimeLeft(minutes * 60);
  };

  // Toggle Pantalla Completa
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen?.();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.();
      setIsFullscreen(false);
    }
  };

  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;
  const progressPercent = Math.min(
    100,
    Math.max(0, ((totalSeconds - timeLeft) / (totalSeconds || 1)) * 100)
  );

  const currentTopic = topics.find((t) => t.id === selectedTopicId);
  const techniqueInfo = STUDY_TECHNIQUES[selectedTechnique];

  const elapsedMinutes = Math.max(1, Math.round((totalSeconds - timeLeft) / 60) || 1);

  /** Guarda lo hecho y sale: la sesión queda pausada, no perdida. */
  const handlePause = () => {
    if (!initialBlock) return;
    startTransition(async () => {
      await pauseSession(initialBlock.id, elapsedMinutes);
      router.push('/');
    });
  };

  // Enviar resultado de la sesión
  const handleRecordOutcome = (outcome: 'entendido' | 'con_dudas' | 'fallado') => {
    if (!selectedTopicId) return;
    const minutesSpent = Math.max(1, Math.round((totalSeconds - timeLeft) / 60) || 1);

    startTransition(async () => {
      const res = await recordStudySession({
        topicId: selectedTopicId,
        minutesSpent,
        techniqueUsed: selectedTechnique,
        outcome,
        notes: sessionNotes,
        blockId: initialBlock?.id,
      });

      if (res.success) {
        setRecordedResult(`¡Dominio actualizado! Nivel actual: ${res.newMastery}%`);
        setTimeout(() => {
          setIsEvaluationOpen(false);
          setRecordedResult(null);
          // Reiniciar timer
          setTimeLeft(totalSeconds);
          router.refresh();
        }, 1500);
      }
    });
  };

  return (
    <div
      ref={containerRef}
      className={clsx(
        'transition-all duration-300 flex flex-col items-center justify-between',
        isFullscreen
          ? 'fixed inset-0 z-50 bg-[#060911] p-8 overflow-y-auto'
          : 'p-6 sm:p-10 rounded-3xl bg-[#0b101c] border border-white/10 shadow-2xl relative'
      )}
    >
      {/* Barra Superior de Controles Zen */}
      <div className="w-full flex items-center justify-between pb-6 border-b border-slate-800/80">
        <div className="flex items-center gap-2">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs font-mono font-bold uppercase tracking-widest text-emerald-400">
            Modo Enfoque Zen
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsMuted(!isMuted)}
            className="p-2 rounded-lg bg-slate-800/60 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
            title={isMuted ? 'Activar sonido' : 'Silenciar'}
          >
            {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>

          <button
            onClick={toggleFullscreen}
            className="p-2 rounded-lg bg-slate-800/60 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
            title={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
          >
            {isFullscreen ? (
              <Minimize2 className="w-4 h-4" />
            ) : (
              <Maximize2 className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {/* Selectores de Tema y Técnica */}
      <div className="w-full max-w-xl my-6 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
              Tema a Trabajar
            </label>
            <select
              value={selectedTopicId}
              onChange={(e) => setSelectedTopicId(e.target.value)}
              disabled={isRunning}
              className="w-full bg-[#070b14] border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 truncate"
            >
              {topics.map((t) => (
                <option key={t.id} value={t.id}>
                  [{t.subject.name}] {t.title} (
                  {t.masterySource === 'sin_medir' || !t.masterySource
                    ? 'nivel sin medir'
                    : `${t.masteryLevel}%`}
                  )
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
              Método Activo
            </label>
            <select
              value={selectedTechnique}
              onChange={(e) =>
                setSelectedTechnique(e.target.value as StudyTechnique)
              }
              disabled={isRunning}
              className="w-full bg-[#070b14] border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {Object.entries(STUDY_TECHNIQUES).map(([key, val]) => (
                <option key={key} value={key}>
                  {val.label} ({val.defaultMinutes}m)
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Explicación de la Técnica */}
        {techniqueInfo && (
          <p className="text-[11px] text-slate-400 italic text-center">
            💡 {techniqueInfo.description}
          </p>
        )}
      </div>

      {/* Presets Rápidos de Tiempo */}
      <div className="flex flex-wrap items-center justify-center gap-2 mb-6">
        {[
          { label: 'Repaso rápido (10m)', min: 10 },
          { label: 'Micro (15m)', min: 15 },
          { label: 'Estándar (25m)', min: 25 },
          { label: 'Profundo (40m)', min: 40 },
          { label: 'Profundo (50m)', min: 50 },
          { label: 'Intensivo (60m)', min: 60 },
          { label: 'Simulacro PAU (90m)', min: 90 },
        ].map((p) => (
          <button
            key={p.min}
            onClick={() => setPresetMinutes(p.min)}
            disabled={isRunning}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-xs font-mono transition-all',
              totalSeconds === p.min * 60
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold'
                : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200'
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Ondas binaurales de concentración (generadas en el navegador) */}
      <div className="w-full max-w-xl mb-4">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          <Waves className="h-3.5 w-3.5 text-cyan-400" />
          Ondas binaurales
        </p>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(BINAURAL_WAVES) as BinauralWave[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setWave(key)}
              aria-pressed={wave === key}
              className={clsx(
                'min-h-[40px] rounded-lg border px-3 py-1.5 text-xs font-mono transition-all',
                wave === key
                  ? 'border-cyan-500/50 bg-cyan-500/15 font-bold text-cyan-300'
                  : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
              )}
            >
              {BINAURAL_WAVES[key].label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500 italic">
          {BINAURAL_WAVES[wave].description}
          {wave !== 'off' && !isRunning ? ' Se activan al iniciar el enfoque.' : ''}
          {wave !== 'off' ? ' Usa auriculares: cada oído necesita su tono.' : ''}
        </p>
      </div>

      {/* Reloj Digital Gigante con Anillo de Progreso */}
      <div className="relative my-4 flex items-center justify-center">
        {/* SVG Circular Progress Bar */}
        <div className="relative w-64 h-64 sm:w-80 sm:h-80 flex items-center justify-center">
          <svg className="w-full h-full transform -rotate-90">
            <circle
              cx="50%"
              cy="50%"
              r="45%"
              className="stroke-slate-900"
              strokeWidth="10"
              fill="transparent"
            />
            <circle
              cx="50%"
              cy="50%"
              r="45%"
              className="stroke-emerald-400 transition-all duration-1000 ease-linear"
              strokeWidth="10"
              strokeDasharray="283"
              strokeDashoffset={283 - (283 * progressPercent) / 100}
              strokeLinecap="round"
              fill="transparent"
            />
          </svg>

          {/* Tiempo Digital */}
          <div className="absolute text-center select-none">
            <div className="text-5xl sm:text-7xl font-black text-slate-100 font-mono tracking-tight drop-shadow-[0_0_20px_rgba(16,185,129,0.2)]">
              {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
            </div>
            <p className="text-xs text-slate-400 font-medium uppercase tracking-widest mt-2">
              {isRunning ? 'Sesión en Marcha' : timeLeft === 0 ? '¡Bloque Finalizado!' : 'Pausado'}
            </p>
          </div>
        </div>
      </div>

      {/* Botones de Control del Temporizador */}
      <div className="flex items-center gap-4 my-6">
        <button
          onClick={() => {
            if (!isRunning && initialBlock) {
              void startSession(initialBlock.id);
            }
            setIsRunning(!isRunning);
          }}
          className={clsx(
            'flex items-center gap-2.5 px-6 py-3 rounded-2xl font-black text-sm transition-all shadow-xl hover:scale-105 active:scale-95',
            isRunning
              ? 'bg-amber-500 hover:bg-amber-400 text-slate-950'
              : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-[0_0_25px_rgba(16,185,129,0.3)]'
          )}
        >
          {isRunning ? (
            <>
              <Pause className="w-5 h-5 fill-slate-950" />
              <span>Pausar</span>
            </>
          ) : (
            <>
              <Play className="w-5 h-5 fill-slate-950" />
              <span>Iniciar Enfoque</span>
            </>
          )}
        </button>

        <button
          onClick={() => {
            setIsRunning(false);
            setTimeLeft(totalSeconds);
          }}
          className="p-3 rounded-2xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-100 transition-all hover:scale-105"
          title="Reiniciar temporizador"
        >
          <RotateCcw className="w-5 h-5" />
        </button>

        {initialBlock && (
          <button
            onClick={handlePause}
            disabled={isPending}
            className="px-4 py-3 rounded-2xl bg-slate-900 border border-slate-800 text-slate-300 text-xs font-semibold hover:text-slate-100 transition-all disabled:opacity-50"
            title="Guardar lo hecho y continuar después sin perder el progreso"
          >
            Pausar y seguir luego
          </button>
        )}

        <button
          onClick={() => setIsEvaluationOpen(true)}
          className="px-4 py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition-all border border-slate-700"
          title="Finalizar sesión antes de tiempo y registrar"
        >
          Concluir & Registrar
        </button>
      </div>

      {/* Modal de Calibración / Evaluación de Sesión */}
      {isEvaluationOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#0e1627] border border-white/10 rounded-3xl w-full max-w-lg p-6 shadow-2xl relative space-y-5">
            <div className="text-center space-y-1">
              <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mx-auto">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-black text-slate-100">
                Calibración del Bloque
              </h3>
              <p className="text-xs text-slate-400">
                ¿Cómo ha sido el resultado de asimilación activa en{' '}
                <strong className="text-slate-200">{currentTopic?.title}</strong>?
              </p>
            </div>

            {/* Opciones de Calibración Rápida */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <button
                onClick={() => handleRecordOutcome('entendido')}
                disabled={isPending}
                className="p-4 rounded-2xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 flex flex-col items-center gap-2 transition-all hover:scale-105 group"
              >
                <CheckCircle2 className="w-6 h-6 text-emerald-400" />
                <span className="text-xs font-bold">Entendido</span>
                <span className="text-[10px] text-emerald-400 font-mono">+8% Dominio</span>
              </button>

              <button
                onClick={() => handleRecordOutcome('con_dudas')}
                disabled={isPending}
                className="p-4 rounded-2xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 flex flex-col items-center gap-2 transition-all hover:scale-105 group"
              >
                <AlertCircle className="w-6 h-6 text-amber-400" />
                <span className="text-xs font-bold">Con Dudas</span>
                <span className="text-[10px] text-amber-400 font-mono">+2% Dominio</span>
              </button>

              <button
                onClick={() => handleRecordOutcome('fallado')}
                disabled={isPending}
                className="p-4 rounded-2xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 flex flex-col items-center gap-2 transition-all hover:scale-105 group"
              >
                <XCircle className="w-6 h-6 text-rose-400" />
                <span className="text-xs font-bold">Fallado</span>
                <span className="text-[10px] text-rose-400 font-mono">-8% Dominio</span>
              </button>
            </div>

            {/* Notas opcionales */}
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Reflexión breve de la sesión (opcional)
              </label>
              <textarea
                rows={2}
                placeholder="p.ej. Se me resiste el despeje en integrales por partes; revisar fórmula u·v - ∫v·du"
                value={sessionNotes}
                onChange={(e) => setSessionNotes(e.target.value)}
                className="w-full bg-[#080d18] border border-slate-800 rounded-xl p-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
              />
            </div>

            {recordedResult && (
              <p className="text-xs text-emerald-400 font-semibold text-center animate-bounce">
                {recordedResult}
              </p>
            )}

            <div className="flex justify-between items-center pt-2 border-t border-slate-800">
              <button
                onClick={() => {
                  setIsEvaluationOpen(false);
                  router.push('/errores');
                }}
                className="text-[11px] text-rose-400 hover:text-rose-300 underline"
              >
                ¿Tuviste un error grave? Abrir Banco de Errores
              </button>

              <button
                onClick={() => setIsEvaluationOpen(false)}
                className="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-200"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
