'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { BatteryFull, BatteryLow, BatteryMedium } from 'lucide-react';
import { setTodayEnergy } from '@/lib/actions';
import type { EnergyLevel } from '@/lib/sessionEngine';
import clsx from 'clsx';

const OPTIONS: Array<{
  level: EnergyLevel;
  label: string;
  hint: string;
  Icon: typeof BatteryFull;
}> = [
  { level: 'baja', label: 'Baja', hint: 'Poca energía: repaso y bloques cortos', Icon: BatteryLow },
  { level: 'media', label: 'Normal', hint: 'Energía normal: plan equilibrado', Icon: BatteryMedium },
  { level: 'alta', label: 'Alta', hint: 'Con chispa: admite avance nuevo y bloques largos', Icon: BatteryFull },
];

/**
 * «Hoy voy con…». La elección no es cosmética: escribe `PlanState.energy` y el
 * motor vuelve a repartir el día con ese factor (0.5 / 1 / 1.2). Si no se elige,
 * manda la hora, como antes.
 */
export default function EnergySelector({ current }: { current: EnergyLevel }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-0.5">
      <span className="px-1.5 text-[10px] font-mono text-slate-500">energía</span>
      {OPTIONS.map(({ level, label, hint, Icon }) => {
        const active = current === level;
        return (
          <button
            key={level}
            type="button"
            aria-pressed={active}
            title={hint}
            disabled={isPending}
            onClick={() =>
              startTransition(async () => {
                await setTodayEnergy(level);
                router.refresh();
              })
            }
            className={clsx(
              'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-semibold transition-colors disabled:opacity-50',
              active
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'text-slate-500 hover:text-slate-200'
            )}
          >
            <Icon className="h-3 w-3" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
