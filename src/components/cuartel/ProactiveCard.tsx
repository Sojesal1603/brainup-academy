'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Flame,
  Play,
  Repeat,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  dismissalStorageKey,
  type ProactiveDecision,
  type ProactiveKind,
  type ProactiveProposal,
} from '@/lib/proactivity';

/**
 * La propuesta del día en el Cuartel.
 *
 * No decide nada: recibe la decisión ya razonada por `buildProactiveProposal`.
 * Aquí solo se pinta, se descarta («Hoy no») y se enlaza a la acción real. El
 * descarte vive en `localStorage` con la clave del día, así que no hace falta
 * tocar el esquema ni pedir una escritura al servidor.
 */

const KIND_META: Record<ProactiveKind, { label: string; icon: LucideIcon; tone: string }> = {
  examen: {
    label: 'Examen a la vista',
    icon: CalendarClock,
    tone: 'border-amber-500/30 bg-amber-500/[0.06] text-amber-300',
  },
  repaso: {
    label: 'Repaso pendiente',
    icon: Repeat,
    tone: 'border-cyan-500/30 bg-cyan-500/[0.06] text-cyan-300',
  },
  errores: {
    label: 'Errores por cerrar',
    icon: AlertTriangle,
    tone: 'border-rose-500/30 bg-rose-500/[0.06] text-rose-300',
  },
  racha: {
    label: 'Racha en juego',
    icon: Flame,
    tone: 'border-orange-500/30 bg-orange-500/[0.06] text-orange-300',
  },
  empezar: {
    label: 'Siguiente bloque',
    icon: Play,
    tone: 'border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-300',
  },
  medir: {
    label: 'Sin mediciones',
    icon: Sparkles,
    tone: 'border-violet-500/30 bg-violet-500/[0.06] text-violet-300',
  },
};

export default function ProactiveCard({ decision }: { decision: ProactiveDecision }) {
  const [dismissed, setDismissed] = useState<ProactiveKind[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(dismissalStorageKey(decision.dayKey));
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      if (Array.isArray(parsed)) {
        setDismissed(parsed.filter((kind): kind is ProactiveKind => typeof kind === 'string'));
      }
    } catch {
      // Sin localStorage (modo privado, permisos): la tarjeta funciona igual.
    }
    setReady(true);
  }, [decision.dayKey]);

  const visible = useMemo(() => {
    const all = [decision.primary, ...decision.secondary].filter(
      (proposal): proposal is ProactiveProposal => Boolean(proposal)
    );
    return all.filter((proposal) => !dismissed.includes(proposal.kind));
  }, [decision.primary, decision.secondary, dismissed]);

  function dismiss(kind: ProactiveKind) {
    const next = Array.from(new Set([...dismissed, kind]));
    setDismissed(next);
    try {
      window.localStorage.setItem(dismissalStorageKey(decision.dayKey), JSON.stringify(next));
    } catch {
      // El descarte sigue valiendo para esta visita aunque no se pueda guardar.
    }
  }

  if (!ready || !decision.primary || visible.length === 0) return null;

  const primary = visible[0];
  const secondary = visible.slice(1);
  const meta = KIND_META[primary.kind];
  const Icon = meta.icon;

  return (
    <section
      aria-labelledby="propuesta-dia"
      className={`rounded-2xl border p-4 ${meta.tone}`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-black/20">
          <Icon className="h-4 w-4" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-80">
            Propuesta de hoy · {meta.label}
          </p>
          <h2 id="propuesta-dia" className="mt-1 text-sm font-bold text-slate-100">
            {primary.title}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-300">{primary.detail}</p>

          {primary.evidence.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-400">
              {primary.evidence.map((item) => (
                <li key={item} className="inline-flex items-center gap-1">
                  <span className="h-1 w-1 rounded-full bg-current opacity-60" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Link
              href={primary.action.href}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.06] px-3 py-1.5 text-[11px] font-semibold text-slate-100 transition-colors hover:border-white/25 hover:bg-white/[0.1]"
            >
              {primary.action.label}
              <ArrowRight className="h-3 w-3" />
            </Link>
            <button
              type="button"
              onClick={() => dismiss(primary.kind)}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium text-slate-500 transition-colors hover:text-slate-300"
            >
              <X className="h-3 w-3" />
              Hoy no
            </button>
          </div>

          {secondary.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-2 text-[10px]">
              <span className="text-slate-500">También puedes:</span>
              {secondary.map((proposal) => (
                <Link
                  key={proposal.kind}
                  href={proposal.action.href}
                  className="rounded-full border border-white/10 px-2 py-0.5 font-medium text-slate-300 transition-colors hover:border-white/25 hover:text-white"
                >
                  {proposal.action.label}
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
