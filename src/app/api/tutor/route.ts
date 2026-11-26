import { NextResponse, after } from 'next/server';
import { publicTutorError } from '@/lib/tutorPublicError';
import { TUTOR_STREAM_STATUS_LINES, tutorSseFrame, type TutorStreamEvent } from '@/lib/tutorStream';
import { turnRowId } from '@/lib/tutorTurnKey';
import { currentTenant } from '@/lib/tenantContext';
import { loadMemoryBlock, rememberConversation } from '@/lib/agentMemory';
import { polishMemoryWithAi } from '@/lib/agentMemoryPolish';
import { loadCoachPromptBlock, refreshCoachAdvice } from '@/lib/coach/store';
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
import { normalizeSubjectMode } from '@/lib/subjects/modes';
import { activateAiCredentials, ensureAiAccess } from '@/lib/ai/access';
import { buildLocalTutorReply, LOCAL_TUTOR_PROVIDER } from '@/lib/tutorFallback';
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
import { detectOpenNoteIntent, matchNoteIntent } from '@/lib/noteIntent';
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_TUTOR_ATTACHMENTS,
  formatBytes,
  isImageMime,
} from '@/lib/attachmentLimits';
import { readUpload, readUploadBytes, type StoredUpload } from '@/lib/docStore';
import { buildDocumentContext, parsePageRequests, type IndexedDoc } from '@/lib/docContext';
import { startOfDay } from '@/lib/srs';
import { readTodayPlanConstraints } from '@/lib/planner/constraintStore';
import { openDocument } from '@/lib/tutorDocuments';
import { loadSourceChunksForSubject } from '@/lib/study/retrievalServer';
import {
  chunksFromNote,
  chunksFromUpload,
  isConversationalQuery,
  normalizeRetrievalMode,
  normalizeTutorScope,
  selectRetrievalContext,
} from '@/lib/study/retrieval';
import {
  buildStrictOutOfScopeReply,
  buildTutorScopeLayer,
  parseStudyMeta,
  validateStudyAnswer,
  type StudyAnswerMeta,
} from '@/lib/study/answerContract';
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
  /** Modo de trabajo del turno (Paso 14): diagnostico, entrenar, simulacro… */
  mode?: unknown;
  /**
   * Ámbito de fuentes (Fase 4): `estudio` (cerrado a su material), `curiosidad`
   * (abierto y etiquetado) o `examen` (sin pistas). Por defecto, `estudio`.
   */
  scope?: unknown;
  /**
   * Clave idempotente que genera el navegador UNA vez por turno y reutiliza en
   * los reintentos. Con ella, el mensaje del alumno tiene un id determinista y
   * un reintento tras perder la conexión no duplica ni el mensaje ni la
   * respuesta.
   */
  clientKey?: unknown;
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

/** ¿El cliente pide una respuesta en streaming? */
function wantsEventStream(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('text/event-stream');
}

/** Violación de clave única de Prisma (reintento idempotente). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
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

/**
 * POST /api/tutor
 *
 * Si el cliente manda `Accept: text/event-stream`, la respuesta es SSE: el
 * turno empieza a contestar en el acto, con latidos mientras la IA trabaja, y
 * el texto llega en deltas. Los clientes antiguos (y las verificaciones)
 * siguen recibiendo JSON si no piden streaming.
 */
export async function POST(request: Request) {
  if (wantsEventStream(request)) return streamTutorTurn(request);
  return handleTutor(request);
}

async function handleTutor(
  request: Request,
  options: { defer?: (work: () => Promise<void>) => void } = {}
) {
  const { user: authUser, tenant } = await currentTenant();
  // Sin clave propia (y sin estar en PLATFORM_AI_USER_IDS) no se llama al
  // motor: 402 `ai_key_required` antes de gastar ni un token.
  /*
   * El ámbito de credenciales se activa EN ESTA FUNCIÓN, no dentro de la puerta.
   * `activateAiCredentials` usa `AsyncLocalStorage.enterWith`, que cambia el
   * contexto del recurso que ejecuta en ese momento: si se llamara desde dentro
   * de `ensureAiAccess`, al volver aquí ya no habría ámbito y el motor diría que
   * no hay ningún proveedor teniendo la clave propia del alumno.
   */
  const ai = await ensureAiAccess(authUser.id);
  if (ai.denied) return ai.denied;
  activateAiCredentials(ai.credentials);
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
  const mode = normalizeSubjectMode(body.mode);
  const scope = normalizeTutorScope(body.scope);
  const retrievalMode = normalizeRetrievalMode();
  // Por defecto los apuntes se comparten: es justo lo que el alumno ha pedido.
  const shareNotes = body.shareNotes === undefined ? true : body.shareNotes !== false;
  const rawClientKey = typeof body.clientKey === 'string' ? body.clientKey.trim() : '';
  const clientKey = rawClientKey.length > 0 && rawClientKey.length <= 200 ? rawClientKey : null;
  /** Ids deterministas del turno: el reintento cae en las MISMAS filas. */
  const turnUserRowId = clientKey ? turnRowId(authUser.id, clientKey, 'user') : null;
  const turnReplyRowId = clientKey ? turnRowId(authUser.id, clientKey, 'reply') : null;

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
    await Promise.all(uploadIds.map((id) => readUpload(authUser.id, id).catch(() => null)))
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
    const agent = await tenant.aiAgent.findUnique({
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
      ? await tenant.aiConversation.findFirst({
          where: { id: conversationId, agentId },
        })
      : freshConversation
        ? await tenant.aiConversation.create({
            data: {
              agentId,
              title: (message || validAttachments[0]?.name || 'Consulta de Estudio').slice(0, 60),
            },
          })
        : (await tenant.aiConversation.findFirst({
            where: { agentId },
            orderBy: { createdAt: 'desc' },
          })) ??
          (await tenant.aiConversation.create({
            data: {
              agentId,
              title: (message || validAttachments[0]?.name || 'Consulta de Estudio').slice(0, 60),
            },
          }));

    const activeConversation =
      conversation ??
      (await tenant.aiConversation.create({
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
      // Corpus persistente de la materia: documentos indexados del alumno.
      // Si la consulta falla, el chat sigue con sus notas y sus adjuntos; no se
      // convierte un fallo de lectura en una respuesta inventada.
      sourceChunks,
      // La memoria entre días: lo que este catedrático ya habló con él en esta
      // materia. Cadena vacía el primer día (y entonces no se añade nada al prompt).
      memoryBlock,
      // El ajuste pedagógico que dejó el coach en segundo plano. Se lee, no se
      // calcula aquí: este turno no espera al análisis de patrones.
      coachBlock,
      planConstraints,
    ] = await Promise.all([
      tenant.userProfile.findUnique({ where: { id: authUser.id } }),
      tenant.topic.findMany({
        where: { subjectId: agent.subjectId, masterySource: { not: 'sin_medir' } },
        orderBy: { masteryLevel: 'asc' },
        take: 8,
        select: { title: true, masteryLevel: true, unitNumber: true, masterySource: true },
      }),
      tenant.topic.count({ where: { subjectId: agent.subjectId, masterySource: 'sin_medir' } }),
      tenant.topic.findMany({
        where: { subjectId: agent.subjectId },
        orderBy: { unitNumber: 'asc' },
        select: { id: true, title: true, unitNumber: true, status: true, teacherMethod: true },
      }),
      tenant.exam.findMany({
        where: { subjectId: agent.subjectId, examDate: { gte: new Date() } },
        orderBy: { examDate: 'asc' },
        take: 3,
        select: { title: true, examDate: true, examType: true },
      }),
      tenant.errorLog.count({
        where: { subjectId: agent.subjectId, isMastered: false },
      }),
      // Planificador → catedrático: lo que hay programado para hoy, con su
      // estado. Sin esto el chat podía proponer algo que la agenda ya descartó.
      tenant.studyBlock.findMany({
        where: { date: { gte: nowStart, lt: todayEnd } },
        orderBy: [{ orderIndex: 'asc' }],
        select: {
          durationMinutes: true,
          technique: true,
          isCompleted: true,
          topic: { select: { title: true, subject: { select: { name: true } } } },
        },
      }),
      tenant.aiMessage.findMany({
        where: {
          conversationId: activeConversation.id,
          // En un reintento, el mensaje de ESTE turno ya está guardado: no debe
          // entrar en el historial y repetirse delante del modelo.
          ...(turnUserRowId ? { id: { not: turnUserRowId } } : {}),
        },
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
        ? tenant.note
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
      tenant.note.count({ where: { topic: { subjectId: agent.subjectId } } }),
      loadSourceChunksForSubject(authUser.id, agent.subjectId).catch((error) => {
        console.warn('[tutor] no se ha podido leer el corpus persistente:', error);
        return [];
      }),
      loadMemoryBlock(authUser.id, agent.id),
      loadCoachPromptBlock(authUser.id, agent.subjectId),
      // Si las restricciones no se pueden leer, el chat sigue: el contexto es
      // útil, no una condición para contestar.
      readTodayPlanConstraints(authUser.id)
        .then((today) => today.constraints)
        .catch(() => []),
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

    /*
     * APERTURA DETERMINISTA: «ábreme los apuntes de la unidad 3 de filosofía»
     * no puede depender de que el modelo recuerde escribir `[[abrir:N3]]`. La
     * app reconoce la petición, busca el apunte en el cuaderno por unidad y
     * título, y lo abre ella misma. El modelo recibe la pista para que su texto
     * acompañe a la apertura; si aun así no pone la etiqueta, la apertura ya
     * está resuelta aquí abajo.
     */
    const openIntent = shareNotes ? detectOpenNoteIntent(message) : null;
    const intentNote = openIntent
      ? matchNoteIntent(
          openIntent,
          noteRows.map((row) => ({
            id: row.id,
            title: row.title,
            unitNumber: row.unitNumber,
            unitTitle: row.topicTitle,
          })),
          agent.subject.name
        )
      : null;
    if (openIntent) {
      console.log(
        `[tutor] petición de apertura: «${openIntent.raw.slice(0, 120)}» → ${
          intentNote ? `«${intentNote.title}»` : 'sin coincidencia clara'
        }`
      );
    }
    const requestedNoteHint = intentNote
      ? {
          key: noteIndex.find((entry) => entry.id === intentNote.id)?.key ?? '',
          title: intentNote.title,
        }
      : null;

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

    // Corpus de este turno: documentos persistidos + notas del cuaderno +
    // documentos que acaba de subir. El filtro por dueño se repite dentro de
    // `selectRetrievalContext` aunque todas las fuentes ya vengan acotadas.
    const noteChunks = shareNotes
      ? noteRows.flatMap((note) =>
          chunksFromNote({
            id: note.id,
            userId: authUser.id,
            title: note.title,
            topicTitle: note.topicTitle,
            content: note.content,
          })
        )
      : [];
    const uploadChunks = documentIndexes.flatMap((doc) =>
      chunksFromUpload({ userId: authUser.id, doc })
    );
    // Un turno sin texto (solo adjunto) se lee en orden; un saludo no se
    // convierte en «fuera de temario». En ambos casos no se inventa contenido.
    const retrievalQuery = message.trim().length > 0 ? message : '';
    const allowNoMatch = message.trim().length === 0 || isConversationalQuery(message);
    const retrievalPlan = selectRetrievalContext({
      userId: authUser.id,
      chunks: [...sourceChunks, ...noteChunks, ...uploadChunks],
      query: retrievalQuery,
      scope,
      mode: retrievalMode,
      pages: requestedPages,
      budgetChars: 30_000,
      maxChunks: 20,
      allowNoMatch,
    });

    // En estudio manda el contrato de citas; en curiosidad se conserva el
    // contexto de documentos de siempre (exploración abierta).
    const documentsBlock =
      scope === 'estudio'
        ? retrievalPlan.prompt
        : buildDocumentContext(documentIndexes, questionForModel, {
            ...(requestedPages.length > 0 ? { pages: requestedPages } : {}),
          });

    if (scope === 'estudio') {
      console.log(
        `[tutor] estudio: ${retrievalPlan.corpusBlocks} bloques en la materia · ${retrievalPlan.retrievedBlocks} enviados · modo ${retrievalPlan.mode}${retrievalPlan.outOfScope ? ` · fuera de ámbito (${retrievalPlan.reason})` : ''}`
      );
    }

    if (documentIndexes.length > 0) {
      console.log(
        `[tutor] documentos: ${documentIndexes.map((doc) => `${doc.name} (${doc.pages} pág., ${doc.chars} car.)`).join(' | ')} · extracto de ${documentsBlock.length} caracteres${requestedPages.length > 0 ? ` · páginas pedidas: ${requestedPages.join(', ')}` : ''}`
      );
    }

    let systemInstruction = buildTutorSystemPrompt(
      {
        name: agent.name,
        specialty: agent.specialty,
        systemPrompt: agent.systemPrompt,
        subject: {
          name: agent.subject.name,
          category: agent.subject.category,
          currentGrade: agent.subject.currentGrade,
          gradeSource: agent.subject.gradeSource,
          targetGrade: agent.subject.targetGrade,
        },
      },
      {
        studentName: student?.name ?? 'Estudiante',
        modality: student?.modality ?? '1º de Bachillerato',
        mode,
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
          ? {
              title: courseUnit.title,
              unitNumber: courseUnit.unitNumber,
              status: courseUnit.status,
              teacherMethod: courseUnit.teacherMethod,
            }
          : null,
        constraints: planConstraints,
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
        requestedNote: requestedNoteHint?.key ? requestedNoteHint : null,
        memory: memoryBlock,
        coach: coachBlock,
        documents: documentsBlock,
      }
    );

    systemInstruction += `\n\n${buildTutorScopeLayer({
      scope,
      hasSources: retrievalPlan.chunks.length > 0,
      corpusBlocks: retrievalPlan.corpusBlocks,
    })}`;

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

      const bytes = await readUploadBytes(authUser.id, upload.id);
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

    // Si el turno traía archivos pero no ha quedado nada legible, el modelo
    // tiene que saberlo. Sin esto podía inventarse el contenido o disculparse
    // por algo que nadie le había dicho.
    if (
      uploads.length + validAttachments.length > 0 &&
      attachmentParts.length === 0 &&
      documentIndexes.length === 0
    ) {
      const names = [...uploads, ...validAttachments].map((item) => `«${item.name}»`).join(', ');
      systemInstruction += `\n\nMATERIAL DEL ALUMNO NO LEGIBLE: el alumno ha adjuntado ${names}, pero la app no ha podido extraer ni enviar su contenido (demasiado grande o sin texto legible). Dilo con claridad y pídele que lo suba por partes, como captura o en PDF con texto; NO inventes lo que dice el archivo.`;
    }

    /**
     * PERSISTENCIA ANTES DE INFERENCIA.
     *
     * El mensaje del alumno (y sus adjuntos) se guardan ANTES de llamar al
     * modelo. Si la IA tarda, falla o el móvil pierde la conexión, el turno ya
     * está en la base y el reintento con la misma `clientKey` cae en la misma
     * fila en vez de duplicarla. Si la respuesta anterior ya existe, se devuelve
     * tal cual: el alumno ve su contestación sin gastar otra llamada.
     */
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

    let userMessageRow = turnUserRowId
      ? await tenant.aiMessage.findUnique({
          where: { id: turnUserRowId },
          select: { id: true, createdAt: true },
        })
      : null;

    if (!userMessageRow) {
      try {
        userMessageRow = await tenant.aiMessage.create({
          data: {
            ...(turnUserRowId ? { id: turnUserRowId } : {}),
            userId: authUser.id,
            conversationId: activeConversation.id,
            role: 'user',
            content: message,
          },
          select: { id: true, createdAt: true },
        });

        if (stored.length > 0) {
          await tenant.aiAttachment.createMany({
            data: stored.map((attachment) => ({
              userId: authUser.id,
              messageId: userMessageRow!.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              localPath: attachment.localPath || null,
            })),
          });
        }
      } catch (error) {
        // Otro reintento se nos ha adelantado: se reutiliza su fila.
        if (!turnUserRowId || !isUniqueViolation(error)) throw error;
        userMessageRow = await tenant.aiMessage.findUnique({
          where: { id: turnUserRowId },
          select: { id: true, createdAt: true },
        });
        if (!userMessageRow) throw error;
      }
    }

    if (turnUserRowId && turnReplyRowId) {
      const existingReply = await tenant.aiMessage.findUnique({
        where: { id: turnReplyRowId },
        select: {
          id: true,
          content: true,
          stepStage: true,
          studyMetaJson: true,
          createdAt: true,
        },
      });
      if (existingReply && existingReply.content.trim().length > 0) {
        return NextResponse.json({
          conversationId: activeConversation.id,
          replayed: true,
          degraded: false,
          measured: null,
          attachments: stored.map((attachment) => ({
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          })),
          attachmentsReadable: true,
          unreadable: [],
          documents: [],
          notRead: [],
          sharedNotes: [],
          notesTotal,
          scope,
          study: parseStudyMeta(existingReply.studyMetaJson),
          plannerSync: null,
          noteProposal: null,
          openNote: null,
          userMessageId: userMessageRow.id,
          reply: {
            id: existingReply.id,
            role: 'assistant',
            content: existingReply.content,
            stage: existingReply.stepStage,
            createdAt: existingReply.createdAt,
          },
        });
      }
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
    let studyMeta: StudyAnswerMeta | null = null;

    if (scope === 'estudio' && retrievalPlan.outOfScope) {
      // Degradación honesta ANTES de llamar: si no hay material o nada se parece
      // a la pregunta, no se gasta una llamada ni se completa con conocimiento
      // general. La UI ofrece cambiar a curiosidad.
      reply = {
        text: buildStrictOutOfScopeReply(retrievalPlan.reason),
        stage: null,
        level: null,
        proposal: null,
        openNote: null,
        steps: [],
        model: 'catedrático local',
        provider: LOCAL_TUTOR_PROVIDER,
      };
      studyMeta = {
        scope: 'estudio',
        outOfScope: true,
        status: 'sin_respaldo',
        coverage: {
          withCitation: 0,
          total: 0,
          ratio: 0,
          citedBlocks: 0,
          retrievedBlocks: 0,
          corpusBlocks: retrievalPlan.corpusBlocks,
        },
        sources: [],
        invalidCitations: 0,
        verifiedCitations: 0,
      };
    } else try {
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
        // Los PDF/Word con texto ya viajan en `documentsBlock`. Sin declararlo,
        // Groq/OpenRouter se disculpaban por «no poder leer archivos» aunque
        // tuvieran el texto delante.
        readableTextAttachments: documentIndexes.map((doc) => doc.name),
        history,
      });
      reply = parseTutorResult(result);

      if (scope === 'estudio') {
        const checked = validateStudyAnswer({
          raw: reply.text,
          userId: authUser.id,
          allowed: retrievalPlan.allowed,
          meta: retrievalPlan.chunkMeta,
          retrievedBlocks: retrievalPlan.retrievedBlocks,
          corpusBlocks: retrievalPlan.corpusBlocks,
        });
        reply.text = checked.markdown;
        studyMeta = checked.meta;
      }
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

      const attachmentCount = uploads.length + validAttachments.length;
      const localText = buildLocalTutorReply({
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
      });
      reply = {
        text:
          attachmentCount > 0
            ? `${localText}\n\n⚠️ No he podido leer el archivo adjunto en este turno. No voy a inventar su contenido: vuelve a subirlo (mejor en PDF con texto o como captura) cuando la IA esté disponible.`
            : localText,
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

    // Si el turno de estudio acabó en respaldo local (sin IA), no hay citas que
    // verificar: se declara cobertura cero en vez de dejar la interfaz muda.
    if (scope === 'estudio' && !studyMeta) {
      studyMeta = {
        scope: 'estudio',
        outOfScope: false,
        status: 'sin_respaldo',
        coverage: {
          withCitation: 0,
          total: 0,
          ratio: 0,
          citedBlocks: 0,
          retrievedBlocks: retrievalPlan.retrievedBlocks,
          corpusBlocks: retrievalPlan.corpusBlocks,
        },
        sources: [],
        invalidCitations: 0,
        verifiedCitations: 0,
      };
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

    // Apertura de un apunte guardado: primero manda la petición explícita del
    // alumno ya resuelta contra el cuaderno (aunque el modelo no haya puesto la
    // etiqueta); después, la clave que haya escrito el catedrático. Una clave
    // inventada no abre nada y se avisa en consola en vez de pedir un apunte
    // que no existe.
    const requestedNote = intentNote
      ? noteIndex.find((entry) => entry.id === intentNote.id)
      : reply.openNote
        ? noteIndex.find((entry) => entry.key === reply.openNote!.key)
        : undefined;
    if (reply.openNote && !requestedNote) {
      console.warn(
        `[tutor] el catedrático ha pedido abrir «${reply.openNote.key}», que no está en el índice del cuaderno`
      );
    }
    if (intentNote && requestedNote) {
      console.log(`[tutor] abriendo apunte guardado por petición explícita: «${requestedNote.title}»`);
    }
    // La apertura se ejecuta en servidor con el userId de la sesión. Aunque el
    // índice ya está acotado, esta es la comprobación final de que el apunte
    // existe y es suyo; al modelo nunca se le manda el id ni el dueño.
    const openedDocument = requestedNote
      ? await openDocument(authUser.id, 'note', requestedNote.id)
      : null;
    const openNote =
      requestedNote && openedDocument?.ok
        ? {
            id: requestedNote.id,
            title: openedDocument.title ?? requestedNote.title,
            unitNumber: requestedNote.unitNumber,
            unitTitle: requestedNote.unitTitle,
            subjectId: agent.subjectId,
            /** Cita estable: el panel se puede abrir desde esta dirección. */
            href: `?doc=note:${requestedNote.id}`,
          }
        : null;

    // La respuesta se guarda con un id determinista cuando hay `clientKey`: si
    // dos reintentos llegan a la vez, el segundo recupera la respuesta ya escrita
    // en vez de crear un mensaje duplicado.
    let assistantMessage: {
      id: string;
      content: string;
      stepStage: string | null;
      createdAt: Date;
    };
    try {
      assistantMessage = await tenant.aiMessage.create({
        data: {
          ...(turnReplyRowId ? { id: turnReplyRowId } : {}),
          userId: authUser.id,
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
          // Solo los proveedores que devuelven pasos crudos los guardan.
          rawStepsJson: reply.steps.length > 0 ? JSON.stringify(reply.steps) : null,
          // La franja de cobertura se guarda con la respuesta: al recargar, la
          // interfaz reconstruye las mismas métricas verificadas del turno.
          studyMetaJson: studyMeta ? JSON.stringify(studyMeta) : null,
        },
        select: { id: true, content: true, stepStage: true, createdAt: true },
      });
    } catch (error) {
      if (!turnReplyRowId || !isUniqueViolation(error)) throw error;
      const existing = await tenant.aiMessage.findUnique({
        where: { id: turnReplyRowId },
        select: {
          id: true,
          content: true,
          stepStage: true,
          studyMetaJson: true,
          createdAt: true,
        },
      });
      if (!existing) throw error;
      assistantMessage = existing;
    }

    // Medición real que aporta el catedrático: [[nivel:U4=55]] al final del
    // mensaje. Se anota como nivel diagnosticado, nunca como valor de fábrica.
    let measured: { unitNumber: number; title: string; mastery: number } | null = null;
    /** Lo que el diagnóstico ha programado en la agenda (catedrático → planificador). */
    let plannerSync: TutorPlannerSyncResult | null = null;
    if (reply.level) {
      const unit = subjectUnits.find((candidate) => candidate.unitNumber === reply.level!.unitNumber);
      if (unit) {
        await tenant.topic.update({
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
          userId: authUser.id,
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
    // En modo streaming el `after` del framework puede quedar fuera del ámbito
    // de la petición: se ejecuta igual, sin retrasar el cierre del stream.
    const defer = options.defer ?? after;
    defer(async () => {
      try {
        const remembered = await rememberConversation(authUser.id, {
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

      // El coach se recalcula también fuera de la respuesta. Si falla, el chat
      // sigue igual: en el peor caso se conserva el perfil anterior (caduca a
      // los 14 días) o no se añade ningún ajuste.
      try {
        const coach = await refreshCoachAdvice(authUser.id, agent.subjectId, {
          timezone: student?.timezone ?? null,
        });
        if (coach) {
          console.log(
            `[coach] ${coach.signals.length} señal(es) · ${coach.rigor}/${coach.explanationFocus} · ${coach.fingerprint}`
          );
        }
      } catch (error) {
        console.error('[coach] no se pudo actualizar el perfil pedagógico:', error);
      }
    })

    return NextResponse.json({
      conversationId: activeConversation.id,
      /** Contesta el respaldo local: el cliente puede ofrecer reintentar. */
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
      scope,
      /** Contrato de citas y cobertura del turno (solo en modo estudio). */
      study: studyMeta,
      /** Qué ha programado el diagnóstico en la agenda (null si no tocaba refuerzo). */
      plannerSync,
      noteProposal: correctedProposal,
      /** Documento guardado que el catedrático ha pedido proyectar al lado del chat. */
      openNote,
      userMessageId: userMessageRow.id,
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

    // Siempre JSON con forma de error, también en streaming: el cliente nunca
    // recibe un HTML de pasarela ni una conexión cortada. El mensaje público es
    // neutro (sin proveedor, modelo ni detalle de red); el detalle se queda en
    // el log del servidor.
    const failure = publicTutorError(error);
    return NextResponse.json(
      {
        ok: false,
        error: failure.message,
        retryable: failure.retryable,
      },
      { status: failure.status, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

/**
 * Respuesta SSE del mismo turno.
 *
 * El `POST` devuelve la cabecera al instante y el trabajo real sigue dentro del
 * stream: latidos cada 15 s (para que ni el móvil ni la pasarela la den por
 * muerta) y frases de estado pedagógicas mientras el catedrático prepara la
 * respuesta. El texto final se entrega en `delta` para que aparezca de forma
 * fluida en vez de en un bloque seco.
 *
 * Los deltas se generan al recibir la respuesta completa del motor: es
 * transporte en streaming, no tokens del proveedor. El contrato de la UI es el
 * mismo y el alumno ve la respuesta escribirse; cuando el motor exponga tokens,
 * solo cambia esta función.
 */
async function streamTutorTurn(request: Request): Promise<Response> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: TutorStreamEvent, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(tutorSseFrame(event, data)));
        } catch {
          // El alumno ha cerrado la pestaña: el turno sigue y se guarda igual.
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Ya estaba cerrado.
        }
      };

      send('open', { ok: true, academy: 'BrainUp Academy' });

      const heartbeat = setInterval(() => send('heartbeat', { at: Date.now() }), 15_000);
      let statusIndex = 0;
      const status = setInterval(() => {
        send('status', {
          text:
            TUTOR_STREAM_STATUS_LINES[statusIndex % TUTOR_STREAM_STATUS_LINES.length],
        });
        statusIndex += 1;
      }, 4_000);

      void (async () => {
        try {
          const response = await handleTutor(request, {
            defer: (work) => {
              void work().catch((error) =>
                console.error('[tutor] memoria en segundo plano:', error)
              );
            },
          });
          const data = (await response.json().catch(() => null)) as
            | { reply?: { content?: string }; error?: string; retryable?: boolean }
            | null;

          if (!response.ok || !data?.reply) {
            send('error', {
              error:
                data?.error ??
                'El catedrático no ha podido responder en este momento. Tu mensaje no se ha perdido: vuelve a intentarlo.',
              retryable: data?.retryable !== false,
              status: response.status,
            });
            return;
          }

          const characters = Array.from(String(data.reply.content ?? ''));
          if (characters.length > 0) {
            const pieces = Math.min(40, Math.max(1, Math.ceil(characters.length / 90)));
            const size = Math.max(1, Math.ceil(characters.length / pieces));
            for (let index = 0; index < characters.length; index += size) {
              send('delta', { text: characters.slice(index, index + size).join('') });
              await new Promise((resolve) => setTimeout(resolve, 12));
            }
          }

          send('done', data);
        } catch (error) {
          console.error('[tutor] stream interrumpido:', error);
          send('error', {
            error:
              'El catedrático no ha podido responder en este momento. Tu mensaje no se ha perdido: vuelve a intentarlo.',
            retryable: true,
          });
        } finally {
          clearInterval(heartbeat);
          clearInterval(status);
          close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Netlify y otras pasarelas no deben acumular el stream.
      'X-Accel-Buffering': 'no',
    },
  });
}
