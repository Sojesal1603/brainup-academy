'use client';

import { useState, useTransition } from 'react';
import { Loader2, Tags } from 'lucide-react';
import { setSubjectCategory } from '@/lib/actions';
import {
  SUBJECT_CATEGORIES,
  SUBJECT_CATEGORY_META,
  inferSubjectCategory,
} from '@/lib/subjects/category';

export interface CategoryPanelSubject {
  id: string;
  name: string;
  color: string;
  category: string | null;
}

/**
 * Cómo se trabaja cada materia (Paso 14).
 *
 * La categoría decide el método del catedrático y el orden de las herramientas.
 * «Automática» vuelve a la inferencia por nombre. El cambio no reescribe el
 * prompt guardado del agente: la capa se aplica al construir cada turno.
 */
export default function SubjectCategoriesPanel({
  subjects,
}: {
  subjects: CategoryPanelSubject[];
}) {
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(subjects.map((subject) => [subject.id, subject.category ?? 'AUTO']))
  );
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (subjects.length === 0) return null;

  const change = (subject: CategoryPanelSubject, value: string) => {
    setValues((prev) => ({ ...prev, [subject.id]: value }));
    setError(null);
    setSaved(null);
    startTransition(async () => {
      const result = await setSubjectCategory(subject.id, value === 'AUTO' ? null : value);
      if (!result?.success) {
        setError(result?.error ?? 'No se ha podido guardar la categoría.');
        return;
      }
      setSaved(subject.id);
    });
  };

  return (
    <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.02] p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/15 text-violet-300">
          <Tags className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-slate-100">Cómo se trabaja cada materia</h3>
          <p className="mt-0.5 text-xs text-slate-400">
            El catedrático adapta el método y las herramientas a esta categoría. «Automática» la
            deduce del nombre; puedes corregirla cuando quieras.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {subjects.map((subject) => {
          const value = values[subject.id] ?? 'AUTO';
          const effective =
            value === 'AUTO' ? inferSubjectCategory(subject.name) : value;
          const meta = SUBJECT_CATEGORY_META[effective as keyof typeof SUBJECT_CATEGORY_META];

          return (
            <div
              key={subject.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.07] bg-[#0a0a0c] px-3 py-2"
            >
              <div className="flex min-w-[180px] flex-1 items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: subject.color }}
                />
                <span className="text-xs font-semibold text-slate-200">{subject.name}</span>
              </div>

              <select
                value={value}
                disabled={pending}
                onChange={(event) => change(subject, event.target.value)}
                className="min-w-[240px] rounded-lg border border-white/10 bg-[#0c1322] px-2.5 py-1.5 text-[11px] text-slate-200 outline-none focus:border-violet-500/60 disabled:opacity-60"
              >
                <option value="AUTO">Automática — {meta.label}</option>
                {SUBJECT_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {SUBJECT_CATEGORY_META[category].label}
                  </option>
                ))}
              </select>

              <span className="hidden text-[10px] text-slate-500 sm:inline">
                {meta?.description}
              </span>

              {pending ? (
                <Loader2 className="h-3 w-3 animate-spin text-slate-500" />
              ) : saved === subject.id ? (
                <span className="text-[10px] font-semibold text-emerald-300">Guardada</span>
              ) : null}
            </div>
          );
        })}
      </div>

      {error && <p className="text-[11px] text-rose-300">{error}</p>}
    </div>
  );
}
