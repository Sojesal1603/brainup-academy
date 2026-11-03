'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle, Play, ArrowRight } from 'lucide-react';
import { toggleStudyBlock } from '@/lib/actions';
import { STUDY_TECHNIQUES, StudyTechnique } from '@/lib/types';
import clsx from 'clsx';

interface StudyBlockItemProps {
  block: {
    id: string;
    topicId: string;
    durationMinutes: number;
    technique: string;
    isCompleted: boolean;
    orderIndex: number;
    objective?: string | null;
    reason?: string | null;
    material?: string | null;
    stage?: string | null;
    breakMinutes?: number;
    status?: string;
    spentMinutes?: number;
    origin?: string;
    topic: {
      id: string;
      title: string;
      masteryLevel: number;
      masterySource?: string | null;
      subject: {
        name: string;
        color: string;
      };
    };
  };
}

export default function StudyBlockItem({ block }: StudyBlockItemProps) {
  const [isPending, startTransition] = useTransition();

  const tech = STUDY_TECHNIQUES[block.technique as StudyTechnique] || {
    label: block.technique,
    badgeColor: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
  };

  const handleToggle = () => {
    startTransition(async () => {
      await toggleStudyBlock(block.id);
    });
  };

  return (
    <div
      className={clsx(
        'group flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border transition-all duration-200 gap-3',
        block.isCompleted
          ? 'bg-[#0b101c]/50 border-slate-800/80 opacity-60'
          : 'glass-card border-white/10 hover:border-slate-700 shadow-sm'
      )}
    >
      <div className="flex items-start gap-3">
        {/* Checkbox button */}
        <button
          onClick={handleToggle}
          disabled={isPending}
          className="mt-0.5 text-slate-500 hover:text-emerald-400 transition-colors"
          title={block.isCompleted ? 'Marcar como pendiente' : 'Marcar como completado'}
        >
          {block.isCompleted ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
          ) : (
            <Circle className="w-5 h-5 group-hover:text-emerald-400/80" />
          )}
        </button>

        <div>
          {/* Asignatura y Técnica */}
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span
              className="text-[11px] font-semibold px-2 py-0.5 rounded border"
              style={{
                backgroundColor: `${block.topic.subject.color}15`,
                borderColor: `${block.topic.subject.color}40`,
                color: block.topic.subject.color,
              }}
            >
              {block.topic.subject.name}
            </span>
            <span
              className={clsx(
                'text-[10px] px-2 py-0.5 rounded border font-mono font-medium',
                tech.badgeColor
              )}
            >
              {tech.label}
            </span>
            <span className="text-[11px] text-slate-400 font-mono">
              {block.durationMinutes} min
              {block.breakMinutes ? ` + ${block.breakMinutes} descanso` : ''}
            </span>
            {block.status === 'parcial' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-300 font-mono">
                pausada · {block.spentMinutes ?? 0} min hechos
              </span>
            )}
          </div>

          {/* Título del Tema */}
          <h4
            className={clsx(
              'text-sm font-semibold text-slate-100 transition-all',
              block.isCompleted && 'line-through text-slate-400'
            )}
          >
            {block.topic.title}
          </h4>

          {block.reason && (
            <p className="text-[11px] text-slate-400 mt-1">
              <span className="text-emerald-400 font-semibold">Por qué hoy: </span>
              {block.reason}
            </p>
          )}

          {/* Nivel: solo se muestra si alguien lo ha medido */}
          {block.topic.masterySource === 'sin_medir' || !block.topic.masterySource ? (
            <div className="flex items-center gap-2 mt-1.5 text-[11px] text-slate-500">
              <span className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-800/40 font-mono text-[10px]">
                nivel sin medir
              </span>
              <span className="text-[10px]">primera pasada: aquí se construye la base</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 mt-1.5 text-[11px] text-slate-400">
              <span>Nivel:</span>
              <div className="w-20 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${block.topic.masteryLevel}%`,
                    backgroundColor:
                      block.topic.masteryLevel >= 75
                        ? '#10b981'
                        : block.topic.masteryLevel >= 50
                        ? '#3b82f6'
                        : '#f59e0b',
                  }}
                />
              </div>
              <span className="font-mono text-slate-300">
                {block.topic.masteryLevel}%
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Botón de Iniciar Bloque (Lleva al Modo Enfoque configurado con este tema) */}
      {!block.isCompleted && (
        <div className="flex items-center justify-end sm:justify-start gap-2 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-800/60">
          <Link
            href={`/enfoque?block=${block.id}`}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-xs font-semibold transition-all hover:scale-105"
          >
            <Play className="w-3 h-3 fill-emerald-400 text-emerald-400" />
            <span>Iniciar</span>
            <ArrowRight className="w-3 h-3 text-emerald-400" />
          </Link>
        </div>
      )}
    </div>
  );
}
