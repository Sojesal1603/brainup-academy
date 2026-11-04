'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ClipboardList,
  Loader2,
  RotateCcw,
  Send,
  Sparkles,
  User,
} from 'lucide-react';
import clsx from 'clsx';
import MarkdownMessage from '@/components/brainup/MarkdownMessage';
import { type ChecklistItem, type SetupChecklist, type SetupSnapshot } from '@/lib/setup';
import {
  clearSetupConversation,
  finishSetup,
  reopenSetupConversation,
} from '@/lib/setupActions';

export interface SetupMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Lo que esa respuesta dejó anotado en el sistema. */
  applied?: string[];
  problems?: string[];
}

interface SetupChatProps {
  conversationId: string | null;
  initialMessages: SetupMessage[];
  initialChecklist: SetupChecklist;
  initialSnapshot: SetupSnapshot;
  modelLabel: string;
}

interface ApiResponse {
  conversationId: string;
  changed: boolean;
  blocks: number;
  applied: string[];
  problems: string[];
  checklist: SetupChecklist;
  snapshot: SetupSnapshot;
  reply: { id: string; content: string; createdAt: string };
  error?: string;
}

/**
 * Tope de espera de un turno en el cliente.
 *
 * El servidor contesta en segundos (y en Netlify se rinde a los 8 s para no morir
 * con la función), así que a los 60 s lo que hay delante ya no es un turno lento:
 * es un cuelgue, y el alumno tiene que saberlo en vez de mirar el spinner.
 */
const TURN_TIMEOUT_MS = 60_000;

/** La respuesta del servidor es la que espera el componente (campos obligatorios). */
function isSetupResponse(data: unknown): data is ApiResponse {
  const value = data as ApiResponse | null;
  return Boolean(
    value &&
      value.reply &&
      typeof value.reply.content === 'string' &&
      value.checklist &&
      value.snapshot
  );
}

/** Qué atajos tienen sentido según lo que toca preguntar ahora. */
function quickReplies(checklist: SetupChecklist): string[] {
  switch (checklist.nextQuestion.about) {
    case 'horas':
      return ['Puedo estudiar 2 h al día', 'Tres horas diarias y el finde más', 'Menos de lo que me gustaría'];
    case 'horario':
      return [
        'Te dicto el horario completo',
        'Tengo clase de 8:15 a 14:15',
        'Hay materias que no estudio (Religión, Ed. Física…)',
      ];
    case 'temario':
      return [
        'Te dicto la lista ahora',
        'No tengo el índice a mano todavía',
        'Propónmelo tú y yo te corrijo',
      ];
    case 'examenes':
      return ['Te doy las fechas ahora', 'Todavía no sé las fechas', 'El más cercano es importante'];
    default:
      return ['Vamos a cerrar la puesta a punto', 'Antes quiero cambiar algo'];
  }
}

export default function SetupChat({
  conversationId,
  initialMessages,
  initialChecklist,
  initialSnapshot,
  modelLabel,
}: SetupChatProps) {
  const router = useRouter();
  const [messages, setMessages] = useState<SetupMessage[]>(initialMessages);
  const [checklist, setChecklist] = useState<SetupChecklist>(initialChecklist);
  const [snapshot, setSnapshot] = useState<SetupSnapshot>(initialSnapshot);
  const [conversation, setConversation] = useState<string | null>(conversationId);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [pending, startTransition] = useTransition();
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, isSending]);

  const hasMessages = messages.length > 0;
  const missing = useMemo(() => checklist.pending.map((subject) => subject.name), [checklist]);
  const finished = Boolean(snapshot.setupCompletedAt);

  const opening = useMemo(() => {
    const lines: string[] = [
      'Soy tu **Coordinador de puesta a punto**. No doy clase: dejo tu curso montado.',
      'Vamos a ir por partes: primero tus horas reales, después el **horario completo de clases** (todas las materias, también las que no estudias), luego el **temario entero** materia por materia y al final las fechas de examen. Yo lo anoto todo según me lo cuentas y tú ves el progreso a la derecha.',
      'Sin el horario y el temario completo el plan saldría a ciegas, así que insiste: prefiero preguntarte dos veces a darte un plan que no es el tuyo.',
    ];
    if (missing.length > 0) {
      lines.push(`Ahora mismo te falta por montar: **${missing.join(', ')}**.`);
    } else {
      lines.push('Temario y exámenes están puestos: podemos cerrar la puesta a punto cuando quieras.');
    }
    lines.push(
      'Si se me pasa algo o me equivoco, dímelo en cualquier momento («recuérdame que…», «esa unidad ya no va») y lo corrijo en el momento.'
    );
    return lines.join('\n\n');
  }, [missing]);

  const send = async (text: string) => {
    const clean = text.trim();
    if (!clean || isSending) return;

    setError(null);
    setInput('');
    const userMessage: SetupMessage = { id: `local-user-${Date.now()}`, role: 'user', content: clean };
    setMessages((previous) => [...previous, userMessage]);
    setIsSending(true);

    // El turno puede quedarse sin respuesta (Netlify corta la función, se cae la
    // red). Con este tope se deja de esperar y se dice qué pasa, en vez de dejar
    // el chat girando para siempre.
    const controller = new AbortController();
    const stop = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);

    try {
      const response = await fetch('/api/puesta-a-punto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: clean, conversationId: conversation }),
        signal: controller.signal,
      });

      // Se lee como texto y se intenta parsear: si el servidor muere a medias
      // (cuerpo vacío o HTML de error), `response.json()` lanzaba «Unexpected end
      // of JSON input», un error en inglés que al alumno no le dice nada.
      const raw = await response.text();
      let data: unknown = null;
      try {
        data = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        data = null;
      }

      const failure = (data as { error?: string } | null)?.error;
      if (!response.ok || failure || !isSetupResponse(data)) {
        throw new Error(
          failure ??
            (response.status === 502 || response.status === 504
              ? 'El servidor ha cortado la respuesta por tardar demasiado. Vuelve a enviarlo: este turno no se ha guardado.'
              : `El coordinador no ha podido responder (HTTP ${response.status}). Vuelve a intentarlo.`)
        );
      }

      setConversation(data.conversationId);
      setChecklist(data.checklist);
      setSnapshot(data.snapshot);
      setMessages((previous) => [
        ...previous,
        {
          id: data.reply.id,
          role: 'assistant',
          content: data.reply.content,
          applied: data.applied,
          problems: data.problems,
        },
      ]);
      if (data.changed) router.refresh();
    } catch (caught) {
      // Nada de este turno se ha guardado: se retira la burbuja optimista y el
      // texto vuelve al cuadro para poder reenviarlo tal cual (antes el mensaje
      // se perdía y había que volver a escribirlo).
      setMessages((previous) => previous.filter((message) => message.id !== userMessage.id));
      setInput(clean);
      const failed = caught as Error;
      setError(
        failed.name === 'AbortError'
          ? `El coordinador ha tardado más de ${Math.round(TURN_TIMEOUT_MS / 1000)} s y he dejado de esperar. Vuelve a enviarlo: no se ha guardado nada.`
          : failed.message
      );
    } finally {
      clearTimeout(stop);
      setIsSending(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      {/* Chat */}
      <section className="flex flex-col rounded-2xl border border-white/10 bg-[#0c1322]">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
              <ClipboardList className="h-4 w-4" />
            </div>
            <div>
              <div className="text-sm font-bold text-slate-100">Puesta a punto</div>
              <div className="font-mono text-[10px] text-slate-500">
                {modelLabel} · {checklist.percent}% montado
              </div>
            </div>
          </div>

          {finished && (
            <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
              cerrada el {snapshot.setupCompletedAt} · se puede reabrir
            </span>
          )}
        </header>

        <div className="flex max-h-[58vh] min-h-[380px] flex-1 flex-col space-y-4 overflow-y-auto px-4 py-4">
          {!hasMessages && (
            <div className="flex gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <div className="space-y-2 rounded-2xl rounded-tl-md glass-card px-4 py-3">
                  <MarkdownMessage content={opening} />
                </div>
                <div className="grid gap-2">
                  {['Vamos allá', 'Empecemos por mi temario', 'Dime tú por dónde'].map((starter) => (
                    <button
                      key={starter}
                      disabled={isSending}
                      onClick={() => send(starter)}
                      className="group flex items-center justify-between gap-3 rounded-xl glass-card px-3.5 py-2.5 text-left text-xs text-slate-300 transition-colors hover:border-emerald-500/40 hover:bg-[#111a2e] disabled:opacity-50"
                    >
                      <span className="font-semibold text-slate-200">{starter}</span>
                      <ArrowRight className="h-3 w-3 text-slate-500 group-hover:text-emerald-400" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {messages.map((message) => {
            const isUser = message.role === 'user';
            return (
              <div key={message.id} className={clsx('flex gap-3', isUser && 'justify-end')}>
                {!isUser && (
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
                    <Sparkles className="h-4 w-4" />
                  </div>
                )}

                <div className={clsx('min-w-0 space-y-1.5', isUser ? 'max-w-[85%]' : 'max-w-[88%] flex-1')}>
                  {isUser ? (
                    <div className="rounded-2xl rounded-br-md bg-emerald-500/90 px-4 py-2.5">
                      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-950">
                        {message.content}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2 rounded-2xl rounded-tl-md glass-card px-4 py-3">
                      <MarkdownMessage content={message.content} />
                    </div>
                  )}

                  {(message.applied?.length ?? 0) > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {message.applied!.map((item, index) => (
                        <span
                          key={`${item}-${index}`}
                          className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
                        >
                          <Check className="h-2.5 w-2.5" />
                          {item}
                        </span>
                      ))}
                    </div>
                  )}

                  {(message.problems?.length ?? 0) > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {message.problems!.map((item, index) => (
                        <span
                          key={`${item}-${index}`}
                          className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
                        >
                          <AlertTriangle className="h-2.5 w-2.5" />
                          {item}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {isUser && (
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-800 text-slate-400">
                    <User className="h-4 w-4" />
                  </div>
                )}
              </div>
            );
          })}

          {isSending && (
            <div className="flex items-center gap-2 text-[11px] text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" />
              anotando y contestando…
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Atajos contextuales */}
        <div className="space-y-2 border-t border-white/10 px-4 py-3">
          <div className="flex flex-wrap gap-1.5">
            {quickReplies(checklist).map((reply) => (
              <button
                key={reply}
                disabled={isSending}
                onClick={() => send(reply)}
                className="rounded-lg border border-white/10 bg-[#0a0a0c] px-2.5 py-1.5 text-[11px] text-slate-300 transition-colors hover:border-emerald-500/40 hover:text-emerald-300 disabled:opacity-40"
              >
                {reply}
              </button>
            ))}
            <button
              disabled={isSending}
              onClick={() => setInput('Recuérdame que ')}
              className="rounded-lg border border-dashed border-white/10 px-2.5 py-1.5 text-[11px] text-slate-400 transition-colors hover:border-amber-500/40 hover:text-amber-300 disabled:opacity-40"
            >
              Recuérdame algo
            </button>
          </div>

          <div className="flex items-end gap-2">
            <textarea
              value={input}
              rows={2}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send(input);
                }
              }}
              placeholder="Contéstale aquí: una cosa por turno. Si algo no cuadra, díselo."
              className="flex-1 resize-none rounded-xl border border-white/10 bg-[#0a0a0c] px-3 py-2 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-500/40"
            />
            <button
              disabled={isSending || input.trim().length === 0}
              onClick={() => void send(input)}
              className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-3.5 py-2.5 text-xs font-bold text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
              Enviar
            </button>
          </div>
        </div>
      </section>

      {/* Panel de progreso */}
      <aside className="space-y-3">
        <div className="rounded-2xl border border-white/10 bg-[#0c1322] p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] uppercase tracking-widest text-slate-500">Estado real</span>
            <span className="font-mono text-lg font-bold text-emerald-300">{checklist.percent}%</span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#1e293b]">
            <div className="h-full rounded-full bg-emerald-400" style={{ width: `${checklist.percent}%` }} />
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            {checklist.doneItems}/{checklist.totalItems} datos puestos. Ahora toca:{' '}
            <span className="text-slate-200">{checklist.nextQuestion.prompt}</span>.
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#0c1322] p-4">
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Por materia</div>
          <ul className="mt-2 space-y-2">
            {checklist.subjects.map((subject) => (
              <li key={subject.id} className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[11px] font-medium text-slate-200">
                    {subject.name}
                    {subject.units > 0 && !subject.syllabusComplete && (
                      <span className="ml-1 text-[10px] text-amber-300">({subject.units} uds.)</span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {subject.items.map((item) => (
                      <CheckItem key={item.key} item={item} />
                    ))}
                  </div>
                </div>
                {subject.done && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />}
              </li>
            ))}
          </ul>

          {checklist.untracked.length > 0 && (
            <div className="mt-3 border-t border-white/10 pt-3">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">
                Solo en el horario
              </div>
              <p className="mt-1 text-[10px] text-slate-500">
                Ocupan horas de clase pero no se estudian: no se les pide temario ni exámenes.
              </p>
              <ul className="mt-1.5 flex flex-wrap gap-1">
                {checklist.untracked.map((subject) => (
                  <li
                    key={subject.id}
                    className="rounded border border-white/10 bg-[#0a0a0c] px-1.5 py-0.5 text-[10px] text-slate-400"
                  >
                    {subject.name}
                    {subject.classCount > 0 ? ` · ${subject.classCount} clases` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-3 border-t border-white/10 pt-3">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">General</div>
            <ul className="mt-2 space-y-1.5">
              {checklist.general.map((item) => (
                <li key={item.key} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-slate-300">{item.label}</span>
                  <span className={item.done ? 'text-emerald-300' : 'text-amber-300'}>{item.hint}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  if (finished) await reopenSetupConversation();
                  else await finishSetup();
                  router.refresh();
                })
              }
              className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-slate-300 transition-colors hover:border-emerald-500/40 hover:text-emerald-300 disabled:opacity-40"
            >
              {finished ? 'Reabrir la puesta a punto' : 'Dar por cerrada la puesta a punto'}
            </button>
            {hasMessages && (
              <button
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    if (!confirm('¿Borrar el chat de la puesta a punto? Tu temario y tus exámenes se quedan.')) return;
                    await clearSetupConversation();
                    setMessages([]);
                    setConversation(null);
                    router.refresh();
                  })
                }
                className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-slate-400 transition-colors hover:border-rose-500/40 hover:text-rose-300 disabled:opacity-40"
              >
                <RotateCcw className="h-3 w-3" />
                Empezar de cero el chat
              </button>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            <Link href="/temario" className="text-emerald-300 hover:text-emerald-200">
              Ver el temario →
            </Link>
            <Link href="/examenes" className="text-emerald-300 hover:text-emerald-200">
              Ver exámenes →
            </Link>
          </div>
        </div>
      </aside>
    </div>
  );
}

function CheckItem({ item }: { item: ChecklistItem }) {
  return (
    <span
      className={clsx(
        'rounded border px-1.5 py-0.5 text-[10px]',
        item.done
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
          : 'border-white/10 bg-[#0a0a0c] text-slate-500'
      )}
      title={item.hint}
    >
      {item.done ? '✓' : '–'} {item.label}
    </span>
  );
}
