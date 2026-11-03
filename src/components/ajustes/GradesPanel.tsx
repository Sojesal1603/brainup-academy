'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Check, GraduationCap, Loader2, Pencil } from 'lucide-react';
import clsx from 'clsx';
import { declareSubjectGrades } from '@/lib/actions';
import { GRADE_SOURCE_META } from '@/lib/knowledge';

export interface GradePanelSubject {
  id: string;
  name: string;
  color: string;
  currentGrade: number;
  targetGrade: number;
  gradeSource: string;
  measuredUnits: number;
  totalUnits: number;
}

interface GradesPanelProps {
  subjects: GradePanelSubject[];
}

/**
 * «Mis notas reales»: lo único que hace que la proyección PAU y los catedráticos
 * hablen de tus notas en vez de un número de fábrica. Nada se rellena solo.
 */
export default function GradesPanel({ subjects }: GradesPanelProps) {
  const [pending, startTransition] = useTransition();
  // La nota media no se precarga si nadie la ha declarado (no se enseña un
  // número inventado en el campo); el objetivo sí, porque es una meta editable.
  const [draft, setDraft] = useState<Record<string, { current: string; target: string }>>(
    Object.fromEntries(
      subjects.map((subject) => [
        subject.id,
        {
          current: subject.gradeSource === 'sin_medir' ? '' : subject.currentGrade.toString(),
          target: subject.targetGrade.toString(),
        },
      ])
    )
  );
  const [saved, setSaved] = useState<string | null>(null);

  const declared = subjects.filter((subject) => subject.gradeSource !== 'sin_medir').length;

  const save = (subjectId: string) => {
    const values = draft[subjectId];
    if (!values.current.trim()) return; // sin media no hay nada que declarar
    const current = Number(values.current.replace(',', '.'));
    const target = Number(values.target.replace(',', '.') || '0');
    if (!Number.isFinite(current) || !Number.isFinite(target)) return;

    startTransition(async () => {
      const result = await declareSubjectGrades({ subjectId, currentGrade: current, targetGrade: target });
      if (!result?.error) setSaved(subjectId);
    });
  };

  return (
    <div className="p-6 rounded-2xl glass-card space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-sky-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400">
            <GraduationCap className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100">Mis notas reales por asignatura</h3>
            <p className="text-xs text-slate-400">
              La media que llevas y tu objetivo. Hasta que lo declares, la app no inventa ninguna nota:
              la proyección PAU y los catedráticos trabajan con «sin declarar».
            </p>
          </div>
        </div>
        <span className="shrink-0 rounded-lg border border-white/10 bg-[#0a0a0c] px-2.5 py-1 font-mono text-[11px] text-slate-400">
          {declared}/{subjects.length} declaradas
        </span>
      </div>

      <div className="space-y-2">
        {subjects.map((subject) => {
          const values = draft[subject.id];
          const meta = GRADE_SOURCE_META[
            (subject.gradeSource as keyof typeof GRADE_SOURCE_META) ?? 'sin_medir'
          ];

          return (
            <div
              key={subject.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-[#0a0a0c] px-3 py-2"
            >
              <div className="flex min-w-[190px] flex-1 items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: subject.color }}
                />
                <span className="text-xs font-semibold text-slate-200">{subject.name}</span>
                <span
                  className={clsx(
                    'rounded border px-1.5 py-0.5 text-[10px] font-medium',
                    meta?.badgeColor ?? GRADE_SOURCE_META.sin_medir.badgeColor
                  )}
                  title={meta?.hint}
                >
                  {meta?.label ?? GRADE_SOURCE_META.sin_medir.label}
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Media</span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={0.1}
                  placeholder="?"
                  value={values.current}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      [subject.id]: { ...prev[subject.id], current: event.target.value },
                    }))
                  }
                  className="w-16 rounded-md border border-white/10 bg-[#0c1322] px-2 py-1 text-center font-mono text-xs text-slate-100 outline-none focus:border-sky-500/60"
                />
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Objetivo</span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={0.1}
                  value={values.target}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      [subject.id]: { ...prev[subject.id], target: event.target.value },
                    }))
                  }
                  className="w-16 rounded-md border border-white/10 bg-[#0c1322] px-2 py-1 text-center font-mono text-xs text-slate-100 outline-none focus:border-emerald-500/60"
                />
              </div>

              <Link
                href="/temario"
                className="text-[10px] font-mono text-slate-500 hover:text-slate-300"
                title="Autoevalúa el nivel de cada unidad en el Temario"
              >
                nivel medido: {subject.measuredUnits}/{subject.totalUnits}
              </Link>

              <button
                disabled={pending || !values.current.trim()}
                onClick={() => save(subject.id)}
                title={values.current.trim() ? 'Guardar mi nota real' : 'Escribe primero la media que llevas'}
                className={clsx(
                  'flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50',
                  saved === subject.id
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-sky-500/15 text-sky-300 hover:bg-sky-500/25'
                )}
              >
                {pending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : saved === subject.id ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Pencil className="h-3 w-3" />
                )}
                {saved === subject.id ? 'Guardada' : 'Declarar'}
              </button>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-slate-500">
        Estas notas son tuyas, no una medición: quedan marcadas como «declarada». El nivel que sí se mide
        de verdad sale de los simulacros corregidos, las sesiones de estudio, el diagnóstico de tus
        catedráticos IA y la autoevaluación del Temario.
      </p>
    </div>
  );
}
