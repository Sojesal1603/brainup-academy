'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BookOpenCheck,
  Check,
  ChevronRight,
  ChevronsRight,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import type { TemarioSubject, TemarioUnit } from '@/lib/temario';
import {
  TOPIC_SOURCE_META,
  TOPIC_STATUSES,
  TOPIC_STATUS_META,
  TopicStatus,
} from '@/lib/types';
import {
  addTemarioUnit,
  deleteTemarioUnit,
  moveTemarioUnit,
  saveClassMethod,
  setCourseProgressFrom,
  setTopicSelfAssessment,
  setTopicStatus,
  updateTopicDetails,
} from '@/lib/actions';
import { describeMastery, MASTERY_SOURCE_META } from '@/lib/knowledge';

interface TemarioBoardProps {
  subjects: TemarioSubject[];
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

/** Fin del curso actual: la tercera semana de junio. */
function courseEnd(now = new Date()): Date {
  const month = now.getMonth(); // 0 = enero
  const year = month >= 7 ? now.getFullYear() + 1 : now.getFullYear();
  return new Date(year, 5, 20);
}

export default function TemarioBoard({ subjects }: TemarioBoardProps) {
  const [selectedId, setSelectedId] = useState(subjects[0]?.id ?? '');
  const [filter, setFilter] = useState<'todas' | 'pendientes' | 'dadas'>('todas');
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<string>('');

  const selected = subjects.find((subject) => subject.id === selectedId) ?? subjects[0] ?? null;

  const visibleUnits = useMemo(() => {
    if (!selected) return [];
    if (filter === 'pendientes') return selected.units.filter((unit) => unit.status === 'pendiente');
    if (filter === 'dadas') {
      return selected.units.filter((unit) => unit.status === 'visto' || unit.status === 'repasado');
    }
    return selected.units;
  }, [selected, filter]);

  const run = (fn: () => Promise<{ success?: boolean; error?: string }>, message?: string) => {
    startTransition(async () => {
      const result = await fn();
      setFeedback(result?.error ? result.error : message ?? '');
    });
  };

  if (!selected) {
    return (
      <div className="rounded-2xl border border-white/10 bg-[#0c1322] p-8 text-center text-sm text-slate-400">
        Todavía no hay asignaturas. Créalas en Ajustes y vuelve aquí.
      </div>
    );
  }

  const { stats } = selected;
  const end = courseEnd();
  const projected = stats.projectedFinishIso ? new Date(stats.projectedFinishIso) : null;
  const late = projected ? projected.getTime() > end.getTime() : false;

  return (
    <div className="space-y-4">
      {/* Selector de asignatura */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {subjects.map((subject) => {
          const isActive = subject.id === selected.id;
          return (
            <button
              key={subject.id}
              onClick={() => {
                setSelectedId(subject.id);
                setFeedback('');
              }}
              className={clsx(
                'shrink-0 rounded-xl border px-3 py-2 text-left transition-all',
                isActive
                  ? 'border-emerald-500/40 bg-emerald-500/10'
                  : 'border-white/10 bg-[#0c1322] hover:border-slate-600'
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: subject.color }}
                />
                <span
                  className={clsx(
                    'text-xs font-semibold',
                    isActive ? 'text-emerald-300' : 'text-slate-300'
                  )}
                >
                  {subject.name}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] font-mono text-slate-500">
                <span>
                  {subject.stats.seen}/{subject.stats.total} vistas
                </span>
                {subject.stats.counts.en_curso > 0 && (
                  <span className="text-amber-400">{subject.stats.counts.en_curso} en curso</span>
                )}
              </div>
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[#1e293b]">
                <div
                  className="h-full rounded-full bg-emerald-400"
                  style={{ width: `${subject.stats.progressPct}%` }}
                />
              </div>
            </button>
          );
        })}
      </div>

      {/* Cabecera del temario elegido */}
      <div className="rounded-2xl border border-white/10 bg-[#0c1322] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <BookOpenCheck className="h-5 w-5 text-emerald-400" />
              <h2 className="text-base font-bold text-slate-100">{selected.name}</h2>
              {selected.units.length > 0 && (
                <span
                  className={clsx(
                    'rounded border px-1.5 py-0.5 text-[10px] font-medium',
                    TOPIC_SOURCE_META[selected.units[0]?.source ?? 'manual']?.badgeColor ??
                      TOPIC_SOURCE_META.manual.badgeColor
                  )}
                  title={
                    TOPIC_SOURCE_META[selected.units[0]?.source ?? 'manual']?.hint ??
                    TOPIC_SOURCE_META.manual.hint
                  }
                >
                  {TOPIC_SOURCE_META[selected.units[0]?.source ?? 'manual']?.label ??
                    TOPIC_SOURCE_META.manual.label}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-400">
              {selected.units.length} unidades · {stats.seen} dadas · {stats.counts.en_curso} en curso ·{' '}
              {stats.counts.pendiente} por dar ·{' '}
              <span className="text-violet-300">
                {selected.units.filter((unit) => unit.masterySource !== 'sin_medir').length} con nivel
                medido
              </span>
            </p>
          </div>

          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#0a0a0c] p-1">
            {(
              [
                ['todas', 'Todas'],
                ['pendientes', 'Por dar'],
                ['dadas', 'Dadas'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={clsx(
                  'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                  filter === key
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'text-slate-400 hover:text-slate-200'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Diagnóstico del temario */}
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-xl border border-white/10 bg-[#0a0a0c] p-2.5">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">En clase ahora</div>
            <div className="mt-1 truncate text-xs font-semibold text-amber-300" title={stats.currentUnitId ?? ''}>
              {selected.units.find((unit) => unit.id === stats.currentUnitId)?.title ?? '—'}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-[#0a0a0c] p-2.5">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Siguiente</div>
            <div className="mt-1 truncate text-xs font-semibold text-slate-200">
              {selected.units.find((unit) => unit.id === stats.nextUnitId)?.title ?? 'Temario cerrado'}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-[#0a0a0c] p-2.5">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Ritmo real</div>
            <div className="mt-1 text-xs font-semibold text-slate-200">
              {stats.pacePerWeek ? `${stats.pacePerWeek} u/semana` : 'sin datos aún'}
            </div>
          </div>
          <div
            className={clsx(
              'rounded-xl border p-2.5',
              late ? 'border-amber-500/40 bg-amber-500/5' : 'border-white/10 bg-[#0a0a0c]'
            )}
          >
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Fin previsto</div>
            <div className={clsx('mt-1 text-xs font-semibold', late ? 'text-amber-300' : 'text-slate-200')}>
              {projected ? formatDate(stats.projectedFinishIso) : 'marca clases para calcularlo'}
            </div>
          </div>
        </div>

        {late && (
          <p className="mt-2 text-[11px] text-amber-300/90">
            A este ritmo el temario terminaría después del curso (20 de junio). Sube el ritmo de repaso o
            marca lo que ya llevas dado para afinar el cálculo.
          </p>
        )}

        {/* Leyenda de estados */}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[10px] text-slate-500">
          {TOPIC_STATUSES.map((status) => (
            <span key={status} className="flex items-center gap-1.5">
              <span className={clsx('h-2 w-2 rounded-full', TOPIC_STATUS_META[status].dotColor)} />
              {TOPIC_STATUS_META[status].label}
            </span>
          ))}
          <span className="text-slate-600">
            Haz clic en un punto de color para fijar el estado de la unidad.
          </span>
        </div>
      </div>

      {feedback && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          <Check className="h-3.5 w-3.5" />
          {feedback}
        </div>
      )}

      {/* Lista de unidades */}
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0c1322]">
        {selected.units.length === 0 ? (
          <p className="p-6 text-center text-xs text-slate-400">
            <span className="text-slate-300">{selected.name}</span> todavía no tiene temario. Pega tu
            índice en «Cargar tu temario» (arriba) o añade las unidades una a una aquí abajo.
          </p>
        ) : visibleUnits.length === 0 ? (
          <p className="p-6 text-center text-xs text-slate-400">
            No hay unidades en este filtro.
          </p>
        ) : (
          <ul className="divide-y divide-[#1e293b]">
            {visibleUnits.map((unit, index) => (
              <UnitRow
                key={unit.id}
                unit={unit}
                index={index}
                total={visibleUnits.length}
                pending={pending}
                onRun={run}
              />
            ))}
          </ul>
        )}
      </div>

      <AddUnitForm
        subjectId={selected.id}
        pending={pending}
        onRun={run}
        disabled={false}
      />
    </div>
  );
}

function UnitRow({
  unit,
  index,
  total,
  pending,
  onRun,
}: {
  unit: TemarioUnit;
  index: number;
  total: number;
  pending: boolean;
  onRun: (fn: () => Promise<{ success?: boolean; error?: string }>, message?: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(unit.title);
  /**
   * Cómo lo explicó el profesor: el renglón que ata el apunte a su clase.
   *
   * Está aquí, en la propia unidad, porque es donde el alumno se acuerda: al
   * repasar el temario y ver lo que lleva dado. El catedrático lo recibe al
   * redactar los apuntes de esta unidad, así que la notación y los criterios de
   * corrección son los de su profesor y no los de un temario genérico.
   */
  const [methodOpen, setMethodOpen] = useState(false);
  const [method, setMethod] = useState(unit.teacherMethod ?? '');

  const save = () => {
    setEditing(false);
    if (title.trim() === unit.title) return;
    onRun(
      () => updateTopicDetails({ topicId: unit.id, title }),
      `Renombrada: ${title.trim()}`
    );
  };

  const saveMethod = () => {
    const text = method.trim();
    setMethodOpen(false);
    if (text === (unit.teacherMethod ?? '').trim()) return;
    onRun(
      () => saveClassMethod(unit.id, text),
      text.length > 0 ? 'Método del profesor anotado' : 'Método del profesor borrado'
    );
  };

  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2.5 hover:bg-[#111827]">
      <span className="w-9 shrink-0 rounded-md border border-white/10 bg-[#0a0a0c] py-0.5 text-center font-mono text-[11px] text-slate-400">
        {unit.unitNumber ?? '—'}
      </span>

      <div className="min-w-[180px] flex-1">
        {editing ? (
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={save}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
              if (event.key === 'Escape') {
                setTitle(unit.title);
                setEditing(false);
              }
            }}
            className="w-full rounded-md border border-emerald-500/40 bg-[#0a0a0c] px-2 py-1 text-xs text-slate-100 outline-none"
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="text-left text-xs text-slate-200 hover:text-emerald-300"
            title="Editar el título"
          >
            {unit.title}
          </button>
        )}
        {unit.seenInClassAt && (
          <span className="ml-2 text-[10px] text-slate-500">
            en clase el {new Date(unit.seenInClassAt).toLocaleDateString('es-ES', {
              day: 'numeric',
              month: 'short',
            })}
          </span>
        )}
        {unit.teacherMethod && !methodOpen && (
          <p className="mt-0.5 text-[10px] text-violet-300/80" title={unit.teacherMethod}>
            Método del profesor: {unit.teacherMethod}
          </p>
        )}
      </div>

      {/* Evaluación */}
      <select
        value={unit.term ?? ''}
        onChange={(event) =>
          onRun(
            () =>
              updateTopicDetails({
                topicId: unit.id,
                term: event.target.value === '' ? null : Number(event.target.value),
              }),
            'Evaluación actualizada'
          )
        }
        className="rounded-md border border-white/10 bg-[#0a0a0c] px-1.5 py-1 text-[10px] text-slate-300 outline-none"
        title="Evaluación en la que se da"
      >
        <option value="">—</option>
        <option value="1">1ª evaluación</option>
        <option value="2">2ª evaluación</option>
        <option value="3">3ª evaluación</option>
      </select>

      {/* Nivel: solo tuyo o medido de verdad, nunca supuesto */}
      <LevelControl unit={unit} pending={pending} onRun={onRun} />

      {/* Estado: cuatro puntos, el activo resaltado */}
      <div className="flex items-center gap-1">
        {TOPIC_STATUSES.map((status) => {
          const meta = TOPIC_STATUS_META[status];
          const active = unit.status === status;
          return (
            <button
              key={status}
              disabled={pending}
              onClick={() =>
                onRun(
                  () => setTopicStatus(unit.id, status as TopicStatus),
                  `U${unit.unitNumber ?? ''} → ${meta.label}`
                )
              }
              title={`${meta.label} · ${meta.description}`}
              className={clsx(
                'h-3.5 w-3.5 rounded-full border transition-transform',
                meta.dotColor,
                active
                  ? 'scale-125 border-slate-100'
                  : 'border-transparent opacity-35 hover:opacity-90'
              )}
            />
          );
        })}
      </div>

      <span
        className={clsx(
          'rounded border px-1.5 py-0.5 text-[10px] font-medium',
          TOPIC_STATUS_META[unit.status].badgeColor
        )}
      >
        {TOPIC_STATUS_META[unit.status].short}
      </span>

      <div className="flex items-center gap-0.5 text-slate-500">
        <button
          disabled={pending}
          onClick={() => setMethodOpen((open) => !open)}
          className={clsx(
            'rounded p-1 hover:bg-violet-500/10 hover:text-violet-300 disabled:opacity-30',
            unit.teacherMethod && 'text-violet-300'
          )}
          title={
            unit.teacherMethod
              ? 'Cómo lo explicó tu profesor (anotado · pulsa para afinarlo)'
              : 'Anotar cómo lo explicó tu profesor en clase'
          }
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          disabled={pending}
          onClick={() =>
            onRun(
              () => setCourseProgressFrom(unit.subjectId, unit.id),
              `Vamos por aquí: U${unit.unitNumber ?? ''} en curso`
            )
          }
          className="rounded p-1 hover:bg-emerald-500/10 hover:text-emerald-400 disabled:opacity-30"
          title="Vamos por aquí: esto queda en curso y todo lo anterior como dado"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </button>
        <button
          disabled={pending}
          onClick={() => onRun(() => moveTemarioUnit(unit.id, 'up'))}
          className="rounded p-1 hover:bg-[#1e293b] hover:text-slate-200 disabled:opacity-30"
          title="Subir en el orden"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          disabled={pending}
          onClick={() => onRun(() => moveTemarioUnit(unit.id, 'down'))}
          className="rounded p-1 hover:bg-[#1e293b] hover:text-slate-200 disabled:opacity-30"
          title="Bajar en el orden"
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
        <button
          disabled={pending}
          onClick={() => {
            if (confirm(`¿Borrar la unidad «${unit.title}»? Se borrarán sus bloques y errores asociados.`)) {
              onRun(() => deleteTemarioUnit(unit.id), 'Unidad borrada');
            }
          }}
          className="rounded p-1 hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-30"
          title="Borrar unidad"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {pending && index === 0 && total > 0 && (
        <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />
      )}

      {methodOpen && (
        <div className="mt-1 w-full space-y-1.5 rounded-lg border border-violet-500/30 bg-[#0c1322] p-2">
          <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Cómo lo explicó tu profesor en clase (opcional)
          </label>
          <textarea
            value={method}
            onChange={(event) => setMethod(event.target.value)}
            rows={2}
            maxLength={600}
            placeholder="Su notación, los pasos que exige, dónde hizo hincapié, el ejemplo que puso…"
            className="w-full resize-y rounded-lg border border-white/10 bg-[#0a0a0c] px-2 py-1.5 text-[11px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-violet-500/50"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              disabled={pending || method.trim() === (unit.teacherMethod ?? '').trim()}
              onClick={saveMethod}
              className="flex items-center gap-1 rounded-lg border border-violet-500/40 bg-violet-500/10 px-2.5 py-1 text-[10px] font-semibold text-violet-200 transition-colors hover:bg-violet-500/20 disabled:opacity-40"
            >
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Guardar
            </button>
            <button
              onClick={() => {
                setMethod(unit.teacherMethod ?? '');
                setMethodOpen(false);
              }}
              className="text-[10px] text-slate-400 hover:text-slate-200"
            >
              Cancelar
            </button>
            <span className="text-[10px] text-slate-500">
              El catedrático seguirá este método al escribirte los apuntes de esta unidad.
            </span>
          </div>
        </div>
      )}
    </li>
  );
}

const LEVEL_PRESETS = [
  { value: 10, label: '10 · nada' },
  { value: 35, label: '35 · flojo' },
  { value: 55, label: '55 · justo' },
  { value: 75, label: '75 · bien' },
  { value: 90, label: '90 · dominado' },
];

/**
 * Nivel de la unidad: «sin medir» por defecto y, si lo declaras tú, queda
 * marcado como autoevaluación (no como examen). Lo que mide la IA o un
 * simulacro se ve aquí pero no se puede falsear desde este selector.
 */
function LevelControl({
  unit,
  pending,
  onRun,
}: {
  unit: TemarioUnit;
  pending: boolean;
  onRun: (fn: () => Promise<{ success?: boolean; error?: string }>, message?: string) => void;
}) {
  const view = describeMastery(unit);
  const isPreset = LEVEL_PRESETS.some((preset) => preset.value === unit.masteryLevel);
  const selectValue = !view.measured ? '' : isPreset ? String(unit.masteryLevel) : `actual-${unit.masteryLevel}`;

  return (
    <div className="flex items-center gap-1">
      <select
        disabled={pending}
        value={selectValue}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw.startsWith('actual-')) return;
          const level = raw === '' ? null : Number(raw);
          onRun(
            () => setTopicSelfAssessment(unit.id, level),
            level === null ? 'Nivel borrado: vuelve a estar sin medir' : `Nivel declarado: ${level}%`
          );
        }}
        title="Tu nivel en esta unidad: sin medir, o lo que declares tú"
        className={clsx(
          'rounded-md border bg-[#0a0a0c] px-1.5 py-1 text-[10px] outline-none',
          view.measured ? 'border-violet-500/40 text-violet-200' : 'border-white/10 text-slate-400'
        )}
      >
        <option value="">nivel sin medir</option>
        {LEVEL_PRESETS.map((preset) => (
          <option key={preset.value} value={preset.value}>
            {preset.label}
          </option>
        ))}
        {view.measured && !isPreset && (
          <option value={`actual-${unit.masteryLevel}`}>{unit.masteryLevel}% (medido)</option>
        )}
      </select>
      {view.measured && (
        <span
          className={clsx('rounded border px-1 py-0.5 text-[9px] font-medium', view.badgeColor)}
          title={MASTERY_SOURCE_META[view.source].hint}
        >
          {MASTERY_SOURCE_META[view.source].label}
        </span>
      )}
    </div>
  );
}

function AddUnitForm({
  subjectId,
  pending,
  onRun,
}: {
  subjectId: string;
  pending: boolean;
  onRun: (fn: () => Promise<{ success?: boolean; error?: string }>, message?: string) => void;
  disabled: boolean;
}) {
  const [title, setTitle] = useState('');

  const submit = () => {
    if (!title.trim()) return;
    const value = title.trim();
    setTitle('');
    onRun(() => addTemarioUnit({ subjectId, title: value }), `Añadida al final: ${value}`);
  };

  return (
    <div className="flex items-center gap-2 rounded-2xl border border-dashed border-white/10 bg-[#0c1322] p-3">
      <Plus className="h-4 w-4 text-slate-500" />
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && submit()}
        placeholder="Añadir una unidad al final del temario (p. ej. «U15 Formulación orgánica»)"
        className="flex-1 bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-600"
      />
      <button
        disabled={pending || !title.trim()}
        onClick={submit}
        className="flex items-center gap-1 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-[11px] font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/25 disabled:opacity-40"
      >
        <ChevronRight className="h-3.5 w-3.5" />
        Añadir
      </button>
    </div>
  );
}
