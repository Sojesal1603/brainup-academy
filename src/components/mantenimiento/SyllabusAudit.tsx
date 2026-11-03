'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { Bot, Loader2, ScanSearch, Sparkles, Wand2 } from 'lucide-react';
import { applyMaintenanceFixes, auditSyllabusWithAi } from '@/lib/maintenanceActions';

/**
 * La auditoría de IA del temario.
 *
 * La IA **propone**, no cambia nada: devuelve líneas «acción | unidad | motivo»
 * y solo si el alumno pulsa se aplican, por la misma puerta que el resto del
 * taller. Si no hay claves de IA, se dice con el mensaje que devuelve el motor en
 * vez de dejar la pantalla vacía.
 */

export interface AuditSubject {
  id: string;
  name: string;
  units: number;
}

interface Proposal {
  action: string;
  target: string;
  reason: string;
}

interface AuditState {
  success: boolean;
  error?: string;
  subjectName?: string;
  model?: string;
  proposals: Proposal[];
  fix: { id: string; label: string; description: string; count: number } | null;
  summary: string;
}

const ACTION_META: Record<string, { label: string; badgeColor: string }> = {
  renombrar: { label: 'renombrar', badgeColor: 'bg-sky-500/10 text-sky-400 border-sky-500/30' },
  borrar: { label: 'borrar', badgeColor: 'bg-rose-500/10 text-rose-400 border-rose-500/30' },
  renumerar: { label: 'renumerar', badgeColor: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  dudar: { label: 'duda', badgeColor: 'bg-slate-500/10 text-slate-400 border-slate-500/30' },
};

export default function SyllabusAudit({
  subjects,
  aiConfigured,
}: {
  subjects: AuditSubject[];
  aiConfigured: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [applying, startApplying] = useTransition();
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? '');
  const [audit, setAudit] = useState<AuditState | null>(null);
  const [applyNote, setApplyNote] = useState('');
  const [applyError, setApplyError] = useState('');

  function runAudit() {
    if (isPending || !subjectId) return;
    setAudit(null);
    setApplyNote('');
    setApplyError('');

    startTransition(async () => {
      const response = await auditSyllabusWithAi(subjectId);
      setAudit({
        success: response.success,
        error: response.error,
        subjectName: response.subjectName,
        model: response.model,
        proposals: response.proposals,
        fix: response.fix
          ? {
              id: response.fix.id,
              label: response.fix.label,
              description: response.fix.description,
              count: response.fix.count,
            }
          : null,
        summary: response.summary,
      });
    });
  }

  function applyAudit() {
    const fix = audit?.fix;
    if (applying || !fix) return;
    setApplyNote('');
    setApplyError('');

    startApplying(async () => {
      const response = await applyMaintenanceFixes([fix.id]);

      if (!response.success) {
        setApplyError(response.error ?? 'No se ha podido aplicar la auditoría.');
        return;
      }

      setApplyNote(
        response.applied.length === 0
          ? 'No se ha cambiado nada: las propuestas no se han podido convertir en cambios concretos.'
          : `Aplicado: ${response.applied.map((item) => `${item.label} (${item.count})`).join(' · ')}`
      );
      router.refresh();
    });
  }

  const selected = subjects.find((subject) => subject.id === subjectId);

  return (
    <div className="p-5 rounded-2xl glass-card space-y-4">
      <div className="flex items-center gap-2">
        <Bot className="w-4 h-4 text-violet-400" />
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-200">
            Auditoría del temario con IA
          </p>
          <p className="text-[11px] text-slate-400">
            Una IA lee las unidades de una materia, detecta títulos repetidos, numeración rota o
            cosas que no pertenecen ahí, y propone. Tú decides qué se aplica.
          </p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <select
          value={subjectId}
          onChange={(event) => setSubjectId(event.target.value)}
          className="flex-1 bg-[#080d18] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-violet-500"
        >
          {subjects.map((subject) => (
            <option key={subject.id} value={subject.id}>
              {subject.name} · {subject.units} unidad(es)
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={runAudit}
          disabled={isPending || !subjectId}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-500 px-4 py-2.5 text-xs font-bold text-slate-950 transition-all hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Revisando…</span>
            </>
          ) : (
            <>
              <ScanSearch className="w-4 h-4" />
              <span>Revisar {selected ? selected.name : 'la materia'}</span>
            </>
          )}
        </button>
      </div>

      {!aiConfigured && (
        <p className="text-[11px] text-amber-300/90 leading-relaxed">
          Ahora mismo no hay ninguna clave de IA configurada (.env → GEMINI_API_KEY o GROQ_API_KEY),
          así que la auditoría no puede ejecutarse. El resto de comprobaciones del taller funcionan
          igual, sin IA.
        </p>
      )}

      {audit && !audit.success && audit.error && (
        <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/30">
          <p className="text-[11px] text-amber-300 leading-relaxed">{audit.error}</p>
        </div>
      )}

      {audit?.success && (
        <div className="space-y-3">
          <p className="text-[11px] text-slate-300 leading-relaxed">{audit.summary}</p>
          {audit.model && (
            <p className="text-[10px] font-mono text-slate-500">Revisado con {audit.model}</p>
          )}

          {audit.proposals.length > 0 && (
            <div className="rounded-xl border border-white/10 divide-y divide-[#1e293b] overflow-hidden">
              {audit.proposals.map((proposal, index) => {
                const meta = ACTION_META[proposal.action] ?? ACTION_META.dudar;
                return (
                  <div key={index} className="p-3 bg-[#0a1120] space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={clsx(
                          'text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border',
                          meta.badgeColor
                        )}
                      >
                        {meta.label}
                      </span>
                      <span className="text-[11px] font-semibold text-slate-100">
                        {proposal.target}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-relaxed">{proposal.reason}</p>
                  </div>
                );
              })}
            </div>
          )}

          {audit.fix ? (
            <div className="p-4 rounded-xl bg-violet-500/5 border border-violet-500/30 space-y-2">
              <p className="text-xs font-bold text-violet-200 flex items-center gap-1.5">
                <Wand2 className="w-3.5 h-3.5" />
                <span>{audit.fix.label}</span>
              </p>
              <p className="text-[11px] text-slate-300 leading-relaxed">{audit.fix.description}</p>
              <p className="text-[11px] text-slate-400">
                Afecta a {audit.fix.count} unidad(es). La IA propone y tú decides: si algo no te
                cuadra, no lo apliques y dímelo.
              </p>
              <button
                type="button"
                onClick={applyAudit}
                disabled={applying}
                className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-3.5 py-2 text-[11px] font-bold text-slate-950 transition-all hover:bg-violet-400 disabled:opacity-50"
              >
                {applying ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Aplicando…</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Aplicar estas propuestas</span>
                  </>
                )}
              </button>
            </div>
          ) : (
            audit.proposals.length > 0 && (
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Las propuestas son dudas o cambios que no se pueden aplicar solos (por ejemplo,
                fusionar dos unidades). Revísalas a mano en /temario siguiendo esta lista.
              </p>
            )
          )}
        </div>
      )}

      {applyNote && <p className="text-[11px] text-emerald-300 leading-relaxed">{applyNote}</p>}
      {applyError && <p className="text-[11px] text-rose-400 leading-relaxed">{applyError}</p>}
    </div>
  );
}
