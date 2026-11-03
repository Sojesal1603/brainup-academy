'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, ListChecks, Loader2, Pencil, Sparkles, X } from 'lucide-react';
import clsx from 'clsx';
import Link from 'next/link';
import { markTopicSeenInClass, registrarAvanceDeClase, saveClassMethod } from '@/lib/actions';
import type { CheckInItem } from '@/lib/temario';

interface ClassCheckInProps {
  items: CheckInItem[];
}

interface DoneState {
  marked: string;
  /** Id de la unidad marcada: es la que recibe la nota del método del profesor. */
  markedId: string;
  next: string | null;
}

/** Fecha local en formato YYYY-MM-DD (la clave del descarte diario). */
function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
}

function unitLabel(item: { unitNumber: number | null; title: string }): string {
  return `${item.unitNumber ? `U${item.unitNumber} · ` : ''}${item.title}`;
}

/**
 * Chequeo de clase: al llegar a casa, un clic por asignatura para anotar lo que
 * se ha explicado. Es lo que mantiene el temario vivo y lo que hace que el
 * planificador de la tarde priorice lo que de verdad toca.
 */
export default function ClassCheckIn({ items }: ClassCheckInProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<Record<string, DoneState>>({});
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [picking, setPicking] = useState<string | null>(null);
  const [busySubject, setBusySubject] = useState<string | null>(null);
  /** Lo que el alumno cuenta de cómo lo explicó el profesor, por asignatura. */
  const [methodDraft, setMethodDraft] = useState<Record<string, string>>({});
  const [methodSaved, setMethodSaved] = useState<Record<string, boolean>>({});
  const [methodBusy, setMethodBusy] = useState<string | null>(null);
  /** La frase con la que cuenta lo que se ha dado hoy, por asignatura. */
  const [answerDraft, setAnswerDraft] = useState<Record<string, string>>({});
  const [answerBusy, setAnswerBusy] = useState<string | null>(null);
  const [answerError, setAnswerError] = useState<Record<string, string>>({});
  const [answerResult, setAnswerResult] = useState<
    Record<string, { cambios: string[]; headline: string | null }>
  >({});
  /** Asignatura con la caja de texto abierta (solo una a la vez). */
  const [composing, setComposing] = useState<string | null>(null);

  const storageKey = `brainup:checkin:${todayKey()}`;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) setDismissed(JSON.parse(raw) as string[]);
    } catch {
      // Sin localStorage (modo privado estricto): el descarte dura solo la sesión.
    }
  }, [storageKey]);

  const dismiss = (subjectId: string) => {
    const next = [...dismissed, subjectId];
    setDismissed(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* ignorado */
    }
  };

  const mark = (subjectId: string, topicId: string) => {
    setBusySubject(subjectId);
    startTransition(async () => {
      const result = await markTopicSeenInClass(topicId);
      setBusySubject(null);
      setPicking(null);
      if (result.success && result.marked) {
        setDone((prev) => ({
          ...prev,
          [subjectId]: {
            marked: unitLabel(result.marked!),
            markedId: topicId,
            next: result.next ? unitLabel(result.next) : null,
          },
        }));
        router.refresh();
      }
    });
  };

  /**
   * Guarda cómo lo explicó el profesor en la unidad que se acaba de marcar.
   *
   * Es opcional, pero es lo que hace que los apuntes del catedrático sean los de
   * SU clase: su notación, sus pasos y sus convenios de corrección.
   */
  const saveMethod = (subjectId: string, topicId: string) => {
    const text = (methodDraft[subjectId] ?? '').trim();
    if (text.length === 0 || !topicId) return;

    setMethodBusy(subjectId);
    startTransition(async () => {
      const result = await saveClassMethod(topicId, text);
      setMethodBusy(null);
      if (result.success && result.saved) {
        setMethodSaved((prev) => ({ ...prev, [subjectId]: true }));
      }
    });
  };

  /**
   * Frase libre sobre lo que se ha dado hoy. La IA la traduce a unidades del
   * temario, se guarda el avance y la tarde se rehace con lo de hoy arriba:
   * el planificador deja de ser un bloque rígido y se adapta a la clase real.
   */
  const sendAnswer = (subjectId: string) => {
    const text = (answerDraft[subjectId] ?? '').trim();
    if (text.length < 2) return;

    setAnswerBusy(subjectId);
    setAnswerError((prev) => ({ ...prev, [subjectId]: '' }));

    startTransition(async () => {
      const result = await registrarAvanceDeClase(subjectId, text);
      setAnswerBusy(null);

      if (!result.success) {
        setAnswerError((prev) => ({
          ...prev,
          [subjectId]: result.error ?? 'No se pudo anotar el avance.',
        }));
        return;
      }

      setAnswerResult((prev) => ({
        ...prev,
        [subjectId]: { cambios: result.cambios, headline: result.plan?.headline ?? null },
      }));
      setAnswerDraft((prev) => ({ ...prev, [subjectId]: '' }));
      setComposing(null);
      router.refresh();
    });
  };

  const visible = items.filter((item) => !dismissed.includes(item.subjectId));

  if (items.length === 0 || visible.length === 0) {
    return null;
  }

  const answered = visible.filter(
    (item) => done[item.subjectId] || item.markedToday
  ).length;

  return (
    <div className="rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-950/25 to-[#131825] p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/15">
            <ListChecks className="h-4 w-4 text-emerald-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-100">Chequeo de clase de hoy</h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Un clic o una frase por asignatura y el temario queda al día: lo dado hoy sube a lo
              primero del plan de esta tarde.
            </p>
          </div>
        </div>
        <span className="shrink-0 font-mono text-[11px] font-semibold text-emerald-400">
          {answered}/{visible.length}
        </span>
      </div>

      <div className="space-y-2">
        {visible.map((item) => {
          const state = done[item.subjectId];
          const alreadyMarked = item.markedToday;
          const isDone = Boolean(state) || Boolean(alreadyMarked);
          const isBusy = pending && busySubject === item.subjectId;
          /**
           * Lo que ya tenía anotado de cómo lo explicó el profesor. Se enseña en
           * el mismo renglón para poder leerlo y afinarlo: al llegar a casa uno se
           * acuerda de dos detalles más al ver lo de ayer, no al revés.
           */
          const existingMethod = alreadyMarked?.teacherMethod?.trim() ?? '';
          const methodValue = methodDraft[item.subjectId] ?? existingMethod;

          return (
            <div
              key={item.subjectId}
              className="rounded-xl border border-white/10 bg-[#0a0a0c] p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="text-xs font-semibold text-slate-200">{item.subjectName}</span>
                  <span className="font-mono text-[10px] text-slate-500">
                    {item.startTime}–{item.endTime}
                  </span>
                </div>
                <Link
                  href="/temario"
                  className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300"
                >
                  Ver temario
                </Link>
              </div>

              {/* El avance real, contado por él: la IA lo traduce a unidades. */}
              {answerResult[item.subjectId] ? (
                <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-[11px] text-emerald-200">
                  <p className="flex items-start gap-1.5">
                    <Check className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{answerResult[item.subjectId].cambios.join(' · ')}</span>
                  </p>
                  {answerResult[item.subjectId].headline && (
                    <p className="mt-1 text-[10px] text-slate-300">
                      {answerResult[item.subjectId].headline}
                    </p>
                  )}
                  <button
                    onClick={() => {
                      setAnswerResult((prev) => {
                        const next = { ...prev };
                        delete next[item.subjectId];
                        return next;
                      });
                      setComposing(item.subjectId);
                    }}
                    className="mt-1 text-[10px] font-semibold text-emerald-300 hover:text-emerald-200"
                  >
                    Corregir
                  </button>
                </div>
              ) : composing === item.subjectId ? (
                <div className="mt-2 space-y-1.5">
                  <textarea
                    value={answerDraft[item.subjectId] ?? ''}
                    onChange={(e) =>
                      setAnswerDraft((prev) => ({ ...prev, [item.subjectId]: e.target.value }))
                    }
                    rows={2}
                    maxLength={600}
                    autoFocus
                    placeholder="Ej.: «hemos empezado la U5, pero solo el primer apartado»"
                    className="w-full resize-none rounded-lg border border-white/10 bg-[#0c1322] px-2.5 py-1.5 text-[11px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-500/50"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      disabled={
                        answerBusy === item.subjectId ||
                        (answerDraft[item.subjectId] ?? '').trim().length < 2
                      }
                      onClick={() => sendAnswer(item.subjectId)}
                      className="flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-bold text-slate-950 transition-all hover:bg-emerald-400 disabled:opacity-40"
                    >
                      {answerBusy === item.subjectId ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Sparkles className="h-3 w-3" />
                      )}
                      {answerBusy === item.subjectId ? 'Leyéndolo…' : 'Anotar y reajustar'}
                    </button>
                    <button
                      onClick={() => setComposing(null)}
                      className="text-[10px] text-slate-500 hover:text-slate-300"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setComposing(item.subjectId)}
                  className="mt-2 flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-slate-300 transition-colors hover:border-emerald-500/40 hover:text-emerald-300"
                >
                  <Sparkles className="h-3 w-3" />
                  ¿Por dónde vais hoy? Cuéntamelo
                </button>
              )}

              {answerError[item.subjectId] && (
                <p className="mt-1.5 text-[10px] text-rose-300">{answerError[item.subjectId]}</p>
              )}

              {isDone ? (
                <div className="mt-2 flex items-start gap-2 text-[11px] text-emerald-300">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div>
                    <p>
                      Anotado:{' '}
                      <span className="font-semibold">
                        {state?.marked ?? (alreadyMarked ? unitLabel(alreadyMarked) : '')}
                      </span>
                    </p>
                    {(state?.next ?? null) && (
                      <p className="text-slate-400">
                        La próxima será: <span className="text-slate-300">{state?.next}</span>
                      </p>
                    )}
                    <button
                      onClick={() => setPicking(picking === item.subjectId ? null : item.subjectId)}
                      className="mt-1 flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-200"
                    >
                      <Pencil className="h-3 w-3" />
                      He visto otra unidad
                    </button>

                    {/*
                      * CÓMO LO EXPLICÓ EL PROFESOR.
                      *
                      * Un renglón escrito al llegar a casa, mientras se acuerda.
                      * El catedrático lo recibe al escribir los apuntes de esa
                      * unidad, así que el apunte sale con la notación y los pasos
                      * de su profesor en vez de con los de un temario genérico.
                      */}
                    {methodSaved[item.subjectId] ? (
                      <p className="mt-1.5 flex items-center gap-1 text-[10px] text-emerald-300">
                        <Check className="h-3 w-3" />
                        Anotado: los apuntes de esa unidad seguirán el método de tu profesor.
                      </p>
                    ) : (
                      <div className="mt-2 space-y-1.5">
                        <label className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                          ¿Cómo lo explicó el profesor? (opcional)
                        </label>
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            value={methodValue}
                            onChange={(e) =>
                              setMethodDraft((prev) => ({ ...prev, [item.subjectId]: e.target.value }))
                            }
                            maxLength={600}
                            placeholder="Ej.: exige la fórmula antes de sustituir; usa vectores con flecha; el ejemplo del ascensor"
                            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#0c1322] px-2.5 py-1.5 text-[11px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-500/50"
                          />
                          <button
                            disabled={
                              methodBusy === item.subjectId ||
                              methodValue.trim().length === 0 ||
                              // Sin cambios no se escribe nada: guardar dos veces lo
                              // mismo solo ensucia el historial de la unidad.
                              methodValue.trim() === existingMethod.trim()
                            }
                            onClick={() =>
                              saveMethod(item.subjectId, state?.markedId ?? item.markedToday?.id ?? '')
                            }
                            className="flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[10px] font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-40"
                          >
                            {methodBusy === item.subjectId ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Check className="h-3 w-3" />
                            )}
                            Guardar
                          </button>
                        </div>
                        <p className="text-[10px] text-slate-500">
                          {existingMethod.length > 0
                            ? 'Ya lo tenías anotado: puedes afinarlo. '
                            : ''}
                          El catedrático lo usará al escribirte los apuntes de esa unidad.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              ) : item.suggested ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <p className="text-[11px] text-slate-300">
                    ¿Hemos visto{' '}
                    <span className="font-semibold text-slate-100">{unitLabel(item.suggested)}</span>?
                  </p>
                  <button
                    disabled={isBusy}
                    onClick={() => mark(item.subjectId, item.suggested!.id)}
                    className="flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-bold text-slate-950 transition-all hover:bg-emerald-400 disabled:opacity-50"
                  >
                    {isBusy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="h-3 w-3 stroke-[3]" />
                    )}
                    Sí, eso es
                  </button>
                  <button
                    onClick={() => setPicking(picking === item.subjectId ? null : item.subjectId)}
                    className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-slate-600"
                  >
                    <ChevronDown className="h-3 w-3" />
                    Otra unidad
                  </button>
                  <button
                    onClick={() => dismiss(item.subjectId)}
                    className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300"
                    title="Ese día no se dio temario en esa asignatura"
                  >
                    <X className="h-3 w-3" />
                    No hubo temario
                  </button>
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-slate-400">
                  No me queda ninguna unidad por dar en esta asignatura: temario cerrado.
                </p>
              )}

              {picking === item.subjectId && (
                <div className="mt-2 max-h-52 space-y-1 overflow-y-auto rounded-lg border border-white/10 bg-[#0c1322] p-2">
                  {item.candidates.map((candidate) => (
                    <button
                      key={candidate.id}
                      disabled={pending}
                      onClick={() => mark(item.subjectId, candidate.id)}
                      className={clsx(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-[#1e293b]',
                        candidate.status === 'en_curso' && 'text-amber-300'
                      )}
                    >
                      <span className="w-7 shrink-0 font-mono text-[10px] text-slate-500">
                        {candidate.unitNumber ?? '—'}
                      </span>
                      <span className="text-slate-200">{candidate.title}</span>
                      {candidate.status === 'en_curso' && (
                        <span className="ml-auto text-[9px] uppercase tracking-wider text-amber-400">
                          en curso
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {answered === visible.length && (
        <p className="text-[11px] font-medium text-emerald-300">
          Chequeo completado. El planificador de esta tarde ya está ajustado a lo que has dado hoy.
        </p>
      )}
    </div>
  );
}
