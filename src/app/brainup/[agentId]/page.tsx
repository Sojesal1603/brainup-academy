import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentTenant } from '@/lib/tenantContext';
import { agentSlug, looksLikeUuid } from '@/lib/agentSlug';
import { getStageConfig } from '@/lib/stages';
import { buildTutorProactiveLine } from '@/lib/proactivity';
import nextDynamic from 'next/dynamic';
import { ChatSkeleton } from '@/components/ui/Skeletons';

// El chat del catedrático es el componente más grande de la app (1.500 líneas
// entre interfaz, adjuntos y render de apuntes). Viaja en su propio trozo y
// solo al entrar a una conversación; el radar táctico ya está visible.
const TutorChat = nextDynamic(() => import('@/components/brainup/TutorChat'), {
  loading: () => <ChatSkeleton />,
});
import SessionClosePanel from '@/components/brainup/SessionClosePanel';
import { getConfiguredModelLabel, parseTutorReply, type TutorStage } from '@/lib/tutor';import { normalizeSubjectMode } from '@/lib/subjects/modes';


import type { NoteProposal } from '@/lib/apuntesIa';
import { getConfiguredEngines } from '@/lib/aiEngine';
import { resolveAllAiCredentials, runWithAiCredentials } from '@/lib/ai/credentials';
import { ArrowLeft, GraduationCap, Sparkles } from 'lucide-react';
import AiKeyRequiredBanner from '@/components/ia/AiKeyRequiredBanner';

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
  searchParams,
}: {
  params: Promise<{ agentId: string }>;
  searchParams: Promise<{ mode?: string | string[] }>;
}) {
  const { user, tenant: prisma } = await currentTenant();
  const { agentId } = await params;
  const query = await searchParams;
  const initialMode = normalizeSubjectMode(
    Array.isArray(query.mode) ? query.mode[0] : query.mode
  );
  // El rótulo del motor se lee con las credenciales de ESTA cuenta: la página no
  // debe anunciar la clave de plataforma si el usuario no tiene la suya.
  const aiCredentials = await resolveAllAiCredentials(user.id, { tolerateVaultErrors: true });
  const modelLabel = runWithAiCredentials(aiCredentials, () => getConfiguredModelLabel());
  // Motores que pueden escribir ahora mismo: con ellos se comparan las
  // versiones de un mismo apunte (Gemini, Groq, OpenRouter, local…).
  const engines = runWithAiCredentials(aiCredentials, () => getConfiguredEngines());
  // Proveedor que toca ahora mismo: el PRIMERO de la cadena real de esta
  // cuenta, no el primero que aparezca en la etiqueta del modelo. La etiqueta
  // «auto (Gemini + Groq)» contiene «Groq» y la cabecera anunciaba Groq a un
  // alumno cuya clave era de Gemini: decir la verdad es parte del arreglo.
  const engineLabel = aiCredentials.length === 0 ? 'Sin IA' : engines[0]?.name ?? 'Sin IA';

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
    teacherUnit,
    sessionTopics,
    profile,
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
    // Método del profesor: dato real que el alumno contó en el temario. Se usa
    // en el saludo por reglas, sin gastar ninguna llamada de IA.
    prisma.topic.findFirst({
      where: { subjectId: agent.subjectId, teacherMethod: { not: null } },
      orderBy: [{ seenInClassAt: 'desc' }, { updatedAt: 'desc' }],
      select: { teacherMethod: true },
    }),
    // Temas de la materia para el cierre de sesión: solo se puede apuntar un
    // fallo contra una unidad que existe de verdad.
    prisma.topic.findMany({
      where: { subjectId: agent.subjectId },
      orderBy: [{ unitNumber: 'asc' }, { title: 'asc' }],
      select: { id: true, title: true },
    }),
    // Solo `modality`: la columna `stage` del Paso 11 aún no está aplicada en
    // producción y `getStageConfig` sabe inferir la etapa desde la modalidad.
    // Así el saludo se adapta sin romper la página si falta la migración.
    prisma.userProfile.findUnique({
      where: { id: user.id },
      select: { modality: true },
    }),
  ]);

  const stageConfig = getStageConfig({ modality: profile?.modality });
  // Una sola frase, por reglas y con datos ya leídos. No llama al modelo: el
  // saludo del catedrático tiene que seguir sin gastar API.
  const proactiveLine = buildTutorProactiveLine({
    tone: {
      label: stageConfig.label,
      hasPau: stageConfig.scale.hasPau,
      supportsEcts: stageConfig.supportsEcts,
    },
    weakTopicLabel: measuredTopics[0]?.title ?? null,
    unmeasuredCount: unmeasuredUnits,
    examTitle: upcomingExams[0]?.title ?? null,
    examDays: upcomingExams[0] ? daysUntil(upcomingExams[0].examDate) : null,
    pendingErrors,
  });

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

      {aiCredentials.length === 0 ? (
        <div className="shrink-0 px-3 pt-3 sm:px-5">
          <AiKeyRequiredBanner />
        </div>
      ) : null}

      <div className="chat-grid flex min-h-0 flex-1 md:grid md:grid-cols-1">
        {/* Chat */}
        <TutorChat
          agent={{
            id: agent.id,
            name: agent.name,
            specialty: agent.specialty,
            subject: {
              name: agent.subject.name,
              color: agent.subject.color,
              category: agent.subject.category,
            },
          }}
          model={modelLabel}
          initialMode={initialMode}
          initialConversationId={conversation?.id ?? null}
          initialMessages={initialMessages}
          opening={{
            weakTopicLabel: measuredTopics[0]?.title ?? null,
            unmeasuredCount: unmeasuredUnits,
            nextExamLabel: upcomingExams[0]?.title ?? null,
            examDays: upcomingExams[0] ? daysUntil(upcomingExams[0].examDate) : null,
            pendingErrors,
            teacherMethodLabel: teacherUnit?.teacherMethod?.trim().slice(0, 300) || null,
            proactiveLine,
          }}
          notes={{ total: notesTotal, titles: notesPreview.map((note) => note.title) }}
          engines={engines}
        />

      </div>

      <SessionClosePanel agentId={agent.id} topics={sessionTopics} />
    </div>
  );
}
