'use client';

import { useTransition } from 'react';
import { CheckCircle2, RotateCcw, AlertTriangle, ShieldCheck } from 'lucide-react';
import { toggleMasterError } from '@/lib/actions';
import { ERROR_CAUSES, ErrorRootCause } from '@/lib/types';
import clsx from 'clsx';

interface ErrorCardProps {
  error: {
    id: string;
    questionPrompt: string;
    myAnswer: string;
    correctAnswer: string;
    rootCause: string;
    keyLesson: string;
    correctiveAction: string;
    reviewCount: number;
    isMastered: boolean;
    createdAt: Date;
    subject: {
      name: string;
      color: string;
    };
    topic: {
      title: string;
    };
  };
}

export default function ErrorCard({ error }: ErrorCardProps) {
  const [isPending, startTransition] = useTransition();

  const causeInfo = ERROR_CAUSES[error.rootCause as ErrorRootCause] || {
    label: error.rootCause,
    badgeColor: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
  };

  const handleToggle = () => {
    startTransition(async () => {
      await toggleMasterError(error.id);
    });
  };

  return (
    <div
      className={clsx(
        'p-5 rounded-2xl border transition-all space-y-4',
        error.isMastered
          ? 'bg-[#080d17]/50 border-slate-800/80 opacity-70'
          : 'glass-card border-white/10 hover:border-slate-700 shadow-md'
      )}
    >
      {/* Cabecera de la ficha */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="text-xs font-bold px-2 py-0.5 rounded border"
            style={{
              backgroundColor: `${error.subject.color}15`,
              borderColor: `${error.subject.color}40`,
              color: error.subject.color,
            }}
          >
            {error.subject.name}
          </span>
          <span className="text-xs font-semibold text-slate-300">
            {error.topic.title}
          </span>
          <span
            className={clsx(
              'text-[10px] px-2 py-0.5 rounded border font-mono font-bold',
              causeInfo.badgeColor
            )}
          >
            {causeInfo.label}
          </span>
        </div>

        {/* Botón de estado: Dominado vs Pendiente */}
        <button
          onClick={handleToggle}
          disabled={isPending}
          className={clsx(
            'flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition-all',
            error.isMastered
              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
              : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700'
          )}
        >
          {error.isMastered ? (
            <>
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>Superado ({error.reviewCount} repasos)</span>
            </>
          ) : (
            <>
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
              <span>Marcar Superado</span>
            </>
          )}
        </button>
      </div>

      {/* Pregunta Fallada */}
      <div className="space-y-1">
        <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
          Enunciado de la prueba
        </p>
        <p className="text-sm font-semibold text-slate-100">{error.questionPrompt}</p>
      </div>

      {/* Comparativa: Lo que respondí vs Solución Oficial */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <div className="p-3 rounded-xl bg-[#140b15] border border-rose-950/60 space-y-1">
          <p className="text-[10px] font-bold text-rose-400 uppercase tracking-wider">
            Mi Respuesta (Error)
          </p>
          <p className="text-slate-300 leading-relaxed">{error.myAnswer}</p>
        </div>

        <div className="p-3 rounded-xl bg-[#091516] border border-emerald-950/60 space-y-1">
          <p className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">
            Respuesta Correcta Oficial
          </p>
          <p className="text-slate-300 leading-relaxed">{error.correctAnswer}</p>
        </div>
      </div>

      {/* Lección Clave y Acción Preventiva */}
      <div className="p-3 rounded-xl bg-[#080d18] border border-slate-800 space-y-2 text-xs">
        <div>
          <span className="font-bold text-amber-400 font-mono text-[11px]">
            [LECCIÓN APRENDIDA]:{' '}
          </span>
          <span className="text-slate-200">{error.keyLesson}</span>
        </div>
        <div>
          <span className="font-bold text-emerald-400 font-mono text-[11px]">
            [ACCIÓN PREVENTIVA]:{' '}
          </span>
          <span className="text-slate-300 italic">{error.correctiveAction}</span>
        </div>
      </div>
    </div>
  );
}
