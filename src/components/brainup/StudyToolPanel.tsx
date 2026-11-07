'use client';

import { useState, type ComponentType } from 'react';
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  FileText,
  Layers,
  ListChecks,
  Loader2,
  Network,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import MarkdownMessage from './MarkdownMessage';
import {
  STUDY_TOOL_META,
  type Flashcard,
  type QuizQuestion,
  type StudyToolKind,
  type StudyToolPayload,
} from '@/lib/studyTools';

const KIND_ORDER: StudyToolKind[] = ['flashcards', 'test', 'mapa', 'guia'];

const ICONS: Record<StudyToolKind, ComponentType<{ className?: string }>> = {
  flashcards: Layers,
  test: ListChecks,
  mapa: Network,
  guia: FileText,
};

const TOOL_TIMEOUT_MS = 120_000;

function FlashcardsView({ cards }: { cards: Flashcard[] }) {
  const [shown, setShown] = useState<Record<number, boolean>>({});

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {cards.map((card, index) => {
        const flipped = shown[index] === true;
        return (
          <button
            key={`${index}-${card.front.slice(0, 16)}`}
            type="button"
            onClick={() => setShown((prev) => ({ ...prev, [index]: !flipped }))}
            className={clsx(
              'rounded-lg border px-3 py-2.5 text-left transition-colors',
              flipped
                ? 'border-emerald-500/40 bg-emerald-500/[0.07]'
                : 'border-white/[0.07] bg-white/[0.02] hover:border-white/20'
            )}
          >
            <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-slate-500">
              {flipped ? 'Respuesta' : 'Pregunta'}
            </p>
            <p className="text-[12px] leading-relaxed text-slate-200">
              {flipped ? card.back : card.front}
            </p>
            {flipped && card.source && (
              <p className="mt-1.5 text-[10px] text-emerald-300/80">📌 {card.source}</p>
            )}
            <p className="mt-1.5 text-[9px] text-slate-600">
              {flipped ? 'Toca para volver a la pregunta' : 'Toca para ver la respuesta'}
            </p>
          </button>
        );
      })}
    </div>
  );
}

function QuizView({ questions }: { questions: QuizQuestion[] }) {
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const answered = Object.keys(answers).length;
  const score = questions.reduce(
    (total, question, index) => total + (answers[index] === question.correctIndex ? 1 : 0),
    0
  );

  return (
    <div className="space-y-3">
      {questions.map((question, index) => {
        const chosen = answers[index];
        return (
          <div
            key={`${index}-${question.question.slice(0, 20)}`}
            className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-3"
          >
            <p className="text-[12px] font-semibold text-slate-200">
              {index + 1}. {question.question}
            </p>
            <div className="mt-2 grid gap-1">
              {question.options.map((option, optionIndex) => {
                const isChosen = chosen === optionIndex;
                const isRight = submitted && optionIndex === question.correctIndex;
                const isWrong = submitted && isChosen && optionIndex !== question.correctIndex;
                return (
                  <button
                    key={optionIndex}
                    type="button"
                    disabled={submitted}
                    onClick={() =>
                      setAnswers((prev) => ({ ...prev, [index]: optionIndex }))
                    }
                    className={clsx(
                      'rounded-md border px-2.5 py-1.5 text-left text-[11px] transition-colors disabled:cursor-default',
                      isRight
                        ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200'
                        : isWrong
                          ? 'border-rose-500/50 bg-rose-500/10 text-rose-200'
                          : isChosen
                            ? 'border-emerald-400/40 bg-emerald-400/[0.06] text-slate-100'
                            : 'border-white/[0.06] text-slate-300 hover:border-white/20'
                    )}
                  >
                    <span className="mr-1.5 font-mono text-[10px] text-slate-500">
                      {String.fromCharCode(65 + optionIndex)}
                    </span>
                    {option}
                  </button>
                );
              })}
            </div>
            {submitted && (
              <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
                <span
                  className={
                    chosen === question.correctIndex ? 'text-emerald-300' : 'text-rose-300'
                  }
                >
                  {chosen === question.correctIndex
                    ? 'Correcta. '
                    : `Correcta: ${String.fromCharCode(65 + question.correctIndex)}. `}
                </span>
                {question.explanation}
                {question.source ? (
                  <span className="text-slate-500"> · {question.source}</span>
                ) : null}
              </p>
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        {submitted ? (
          <>
            <span className="font-mono text-[11px] text-emerald-300">
              {score}/{questions.length} correctas
            </span>
            <button
              type="button"
              onClick={() => {
                setAnswers({});
                setSubmitted(false);
              }}
              className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[10px] font-semibold text-slate-300 transition-colors hover:border-white/25"
            >
              <RotateCcw className="h-3 w-3" /> Repetir
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setSubmitted(true)}
            disabled={answered === 0}
            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-[10px] font-bold text-slate-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Corregir ({answered}/{questions.length})
          </button>
        )}
      </div>
    </div>
  );
}

function MindMapView({ mermaid, summary }: { mermaid: string; summary: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-2">
      <div className="relative">
        <pre className="max-h-72 overflow-auto whitespace-pre rounded-lg border border-white/[0.07] bg-[#05080f] p-3 font-mono text-[10.5px] leading-relaxed text-emerald-200/90">
          {mermaid}
        </pre>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(mermaid);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            } catch {
              // Sin permiso de portapapeles: se puede seleccionar el texto a mano.
            }
          }}
          className="absolute right-2 top-2 flex items-center gap-1 rounded-md border border-white/10 bg-[#0b0f17]/90 px-2 py-1 text-[9px] font-semibold text-slate-300 transition-colors hover:border-white/25"
        >
          {copied ? <Check className="h-3 w-3" /> : <ClipboardCopy className="h-3 w-3" />}
          {copied ? 'Copiado' : 'Copiar Mermaid'}
        </button>
      </div>
      {summary.length > 0 && <p className="text-[11px] text-slate-400">{summary}</p>}
    </div>
  );
}

/**
 * Panel de herramientas de estudio del chat.
 *
 * Genera el material a petición, con la unidad que el alumno está dando y el
 * foco de su último mensaje. No manda al alumno a otra pantalla ni le hace
 * perder el hilo de la conversación.
 */
export default function StudyToolPanel({
  agentId,
  subjectColor,
  focus,
}: {
  agentId: string;
  subjectColor: string;
  focus: string;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<StudyToolKind | null>(null);
  const [loading, setLoading] = useState(false);
  const [tool, setTool] = useState<StudyToolPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const generate = async (nextKind: StudyToolKind) => {
    if (loading) return;
    setOpen(true);
    setKind(nextKind);
    setLoading(true);
    setTool(null);
    setError(null);

    try {
      const res = await fetch('/api/tutor/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
        body: JSON.stringify({ agentId, kind: nextKind, focus }),
      });
      const data = (await res.json().catch(() => null)) as
        | { tool?: StudyToolPayload; error?: string }
        | null;

      if (!res.ok) {
        throw new Error(data?.error || 'No se ha podido generar la herramienta.');
      }
      if (!data?.tool) {
        throw new Error('El catedrático ha devuelto el material vacío. Vuelve a pedirlo.');
      }

      setTool(data.tool);
      setGeneration((value) => value + 1);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'No se ha podido generar la herramienta.'
      );
    } finally {
      setLoading(false);
    }
  };

  const close = () => {
    setOpen(false);
    setTool(null);
    setError(null);
    setKind(null);
  };

  return (
    <div className="shrink-0 border-t border-white/[0.06] px-4 pt-2 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.16em] text-stone-500">
            <Sparkles className="h-3 w-3" /> Herramientas
          </span>

          {KIND_ORDER.map((id) => {
            const Icon = ICONS[id];
            const active = open && kind === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => void generate(id)}
                disabled={loading}
                aria-pressed={active}
                title={STUDY_TOOL_META[id].description}
                className={clsx(
                  'flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  active
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                    : 'border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200'
                )}
                style={active ? { color: subjectColor } : undefined}
              >
                {loading && kind === id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Icon className="h-3 w-3" />
                )}
                {STUDY_TOOL_META[id].short}
              </button>
            );
          })}

          {open && (
            <button
              type="button"
              onClick={close}
              title="Cerrar las herramientas"
              className="ml-auto rounded-lg border border-white/10 p-1 text-slate-500 transition-colors hover:border-white/25 hover:text-slate-200"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {open && (
          <div className="mb-2 mt-2 max-h-[46vh] overflow-y-auto rounded-xl border border-white/[0.08] bg-[#080d17] p-3">
            {loading && (
              <div className="flex items-center gap-2 py-6 text-[11px] text-slate-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                El catedrático fabrica el material de tu unidad actual…
              </div>
            )}

            {!loading && error && (
              <p className="flex items-start gap-2 py-2 text-[11px] leading-relaxed text-rose-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {error}
              </p>
            )}

            {!loading && tool && (
              <div className="space-y-3">
                <div>
                  <p className="text-[12px] font-bold text-slate-100">{tool.title}</p>
                  <p className="text-[10px] text-slate-500">
                    {tool.notice ?? STUDY_TOOL_META[tool.kind].description}
                  </p>
                </div>

                {tool.kind === 'flashcards' && (
                  <FlashcardsView key={`f-${generation}`} cards={tool.cards} />
                )}
                {tool.kind === 'test' && (
                  <QuizView key={`t-${generation}`} questions={tool.questions} />
                )}
                {tool.kind === 'mapa' && (
                  <MindMapView mermaid={tool.mermaid} summary={tool.summary} />
                )}
                {tool.kind === 'guia' && (
                  <div className="text-[13px] leading-7 text-stone-200/90">
                    <MarkdownMessage content={tool.markdown} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
