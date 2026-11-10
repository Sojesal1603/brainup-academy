'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlarmClock,
  ArrowLeft,
  ClipboardCheck,
  FileText,
  Loader2,
  Paperclip,
  Send,
  ShieldAlert,
  Timer,
  X,
} from 'lucide-react';
import MathText from './MathText';
import ExamResults from './ExamResults';
import type { ExamBlock, ExamGrade } from '@/lib/examenTypes';

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace('.', ',');
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function wordCount(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}

export default function PauExamRunner({
  sessionId,
  subjectName,
  timedMinutes,
  startedAtIso,
  blocks,
  source,
  model,
  initialAnswers,
}: {
  sessionId: string;
  subjectName: string;
  timedMinutes: number;
  startedAtIso: string;
  blocks: ExamBlock[];
  source: 'ai' | 'local';
  model?: string | null;
  initialAnswers: string[];
}) {
  const storageKey = `brainup-pau-${sessionId}`;
  const startedAt = useRef(new Date(startedAtIso).getTime());

  const [answers, setAnswers] = useState<string[]>(() =>
    blocks.map((_, index) =>
      typeof initialAnswers[index] === 'string' ? initialAnswers[index] : ''
    )
  );
  const [now, setNow] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [grade, setGrade] = useState<ExamGrade | null>(null);
  const [selfMode, setSelfMode] = useState<{ active: boolean; message: string }>({
    active: false,
    message: '',
  });
  const [selfScores, setSelfScores] = useState<number[]>(() => blocks.map(() => 0));
  const [notice, setNotice] = useState('');
  /** Resoluciones escaneadas: se suben aparte y viajan como ids al corregir. */
  const [uploadIds, setUploadIds] = useState<string[]>([]);
  const [uploadNames, setUploadNames] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoSubmitted = useRef(false);

  /* ---- Borrador local: la sesión se retoma aunque se recargue la página ---- */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { answers?: unknown };
      const restored = parsed.answers;
      if (Array.isArray(restored)) {
        setAnswers(
          blocks.map((_, index) =>
            typeof restored[index] === 'string' ? (restored[index] as string) : ''
          )
        );
      }
    } catch {
      // Borrador corrupto: empezamos de cero sin romper nada.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ answers }));
    } catch {
      // Sin espacio o sin permisos: seguimos sin guardado local.
    }
  }, [answers, storageKey]);

  /* ---- Cronómetro ---- */
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const totalSeconds = timedMinutes * 60;
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt.current) / 1000));
  const remainingSeconds = Math.max(0, totalSeconds - elapsedSeconds);
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  const progress = Math.min(100, (elapsedSeconds / totalSeconds) * 100);
  const timeTone =
    remainingSeconds <= 300
      ? { text: 'text-rose-400', bar: 'bg-rose-400', label: 'Últimos minutos: cierra y entrega' }
      : remainingSeconds <= 900
        ? { text: 'text-amber-400', bar: 'bg-amber-400', label: 'Queda menos de un cuarto de hora' }
        : { text: 'text-emerald-400', bar: 'bg-emerald-400', label: 'Ritmo correcto' };

  /* ---- Envío y corrección ---- */
  const submit = useCallback(
    async (extra?: { selfScores?: number[] }) => {
      if (submitting || grade) return;
      setSubmitting(true);
      setNotice('');

      try {
        const res = await fetch('/api/examinador/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            answers,
            elapsedMinutes,
            uploadIds,
            ...(extra ? { selfScores: extra.selfScores } : {}),
          }),
        });

        const data = (await res.json().catch(() => null)) as
          | { ok?: boolean; grade?: ExamGrade; mode?: string; message?: string; error?: string }
          | null;

        if (res.ok && data?.ok && data.grade) {
          setGrade(data.grade);
          try {
            localStorage.removeItem(storageKey);
          } catch {
            // Irrelevante: el resultado ya está guardado en SQLite.
          }
        } else if (data?.mode === 'self') {
          setSelfMode({
            active: true,
            message:
              data.message ||
              'La corrección automática no está disponible: completa la autoevaluación guiada.',
          });
        } else {
          setNotice(data?.error || 'No se pudo corregir el simulacro. Inténtalo de nuevo.');
        }
      } catch {
        setNotice('Error de red al enviar el simulacro. Comprueba tu conexión.');
      } finally {
        setSubmitting(false);
      }
    },
    [answers, elapsedMinutes, grade, sessionId, storageKey, submitting, uploadIds]
  );

  /* ---- Entrega automática al agotarse el tiempo ---- */
  useEffect(() => {
    if (remainingSeconds === 0 && !grade && !submitting && !autoSubmitted.current) {
      autoSubmitted.current = true;
      setNotice('⏰ Se agotó el tiempo oficial: el simulacro se entrega automáticamente.');
      void submit();
    }
  }, [remainingSeconds, grade, submitting, submit]);

  const answeredCount = answers.filter((a) => a.trim().length > 0).length;

  /** Sube una captura o PDF de la resolución y guarda su id para la corrección. */
  const uploadResolution = async (file: File) => {
    setUploading(true);
    setUploadError('');
    try {
      const res = await fetch('/api/tutor/attachments', {
        method: 'PUT',
        headers: {
          'x-file-name': encodeURIComponent(file.name),
          'x-file-type': encodeURIComponent(file.type || 'application/octet-stream'),
          'x-file-size': String(file.size),
        },
        body: file,
      });
      const data = (await res.json().catch(() => null)) as
        | { upload?: { id: string; name: string }; error?: string }
        | null;

      if (!res.ok || !data?.upload?.id) {
        throw new Error(data?.error || 'No se ha podido subir la resolución.');
      }

      setUploadIds((prev) => [...prev, data.upload!.id]);
      setUploadNames((prev) => ({ ...prev, [data.upload!.id]: data.upload!.name }));
    } catch (caught) {
      setUploadError(
        caught instanceof Error ? caught.message : 'No se ha podido subir la resolución.'
      );
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /* ---- Vista de resultados tras la corrección ---- */
  if (grade) {
    return (
      <ExamResults
        subjectName={subjectName}
        blocks={blocks}
        grade={grade}
        answers={answers}
        elapsedMinutes={elapsedMinutes}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Cabecera fija con cronómetro */}
      <div className="sticky top-0 z-20 -mx-1 px-1 py-2 bg-[#060a12]/95 backdrop-blur-md">
        <div className="p-4 rounded-2xl glass-card space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Link
                href="/examinador"
                className="w-8 h-8 rounded-lg bg-slate-800/80 border border-slate-700 flex items-center justify-center text-slate-300 hover:text-white transition-colors"
                title="Salir del simulacro"
              >
                <ArrowLeft className="w-4 h-4" />
              </Link>
              <div>
                <h2 className="text-sm font-black text-slate-100 uppercase font-mono tracking-tight">
                  Simulacro EBAU · {subjectName}
                </h2>
                <p className="text-[10px] text-slate-500">
                  {source === 'ai'
                    ? `Enunciados generados por IA${model ? ` (${model})` : ''}`
                    : 'Enunciados por plantilla local (IA no disponible)'}{' '}
                  · {blocks.length} bloques · {fmt(blocks.reduce((total, block) => total + block.points, 0))} puntos
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                  Respondidos
                </p>
                <p className="text-sm font-bold text-slate-200 font-mono">
                  {answeredCount}/{blocks.length}
                </p>
              </div>
              <div className={`flex items-center gap-2 ${timeTone.text}`}>
                <AlarmClock className="w-5 h-5" />
                <span className="text-2xl font-black font-mono tabular-nums">
                  {formatClock(remainingSeconds)}
                </span>
              </div>
            </div>
          </div>

          <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-1000 ${timeTone.bar}`}
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className={`text-[11px] ${timeTone.text}`}>{timeTone.label}</p>
        </div>
      </div>

      {/* Aviso de autoevaluación (solo si la corrección IA no está disponible) */}
      {selfMode.active && (
        <div className="p-4 rounded-xl bg-[#1a140d] border border-amber-500/40 space-y-1.5">
          <h3 className="text-xs font-bold uppercase tracking-wider text-amber-300 flex items-center gap-2">
            <ShieldAlert className="w-4 h-4" />
            <span>Autoevaluación guiada activada</span>
          </h3>
          <p className="text-xs text-amber-200/90 leading-relaxed">{selfMode.message}</p>
          <p className="text-[11px] text-amber-400/80">
            Rúbrica por bloque: rigor conceptual (40%), desarrollo justificado (30%), resultado (20%),
            notación y unidades (10%).
          </p>
        </div>
      )}

      {notice && (
        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
          {notice}
        </div>
      )}

      {/* Bloques del examen */}
      <div className="space-y-5">
        {blocks.map((block, index) => (
          <div key={index} className="p-5 rounded-2xl glass-card space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-xs font-bold text-emerald-400 font-mono">
                  {index + 1}
                </span>
                <div>
                  <p className="text-xs font-bold text-slate-200">{block.topicTitle}</p>
                  <p className="text-[10px] text-slate-500 uppercase tracking-wider">
                    {fmt(block.points)} puntos
                  </p>
                </div>
              </div>
              {selfMode.active && (
                <span className="text-xs font-mono text-amber-300">
                  {fmt(selfScores[index])} / {fmt(block.points)}
                </span>
              )}
            </div>

            <div className="text-sm text-slate-200 leading-relaxed">
              <MathText text={block.prompt} />
            </div>

            {selfMode.active ? (
              <div className="p-3 rounded-xl bg-[#080d18] border border-slate-800 space-y-2">
                <label className="text-[11px] text-slate-400 font-semibold">
                  ¿Cuánto crees que mereces en este bloque?
                </label>
                <input
                  type="range"
                  min={0}
                  max={block.points}
                  step={0.25}
                  value={selfScores[index]}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setSelfScores((prev) => prev.map((s, i) => (i === index ? value : s)));
                  }}
                  className="w-full accent-amber-400"
                />
              </div>
            ) : (
              <textarea
                value={answers[index]}
                onChange={(event) => {
                  const value = event.target.value;
                  setAnswers((prev) => prev.map((a, i) => (i === index ? value : a)));
                }}
                rows={6}
                placeholder="Escribe tu resolución completa: planteamiento, desarrollo paso a paso y resultado con unidades…"
                className="w-full rounded-xl bg-[#080d18] border border-slate-800 focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 outline-none text-xs text-slate-200 leading-relaxed p-3 resize-y"
              />
            )}

            {!selfMode.active && (
              <p className="text-[10px] text-slate-500 text-right font-mono">
                {wordCount(answers[index])} palabras
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Resolución adjunta: el corrector la lee y la cruza con los bloques */}
      <div className="p-4 rounded-2xl glass-card space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
            <Paperclip className="h-3.5 w-3.5 text-emerald-400" />
            Resolución adjunta (PDF o foto)
          </p>
          <span className="text-[10px] text-slate-500">{uploadIds.length}/4</span>
        </div>
        <p className="text-[10px] leading-relaxed text-slate-500">
          Si has hecho el examen en papel, súbelo aquí: el corrector lee el documento y lo cruza con
          los bloques. También puedes escribirlo arriba.
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void uploadResolution(file);
          }}
        />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || uploadIds.length >= 4 || selfMode.active}
          className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[10px] font-semibold text-slate-300 transition-colors hover:border-emerald-500/40 disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Paperclip className="h-3 w-3" />
          )}
          {uploading ? 'Subiendo…' : 'Adjuntar resolución'}
        </button>

        {uploadIds.length > 0 && (
          <ul className="space-y-1">
            {uploadIds.map((id) => (
              <li
                key={id}
                className="flex items-center justify-between gap-2 rounded border border-white/[0.06] bg-white/[0.02] px-2 py-1 text-[10px] text-slate-300"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <FileText className="h-3 w-3 shrink-0 text-emerald-400" />
                  <span className="truncate">{uploadNames[id] ?? 'resolución'}</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setUploadIds((prev) => prev.filter((value) => value !== id));
                    void fetch(`/api/tutor/attachments?id=${id}`, { method: 'DELETE' });
                  }}
                  className="text-slate-500 hover:text-rose-300"
                  title="Quitar"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {uploadError && <p className="text-[10px] text-rose-300">{uploadError}</p>}
      </div>

      {/* Acciones */}
      <div className="flex flex-col sm:flex-row gap-3 pb-4">
        {selfMode.active ? (
          <button
            type="button"
            onClick={() => void submit({ selfScores })}
            disabled={submitting}
            className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-xl bg-amber-400 hover:bg-amber-300 disabled:opacity-60 text-slate-950 text-sm font-black transition-all shadow-md"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <ClipboardCheck className="w-4 h-4 stroke-[2.5]" />
            )}
            <span>{submitting ? 'Guardando…' : 'Guardar autoevaluación y ver informe'}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 text-slate-950 text-sm font-black transition-all shadow-md"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4 stroke-[2.5]" />
            )}
            <span>{submitting ? 'Corrigiendo con rúbrica…' : 'Entregar y corregir'}</span>
          </button>
        )}

        <div className="flex items-center gap-2 px-4 py-3 glass-card rounded-2xl text-[11px] text-slate-400 sm:w-64">
          <Timer className="w-4 h-4 text-slate-500 shrink-0" />
          <span>
            Tu borrador se guarda en este navegador: si recargas, no pierdes lo escrito.
          </span>
        </div>
      </div>
    </div>
  );
}
