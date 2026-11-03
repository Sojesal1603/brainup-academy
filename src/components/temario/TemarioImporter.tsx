'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Loader2,
  ListChecks,
} from 'lucide-react';
import clsx from 'clsx';
import {
  countByTerm,
  parseTemarioText,
  TemarioSource,
  TEMARIO_SOURCES,
} from '@/lib/temarioImport';
import { importTemario } from '@/lib/actions';

export interface ImporterSubject {
  id: string;
  name: string;
  /** Unidades que ya tiene cargadas (0 = temario vacío). */
  unitCount: number;
}

const SOURCE_META: Record<TemarioSource, { label: string; hint: string }> = {
  profesor: {
    label: 'Índice de mi profesor',
    hint: 'Lo que se da en clase: esta es la lista que manda en el planificador.',
  },
  libro: {
    label: 'Índice de mi libro',
    hint: 'El temario del libro de texto que usas.',
  },
  manual: {
    label: 'Lo escribo yo',
    hint: 'Una lista tuya, escrita a mano.',
  },
};

const TERM_LABEL: Record<string, string> = {
  '1': '1ª ev.',
  '2': '2ª ev.',
  '3': '3ª ev.',
  sin: 'sin evaluación',
};

const PLACEHOLDER = `1ª evaluación
1. Números reales y radicales
2. Trigonometría: razones y ecuaciones [4]
3. Vectores y rectas en el plano

2ª evaluación
4. Funciones: dominio, límites y continuidad [4]
5. Derivadas y sus aplicaciones

3ª evaluación
6. Estadística y probabilidad`;

type ImportResponse = Awaited<ReturnType<typeof importTemario>>;

export default function TemarioImporter({
  subjects,
  defaultOpen = false,
}: {
  subjects: ImporterSubject[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? '');
  const [source, setSource] = useState<TemarioSource>('profesor');
  const [mode, setMode] = useState<'replace' | 'merge'>('replace');
  const [text, setText] = useState('');
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [pending, startTransition] = useTransition();

  const subject = subjects.find((item) => item.id === subjectId) ?? subjects[0] ?? null;

  const preview = useMemo(() => (text.trim().length > 0 ? parseTemarioText(text) : null), [text]);
  const termCounts = preview ? countByTerm(preview.units) : null;

  if (!subject) {
    return (
      <div className="rounded-2xl border border-white/10 bg-[#0c1322] p-4 text-xs text-slate-400">
        Todavía no hay asignaturas. Créalas en Ajustes y vuelve aquí a cargar tus temarios.
      </div>
    );
  }

  const submit = () => {
    if (!preview || preview.units.length === 0) return;

    if (mode === 'replace' && subject.unitCount > 0) {
      const ok = confirm(
        `Vas a sustituir las ${subject.unitCount} unidades de ${subject.name} por las ${preview.units.length} que has pegado.\n\nSe guarda una copia de seguridad antes de borrar. ¿Seguir?`
      );
      if (!ok) return;
    }

    startTransition(async () => {
      const response = await importTemario({ subjectId: subject.id, text, source, mode });
      setResult(response);
    });
  };

  return (
    <div className="rounded-2xl border border-emerald-500/25 bg-[#0c1322]">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <ClipboardPaste className="h-4 w-4 text-emerald-400" />
          <div>
            <div className="text-sm font-bold text-slate-100">Cargar tu temario</div>
            <div className="text-[11px] text-slate-400">
              El temario lo pones tú: la app no inventa unidades. Pega el índice de tu profesor o de
              tu libro, una unidad por línea.
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {subject.unitCount === 0 && (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
              temario vacío
            </span>
          )}
          {open ? (
            <ChevronDown className="h-4 w-4 text-slate-500" />
          ) : (
            <ChevronRight className="h-4 w-4 text-slate-500" />
          )}
        </div>
      </button>

      {open && (
        <div className="space-y-3 border-t border-white/10 px-4 py-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="text-[10px] uppercase tracking-widest text-slate-500">
                Asignatura
              </span>
              <select
                value={subject.id}
                onChange={(event) => {
                  setSubjectId(event.target.value);
                  setResult(null);
                }}
                className="mt-1 w-full rounded-lg border border-white/10 bg-[#0a0a0c] px-2 py-1.5 text-xs text-slate-200 outline-none"
              >
                {subjects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.unitCount} unidades
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-[10px] uppercase tracking-widest text-slate-500">
                De dónde sale esta lista
              </span>
              <select
                value={source}
                onChange={(event) => setSource(event.target.value as TemarioSource)}
                className="mt-1 w-full rounded-lg border border-white/10 bg-[#0a0a0c] px-2 py-1.5 text-xs text-slate-200 outline-none"
              >
                {TEMARIO_SOURCES.map((value) => (
                  <option key={value} value={value}>
                    {SOURCE_META[value].label}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[10px] text-slate-500">
                {SOURCE_META[source].hint}
              </span>
            </label>
          </div>

          <label className="block">
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-slate-500">
              <ListChecks className="h-3 w-3" /> Pega tu índice
            </span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={10}
              spellCheck={false}
              placeholder={PLACEHOLDER}
              className="mt-1 w-full resize-y rounded-lg border border-white/10 bg-[#0a0a0c] p-2.5 font-mono text-[11px] leading-relaxed text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-500/40"
            />
          </label>

          <p className="text-[10px] leading-relaxed text-slate-500">
            Se leen solos: la numeración («1.», «U3», «Tema 5:»), las viñetas, las cabeceras de
            evaluación («1ª evaluación», «Segundo trimestre») y la dificultad opcional al final
            («[4]»). Todo entra como <span className="text-slate-300">pendiente</span> y{' '}
            <span className="text-slate-300">sin medir</span>: cargar el temario no es saberlo.
          </p>

          {/* Vista previa de lo que se va a cargar */}
          {preview && (
            <div className="rounded-xl border border-white/10 bg-[#0a0a0c] p-3">
              {preview.units.length === 0 ? (
                <div className="flex items-center gap-2 text-xs text-amber-300">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  No he reconocido ninguna unidad. Escribe una unidad por línea.
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-mono text-sm font-bold text-emerald-300">
                      {preview.units.length} unidades detectadas
                    </div>
                    {termCounts && (
                      <div className="flex flex-wrap gap-1.5 text-[10px] text-slate-400">
                        {(['1', '2', '3', 'sin'] as const).map((key) =>
                          termCounts[key] ? (
                            <span
                              key={key}
                              className="rounded border border-white/10 bg-[#0c1322] px-1.5 py-0.5"
                            >
                              {TERM_LABEL[key]}: {termCounts[key]}
                            </span>
                          ) : null
                        )}
                      </div>
                    )}
                  </div>

                  <ul className="mt-2 max-h-44 space-y-0.5 overflow-y-auto pr-1">
                    {preview.units.slice(0, 40).map((unit, index) => (
                      <li
                        key={`${unit.title}-${index}`}
                        className="flex items-center gap-2 text-[11px] text-slate-300"
                      >
                        <span className="w-7 shrink-0 text-right font-mono text-[10px] text-slate-500">
                          {index + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate" title={unit.title}>
                          {unit.title}
                        </span>
                        {unit.difficulty !== 3 && (
                          <span className="shrink-0 font-mono text-[10px] text-slate-500">
                            dif {unit.difficulty}
                          </span>
                        )}
                        <span className="shrink-0 font-mono text-[10px] text-violet-300/80">
                          {TERM_LABEL[unit.term === null ? 'sin' : String(unit.term)]}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {preview.units.length > 40 && (
                    <p className="mt-1 text-[10px] text-slate-500">
                      …y {preview.units.length - 40} más.
                    </p>
                  )}

                  {(preview.duplicates.length > 0 ||
                    preview.ignored.length > 0 ||
                    preview.headers.length > 0) && (
                    <div className="mt-2 space-y-1 border-t border-white/10 pt-2 text-[10px]">
                      {preview.headers.length > 0 && (
                        <p className="text-slate-500">
                          Cabeceras leídas ({preview.headers.length}):{' '}
                          <span className="text-slate-400">
                            {preview.headers.slice(0, 4).join(' · ')}
                            {preview.headers.length > 4 ? ' …' : ''}
                          </span>
                        </p>
                      )}
                      {preview.duplicates.length > 0 && (
                        <p className="text-amber-300">
                          {preview.duplicates.length} título(s) repetido(s), se cargan una sola vez:{' '}
                          {preview.duplicates.slice(0, 3).join(' · ')}
                        </p>
                      )}
                      {preview.ignored.length > 0 && (
                        <p className="text-slate-500">
                          {preview.ignored.length} línea(s) no parecían unidades y se quedan fuera:{' '}
                          {preview.ignored.slice(0, 3).join(' · ')}
                          {preview.ignored.length > 3 ? ' …' : ''}
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Modo: sustituir o añadir */}
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['replace', 'Sustituir el temario de esta asignatura'],
                ['merge', 'Añadir a lo que ya hay'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setMode(key)}
                className={clsx(
                  'rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                  mode === key
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                    : 'border-white/10 bg-[#0a0a0c] text-slate-400 hover:text-slate-200'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {mode === 'replace' && (
            <p className="text-[10px] text-slate-500">
              Se guardará una copia en{' '}
              <code className="text-slate-400">data/backups/</code> antes de borrar nada.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              disabled={pending || !preview || preview.units.length === 0}
              onClick={submit}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-[11px] font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/25 disabled:opacity-40"
            >
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ClipboardPaste className="h-3.5 w-3.5" />
              )}
              {preview && preview.units.length > 0
                ? `Cargar ${preview.units.length} unidades en ${subject.name}`
                : 'Cargar temario'}
            </button>
            {(text.length > 0 || result) && (
              <button
                disabled={pending}
                onClick={() => {
                  setText('');
                  setResult(null);
                }}
                className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-slate-400 transition-colors hover:text-slate-200 disabled:opacity-40"
              >
                Limpiar
              </button>
            )}
          </div>

          {/* Resultado real de la carga */}
          {result && (
            <div
              className={clsx(
                'rounded-xl border px-3 py-2 text-[11px]',
                result.success
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
              )}
            >
              {result.success ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <Check className="h-3.5 w-3.5" />
                    {result.created} unidades cargadas en {result.subjectName}
                    {result.removed > 0 ? ` · ${result.removed} anteriores sustituidas` : ''}
                    {result.skipped > 0 ? ` · ${result.skipped} ya estaban` : ''}
                    {result.updated > 0 ? ` · ${result.updated} completadas con su evaluación` : ''}
                  </div>
                  <div className="text-emerald-300/80">
                    Ahora tiene {result.total} unidades · {result.blocks} bloques de estudio
                    planificados
                    {result.terms.length > 0
                      ? ` · evaluaciones detectadas: ${result.terms.join(', ')}`
                      : ''}
                  </div>
                  {result.backup && (
                    <div className="font-mono text-[10px] text-emerald-300/70">
                      copia previa: {result.backup}
                    </div>
                  )}
                  {result.ignored > 0 && (
                    <div className="text-[10px] text-emerald-300/70">
                      {result.ignored} línea(s) quedaron fuera por no parecer unidades.
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {result.error}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
