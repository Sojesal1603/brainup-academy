import { NextResponse, after } from 'next/server';
import { prisma } from '@/lib/prisma';
import { loadMemoryBlock, rememberConversation } from '@/lib/agentMemory';
import { polishMemoryWithAi } from '@/lib/agentMemoryPolish';
import {
  TUTOR_MAX_HISTORY_MESSAGES,
  buildTutorSystemPrompt,
  hasAiProviderAsync,
  parseTutorResult,
  runAiText,
  TutorError,
  type AiAttachmentPart,
  type ChatMessage,
  type TutorReply,
} from '@/lib/tutor';
import { buildUserInputStep, modelSupportsVision } from '@/lib/aiEngine';
import { buildLocalTutorReply, LOCAL_TUTOR_PROVIDER } from '@/lib/tutorFallback';
import { withDbRetry } from '@/lib/prismaRetry';
import { isLocalModeReply } from '@/lib/setupFallback';
import {
  ATTACHMENT_LIVE_TURNS,
  loadAttachmentParts,
  storeAttachments,
  validateAttachments,
} from '@/lib/tutorAttachments';
import {
  buildNoteIndex,
  selectNotesForTutor,
  type NoteRowForTutor,
} from '@/lib/tutorNotes';
import { resolveNoteUnit } from '@/lib/noteUnitMatch';
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_TUTOR_ATTACHMENTS,
  formatBytes,
  isImageMime,
} from '@/lib/attachmentLimits';
import { readUpload, readUploadBytes, type StoredUpload } from '@/lib/docStore';
import { buildDocumentContext, parsePageRequests, type IndexedDoc } from '@/lib/docContext';
import { startOfDay } from '@/lib/srs';
import {
  syncTutorWithPlanner,
  type TutorPlannerSyncResult,
} from '@/lib/tutorPlannerSync';

interface TutorRequestBody {
  agentId?: unknown;
  conversationId?: unknown;
  message?: unknown;
  /**
   * Adjuntos ya subidos (`/api/tutor/attachments`): la vía buena, porque el
   * archivo va subiendo a disco en crudo y no pasa por el JSON en base64.
   */
  uploadIds?: unknown;
  /** Capturas, fotos y PDFs que el alumno le enseña al catedrático. */
  attachments?: unknown;
  /** ¿Ha activado «compartir mis apuntes» para esta consulta? (por defecto, sí) */
  shareNotes?: unknown;
  /**
   * Abre una conversación NUEVA aunque ya haya una anterior. Es lo que usan las
   * verificaciones para no escribir (ni borrar) en el hilo real del alumno, y lo
   * que usará el botón de «nueva consulta» cuando se añada. Sin este flag, el
   * servidor continúa la última conversación: recargar no parte el hilo.
   */
  fresh?: unknown;
}

interface StoredAttachmentRow {
  name: string;
  mimeType: string;
  localPath: string | null;
  sizeBytes: number;
}

interface StoredMessage {
  id: string;
  role: string;
  content: string;
  rawStepsJson: string | null;
  attachments: StoredAttachmentRow[];
}

/**
 * Los turnos recientes que conservan el archivo binario en el historial. Un PDF
 * de 5 MB no se reenvía al modelo veinte veces: solo durante los últimos turnos
 * con adjunto. A partir de ahí queda el nombre, para que el catedrático sepa
 * que existió y pueda pedir que se lo vuelvas a pasar.
 */
function liveAttachmentMessageIds(messages: StoredMessage[]): Set<string> {
  const withAttachments = messages.filter(
    (message) => message.role === 'user' && message.attachments.length > 0
  );
  return new Set(withAttachments.slice(-ATTACHMENT_LIVE_TURNS).map((message) => message.id));
}

/**
 * Reconstruye el historial de pasos que espera la API de Gemini: turnos de
 * usuario como `user_input` (con sus archivos, si están vivos) y los pasos
 * crudos del modelo tal cual.
 */
async function toHistorySteps(
  messages: StoredMessage[],
  liveIds: Set<string>
): Promise<unknown[]> {
  const steps: unknown[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      if (message.attachments.length === 0) {
        steps.push(buildUserInputStep(message.content));
        continue;
      }

      const parts = liveIds.has(message.id) ? await loadAttachmentParts(message.attachments) : [];

      if (parts.length === 0) {
        const names = message.attachments.map((attachment) => `«${attachment.name}»`).join(', ');
        steps.push(
          buildUserInputStep(
            `${message.content}\n\n(En un turno anterior me enseñaste un archivo: ${names}. Ya no lo tienes cargado; si necesitas volver a verlo, pídemelo.)`
          )
        );
        continue;
      }

      steps.push(buildUserInputStep(message.content, parts));
      continue;
    }

    if (message.role === 'assistant') {
      if (message.rawStepsJson) {
        try {
          const parsed = JSON.parse(message.rawStepsJson);
          if (Array.isArray(parsed) && parsed.length > 0) {
            steps.push(...parsed);
            continue;
          }
        } catch {
          // Paso corrupto: se reconstruye desde el texto en vez de perder el turno.
        }
      }

      // Turnos viejos o de un proveedor que no da pasos: se reconstruye la
      // respuesta como paso de modelo. Si no, Gemini vería dos preguntas del
      // alumno seguidas y creería que la conversación empieza ahí.
      const content = String(message.content ?? '').trim();
      if (content.length > 0) {
        steps.push({ type: 'model_output', content: [{ type: 'text', text: content }] })
      }
    }
  }

  return steps;
}

function trimHistory<T extends { role: string }>(messages: T[]): T[] {
  let recent = messages.slice(-TUTOR_MAX_HISTORY_MESSAGES);
  const firstUser = recent.findIndex((m) => m.role === 'user');
  if (firstUser > 0) recent = recent.slice(firstUser);
  return recent;
}

/**
 * El mismo historial en formato de chat: lo usan los proveedores
 * OpenAI-compatibles (Groq), que no entienden los pasos crudos de Gemini.
 */
function toChatMessages(messages: StoredMessage[]): ChatMessage[] {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      if (m.role === 'user' && m.attachments.length > 0) {
        const names = m.attachments.map((attachment) => attachment.name).join(', ');
        return { role: 'user' as const, content: `${m.content}\n\n(Adjuntó: ${names}.)` };
      }
      return {
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.content,
      };
    })
}

/**
 * La ruta habla con Prisma y con los proveedores de IA: runtime de Node.
 *
 * `maxDuration` es el techo de la plataforma, no del turno: el turno ya se
 * corta solo con su presupuesto (`AI_TEXT_BUDGET_MS`) y contesta en local. Lo
 * que evita es que un despliegue serverless mate la petición a media respuesta.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request) {
  let body: TutorRequestBody;
  try {
    body = (await request.json()) as TutorRequestBody;
  } catch {
    return NextResponse.json({ error: 'Petición inválida.' }, { status: 400 })
  }

  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const conversationId =
    typeof body.conversationId === 'string' && body.conversationId.length > 0
      ? body.conversationId
      : null;
  const freshConversation = body.fresh === true;
  // Por defecto los apuntes se comparten: es justo lo que el alumno ha pedido.
  const shareNotes = body.shareNotes === undefined ? true : body.shareNotes !== false;

  const attachments = validateAttachments(body.attachments);
  if (!attachments.ok) {
    return NextResponse.json({ error: attachments.error }, { status: 400 })
  }
  const validAttachments = attachments.attachments;

  // Los adjuntos del turno: lo normal hoy es que vengan ya subidos por su propia
  // puerta (solo viaja el id); el base64 del JSON se sigue aceptando para no
  // romper a nadie que hable con la API antigua.
  const uploadIds = Array.isArray(body.uploadIds)
    ? body.uploadIds
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .slice(0, MAX_TUTOR_ATTACHMENTS)
    : [];
  const uploads = (
    await Promise.all(uploadIds.map((id) => readUpload(id).catch(() => null)))
  ).filter((upload): upload is StoredUpload => upload !== null);

  if (!agentId || (!message && validAttachments.length === 0 && uploads.length === 0)) {
    return NextResponse.json(
      { error: 'Faltan datos: se requiere agente y mensaje (o un archivo adjunto).' },
      { status: 400 }
    );
  }

  if (message.length > 4000) {
    return NextResponse.json(
      { error: 'El mensaje es demasiado largo (máximo 4000 caracteres).' },
      { status: 400 }
    );
  }

  // OJO: aquí NO se corta la conversación por no haber clave. Si no hay ningún
  // motor (ni clave en la nube ni Ollama levantado), el catedrático contesta
  // con el respaldo local unas líneas más abajo: el chat del alumno no puede
  // quedarse en un error por configuración.

  try {
    const agent = await prisma.aiAgent.findUnique({
      where: { id: agentId },
      include: { subject: true },
    })

    if (!agent) {
      return NextResponse.json({ error: 'Catedrático no encontrado.' }, { status: 404 })
    }

    // La conversación se abre antes de llamar a la IA, para que un fallo del
    // modelo no deje el turno huérfano. Los mensajes se escriben justo después
    // de una respuesta correcta: nada a medias en la base.
    // Sin `conversationId` NO se abre una conversación nueva a ciegas: se
    // continúa la última de este catedrático. Así el hilo no se parte cuando el
    // navegador pierde el id (recarga, cambio de pestaña, móvil) y la memoria de
    // lo hablado sigue estando ahí. Solo se crea una si de verdad no hay ninguna.
    const conversation = conversationId
      ? await prisma.aiConversation.findFirst({
          where: { id: conversationId, agentId },
        })
      : freshConversation
        ? await prisma.aiConversation.create({
            data: {
              agentId,
              title: (message || validAttachments[0]?.name || 'Consulta de Estudio').slice(0, 60),
            },
          })
        : (await prisma.aiConversation.findFirst({
            where: { agentId },
            orderBy: { createdAt: 'desc' },
          })) ??
          (await prisma.aiConversation.create({
            data: {
              agentId,
              title: (message || validAttachments[0]?.name || 'Consulta de Estudio').slice(0, 60),
            },
          }));

    const activeConversation =
      conversation ??
      (await prisma.aiConversation.create({
        data: {
          agentId,
          title: (message || validAttachments[0]?.name || 'Consulta de Estudio').slice(0, 60),
        },
      }));

    // Expediente del alumno: SOLO entran las unidades con nivel medido. Las que
    // nadie ha medido se cuentan aparte para que el catedrático sepa que no sabe
    // nada de ellas (y las diagnostique él) en vez de leerlas como «puntos flojos».
    // El día de hoy, una sola vez: se usa para el plan que se le cuenta al
    // catedrático y para saber qué sesiones tiene ya en marcha el Planificador.
    const nowStart = startOfDay(new Date());
    const todayEnd = new Date(nowStart.getTime() + 86400000);

    const [
      student,
      measuredTopics,
      unmeasuredCount,
      subjectUnits,
      upcomingExams,
      pendingErrors,
      todayBlocks,
      historyRows,
      noteRows,
      notesTotal,
      // La memoria entre días: lo que este catedrático ya habló con él en esta
      // materia. Cadena vacía el primer día (y entonces no se añade nada al prompt).
      memoryBlock,
    ] = await Promise.all([
      prisma.userProfile.findUnique({ where: { id: 'user_default' } }),
      prisma.topic.findMany({
        where: { subjectId: agent.subjectId, masterySource: { not: 'sin_medir' } },
        orderBy: { masteryLevel: 'asc' },
        take: 8,
        select: { title: true, masteryLevel: true, unitNumber: true, masterySource: true },
      }),
      prisma.topic.count({ where: { subjectId: agent.subjectId, masterySource: 'sin_medir' } }),
      prisma.topic.findMany({
        where: { subjectId: agent.subjectId },
        orderBy: { unitNumber: 'asc' },
        select: { id: true, title: true, unitNumber: true, status: true },
      }),
      prisma.exam.findMany({
        where: { subjectId: agent.subjectId, examDate: { gte: new Date() } },
        orderBy: { examDate: 'asc' },
        take: 3,
        select: { title: true, examDate: true, examType: true },
      }),
      prisma.errorLog.count({
        where: { subjectId: agent.subjectId, isMastered: false },
      }),
      // Planificador → catedrático: lo que hay programado para hoy, con su
      // estado. Sin esto el chat podía proponer algo que la agenda ya descartó.
      prisma.studyBlock.findMany({
        where: { date: { gte: nowStart, lt: todayEnd } },
        orderBy: [{ orderIndex: 'asc' }],
        select: {
          durationMinutes: true,
          technique: true,
          isCompleted: true,
          topic: { select: { title: true, subject: { select: { name: true } } } },
        },
      }),
      prisma.aiMessage.findMany({
        where: { conversationId: activeConversation.id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          role: true,
          content: true,
          rawStepsJson: true,
          attachments: { select: { name: true, mimeType: true, localPath: true, sizeBytes: true } },
        },
      }),
      // Los apuntes que el alumno ha escrito de esta materia: es lo que el
      // catedrático puede leer. Se traen de más y el módulo recorta.
      shareNotes
        ? prisma.note
            .findMany({
              where: { topic: { subjectId: agent.subjectId } },
              orderBy: [{ isPinned: 'desc' }, { updatedAt: 'desc' }],
              take: 40,
              select: {
                id: true,
                title: true,
                content: true,
                tags: true,
                isPinned: true,
                updatedAt: true,
                topic: { select: { title: true, unitNumber: true } },
              },
            })
            .then((rows): NoteRowForTutor[] =>
              rows.map((note) => ({
                id: note.id,
                title: note.title,
                content: note.content,
                tags: note.tags,
                isPinned: note.isPinned,
                updatedAt: note.updatedAt,
                topicTitle: note.topic?.title ?? null,
                unitNumber: note.topic?.unitNumber ?? null,
              }))
            )
        : Promise.resolve([] as NoteRowForTutor[]),
      prisma.note.count({ where: { topic: { subjectId: agent.subjectId } } }),
      loadMemoryBlock(agent.id),
    ]);

    // Unidad que está dando en clase (temario): dato real que sí se puede citar.
    const courseUnit =
      [...subjectUnits].reverse().find((unit) => unit.status === 'en_curso') ??
      [...subjectUnits].reverse().find((unit) => unit.status === 'visto' || unit.status === 'repasado') ??
      subjectUnits.find((unit) => unit.status === 'pendiente') ??
      null;

    const sharedNotes = selectNotesForTutor(noteRows);

    // El índice completo del cuaderno (título + clave) es lo que permite abrir
    // un apunte guardado en vez de reescribirlo. Sin apuntes compartidos no hay
    // índice: el catedrático no conoce el cuaderno.
    const noteIndex = shareNotes ? buildNoteIndex(noteRows) : [];

    const recentHistory = trimHistory(historyRows as StoredMessage[]);

    /**
     * El historial que viaja al modelo, sin los turnos del respaldo local.
     *
     * Esos mensajes se guardan como del asistente igual que los demás y el modelo
     * los imita: acababa contestando «⚠️ Sin IA ahora mismo…» con el proveedor
     * funcionando (pasó en la puesta a punto: `provider: groq`, `degraded: false`
     * y el texto del respaldo). Al catedrático le pasaría lo mismo en cuanto
     * hubiera un turno degradado en su conversación.
     */
    const modelHistory = recentHistory.filter(
      (row) => row.role !== 'assistant' || !isLocalModeReply(row.content)
    );

    // Lo que el catedrático va a poder **leer** de verdad en este turno. El texto
    // de cada documento viene troceado con su página, y de ahí se sacan el mapa
    // del documento y los extractos que le tocan a la pregunta. Si en su
    // respuesta anterior pidió páginas concretas («pásame las 210-214»), se le
    // traen esas: es la forma de leer un libro entero sin mandarlo entero.
    const documentIndexes: IndexedDoc[] = uploads
      .map((upload) => upload.index)
      .filter((index): index is IndexedDoc => index !== null);
    const previousReply = [...recentHistory].reverse().find((row) => row.role === 'assistant');
    const requestedPages = previousReply ? parsePageRequests(previousReply.content) : [];

    // Un documento sin pregunta se lee igual: se le pide al catedrático que lo
    // mire y diga de qué va, en vez de mandarle un turno vacío al modelo.
    const questionForModel =
      message.length > 0
        ? message
        : documentIndexes.length > 0
          ? 'Te he dado un documento. Dime de qué va, qué es lo esencial y por dónde empezar.'
          : message;

    const documentsBlock = buildDocumentContext(documentIndexes, questionForModel, {
      ...(requestedPages.length > 0 ? { pages: requestedPages } : {}),
    })

    if (documentIndexes.length > 0) {
      console.log(
        `[tutor] documentos: ${documentIndexes.map((doc) => `${doc.name} (${doc.pages} pág., ${doc.chars} car.)`).join(' | ')} · extracto de ${documentsBlock.length} caracteres${requestedPages.length > 0 ? ` · páginas pedidas: ${requestedPages.join(', ')}` : ''}`
      );
    }

    const systemInstruction = buildTutorSystemPrompt(
      {
        name: agent.name,
        specialty: agent.specialty,
        systemPrompt: agent.systemPrompt,
        subject: {
          name: agent.subject.name,
          currentGrade: agent.subject.currentGrade,
          gradeSource: agent.subject.gradeSource,
          targetGrade: agent.subject.targetGrade,
        },
      },
      {
        studentName: student?.name ?? 'Estudiante',
        modality: student?.modality ?? '1º de Bachillerato',
        measuredTopics: measuredTopics.map((topic) => ({
          title: topic.title,
          masteryLevel: topic.masteryLevel,
          unitNumber: topic.unitNumber,
          source: topic.masterySource,
        })),
        unmeasuredCount,
        // El temario con su numeración: es lo que evita que proponga los apuntes
        // de la unidad que está dando en clase cuando le piden otra.
        syllabus: subjectUnits.map((unit) => ({ unitNumber: unit.unitNumber, title: unit.title })),
        courseUnit: courseUnit
          ? { title: courseUnit.title, unitNumber: courseUnit.unitNumber, status: courseUnit.status }
          : null,
        upcomingExams,
        pendingErrors,
        todayPlan: todayBlocks.map((block) => ({
          subjectName: block.topic.subject.name,
          topicTitle: block.topic.title,
          minutes: block.durationMinutes,
          technique: block.technique,
          done: block.isCompleted,
        })),
        notes: sharedNotes,
        notesShared: shareNotes,
        notesTotal,
        notesIndex: noteIndex,
        memory: memoryBlock,
        documents: documentsBlock,
      }
    );

    // Se registra si el catedrático ha recibido memoria: es la prueba de que lo
    // hablado ayer está entrando en el prompt de hoy (lo lee la verificación).
    if (memoryBlock.length > 0) {
      console.log(`[tutor] memoria del catedrático: ${memoryBlock.length} caracteres`);
    }

    const history = await toHistorySteps(modelHistory, liveAttachmentMessageIds(modelHistory));

    // Al modelo solo le viajan los **bytes de lo que hay que mirar** —capturas y
    // escaneos— y solo si caben en la petición. Un tema de 300 páginas no se le
    // manda: se le da su texto (documentsBlock) y él pide las páginas que le
    // hagan falta. Lo que no cabe ni se puede mirar se le dice al alumno, en vez
    // de fingir que se ha leído.
    const attachmentParts: AiAttachmentPart[] = [];
    const tooBigToSee: string[] = [];
    let inlineBytes = 0;

    for (const upload of uploads) {
      const needsVision = isImageMime(upload.mimeType) || upload.mimeType === 'application/pdf';
      if (!needsVision) continue;

      if (
        upload.sizeBytes > MAX_INLINE_ATTACHMENT_BYTES ||
        inlineBytes + upload.sizeBytes > MAX_INLINE_ATTACHMENT_BYTES
      ) {
        tooBigToSee.push(`«${upload.name}» (${formatBytes(upload.sizeBytes)})`);
        continue;
      }

      const bytes = await readUploadBytes(upload.id);
      if (!bytes) continue;
      inlineBytes += bytes.byteLength;
      attachmentParts.push({
        name: upload.name,
        mimeType: upload.mimeType,
        data: bytes.toString('base64'),
      })
    }

    // Vía antigua (base64 en el JSON): se manda igual que siempre.
    for (const attachment of validAttachments) {
      attachmentParts.push({
        name: attachment.name,
        mimeType: attachment.mimeType,
        data: attachment.base64,
      })
    }

    if (tooBigToSee.length > 0) {
      console.warn(
        `[tutor] no se pueden mirar (demasiado grandes para una petición): ${tooBigToSee.join(', ')}`
      );
    }

    /**
     * EL CATEDRÁTICO NO SE QUEDA EN UN ERROR.
     *
     * Si los tres proveedores gratuitos están secos o saturados (y no hay motor
     * local), antes se devolvía un 429/503 y el alumno veía un error en el chat.
     * Ahora contesta el respaldo local (`tutorFallback.ts`) con lo que el sistema
     * sabe de su curso: examen próximo, unidad floja, errores pendientes y un
     * plan de acción. No inventa la explicación: la deja para cuando vuelva la IA.
     */
    let reply: TutorReply;
    let degraded = false;

    try {
      // Se sondea antes de gastar el turno: en serverless cada instancia arranca
      // sin saber si hay modelo local, y sin esto un Ollama levantado se
      // ignoraba y el alumno recibía un «no hay IA» falso.
      if (!(await hasAiProviderAsync())) {
        throw new TutorError(
          'Ahora mismo no hay ningún motor de IA disponible (ninguna clave con cupo y ningún modelo local), así que te contesto con lo que el sistema sabe de tu curso.',
          503,
          'sin proveedores de IA disponibles'
        );
      }
      const result = await runAiText({
        systemInstruction,
        messages: toChatMessages(modelHistory),
        message: questionForModel,
        attachments: attachmentParts,
        history,
      });
      reply = parseTutorResult(result);
    } catch (error) {
      const recoverable =
        error instanceof TutorError &&
        (error.status === 429 || error.status === 502 || error.status === 503);
      if (!recoverable) throw error;

      const recentExam = upcomingExams[0];
      const daysToExam = recentExam
        ? Math.round(
            (new Date(recentExam.examDate).setHours(0, 0, 0, 0) -
              new Date().setHours(0, 0, 0, 0)) /
              86400000
          )
        : null;

      console.error(
        '[tutor] sin IA disponible, contesta el respaldo local:',
        error.status,
        error.message
      );

      reply = {
        text: buildLocalTutorReply({
          agentName: agent.name,
          subjectName: agent.subject.name,
          studentName: student?.name ?? 'Estudiante',
          message,
          weakTopic: measuredTopics[0]
            ? { title: measuredTopics[0].title, masteryLevel: measuredTopics[0].masteryLevel }
            : null,
          nextExam:
            recentExam && daysToExam !== null
              ? { title: recentExam.title, days: daysToExam }
              : null,
          unmeasuredCount,
          pendingErrors,
          courseUnit: courseUnit?.title ?? null,
          noteTitles: sharedNotes.map((note) => note.title),
        }),
        stage: null,
        level: null,
        proposal: null,
        openNote: null,
        steps: [],
        model: 'catedrático local',
        provider: LOCAL_TUTOR_PROVIDER,
      };
      degraded = true;
    }


    let resolvedProposal = reply.proposal
      ? resolveNoteUnit(subjectUnits, {
          unitNumber: reply.proposal.unitNumber,
          title: reply.proposal.title,
        })
      : null;
    if (reply.proposal && resolvedProposal?.corrected && resolvedProposal.unit) {
      console.warn(
        `[tutor] propuesta de apuntes corregida: decía U${reply.proposal.unitNumber} «${reply.proposal.title}» y es U${resolvedProposal.unit.unitNumber} «${resolvedProposal.unit.title}»`
      );
    }
    const correctedProposal = reply.proposal
      ? {
          ...reply.proposal,
          unitNumber: resolvedProposal?.unit?.unitNumber ?? reply.proposal.unitNumber,
        }
      : null;

    // Apertura de un apunte guardado: la clave del índice se traduce aquí a un
    // id real. Una clave inventada no abre nada (y se avisa en consola) en vez
    // de hacer que el chat pida un apunte que no existe.
    const requestedNote = reply.openNote
      ? noteIndex.find((entry) => entry.key === reply.openNote!.key)
      : undefined;
    if (reply.openNote && !requestedNote) {
      console.warn(
        `[tutor] el catedrático ha pedido abrir «${reply.openNote.key}», que no está en el índice del cuaderno`
      );
    }
    const openNote = requestedNote
      ? {
          id: requestedNote.id,
          title: requestedNote.title,
          unitNumber: requestedNote.unitNumber,
          unitTitle: requestedNote.unitTitle,
          subjectId: agent.subjectId,
        }
      : null;

    // Los adjuntos que ya estaban en disco (subida en streaming) no se reescriben:
    // se apunta su ruta y su peso, que es lo que hace falta para reabrirlos.
    const stored = [
      ...(validAttachments.length > 0 ? await storeAttachments(validAttachments) : []),
      ...uploads.map((upload) => ({
        name: upload.name,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        localPath: upload.path,
      })),
    ];

    // El turno se reintenta si la conexión con la base se corta (P1017 con el
    // pooler de Supabase): perder la respuesta ya cobrada al modelo es lo peor
    // que puede pasar aquí.
    const [userMessage, assistantMessage] = await withDbRetry(() => prisma.$transaction(async (tx) => {
      const user = await tx.aiMessage.create({
        data: { conversationId: activeConversation.id, role: 'user', content: message },
      })

      if (stored.length > 0) {
        await tx.aiAttachment.createMany({
          data: stored.map((attachment) => ({
            messageId: user.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            localPath: attachment.localPath || null,
          })),
        })
      }

      const assistant = await tx.aiMessage.create({
        data: {
          conversationId: activeConversation.id,
          role: 'assistant',
          content: reply.text,
          stepStage: reply.stage,
          // Propuesta de apunte pendiente de tu permiso: se guarda con el turno
          // para que el botón siga ahí aunque recargues la página.
          // Si el número no cuadra con el título que él mismo ha escrito (le
          // piden orgánica y propone la unidad que está dando en clase), se
          // guarda ya corregido: la tarjeta del chat y el redactor de apuntes
          // leen esto, y así los dos hablan de la misma unidad.
          noteProposal: reply.proposal
            ? JSON.stringify({
                ...reply.proposal,
                unitNumber: correctedProposal?.unitNumber ?? reply.proposal.unitNumber,
              })
            : null,
          // Solo Gemini devuelve pasos crudos reutilizables en el siguiente turno.
          rawStepsJson: reply.steps.length > 0 ? JSON.stringify(reply.steps) : null,
        },
      })

      return [user, assistant] as const;
    }), { label: 'tutor: guardar turno' })

    // Medición real que aporta el catedrático: [[nivel:U4=55]] al final del
    // mensaje. Se anota como nivel diagnosticado, nunca como valor de fábrica.
    let measured: { unitNumber: number; title: string; mastery: number } | null = null;
    /** Lo que el diagnóstico ha programado en la agenda (catedrático → planificador). */
    let plannerSync: TutorPlannerSyncResult | null = null;
    if (reply.level) {
      const unit = subjectUnits.find((candidate) => candidate.unitNumber === reply.level!.unitNumber);
      if (unit) {
        await prisma.topic.update({
          where: { id: unit.id },
          data: {
            masteryLevel: reply.level.mastery,
            masterySource: 'diagnostico',
            lastReviewedAt: new Date(),
          },
        })
        measured = { unitNumber: reply.level.unitNumber, title: unit.title, mastery: reply.level.mastery };
        console.log(
          `[tutor] nivel diagnosticado: ${agent.subject.name} U${measured.unitNumber} = ${measured.mastery}%`
        );

        // Catedrático → Planificador: si la unidad sale floja, entra en la
        // agenda de hoy (ficha de error + plan rehecho). No se deja para luego:
        // un diagnóstico sin sesión es una etiqueta, no una corrección.
        plannerSync = await syncTutorWithPlanner({
          subjectId: agent.subjectId,
          topicId: unit.id,
          unitNumber: unit.unitNumber,
          unitTitle: unit.title,
          mastery: reply.level.mastery,
          agentName: agent.name,
          conversationId: activeConversation.id,
        }).catch((error) => {
          console.error('[tutor] no se ha podido sincronizar con el Planificador:', error);
          return null;
        });
        if (plannerSync) {
          console.log(
            `[tutor] Planificador: ${plannerSync.reason} · ${plannerSync.created} sesión(es) · ${plannerSync.plannedMinutes} min${plannerSync.registeredError ? ' · ficha de error abierta' : ''}`
          );
        }
      }
    }

    // ¿Ha podido leer lo que se le ha dado? Hay dos vías y no son la misma:
    //   · El TEXTO de PDFs, Word, PowerPoint y texto lo lee cualquier proveedor,
    //     porque la app lo extrae y lo mete en el prompt (`documentIndexes`).
    //   · Los BYTES de una captura o de un escaneo solo los lee un modelo con
    //     visión. Gemini siempre; Groq/OpenRouter/Ollama, solo si el modelo
    //     elegido está en la lista de multimodales.
    // Antes se daba por no leído todo lo que no fuera Gemini, aunque el texto
    // del documento estuviera en el prompt: el aviso mentía y el modelo se
    // disculpaba por no ver un PDF que sí tenía delante.
    const supportsVision =
      reply.provider !== 'local' && modelSupportsVision(reply.provider, reply.model);
    const imageParts = attachmentParts.filter((part) => isImageMime(part.mimeType));
    const unreadableImages = supportsVision || reply.provider === 'gemini' ? [] : imageParts;
    const unreadableDocuments =
      reply.provider === 'gemini'
        ? []
        : [...uploads, ...validAttachments].filter(
            (attachment) =>
              !isImageMime(attachment.mimeType) &&
              !documentIndexes.some((doc) => doc.name === attachment.name)
          );
    const unreadable = [...unreadableImages, ...unreadableDocuments];
    const attachmentsReadable = unreadable.length === 0;

    if (attachmentParts.length > 0 || documentIndexes.length > 0) {
      console.log(
        `[tutor] adjuntos: ${uploads.length + validAttachments.length} · documentos con texto: ${documentIndexes.length} · bytes enviados: ${attachmentParts.length} · proveedor ${reply.provider}${supportsVision ? ' (visión)' : ''} · legibles: ${attachmentsReadable}${unreadable.length > 0 ? ` · sin leer: ${unreadable.map((a) => a.name).join(', ')}` : ''}`
      );
    }
    if (shareNotes && sharedNotes.length > 0) {
      console.log(`[tutor] apuntes compartidos: ${sharedNotes.length} de ${notesTotal}`);
    }

    // Lo hablado hoy se apunta como memoria DESPUÉS de contestar (`after`): el
    // alumno no espera a que el sistema escriba el recuerdo, y si esto falla la
    // respuesta ya está dada. Las reglas escriben siempre; el modelo solo pule.
    after(async () => {
      try {
        const remembered = await rememberConversation({
          scope: agent.id,
          conversationId: activeConversation.id,
          polish: (raw) =>
            polishMemoryWithAi(raw, `${agent.name}, catedrático de ${agent.subject.name}`),
        })
        if (remembered) {
          console.log(
            `[memoria] ${agent.name}: ${remembered.polished ? 'pulida' : 'de reglas'} · ${remembered.summary.slice(0, 110)}`
          );
        }
      } catch (error) {
        console.error('[memoria] no se pudo escribir la del catedrático:', error);
      }
    })

    return NextResponse.json({
      conversationId: activeConversation.id,
      model: reply.model,
      provider: reply.provider,
      /** Contesta el respaldo local: el cliente puede avisar de que no hay IA. */
      degraded,
      measured,
      attachments: stored.map((attachment) => ({
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      })),
      attachmentsReadable,
      /** Nombres que el modelo de este turno no ha podido leer (capturas sin visión…). */
      unreadable: unreadable.map((attachment) => attachment.name),
      /** Qué se ha podido leer de cada archivo, para poder decírselo al alumno. */
      documents: uploads.map((upload) => ({
        name: upload.name,
        pages: upload.pages,
        chars: upload.chars,
        mode: upload.mode,
        notes: upload.notes,
      })),
      /** Archivos que ni se han podido mirar por tamaño (se dice, no se calla). */
      notRead: tooBigToSee,
      sharedNotes: sharedNotes.map((note) => ({
        id: note.id,
        title: note.title,
        topicLabel: note.topicLabel,
      })),
      notesTotal,
      /** Qué ha programado el diagnóstico en la agenda (null si no tocaba refuerzo). */
      plannerSync,
      noteProposal: correctedProposal,
      /** Documento guardado que el catedrático ha pedido proyectar al lado del chat. */
      openNote,
      userMessageId: userMessage.id,
      reply: {
        id: assistantMessage.id,
        role: 'assistant',
        content: assistantMessage.content,
        stage: assistantMessage.stepStage,
        createdAt: assistantMessage.createdAt,
      },
    })
  } catch (error) {
    console.error('[tutor] Error inesperado:', error);

    // Siempre JSON con forma de error: el cliente nunca debe recibir un HTML de
    // pasarela ni una conexión cortada. Si el fallo es de la IA, se conserva su
    // estado (429 cupo, 502 proveedor, 503 sin motor) y su mensaje, que ya está
    // escrito para el alumno. El resto se cuenta como 500 sin filtrar detalles.
    if (error instanceof TutorError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          kind: error.kind ?? 'ia',
          retryable: error.status === 429 || error.status >= 500,
        },
        { status: error.status, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error:
          'El catedrático no ha podido responder por un fallo del servidor. Tu mensaje no se ha perdido: vuelve a intentarlo en unos segundos.',
        kind: 'servidor',
        retryable: true,
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
