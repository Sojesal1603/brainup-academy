import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  buildNoteWriterSystemPrompt,
  buildNoteWriterUserMessage,
  classifyNoteSubject,
  noteQualityReport,
  sanitizeNoteContent,
  splitNoteTitle,
  NOTE_INCOMPLETE_ISSUE_TITLE,
  type NotebookContextInput,
  type NoteQuality,
} from '@/lib/apuntesIa';
import { noteExcerpt } from '@/lib/tutorNotes';
import {
  getConfiguredProviders,
  hasAiProviderAsync,
  hasAnyFreeKey,
  runAiText,
  TutorError,
  type AiAttachmentPart,
  type AiProvider,
} from '@/lib/aiEngine';
import { loadMemoryBlock } from '@/lib/agentMemory';
import { rememberNoteDraft, takeNoteDraft } from '@/lib/noteDrafts';
import { resolveNoteUnit } from '@/lib/noteUnitMatch';
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_TUTOR_ATTACHMENTS,
  isImageMime,
} from '@/lib/attachmentLimits';
import { readUpload, readUploadBytes, type StoredUpload } from '@/lib/docStore';
import { buildDocumentContext, type IndexedDoc } from '@/lib/docContext';

/**
 * Escribe los apuntes que el catedrático ha propuesto.
 *
 * **El permiso es un contrato, no un adorno**: si la petición no trae
 * `confirmed: true`, aquí no se escribe nada. Ese "sí" lo da el alumno pulsando
 * el botón del chat, y queda claro en la API para que nadie pueda generar
 * apuntes a su espalda ni por error.
 *
 * Y se escribe en **dos pasos**:
 *
 *   1. `{ preview: true }` → redacta el apunte y lo devuelve para que el alumno
 *      lo lea **como va a quedar** en el cuaderno, sin guardar nada.
 *   2. `{ confirmed: true, draftToken }` → guarda ese mismo borrador, sin volver
 *      a llamar a la IA (redactar un apunte es la llamada más cara del sistema:
 *      no se gasta dos veces por el mismo apunte).
 *
 * Sin `draftToken` sigue valiendo el camino de siempre (`confirmed: true` a
 * secas): redacta y guarda de una vez. Eso mantiene viva la puerta vieja sin
 * que nadie pueda escribir nada de tapadillo.
 *
 * Es una llamada de IA aparte de la conversación, con su propio prompt: redactar
 * un apunte para imprimir no es lo mismo que responder una duda por chat.
 *
 * Y tiene tres controles que antes no tenía:
 *
 *   1. **Limpieza.** Todo lo que se guarda pasa por `sanitizeNoteContent`: fuera
 *      vallas de código, HTML, etiquetas invisibles y muletillas de chat.
 *   2. **Control de calidad.** Si al apunte le falta estructura o cuerpo, se le
 *      vuelve a pedir diciéndole exactamente qué faltaba (hasta dos veces más).
 *      Del intento bueno se queda el mejor; no se pierde nunca lo que ya estaba
 *      bien.
 *   3. **Un apunte inservible no se guarda.** Si al final sigue siendo un
 *      esquema de cuatro líneas, se avisa en vez de llenar el cuaderno de
 *      basura. Y si tiene cuerpo pero le falta el desarrollo punto por punto
 *      —que es lo que separa unos apuntes de cátedra de un resumen—, se guarda
 *      (lo que hay es suyo) y queda anotado en el taller para que se pueda
 *      reescribir.
 */

/**
 * Margen de tokens para la redacción. Los apuntes son la respuesta más larga
 * del sistema (desarrollo punto por punto + ejemplo resuelto), así que aquí sí
 * se paga el margen: aligerar el chat no puede costarle que el apunte salga a
 * medias.
 */
const NOTE_MAX_TOKENS = 7000;
/** Presupuesto del turno de redacción (los dos intentos juntos). */
const NOTE_BUDGET_MS = 150_000;
/** Margen de cada intento suelto. */
const NOTE_ATTEMPT_MS = 80_000;
/** Por debajo de esto no es un apunte: es un esquema, y no se guarda. */
const MIN_NOTE_WORDS = 500;
/**
 * Intentos de redacción como mucho: el primero y dos correcciones.
 *
 * Redactar un apunte es la llamada más cara del sistema, así que el tope es
 * corto: solo se vuelve a pedir mientras el anterior se quede corto, y en cuanto
 * una vuelta no mejora, se para (insistir con el mismo modelo rinde cada vez
 * menos y el alumno está esperando).
 */
const MAX_WRITE_ATTEMPTS = 3;

/** Cuántos apuntes suyos se le enseñan al redactor como extracto. */
const MAX_EXISTING_EXCERPTS = 3;

interface NotesBody {
  agentId?: unknown;
  conversationId?: unknown;
  /** Unidad del temario (la forma preferida). */
  unitNumber?: unknown;
  /** O directamente la unidad, si el cliente ya la conoce. */
  topicId?: unknown;
  /** Título propuesto por el catedrático (respaldo si el modelo no pone `# `). */
  title?: unknown;
  /** Lo que el alumno quiere que cubra, si lo ha dicho. */
  focus?: unknown;
  /** El alumno ha dado su permiso explícito. Sin esto, no se escribe nada. */
  confirmed?: unknown;
  /** Redactar y devolver para enseñarlo, SIN guardarlo (vista previa). */
  preview?: unknown;
  /** Vale de un borrador ya redactado que hay que guardar tal cual (paso 2). */
  draftToken?: unknown;
  /** Motor concreto con el que redactar (comparativa multi-IA). */
  provider?: unknown;
  /**
   * Documentos que el alumno subió en la consulta (páginas del libro, esquemas
   * del profesor). Viajan al redactor para que el apunte sea la teoría de SU
   * examen y no un temario genérico.
   */
  uploadIds?: unknown;
}

/** Motores que se pueden pedir explícitamente desde la comparativa. */
const COMPARABLE_PROVIDERS: AiProvider[] = ['gemini', 'groq', 'openrouter', 'nvidia', 'ollama'];

/**
 * Cómo explicó el profesor el tema, con las palabras del alumno.
 *
 * Va primero lo de ESTA unidad (es la que se está apuntando) y después lo de las
 * demás unidades con anotación: los convenios de un profesor se repiten, y saber
 * cómo corrigió el tema anterior ayuda a escribir el siguiente igual. Se acota a
 * cinco notas para no llenar el prompt de cosas de otras unidades.
 */
function buildTeacherMethodology(
  unit: { unitNumber: number | null; title: string; teacherMethod: string | null },
  others: Array<{ unitNumber: number | null; title: string; teacherMethod: string | null }>
): string | null {
  const parts: string[] = [];

  if (unit.teacherMethod && unit.teacherMethod.trim().length > 0) {
    parts.push(`«${unit.title}» (esta unidad): ${unit.teacherMethod.trim()}`);
  }

  for (const other of others) {
    if (!other.teacherMethod || other.teacherMethod.trim().length === 0) continue;
    if (other.unitNumber === unit.unitNumber) continue;
    if (parts.length >= 5) break;
    parts.push(
      `«${other.title}»${other.unitNumber ? ` (U${other.unitNumber})` : ''}: ${other.teacherMethod.trim()}`
    );
  }

  return parts.length > 0 ? parts.join(' | ') : null;
}

function daysUntil(date: Date): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/** Para comparar títulos y no duplicar el mismo apunte de la misma unidad. */
function normalizeTitle(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Deja en el taller la constancia de un apunte que salió sin la estructura de
 * cátedra, con el id del apunte para poder volver a él.
 *
 * Uno por apunte y sin repetirse: si el alumno vuelve a pedir el mismo apunte y
 * sale bien, el aviso se queda ahí como histórico hasta que el taller lo cierre.
 */
async function noteIncompleteIssue(
  noteId: string,
  title: string,
  quality: NoteQuality,
  content: string
): Promise<void> {
  const existing = await prisma.systemIssue.findFirst({
    where: { title: NOTE_INCOMPLETE_ISSUE_TITLE, status: { not: 'resuelto' }, contextJson: { contains: noteId } },
    select: { id: true },
  });
  if (existing) return;

  await prisma.systemIssue.create({
    data: {
      title: NOTE_INCOMPLETE_ISSUE_TITLE,
      detail: [
        `El apunte «${title}» se ha guardado, pero le falta: ${quality.structureMissing.join(', ')}.`,
        `Tiene ${quality.words} palabras y ${quality.developedPoints} apartado(s) de desarrollo.`,
        'Se puede reescribir desde el chat del catedrático pidiéndole los apuntes de esa unidad otra vez.',
      ].join('\n'),
      contextJson: JSON.stringify({
        kind: 'apunte_incompleto',
        noteId,
        words: quality.words,
        developedPoints: quality.developedPoints,
        structureMissing: quality.structureMissing,
        chars: content.length,
        at: new Date().toISOString(),
      }).slice(0, 4000),
      source: 'vigilante',
      status: 'abierto',
    },
  });

  console.warn(`[apuntes] apunte incompleto registrado en el taller: «${title}»`);
}

/**
 * Escribe el apunte en el cuaderno. Es la **única** puerta de escritura.
 *
 * Está aquí y no dentro del manejador porque ahora se entra por dos caminos (el
 * directo de siempre y el de «ya lo he leído y me convence»): con una sola
 * puerta, los dos caminos guardan igual —mismo control de duplicados, mismo
 * aviso al taller si sale sin estructura— y no pueden divergir con el tiempo.
 */
async function saveNoteToNotebook(params: {
  agentId: string;
  conversationId: string | null;
  unitId: string;
  title: string;
  content: string;
}): Promise<{ id: string; title: string; content: string; createdAt: Date; updated: boolean }> {
  // Si ya tenía un apunte del catedrático de esa misma unidad con el mismo
  // título, se actualiza en lugar de duplicarlo.
  const sameUnit = await prisma.note.findMany({
    where: { topicId: params.unitId, author: 'catedratico' },
    select: { id: true, title: true },
  });
  const duplicate = sameUnit.find(
    (note) => normalizeTitle(note.title) === normalizeTitle(params.title)
  );

  const saved = duplicate
    ? await prisma.note.update({
        where: { id: duplicate.id },
        data: {
          title: params.title,
          content: params.content,
          sourceConversationId: params.conversationId,
          updatedAt: new Date(),
        },
      })
    : await prisma.note.create({
        data: {
          topicId: params.unitId,
          title: params.title,
          content: params.content,
          tags: 'apuntes,catedratico',
          author: 'catedratico',
          agentId: params.agentId,
          sourceConversationId: params.conversationId,
        },
      });

  return {
    id: saved.id,
    title: saved.title,
    content: saved.content,
    createdAt: saved.createdAt,
    updated: Boolean(duplicate),
  };
}

export async function POST(request: Request) {
  let body: NotesBody;
  try {
    body = (await request.json()) as NotesBody;
  } catch {
    return NextResponse.json({ error: 'Petición inválida.' }, { status: 400 });
  }

  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  const conversationId =
    typeof body.conversationId === 'string' && body.conversationId.length > 0
      ? body.conversationId
      : null;
  const topicId = typeof body.topicId === 'string' && body.topicId.length > 0 ? body.topicId : null;
  const unitNumber = typeof body.unitNumber === 'number' ? body.unitNumber : null;
  const proposedTitle = typeof body.title === 'string' ? body.title.trim() : '';
  const focus = typeof body.focus === 'string' ? body.focus.trim() : '';
  /** Redactar para enseñarlo, sin guardar nada (vista previa). */
  const preview = body.preview === true;
  /** Vale de un borrador ya redactado que hay que guardar tal cual. */
  const draftToken = typeof body.draftToken === 'string' ? body.draftToken.trim() : '';
  /**
   * Motor elegido a mano para esta versión del apunte. Es opcional: sin él, la
   * cadena decide como siempre. Con él, la pestaña de la comparativa enseña la
   * versión de ESE motor y ninguna otra.
   */
  const requestedProvider = COMPARABLE_PROVIDERS.includes(body.provider as AiProvider)
    ? (body.provider as AiProvider)
    : null;
  const uploadIds = Array.isArray(body.uploadIds)
    ? body.uploadIds
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .slice(0, MAX_TUTOR_ATTACHMENTS)
    : [];

  if (requestedProvider && !getConfiguredProviders().includes(requestedProvider)) {
    return NextResponse.json(
      {
        error: 'Ese motor no está configurado ahora mismo. Elige otro de los disponibles o añade su clave en Ajustes.',
      },
      { status: 400 }
    );
  }

  if (!agentId) {
    return NextResponse.json({ error: 'Falta el catedrático.' }, { status: 400 });
  }

  // Sin el "sí" del alumno, aquí no se escribe nada.
  if (body.confirmed !== true) {
    return NextResponse.json(
      {
        error:
          'El catedrático necesita tu permiso antes de escribirte unos apuntes. Confirma la propuesta para que los redacte.',
      },
      { status: 403 }
    );
  }

  /*
   * PASO 2: guardar un borrador que el alumno YA ha leído.
   *
   * No se vuelve a llamar a la IA, así que no se gasta cupo por segunda vez y lo
   * que se guarda es exactamente lo que ha visto en la vista previa. Si el vale
   * ya no está (caduca en 45 minutos o el servidor se ha reiniciado), se dice
   * claro en vez de redactar otra cosa distinta que él no ha aprobado.
   */
  if (draftToken) {
    const draft = takeNoteDraft(draftToken);
    if (!draft) {
      return NextResponse.json(
        {
          error:
            'Ese apunte en vista previa ya no está disponible (los borradores caducan). Pídele al catedrático que te los redacte otra vez: son unos segundos.',
        },
        { status: 409 }
      );
    }

    try {
      const [agent, unit] = await Promise.all([
        prisma.aiAgent.findUnique({ where: { id: draft.agentId }, include: { subject: true } }),
        prisma.topic.findUnique({ where: { id: draft.topicId } }),
      ]);
      if (!agent || !unit) {
        return NextResponse.json(
          { error: 'Ese apunte ya no encaja en tu temario (la materia o la unidad han cambiado).' },
          { status: 409 }
        );
      }

      const quality = noteQualityReport(draft.content);
      const saved = await saveNoteToNotebook({
        agentId: agent.id,
        conversationId: draft.conversationId ?? conversationId,
        unitId: unit.id,
        title: draft.title,
        content: draft.content,
      });

      console.log(
        `[apuntes] ${saved.updated ? 'actualizado' : 'creado'} desde la vista previa · ${agent.subject.name} U${unit.unitNumber ?? '?'} «${saved.title}» · ${quality.words} palabras · ${quality.developedPoints} apartados · ${draft.provider}/${draft.model}`
      );

      if (quality.structureMissing.length > 0) {
        await noteIncompleteIssue(saved.id, saved.title, quality, saved.content).catch(() => {});
      }

      return NextResponse.json({
        ok: true,
        updated: saved.updated,
        model: draft.model,
        provider: draft.provider,
        quality: {
          words: quality.words,
          developedPoints: quality.developedPoints,
          missing: quality.missing,
          structureMissing: quality.structureMissing,
          /** No hubo redacción nueva: los números son los de la vista previa. */
          attempts: 1,
          retried: false,
          fromPreview: true,
        },
        note: {
          id: saved.id,
          title: saved.title,
          content: saved.content,
          author: 'catedratico',
          agentName: agent.name,
          topicId: unit.id,
          unitNumber: unit.unitNumber,
          unitTitle: unit.title,
          subjectId: agent.subjectId,
          subjectName: agent.subject.name,
          subjectColor: agent.subject.color,
          createdAt: saved.createdAt,
        },
      });
    } catch (error) {
      console.error('[apuntes] no se ha podido guardar la vista previa:', error);
      return NextResponse.json(
        { error: 'El apunte estaba listo, pero no se ha podido guardar en el cuaderno. Vuelve a intentarlo.' },
        { status: 500 }
      );
    }
  }

  if (!topicId && unitNumber === null) {
    return NextResponse.json(
      {
        error:
          'No sé de qué unidad quieres los apuntes: el catedrático tiene que proponerte una unidad concreta de su temario.',
      },
      { status: 400 }
    );
  }

    // Sondeo real (incluye el motor local): en una instancia serverless recién
    // arrancada Ollama todavía no constaba y se negaba a redactar sin motivo.
    if (!(await hasAiProviderAsync())) {
      return NextResponse.json(
        {
          error:
            'El motor de IA no está configurado: falta GEMINI_API_KEY (o GROQ_API_KEY) en el archivo .env, y no hay ningún modelo local levantado, así que no puedo redactar los apuntes.',
        },
        { status: 503 }
      );
    }

    // Sin ninguna clave con cupo no se encadenan treinta intentos: redactar un
    // apunte tardaba más de un minuto para acabar en el mismo error. Se dice ya,
    // que además es lo que el alumno necesita saber (esperar o añadir una clave).
    if (!hasAnyFreeKey()) {
      return NextResponse.json(
        {
          error:
            'Ahora mismo no queda cupo de IA: todas las claves configuradas están en espera. Se reanudan solas en unos minutos; si tienes prisa, añade otra clave gratuita en Ajustes y vuelve a darle.',
        },
        { status: 429 }
      );
    }

  try {
    const agent = await prisma.aiAgent.findUnique({
      where: { id: agentId },
      include: { subject: true },
    });

    if (!agent) {
      return NextResponse.json({ error: 'Catedrático no encontrado.' }, { status: 404 });
    }

    // La memoria entre días: lo que este catedrático ya trabajó con él en esta
    // asignatura. El apunte continúa el hilo en vez de empezar de cero.
    const memoryBlock = await loadMemoryBlock(agent.id).catch(() => '');

    // La unidad tiene que ser SUYA: un catedrático no escribe apuntes de otra
    // asignatura, por mucho que se lo pidan. Se trae el temario entero porque el
    // número que llega se contrasta con los títulos: si el catedrático se ha
    // equivocado de número (te pide orgánica —U9— y propone trabajo mecánico
    // —U16—), el título manda y los apuntes se escriben de la unidad de verdad.
    const subjectUnits = await prisma.topic.findMany({
      where: { subjectId: agent.subjectId },
      orderBy: { unitNumber: 'asc' },
      select: { id: true, unitNumber: true, title: true, status: true, teacherMethod: true },
    });

    const resolution = topicId
      ? {
          unit: subjectUnits.find((candidate) => candidate.id === topicId) ?? null,
          corrected: false,
          numbered: null,
        }
      : resolveNoteUnit(subjectUnits, { unitNumber, title: proposedTitle });
    const unit = resolution.unit;

    if (!unit) {
      return NextResponse.json(
        {
          error: topicId
            ? 'Esa unidad no es de su asignatura, así que no puedo escribirle apuntes de ella. Pídeselos al catedrático de esa materia.'
            : `La unidad ${unitNumber ?? '?'} no está en el temario de ${agent.subject.name}, así que no sé de qué escribir. Dime el tema con sus palabras y te los preparo de la unidad que sea.`,
        },
        { status: 404 }
      );
    }

    if (resolution.corrected && resolution.numbered) {
      console.warn(
        `[apuntes] la propuesta decía U${resolution.numbered.unitNumber} «${resolution.numbered.title}» pero «${proposedTitle}» corresponde a U${unit.unitNumber} «${unit.title}»: se escriben los de la unidad del título`
      );
    }

    // La fuente real del examen: los documentos que el alumno acaba de subir.
    // Se extrae su texto y se le pasa al redactor como material prioritario.
    const uploads = (
      await Promise.all(uploadIds.map((id) => readUpload(id).catch(() => null)))
    ).filter((upload): upload is StoredUpload => upload !== null);
    const documentIndexes: IndexedDoc[] = uploads
      .map((upload) => upload.index)
      .filter((index): index is IndexedDoc => index !== null);
    const sourceDocuments =
      documentIndexes.length > 0
        ? buildDocumentContext(documentIndexes, `${unit.title} ${proposedTitle} ${focus}`.trim())
        : null;

    /*
     * ADEMÁS DEL TEXTO, LOS BYTES: las fotos de exámenes, los escaneos sin capa
     * de texto y los PDFs con tablas o diagramas se le mandan a Gemini tal cual.
     * Su ventana de contexto permite leer el documento completo de una vez, y
     * es lo único que puede interpretar una tabla dibujada o un gráfico que el
     * extractor de texto no ve. El texto sigue yendo en el prompt: así el
     * redactor cita páginas incluso si el modelo no puede mirar los bytes.
     *
     * Se manda lo que cabe en una sola petición (15 MB en total), no lo que pesa
     * el archivo en disco: un libro de 40 MB se sigue leyendo por su texto.
     */
    const noteAttachments: AiAttachmentPart[] = [];
    let inlineBytes = 0;
    for (const upload of uploads) {
      const canBeSeen = isImageMime(upload.mimeType) || upload.mimeType === 'application/pdf';
      if (!canBeSeen) continue;
      if (
        upload.sizeBytes > MAX_INLINE_ATTACHMENT_BYTES ||
        inlineBytes + upload.sizeBytes > MAX_INLINE_ATTACHMENT_BYTES
      ) {
        continue;
      }
      const bytes = await readUploadBytes(upload.id).catch(() => null);
      if (!bytes || inlineBytes + bytes.byteLength > MAX_INLINE_ATTACHMENT_BYTES) continue;
      inlineBytes += bytes.byteLength;
      noteAttachments.push({
        name: upload.name,
        mimeType: upload.mimeType,
        data: bytes.toString('base64'),
      });
    }

    /** Los documentos cuyo TEXTO ya viaja en el prompt: no hay que decir que no se han leído. */
    const readableUploadNames = uploads
      .filter((upload) => upload.chars > 0)
      .map((upload) => upload.name);

    // Gemini es el motor multimodal de referencia. Se fuerza solo cuando hay un
    // archivo que SOLO se puede mirar (una foto o un escaneo sin capa de texto):
    // ahí un modelo sin visión no puede hacer el trabajo. Con PDFs que sí tienen
    // texto se deja la cadena normal —que ya pone Gemini primero— para que un
    // cupo agotado no bloquee la redacción entera.
    const geminiConfigured = getConfiguredProviders().includes('gemini');
    const needsVision = uploads.some(
      (upload) => isImageMime(upload.mimeType) || (upload.mimeType === 'application/pdf' && upload.chars === 0)
    );
    const writerProvider: AiProvider | undefined =
      requestedProvider ?? (noteAttachments.length > 0 && needsVision && geminiConfigured ? 'gemini' : undefined);

    const [
      student,
      syllabus,
      measuredTopics,
      upcomingExams,
      existingNotes,
      teacherMaterials,
      teacherMethods,
    ] = await Promise.all([
      prisma.userProfile.findUnique({ where: { id: 'user_default' } }),
      // El temario ya está en `subjectUnits` (y con su id): no se pregunta dos veces.
      Promise.resolve(subjectUnits),
      prisma.topic.findMany({
        where: { subjectId: agent.subjectId, masterySource: { not: 'sin_medir' } },
        orderBy: { masteryLevel: 'asc' },
        take: 10,
        select: { title: true, unitNumber: true, masteryLevel: true, masterySource: true },
      }),
      prisma.exam.findMany({
        where: { subjectId: agent.subjectId, examDate: { gte: new Date() } },
        orderBy: { examDate: 'asc' },
        take: 3,
        select: { title: true, examDate: true, examType: true },
      }),
      // Su cuaderno completo de la materia: para completar, no para repetir.
      prisma.note.findMany({
        where: { topic: { subjectId: agent.subjectId } },
        orderBy: [{ isPinned: 'desc' }, { updatedAt: 'desc' }],
        take: 40,
        select: {
          id: true,
          title: true,
          content: true,
          isPinned: true,
          author: true,
          updatedAt: true,
          topic: { select: { unitNumber: true } },
        },
      }),
      // Lo que ha subido su profesor a Moodle de esta asignatura (solo nombres).
      prisma.moodleMaterial.findMany({
        where: { course: { subjectId: agent.subjectId } },
        orderBy: { name: 'asc' },
        take: 20,
        select: { name: true, sectionName: true },
      }),
      // Cómo ha explicado su profesor cada unidad, contado por el alumno. Es lo
      // que ata el apunte al aula: sin esto, el catedrático escribe un temario
      // genérico (correcto) que no tiene por qué parecerse a cómo le corrigen.
      prisma.topic.findMany({
        where: { subjectId: agent.subjectId, teacherMethod: { not: null } },
        orderBy: { unitNumber: 'asc' },
        select: { unitNumber: true, title: true, teacherMethod: true },
      }),
    ]);

    // Los extractos que más ayudan: primero los de ESTA unidad, después el resto.
    const orderedForExcerpts = [
      ...existingNotes.filter((note) => note.topic.unitNumber === unit.unitNumber),
      ...existingNotes.filter((note) => note.topic.unitNumber !== unit.unitNumber),
    ];
    const existingNoteExcerpts = orderedForExcerpts
      .map((note) => ({ title: note.title, excerpt: noteExcerpt(note.content, 320) }))
      .filter((note) => note.excerpt.length > 0)
      .slice(0, MAX_EXISTING_EXCERPTS);

    const context: NotebookContextInput = {
      studentName: student?.name ?? 'el alumno',
      subjectName: agent.subject.name,
      unit: { title: unit.title, unitNumber: unit.unitNumber, status: unit.status },
      syllabus,
      measuredTopics: measuredTopics.map((topic) => ({
        title: topic.title,
        unitNumber: topic.unitNumber,
        masteryLevel: topic.masteryLevel,
        source: topic.masterySource,
      })),
      upcomingExams: upcomingExams.map((exam) => ({
        title: exam.title,
        examType: exam.examType,
        days: daysUntil(exam.examDate),
      })),
      existingNotes: existingNotes.map((note) => ({
        title: note.title,
        unitNumber: note.topic.unitNumber,
        author: note.author,
      })),
      existingNoteExcerpts,
      teacherMaterials,
      teacherMethodology: buildTeacherMethodology(unit, teacherMethods),
      sourceDocuments,
      memory: memoryBlock,
      subjectKind: classifyNoteSubject(agent.subject.name),
      focus: focus.length > 0 ? focus : null,
    };

    if (documentIndexes.length > 0) {
      console.log(
        `[apuntes] redactando con ${documentIndexes.length} documento(s) del alumno: ${documentIndexes.map((doc) => `${doc.name} (${doc.pages} pág.)`).join(' | ')}`
      );
    }
    if (noteAttachments.length > 0) {
      console.log(
        `[apuntes] ${noteAttachments.length} archivo(s) se envían a ${writerProvider ?? 'la cadena'} para lectura multimodal: ${noteAttachments.map((part) => part.name).join(' | ')}`
      );
    }
    if (memoryBlock.length > 0) {
      console.log(`[apuntes] memoria de la asignatura: ${memoryBlock.length} caracteres`);
    }

    const writerInput = { ...context, proposedTitle: proposedTitle || unit.title };

    // Un intento de redacción: se limpia y se mide lo que ha salido.
    const writeOnce = async (correction: string | null) => {
      const reply = await runAiText({
        systemInstruction: buildNoteWriterSystemPrompt(writerInput),
        message: buildNoteWriterUserMessage(writerInput, correction),
        maxTokens: NOTE_MAX_TOKENS,
        budgetMs: NOTE_BUDGET_MS,
        attemptMs: NOTE_ATTEMPT_MS,
        // Los bytes de las fotos, escaneos y PDFs viajan con el turno: el
        // redactor los mira además de leer su texto (tablas, diagramas y
        // criterios escritos a mano que el extractor no puede reconstruir).
        attachments: noteAttachments,
        // Los documentos cuyo texto ya está en el prompt no son «ilegibles».
        readableTextAttachments: readableUploadNames,
        // La versión de esta pestaña la escribe EL motor que ha pedido el
        // alumno: si la cadena eligiera por su cuenta, dos pestañas podrían
        // acabar firmadas por el mismo modelo y la comparación sería mentira.
        provider: writerProvider,
      });
      const clean = sanitizeNoteContent(reply.text);
      return { reply, clean, quality: noteQualityReport(clean) };
    };

    /** ¿Es `candidate` mejor apunte que `current`? Primero la estructura, luego el cuerpo. */
    const isBetter = (candidate: NoteQuality, current: NoteQuality) =>
      candidate.ok !== current.ok ? candidate.ok : candidate.words > current.words;

    let attempt = await writeOnce(null);
    let retried = false;
    /** Intentos gastados: el primero ya cuenta. */
    let attemptRounds = 1;

    // Mientras le falte estructura o cuerpo, se le vuelve a pedir diciéndole qué
    // falta exactamente. Se queda el mejor intento: nunca se pierde lo que ya
    // estaba bien, ni se gasta una llamada más si la anterior no ha mejorado.
    while (!attempt.quality.ok && attemptRounds < MAX_WRITE_ATTEMPTS) {
      attemptRounds += 1;
      console.warn(
        `[apuntes] intento ${attemptRounds} flojo (${attempt.quality.words} palabras): falta ${attempt.quality.missing.join(', ')}`
      );

      const retry = await writeOnce(
        `faltaba esto: ${attempt.quality.missing.join(', ')}. Vuelve a escribir el apunte ENTERO (no solo lo que falta), con TODOS los puntos del tema desarrollados en sus propios apartados \`### \` y sin ningún bloque de código ni etiqueta HTML.`
      ).catch((error) => {
        console.warn(
          `[apuntes] el reintento no ha salido: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`
        );
        return null;
      });

      if (!retry) break;
      retried = true;
      if (!isBetter(retry.quality, attempt.quality)) break;
      attempt = retry;
    }

    // El modelo escribe `# Título` en la primera línea: se separa para que el
    // cuaderno tenga el título una sola vez (y la descarga no lo duplique).
    const { title, content } = splitNoteTitle(attempt.clean, proposedTitle || unit.title);

    const finalQuality = noteQualityReport(content);
    if (finalQuality.words < MIN_NOTE_WORDS) {
      throw new TutorError(
        `El apunte ha salido demasiado corto para ser útil (${finalQuality.words} palabras). Inténtalo otra vez en un momento.`,
        502,
        `respuesta de ${content.length} caracteres${retried ? ' tras reintento' : ''}`
      );
    }

    /*
     * PASO 1: la vista previa.
     *
     * El apunte ya está redactado y medido. Antes de meterlo en el cuaderno se
     * le enseña **tal y como va a quedar** (con su estructura y su extensión)
     * para que pueda decir que no. Se guarda solo el borrador en memoria.
     */
    if (preview) {
      const token = rememberNoteDraft({
        agentId: agent.id,
        topicId: unit.id,
        conversationId,
        title,
        content,
        words: finalQuality.words,
        developedPoints: finalQuality.developedPoints,
        structureMissing: finalQuality.structureMissing,
        model: attempt.reply.model,
        provider: attempt.reply.provider,
      });

      console.log(
        `[apuntes] vista previa · ${agent.subject.name} U${unit.unitNumber ?? '?'} «${title}» · ${finalQuality.words} palabras · ${finalQuality.developedPoints} apartados · ${attempt.reply.provider}/${attempt.reply.model}${retried ? ' · con reintento' : ''}`
      );

      return NextResponse.json({
        ok: true,
        preview: true,
        draftToken: token,
        model: attempt.reply.model,
        provider: attempt.reply.provider,
        quality: {
          words: finalQuality.words,
          developedPoints: finalQuality.developedPoints,
          missing: finalQuality.missing,
          structureMissing: finalQuality.structureMissing,
          attempts: attemptRounds,
          retried,
        },
        /** Lo redactado, para poder leerlo antes de guardarlo. */
        draft: {
          title,
          content,
          unitNumber: unit.unitNumber,
          unitTitle: unit.title,
          /** La propuesta apuntaba a otra unidad y el título la ha corregido. */
          unitCorrected: resolution.corrected,
          requestedUnitNumber: resolution.numbered?.unitNumber ?? null,
          subjectName: agent.subject.name,
          subjectColor: agent.subject.color,
          agentName: agent.name,
        },
      });
    }

    const saved = await saveNoteToNotebook({
      agentId: agent.id,
      conversationId,
      unitId: unit.id,
      title,
      content,
    });

    console.log(
      `[apuntes] ${saved.updated ? 'actualizado' : 'creado'} · ${agent.subject.name} U${unit.unitNumber ?? '?'} «${title}» · ${finalQuality.words} palabras · ${finalQuality.developedPoints} apartados · ${attempt.reply.provider}/${attempt.reply.model}${retried ? ' · con reintento' : ''}`
    );

    // El apunte tiene cuerpo pero le falta la estructura de cátedra: se guarda
    // (lo que hay es suyo y sirve para estudiar) y se deja constancia en el
    // taller, porque un resumen sin los puntos desarrollados no es lo que se le
    // ha pedido y hay que poder reescribirlo.
    if (finalQuality.structureMissing.length > 0) {
      await noteIncompleteIssue(saved.id, title, finalQuality, content).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      updated: saved.updated,
      model: attempt.reply.model,
      provider: attempt.reply.provider,
      // Lo que ha salido de verdad, para que el chat pueda decirlo si le falta
      // algo: mejor avisar que dar por bueno un apunte escaso.
      quality: {
        words: finalQuality.words,
        developedPoints: finalQuality.developedPoints,
        missing: finalQuality.missing,
        /** Lo que falta de estructura, que es lo que no se arregla escribiendo más. */
        structureMissing: finalQuality.structureMissing,
        attempts: attemptRounds,
        retried,
      },
      note: {
        id: saved.id,
        title: saved.title,
        content: saved.content,
        author: 'catedratico',
        agentName: agent.name,
        topicId: unit.id,
        unitNumber: unit.unitNumber,
        unitTitle: unit.title,
        subjectId: agent.subjectId,
        subjectName: agent.subject.name,
        subjectColor: agent.subject.color,
        createdAt: saved.createdAt,
      },
    });
  } catch (error) {
    if (error instanceof TutorError) {
      console.error('[apuntes]', error.status, error.message, error.detail ?? '');
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[apuntes] Error inesperado:', error);
    return NextResponse.json(
      { error: 'No se han podido redactar los apuntes. Revisa la consola del servidor.' },
      { status: 500 }
    );
  }
}
