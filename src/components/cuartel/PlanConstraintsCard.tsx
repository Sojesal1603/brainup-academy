'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Sparkles, Trash2, X } from 'lucide-react';
import {
  clearMyPlanConstraints,
  confirmMyPlanConstraints,
  interpretMyPlanConstraints,
} from '@/lib/planner/constraintActions';
import { constraintLabel, type PlanConstraintInput } from '@/lib/planner/constraints';

export default function PlanConstraintsCard({
  initial,
}: {
  initial: PlanConstraintInput[];
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<PlanConstraintInput[]>(initial);
  const [text, setText] = useState('');
  const [proposal, setProposal] = useState<PlanConstraintInput[] | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [interpreting, startInterpret] = useTransition();
  const [saving, startSave] = useTransition();

  const interpret = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setMessage(null);
    setProposal(null);
    startInterpret(async () => {
      const result = await interpretMyPlanConstraints(formData);
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok && result.constraints) setProposal(result.constraints);
    });
  };

  const confirm = () => {
    if (!proposal) return;
    setMessage(null);
    startSave(async () => {
      const result = await confirmMyPlanConstraints(JSON.stringify({ constraints: proposal }));
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok) {
        setCurrent(result.constraints ?? []);
        setProposal(null);
        setText('');
        router.refresh();
      }
    });
  };

  const clear = () => {
    setMessage(null);
    startSave(async () => {
      const result = await clearMyPlanConstraints();
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok) {
        setCurrent([]);
        setProposal(null);
        router.refresh();
      }
    });
  };

  return (
    <div className="glass-card space-y-3 rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-slate-100">Restricciones de hoy</h2>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Dilo con tus palabras; la IA lo interpreta, tú lo confirmas y el plan se rehace. Nada se
            guarda sin tu visto bueno.
          </p>
        </div>
        <Sparkles className="h-4 w-4 shrink-0 text-emerald-300" />
      </div>

      {current.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {current.map((constraint, index) => (
            <li
              key={`${constraint.kind}-${index}`}
              className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-200"
            >
              {constraintLabel(constraint)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-slate-500">
          Sin restricciones: el plan se decide solo con tu expediente y tu tiempo real.
        </p>
      )}

      <form onSubmit={interpret} className="flex flex-col gap-2 sm:flex-row">
        <input
          name="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={600}
          placeholder="Ej.: hoy solo tengo 45 minutos; sin Filosofía"
          className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-[#080d18] px-3 py-2 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-500/60"
          disabled={interpreting || saving}
        />
        <button
          type="submit"
          disabled={interpreting || saving || text.trim().length === 0}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
        >
          {interpreting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Interpretar
        </button>
      </form>

      {proposal ? (
        <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-200">
            Sin guardar todavía · revisa y confirma
          </p>
          <ul className="space-y-1">
            {proposal.map((constraint, index) => (
              <li key={`${constraint.kind}-${index}`} className="text-xs text-amber-100">
                · {constraintLabel(constraint)}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={confirm}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-400 px-3 py-1.5 text-[11px] font-bold text-slate-950 hover:bg-emerald-300 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Confirmar y aplicar
            </button>
            <button
              type="button"
              onClick={() => setProposal(null)}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 px-3 py-1.5 text-[11px] font-semibold text-slate-300 hover:bg-white/5 disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
              Descartar
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p
          role="status"
          className={`text-[11px] ${message.ok ? 'text-emerald-300' : 'text-rose-300'}`}
        >
          {message.text}
        </p>
      ) : null}

      {current.length > 0 ? (
        <button
          type="button"
          onClick={clear}
          disabled={saving}
          className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-slate-500 hover:text-rose-300 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          Quitar las restricciones de hoy
        </button>
      ) : null}
    </div>
  );
}
