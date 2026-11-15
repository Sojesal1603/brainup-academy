'use client';

import { useState, useTransition } from 'react';
import { CheckCircle2, Loader2, Plus, Trash2, XCircle } from 'lucide-react';
import { closeSessionAction, type CloseSessionState } from '@/app/brainup/[agentId]/sessionActions';
import { ROOT_CAUSES, ROOT_CAUSE_LABELS } from '@/lib/sessionCloseTypes';

interface TopicOption {
  id: string;
  title: string;
}

interface ErrorRow {
  questionPrompt: string;
  myAnswer: string;
  correctAnswer: string;
  rootCause: (typeof ROOT_CAUSES)[number];
  keyLesson: string;
  correctiveAction: string;
}

function emptyError(): ErrorRow {
  return {
    questionPrompt: '',
    myAnswer: '',
    correctAnswer: '',
    rootCause: 'concepto',
    keyLesson: '',
    correctiveAction: '',
  };
}

/**
 * Cierre de sesión, confirmado por el alumno.
 *
 * No cierra sola: se abre, se revisa y se confirma. Lo que se escriba aquí es
 * exactamente lo que queda en el Banco de Errores y en las tarjetas; repetir el
 * cierre no duplica nada porque el servidor usa una clave por agente y día.
 */
export default function SessionClosePanel({ agentId, topics }: { agentId: string; topics: TopicOption[] }) {
  const [open, setOpen] = useState(false);
  const [topicId, setTopicId] = useState(topics[0]?.id ?? '');
  const [workedOn, setWorkedOn] = useState('');
  const [pending, setPending] = useState('');
  const [errors, setErrors] = useState<ErrorRow[]>([]);
  const [cards, setCards] = useState('');
  const [state, setState] = useState<CloseSessionState | null>(null);
  const [isPending, startTransition] = useTransition();

  if (topics.length === 0) return null;

  function submit() {
    if (!topicId) {
      setState({ ok: false, message: 'Elige el tema de la sesión.' });
      return;
    }

    const payload = {
      topicId,
      workedOn: workedOn
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      pending: pending
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      errors: errors
        .filter((row) => row.questionPrompt.trim() && row.correctAnswer.trim())
        .map((row) => ({
          questionPrompt: row.questionPrompt.trim(),
          myAnswer: row.myAnswer.trim(),
          correctAnswer: row.correctAnswer.trim(),
          rootCause: row.rootCause,
          keyLesson: row.keyLesson.trim() || 'Repasar el concepto hasta explicarlo sin apuntes.',
          correctiveAction:
            row.correctiveAction.trim() || 'Volver a hacer el ejercicio en dos días sin mirar.',
        })),
      cards: cards
        .split('\n')
        .map((line) => line.split('=>'))
        .filter((parts) => parts.length === 2 && parts[0].trim() && parts[1].trim())
        .map(([front, back]) => ({ front: front.trim(), back: back.trim(), kind: 'flashcard' as const })),
    };

    startTransition(async () => {
      const result = await closeSessionAction(agentId, payload);
      setState(result);
      if (result.ok) {
        setErrors([]);
        setCards('');
        setWorkedOn('');
        setPending('');
      }
    });
  }

  return (
    <div className="shrink-0 border-t border-white/5 bg-stone-950/60 px-3 py-2 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-stone-500">
          ¿Terminaste la sesión? Ciérrala para que los fallos entren en el Banco de Errores y las
          tarjetas en tu repaso.
        </p>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="shrink-0 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-500/20"
        >
          {open ? 'Cancelar' : 'Cerrar sesión'}
        </button>
      </div>

      {state && !open && (
        <p
          className={`mt-2 flex items-start gap-1.5 text-[11px] ${
            state.ok ? 'text-emerald-400' : 'text-rose-400'
          }`}
        >
          {state.ok ? <CheckCircle2 className="mt-0.5 h-3 w-3" /> : <XCircle className="mt-0.5 h-3 w-3" />}
          {state.message}
        </p>
      )}

      {open && (
        <div className="mt-3 space-y-3 rounded-xl border border-white/10 bg-stone-900/60 p-3">
          <label className="block text-[10px] font-mono uppercase tracking-widest text-stone-500">
            Tema trabajado
            <select
              value={topicId}
              onChange={(event) => setTopicId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-stone-950 px-2 py-1.5 text-xs font-sans normal-case tracking-normal text-stone-200"
            >
              {topics.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.title}
                </option>
              ))}
            </select>
          </label>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-[10px] font-mono uppercase tracking-widest text-stone-500">
              Qué hemos trabajado (una línea por cosa)
              <textarea
                value={workedOn}
                onChange={(event) => setWorkedOn(event.target.value)}
                rows={2}
                className="mt-1 w-full rounded-lg border border-white/10 bg-stone-950 px-2 py-1.5 text-xs font-sans normal-case tracking-normal text-stone-200"
              />
            </label>
            <label className="block text-[10px] font-mono uppercase tracking-widest text-stone-500">
              Qué queda pendiente
              <textarea
                value={pending}
                onChange={(event) => setPending(event.target.value)}
                rows={2}
                className="mt-1 w-full rounded-lg border border-white/10 bg-stone-950 px-2 py-1.5 text-xs font-sans normal-case tracking-normal text-stone-200"
              />
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-mono uppercase tracking-widest text-stone-500">
                Fallos de la sesión
              </p>
              <button
                type="button"
                onClick={() => setErrors((rows) => [...rows, emptyError()])}
                className="flex items-center gap-1 text-[10px] font-semibold text-stone-400 hover:text-emerald-300"
              >
                <Plus className="h-3 w-3" /> Añadir fallo
              </button>
            </div>

            {errors.length === 0 && (
              <p className="text-[10px] text-stone-600">
                Sin fallos apuntados no se crea ninguna ficha. Añade solo los que quieras volver a
                machacar.
              </p>
            )}

            {errors.map((row, index) => (
              <div key={index} className="space-y-1.5 rounded-lg border border-white/5 bg-stone-950/60 p-2">
                <div className="flex items-start gap-1.5">
                  <input
                    value={row.questionPrompt}
                    onChange={(event) =>
                      setErrors((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, questionPrompt: event.target.value } : r))
                      )
                    }
                    placeholder="Pregunta o enunciado"
                    className="w-full rounded border border-white/10 bg-stone-950 px-2 py-1 text-[11px] text-stone-200"
                  />
                  <button
                    type="button"
                    onClick={() => setErrors((rows) => rows.filter((_, i) => i !== index))}
                    className="shrink-0 p-1 text-stone-500 hover:text-rose-400"
                    aria-label="Quitar fallo"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  <input
                    value={row.myAnswer}
                    onChange={(event) =>
                      setErrors((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, myAnswer: event.target.value } : r))
                      )
                    }
                    placeholder="Lo que respondiste"
                    className="rounded border border-white/10 bg-stone-950 px-2 py-1 text-[11px] text-stone-200"
                  />
                  <input
                    value={row.correctAnswer}
                    onChange={(event) =>
                      setErrors((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, correctAnswer: event.target.value } : r))
                      )
                    }
                    placeholder="La respuesta correcta"
                    className="rounded border border-white/10 bg-stone-950 px-2 py-1 text-[11px] text-stone-200"
                  />
                </div>
                <div className="grid gap-1.5 sm:grid-cols-3">
                  <select
                    value={row.rootCause}
                    onChange={(event) =>
                      setErrors((rows) =>
                        rows.map((r, i) =>
                          i === index
                            ? { ...r, rootCause: event.target.value as ErrorRow['rootCause'] }
                            : r
                        )
                      )
                    }
                    className="rounded border border-white/10 bg-stone-950 px-2 py-1 text-[11px] text-stone-200"
                  >
                    {ROOT_CAUSES.map((cause) => (
                      <option key={cause} value={cause}>
                        {ROOT_CAUSE_LABELS[cause]}
                      </option>
                    ))}
                  </select>
                  <input
                    value={row.keyLesson}
                    onChange={(event) =>
                      setErrors((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, keyLesson: event.target.value } : r))
                      )
                    }
                    placeholder="Lección (opcional)"
                    className="rounded border border-white/10 bg-stone-950 px-2 py-1 text-[11px] text-stone-200"
                  />
                  <input
                    value={row.correctiveAction}
                    onChange={(event) =>
                      setErrors((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, correctiveAction: event.target.value } : r))
                      )
                    }
                    placeholder="Acción (opcional)"
                    className="rounded border border-white/10 bg-stone-950 px-2 py-1 text-[11px] text-stone-200"
                  />
                </div>
              </div>
            ))}
          </div>

          <label className="block text-[10px] font-mono uppercase tracking-widest text-stone-500">
            Tarjetas nuevas (una por línea: pregunta =&gt; respuesta)
            <textarea
              value={cards}
              onChange={(event) => setCards(event.target.value)}
              rows={2}
              placeholder="¿Qué es un espacio vectorial? => Un conjunto cerrado para suma y producto por escalar…"
              className="mt-1 w-full rounded-lg border border-white/10 bg-stone-950 px-2 py-1.5 text-xs font-sans normal-case tracking-normal text-stone-200"
            />
          </label>

          <div className="flex items-center justify-between gap-3">
            {state && (
              <p className={`text-[11px] ${state.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                {state.message}
              </p>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={isPending}
              className="ml-auto flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-[11px] font-bold text-stone-950 hover:bg-emerald-400 disabled:opacity-50"
            >
              {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
              {isPending ? 'Cerrando…' : 'Confirmar cierre'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
