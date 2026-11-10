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
import { getConfiguredEngines } from '@/lib/aiEngine';
import { ArrowLeft, GraduationCap, Sparkles } from 'lucide-react';

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
  // Motores que pueden escribir ahora mismo: con ellos se comparan las
  // versiones de un mismo apunte (Gemini, Groq, OpenRouter, local…).
  const engines = getConfiguredEngines();
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
    <div className="chat-fullscreen fixed inset-0 z-[60] flex h-[100dvh] w-screen flex-col overflow-hidden bg-[#0a0a0b] text-stone-200">
      {/* Barra fija del catedrático: quién te habla y en qué estado. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.07] px-3 py-2.5 sm:px-5">
        <Link
          href="/brainup"
          aria-label="Volver a los catedráticos"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-white/[0.05] hover:text-stone-200"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>

        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border"
          style={{
            backgroundColor: `${agent.subject.color}14`,
            borderColor: `${agent.subject.color}40`,
            color: agent.subject.color,
          }}
          aria-hidden
        >
          <GraduationCap className="h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1">
          <h1 className="truncate font-serif text-[16px] leading-tight text-stone-100 sm:text-[17px]">
            {agent.name}
          </h1>
          <p className="truncate text-[11px] text-stone-500">
            Catedrático de {agent.subject.name} · {agent.specialty}
          </p>
        </div>

        <div className="hidden shrink-0 items-center gap-3 sm:flex">
          <span className="inline-flex items-center gap-1.5 text-[11px] text-stone-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80" />
            {engineLabel}
          </span>
          <span className="hidden text-[10px] font-mono text-stone-600 lg:inline">
            {modelLabel.startsWith('auto') ? 'mejor modelo gratuito disponible' : modelLabel}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-[10px] text-stone-400">
            <Sparkles className="h-3 w-3" />
            Protocolo socrático
          </span>
        </div>
      </div>

      <div className="chat-grid flex min-h-0 flex-1 md:grid md:grid-cols-1">
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
          engines={engines}
        />

      </div>
    </div>
  );
}
