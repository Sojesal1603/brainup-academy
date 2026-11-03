'use client';

import NeuralLoader from '@/components/ui/NeuralLoader';

import { useTransition } from 'react';
import { Zap, Shield, RefreshCw } from 'lucide-react';
import { switchStudyMode, triggerRecalculatePlan } from '@/lib/actions';
import { StudyMode } from '@/lib/types';
import clsx from 'clsx';

interface ModeSwitcherProps {
  currentMode: StudyMode;
}

export default function ModeSwitcher({ currentMode }: ModeSwitcherProps) {
  const [isPending, startTransition] = useTransition();

  const handleSwitch = (mode: StudyMode) => {
    if (mode === currentMode) return;
    startTransition(async () => {
      await switchStudyMode(mode);
    });
  };

  const handleRecalculate = () => {
    startTransition(async () => {
      await triggerRecalculatePlan();
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Selector de Modos */}
      <div className="inline-flex p-1 rounded-xl bg-[#0b101d] border border-white/10">
        <button
          onClick={() => handleSwitch('comfort')}
          disabled={isPending}
          className={clsx(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all',
            currentMode === 'comfort'
              ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30 shadow-[0_0_12px_rgba(14,165,233,0.2)]'
              : 'text-slate-400 hover:text-slate-200'
          )}
        >
          <Shield className="w-3.5 h-3.5" />
          <span>Zona de Confort</span>
        </button>

        <button
          onClick={() => handleSwitch('athlete')}
          disabled={isPending}
          className={clsx(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all',
            currentMode === 'athlete'
              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-[0_0_12px_rgba(16,185,129,0.2)]'
              : 'text-slate-400 hover:text-slate-200'
          )}
        >
          <Zap className="w-3.5 h-3.5 text-emerald-400" />
          <span>Modo Atleta</span>
        </button>
      </div>

      {/* Botón de Recalcular Plan */}
      <button
        onClick={handleRecalculate}
        disabled={isPending}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#0f172a] hover:bg-[#1e293b] border border-white/10 text-slate-300 hover:text-slate-100 text-xs font-medium transition-all"
        title="Recalcular horario semanal según los últimos errores y notas"
      >
        <RefreshCw
          className={clsx('w-3.5 h-3.5 text-slate-400', isPending && 'animate-spin text-emerald-400')}
        />
        <span>{isPending ? 'Recalculando...' : 'Recalcular Plan'}</span>
      </button>

      {isPending && (
        <NeuralLoader
          compact
          className="w-full"
          title="Optimizando el plan"
          messages={[
            'Optimizando planificación inversa...',
            'Cruzando tu horario con los exámenes...',
            'Ajustando sesiones al tiempo real...',
          ]}
        />
      )}
    </div>
  );
}
