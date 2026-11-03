'use client';

import { useTransition } from 'react';
import { Flame, Check, Circle } from 'lucide-react';
import { toggleHabit } from '@/lib/actions';
import clsx from 'clsx';

interface HabitItemProps {
  habit: {
    id: string;
    title: string;
    description: string | null;
    streak: number;
    isCompletedToday: boolean;
  };
}

export default function HabitItem({ habit }: HabitItemProps) {
  const [isPending, startTransition] = useTransition();

  const handleToggle = () => {
    startTransition(async () => {
      await toggleHabit(habit.id);
    });
  };

  return (
    <div
      onClick={handleToggle}
      className={clsx(
        'group flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all duration-200 select-none',
        habit.isCompletedToday
          ? 'bg-emerald-500/5 border-emerald-500/30 text-emerald-100'
          : 'glass-card border-white/10 hover:border-slate-700 text-slate-300'
      )}
    >
      <div className="flex items-center gap-3">
        <div
          className={clsx(
            'w-6 h-6 rounded-lg flex items-center justify-center border transition-all',
            habit.isCompletedToday
              ? 'bg-emerald-500 border-emerald-400 text-slate-950 font-bold'
              : 'border-slate-700 group-hover:border-slate-500 text-transparent'
          )}
        >
          {habit.isCompletedToday ? (
            <Check className="w-3.5 h-3.5 stroke-[3]" />
          ) : (
            <Circle className="w-3.5 h-3.5 text-slate-700" />
          )}
        </div>
        <div>
          <h5
            className={clsx(
              'text-xs font-semibold',
              habit.isCompletedToday && 'line-through text-slate-400'
            )}
          >
            {habit.title}
          </h5>
          {habit.description && (
            <p className="text-[10px] text-slate-400">{habit.description}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 text-[11px] font-mono text-amber-400/90 pl-2">
        <Flame className="w-3.5 h-3.5 fill-amber-400 text-amber-500" />
        <span>{habit.streak}d</span>
      </div>
    </div>
  );
}
