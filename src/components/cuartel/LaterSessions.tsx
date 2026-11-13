'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, GripVertical, Play } from 'lucide-react';
import { reorderTodayBlocks } from '@/lib/actions';
import type { DayPlan } from '@/lib/dayPlan';

/**
 * Las sesiones que no son «Ahora». Se pueden reordenar arrastrando, pero solo
 * entre ellas: la primera no se mueve y lo empezado/completado no entra aquí.
 */
export default function LaterSessions({
  sessions,
  firstOrder,
}: {
  sessions: DayPlan['sessions'];
  firstOrder: number;
}) {
  const [order, setOrder] = useState(sessions);
  const [dragging, setDragging] = useState<string | null>(null);
  const router = useRouter();

  async function dropOn(targetId: string) {
    if (!dragging || dragging === targetId) return;
    const from = order.findIndex((session) => session.id === dragging);
    const to = order.findIndex((session) => session.id === targetId);
    if (from < 0 || to < 0) return;

    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
    setDragging(null);

    const result = await reorderTodayBlocks(
      next.map((session) => session.id),
      firstOrder
    );
    if (!result.success) {
      setOrder(sessions);
      return;
    }
    router.refresh();
  }

  return (
    <details className="group rounded-xl border border-slate-800 bg-slate-900/40">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5 text-xs font-semibold text-slate-300">
        <span className="inline-flex items-center gap-2">
          <ChevronDown className="h-3.5 w-3.5 text-slate-500 transition-transform group-open:rotate-180" />
          Después · {order.length} sesión(es)
        </span>
        <span className="font-mono text-[10px] font-normal text-slate-500">
          {order.reduce((total, session) => total + session.durationMinutes, 0)} min
        </span>
      </summary>
      <div className="space-y-1 border-t border-slate-800 p-2">
        {order.map((session) => (
          <div
            key={session.id}
            draggable
            onDragStart={() => setDragging(session.id)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => void dropOn(session.id)}
            className={`flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 transition-colors ${
              dragging === session.id ? 'bg-emerald-500/10' : 'hover:bg-slate-800/40'
            }`}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-slate-600" aria-hidden />
              <div className="min-w-0">
                <p className="truncate text-[11px] font-medium text-slate-300">
                  <span
                    className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                    style={{ backgroundColor: session.subjectColor }}
                  />
                  {session.topicTitle}
                </p>
                <p className="truncate text-[10px] text-slate-500">
                  {session.subjectName} · {session.durationMinutes} min · {session.objective}
                </p>
              </div>
            </div>
            <Link
              href={`/enfoque?block=${session.id}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[10px] font-semibold text-slate-300 hover:text-slate-100"
            >
              <Play className="h-2.5 w-2.5" />
              Abrir
            </Link>
          </div>
        ))}
      </div>
    </details>
  );
}
