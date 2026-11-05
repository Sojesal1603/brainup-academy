import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { agentSlug, looksLikeUuid } from '@/lib/agentSlug';
import nextDynamic from 'next/dynamic';
import { ChatSkeleton } from '@/components/ui/Skeletons';

// El chat del catedrático es el componente más grande de la app (1.500 líneas
// entre interfaz, adjuntos y render de apuntes). Viaja en su propio trozo y
// solo al entrar a una conversación; el radar táctico ya está visible.
const TutorChat = nextDynamic(() => import('@/components/brainup/TutorChat'), {
  loading: () => <ChatSkeleton />,
});
import { getConfiguredModelLabel, parseTutorReply, type TutorStage } from '@/lib/tutor';
import type { NoteProposal } from '@/lib/apuntesIa';
import { MASTERY_SOURCE_META } from '@/lib/knowledge';
import {
  ArrowLeft,
  CalendarClock,
  GraduationCap,
  ShieldAlert,
  Sparkles,
  Target,
} from 'lucide-react';

export const dynamic = 'force-dynamic';

/**
 * Propuesta de apunte guardada con el turno. Si el JSON viniera corrupto se
 * ignora en lugar de romper la conversación entera.
 */
function readNoteProposal(raw: string | null): NoteProposal | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { unitNumber?: unknown; title?: unknown };
    if (!parsed || typeof parsed.title !== 'string' || parsed.title.trim().length === 0) return null;
    return {
      unitNumber: typeof parsed.unitNumber === 'number' ? parsed.unitNumber : null,
      title: parsed.title.trim().slice(0, 160),
    };
  } catch {
    return null;
  }
}

function daysUntil(date: Date): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

export default async function TutorPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  const modelLabel = getConfiguredModelLabel();
  // Proveedor que toca ahora mismo: Gemini es el primario y Groq el respaldo,
  // así que el rótulo sale del modelo configurado, no de una suposición.
  const engineLabel = /groq/i.test(modelLabel)
    ? 'Groq'
    : /openrouter/i.test(modelLabel)
      ? 'OpenRouter'
      : /ollama|local/i.test(modelLabel)
        ? 'Local'
        : 'Gemini';

  // La dirección puede ser el UUID del agente o el nombre de la materia
  // («lengua-castellana-y-literatura-i»). El UUID es frágil: cambia al volver a
  // sembrar la base y deja el enlace guardado apuntando a la nada. Por eso se
  // acepta también el nombre, que no cambia nunca.
  const byId = looksLikeUuid(agentId)
    ? await prisma.aiAgent.findUnique({
        where: { id: agentId },
        include: { subject: true },
      })
    : null;

  const requestedSlug = agentSlug(agentId);

  // Si el UUID ya no existe (base regenerada), se busca igualmente por nombre
  // antes de rendirse: así un marcador viejo sigue llevando al catedrático.
  const agent =
    byId ??
    (await prisma.aiAgent.findMany({ include: { subject: true } })).find(
      (candidate) =>
        agentSlug(candidate.subject.name) === requestedSlug ||
        agentSlug(candidate.name) === requestedSlug
    );

  // Nunca una pantalla muerta: si no hay forma de saber de qué catedrático
  // hablamos, se vuelve a la lista, donde están todos.
  if (!agent) redirect('/brainup');

  const [
    conversation,
    measuredTopics,
    unmeasuredUnits,
    upcomingExams,
    pendingErrors,
    notesTotal,
    notesPreview,
  ] = await Promise.all([
    // OJO: el `agentId` de la URL puede ser el slug de la materia
    // («lengua-castellana-y-literatura-i»), no el UUID del agente. Buscar la
    // conversación con el valor de la URL la encontraba solo cuando la dirección
    // traía el UUID; al entrar desde el listado (que enlaza por slug) no había
    // conversación, el chat se pintaba vacío y el siguiente mensaje abría otra
    // nueva. Eso es exactamente lo que hacía que el chat se «reiniciara» cada
    // vez que se salía. Aquí manda el id REAL del agente.
    prisma.aiConversation.findFirst({
      where: { agentId: agent.id },
      orderBy: { createdAt: 'desc' },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          // Los archivos que le enseñaste vuelven con el historial. Las
          // propuestas de apunte pendientes también: son un campo escalar del
          // propio mensaje, así que el botón sigue ahí tras recargar.
          include: {
            attachments: { select: { name: true, mimeType: true, sizeBytes: true } },
          },
        },
      },
    }),
    // Solo unidades con nivel MEDIDO: es lo único que el catedrático puede citar.
    prisma.topic.findMany({
      where: { subjectId: agent.subjectId, masterySource: { not: 'sin_medir' } },
      orderBy: { masteryLevel: 'asc' },
      take: 4,
      select: { id: true, title: true, masteryLevel: true, masterySource: true, unitNumber: true },
    }),
    prisma.topic.count({ where: { subjectId: agent.subjectId, masterySource: 'sin_medir' } }),
    prisma.exam.findMany({
      where: { subjectId: agent.subjectId, examDate: { gte: new Date() } },
      orderBy: { examDate: 'asc' },
      take: 2,
      select: { id: true, title: true, examDate: true, examType: true },
    }),
    prisma.errorLog.count({
      where: { subjectId: agent.subjectId, isMastered: false },
    }),
    // Apuntes del alumno en esta materia: el catedrático puede leerlos.
    prisma.note.count({ where: { topic: { subjectId: agent.subjectId } } }),
    prisma.note.findMany({
      where: { topic: { subjectId: agent.subjectId } },
      orderBy: [{ isPinned: 'desc' }, { updatedAt: 'desc' }],
      take: 3,
      select: { title: true },
    }),
  ]);

  const initialMessages =
    conversation?.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => {
        // Turnos antiguos guardaron la etiqueta [[etapa:...]] dentro del propio
        // texto: se limpia al pintarlos y, de paso, se recupera su etapa si el
        // campo no la traía. Los turnos nuevos ya se guardan limpios.
        const parsed = parseTutorReply(m.content);
        return {
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: parsed.text,
          stage: (m.stepStage as TutorStage | null) ?? parsed.stage,
          attachments: m.attachments.map((attachment) => ({
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          })),
          noteProposal: readNoteProposal(m.noteProposal),
        };
      }) ?? [];

  return (
    <div className="space-y-6">
      {/* Cabecera táctica del catedrático */}
      <div className="card-glass fade-up space-y-4 rounded-2xl p-4 sm:p-5">
        <Link
          href="/brainup"
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-400 hover:text-emerald-400 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Volver a los catedráticos
        </Link>

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            {/* Avatar destacado con halo del color de la materia */}
            <div className="relative shrink-0">
              <span
                className="absolute -inset-1.5 rounded-2xl opacity-60 blur-md"
                style={{ backgroundColor: `${agent.subject.color}55` }}
                aria-hidden
              />
              <div
                className="relative flex h-14 w-14 items-center justify-center rounded-2xl border-2"
                style={{
                  background: `radial-gradient(circle at 30% 20%, ${agent.subject.color}33, #0a0a0c 78%)`,
                  borderColor: `${agent.subject.color}80`,
                  boxShadow: `0 0 22px ${agent.subject.color}40, inset 0 0 14px ${agent.subject.color}22`,
                  color: agent.subject.color,
                }}
              >
                <GraduationCap className="h-7 w-7" />
              </div>
            </div>

            <div className="min-w-0">
              <p
                className="font-mono text-[10px] font-bold uppercase tracking-[0.18em]"
                style={{ color: agent.subject.color }}
              >
                Catedrático IA · {agent.subject.name}
              </p>
              <h1 className="mt-0.5 text-xl font-black tracking-tight text-slate-100 uppercase font-mono">
                {agent.name}
              </h1>
              <p className="text-xs text-slate-400 mt-0.5">{agent.specialty}</p>
            </div>
          </div>

          <div className="flex flex-col items-start gap-2 sm:items-end">
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              {engineLabel} en línea
            </span>
            <span className="text-[10px] font-mono text-slate-500">
              {modelLabel.startsWith('auto') ? 'mejor modelo gratuito disponible' : modelLabel}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/25 bg-blue-500/10 px-2.5 py-1 text-[10px] font-semibold text-blue-200">
              <Sparkles className="h-3 w-3" /> Protocolo socrático activo
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6 items-start">
        {/* Chat */}
        <TutorChat
          agent={{
            id: agent.id,
            name: agent.name,
            specialty: agent.specialty,
            subject: { name: agent.subject.name, color: agent.subject.color },
          }}
          model={modelLabel}
          initialConversationId={conversation?.id ?? null}
          initialMessages={initialMessages}
          opening={{
            weakTopicLabel: measuredTopics[0]?.title ?? null,
            unmeasuredCount: unmeasuredUnits,
            nextExamLabel: upcomingExams[0]?.title ?? null,
            examDays: upcomingExams[0] ? daysUntil(upcomingExams[0].examDate) : null,
            pendingErrors,
          }}
          notes={{ total: notesTotal, titles: notesPreview.map((note) => note.title) }}
        />

        {/* Radar táctico */}
        <aside className="space-y-4">
          <div className="rounded-2xl glass-card p-4 space-y-4">
            <h2 className="text-xs font-black uppercase tracking-widest text-slate-300 font-mono flex items-center gap-2">
              <Target className="w-4 h-4 text-emerald-400" />
              Radar táctico
            </h2>

            {/* Exámenes próximos */}
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Próximos exámenes
              </p>
              {upcomingExams.length === 0 ? (
                <p className="text-[11px] text-slate-500">
                  Sin exámenes registrados para esta materia.
                </p>
              ) : (
                upcomingExams.map((exam) => {
                  const days = daysUntil(exam.examDate);
                  return (
                    <div
                      key={exam.id}
                      className="rounded-xl bg-[#070b14] border border-slate-800 px-3 py-2 space-y-0.5"
                    >
                      <p className="text-[11px] font-semibold text-slate-200 leading-snug">
                        {exam.title}
                      </p>
                      <p className="text-[10px] font-mono text-amber-300 flex items-center gap-1.5">
                        <CalendarClock className="w-3 h-3" />
                        {days <= 0 ? 'Hoy' : days === 1 ? 'Mañana' : `En ${days} días`}
                      </p>
                    </div>
                  );
                })
              )}
            </div>

            {/* Nivel medido (nunca supuesto) */}
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Nivel medido por el catedrático
              </p>
              {measuredTopics.length === 0 ? (
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Todavía no hay ninguna medición real de esta materia{unmeasuredUnits > 0 ? ` (${unmeasuredUnits} unidades sin medir)` : ''}.
                  El catedrático empezará preguntando y anotará el nivel que compruebe con tus
                  respuestas o con un simulacro.
                </p>
              ) : (
                measuredTopics.map((topic) => (
                  <div key={topic.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] text-slate-300 leading-snug line-clamp-1">
                        {topic.title}
                      </p>
                      <span
                        className={`text-[10px] font-mono shrink-0 px-1.5 py-0.5 rounded border ${
                          MASTERY_SOURCE_META[
                            (topic.masterySource as keyof typeof MASTERY_SOURCE_META) ?? 'sin_medir'
                          ]?.badgeColor ?? MASTERY_SOURCE_META.autoevaluacion.badgeColor
                        }`}
                        title={
                          MASTERY_SOURCE_META[
                            (topic.masterySource as keyof typeof MASTERY_SOURCE_META) ?? 'sin_medir'
                          ]?.hint
                        }
                      >
                        {topic.masteryLevel}%
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          topic.masteryLevel < 40
                            ? 'bg-rose-400'
                            : topic.masteryLevel < 70
                              ? 'bg-amber-400'
                              : 'bg-emerald-400'
                        }`}
                        style={{ width: `${Math.max(4, topic.masteryLevel)}%` }}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Errores pendientes */}
            <div
              className={`flex items-center gap-2 rounded-xl px-3 py-2 border text-[11px] ${
                pendingErrors > 0
                  ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
              }`}
            >
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
              {pendingErrors > 0 ? (
                <span>
                  {pendingErrors} {pendingErrors === 1 ? 'error pendiente' : 'errores pendientes'}{' '}
                  de dominio en el banco.
                </span>
              ) : (
                <span>Banco de errores al día en esta materia.</span>
              )}
            </div>
          </div>

          <p className="text-[10px] text-slate-500 leading-relaxed px-1">
            💡 El catedrático conoce tus temas débiles, tus próximos exámenes y tus errores
            pendientes. Cuanto más concreta sea tu pregunta, mejor será el diagnóstico.
          </p>

          <p className="text-[10px] text-slate-500 leading-relaxed px-1">
            📎 Puedes <strong className="text-slate-400">enseñarle una captura o un PDF</strong> con el
            clip (o pegando con Ctrl+V) y darle acceso a tus{' '}
            <strong className="text-slate-400">apuntes</strong> con el interruptor de abajo: los lee de
            verdad antes de responderte.
          </p>

          <p className="text-[10px] text-slate-500 leading-relaxed px-1">
            📝 Y si te hace falta material, <strong className="text-slate-400">pídele los
            apuntes</strong>: te los ofrecerá y, solo si tú dices que sí, los escribe y los deja en la
            sección de su asignatura del cuaderno, listos para descargar o imprimir.
          </p>
        </aside>
      </div>
    </div>
  );
}
