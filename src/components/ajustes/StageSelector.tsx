'use client';

import { useMemo, useState } from 'react';
import { setStudentStage } from '@/app/ajustes/courseActions';
import type { StageSummary } from '@/lib/stages';

interface StageSelectorProps {
  stages: readonly StageSummary[];
  current: {
    stage: string;
    gradeLevel: string;
    trackKey: string | null;
    degreeName: string | null;
    modality: string;
  };
}

/**
 * Selector de etapa educativa (ESO, Bachillerato, Universidad).
 *
 * Los niveles, modalidades y ramas salen del catálogo de `src/lib/stages`, así
 * que la interfaz no puede ofrecer una combinación que el servidor no entienda.
 * Al cambiar de etapa se elige el primer nivel y la primera rama válidos; el
 * servidor vuelve a normalizar todo de todas formas.
 */
export default function StageSelector({ stages, current }: StageSelectorProps) {
  const initialStage = stages.find((summary) => summary.stage === current.stage) ?? stages[0];
  const [stageKey, setStageKey] = useState(initialStage.stage);
  const active = stages.find((summary) => summary.stage === stageKey) ?? stages[0];
  const [gradeLevel, setGradeLevel] = useState(
    active.gradeLevels.some((level) => level.key === current.gradeLevel)
      ? current.gradeLevel
      : active.gradeLevels[0].key
  );
  const [trackKey, setTrackKey] = useState<string>(() => {
    if (active.tracks.length === 0) return '';
    return active.tracks.some((track) => track.key === current.trackKey)
      ? current.trackKey ?? ''
      : active.tracks[0].key;
  });
  const [degreeName, setDegreeName] = useState(current.degreeName ?? '');

  const track = useMemo(
    () => active.tracks.find((option) => option.key === trackKey) ?? null,
    [active, trackKey]
  );
  const scaleNote = active.hasPau
    ? 'Nota sobre 14 y ponderaciones PAU.'
    : active.supportsEcts
      ? 'Nota sobre 10, créditos ECTS y convocatorias.'
      : 'Nota sobre 10, sin PAU.';

  const changeStage = (next: string) => {
    const summary = stages.find((option) => option.stage === next) ?? stages[0];
    setStageKey(summary.stage);
    setGradeLevel(summary.gradeLevels[0].key);
    setTrackKey(summary.tracks[0]?.key ?? '');
    if (!summary.supportsEcts) setDegreeName('');
  };

  return (
    <form
      action={setStudentStage}
      className="space-y-3 border-t border-white/5 pt-4"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="text-xs text-slate-400">
          Etapa educativa
          <select
            name="stage"
            value={stageKey}
            onChange={(event) => changeStage(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-800 bg-[#080d18] px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-emerald-500/50"
          >
            {stages.map((summary) => (
              <option key={summary.stage} value={summary.stage}>
                {summary.label}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs text-slate-400">
          Curso
          <select
            name="gradeLevel"
            value={gradeLevel}
            onChange={(event) => setGradeLevel(event.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-800 bg-[#080d18] px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-emerald-500/50"
          >
            {active.gradeLevels.map((level) => (
              <option key={level.key} value={level.key}>
                {level.label}
              </option>
            ))}
          </select>
        </label>

        {active.tracks.length > 0 ? (
          <label className="text-xs text-slate-400">
            {active.supportsEcts ? 'Rama de conocimiento' : 'Modalidad'}
            <select
              name="trackKey"
              value={trackKey}
              onChange={(event) => setTrackKey(event.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-800 bg-[#080d18] px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-emerald-500/50"
            >
              {active.tracks.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="rounded-xl border border-slate-800 bg-[#080d18] px-3 py-2 text-xs text-slate-500">
            Sin modalidades en esta etapa.
          </div>
        )}
      </div>

      {active.supportsEcts ? (
        <label className="block text-xs text-slate-400">
          Titulación
          <input
            name="degreeName"
            value={degreeName}
            onChange={(event) => setDegreeName(event.target.value)}
            placeholder="Grado en Ingeniería Mecánica"
            maxLength={120}
            className="mt-1 w-full rounded-xl border border-slate-800 bg-[#080d18] px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-emerald-500/50"
          />
        </label>
      ) : null}

      <p className="text-[11px] leading-relaxed text-slate-500">
        {scaleNote}
        {track?.hint ? ` ${track.hint}` : ''}
        {active.supportsEcts
          ? ' Las materias troncales de la rama traen créditos ECTS orientativos; puedes añadir las de tu guía docente.'
          : ''}
        {' '}Cambiar de etapa o curso no borra temario, exámenes ni horas.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
        <span className="text-[10px] font-mono text-slate-500 sm:mr-auto">
          Guardado: {current.modality}
        </span>
        <button
          type="submit"
          className="shrink-0 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-xs font-bold text-emerald-200 transition-colors hover:bg-emerald-500/20"
        >
          Guardar etapa
        </button>
      </div>
    </form>
  );
}
