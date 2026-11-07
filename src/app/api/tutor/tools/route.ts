import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ensureUserProfile } from '@/lib/userProfile';
import { hasAiProviderAsync, hasAnyFreeKey, runAiText, TutorError } from '@/lib/aiEngine';
import {
  buildStudyToolPrompt,
  isStudyToolKind,
  parseStudyToolPayload,
  type StudyToolInput,
} from '@/lib/studyTools';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

interface ToolRequestBody {
  agentId?: unknown;
  kind?: unknown;
  topicId?: unknown;
  /** El último mensaje del alumno: sirve de foco para el material. */
  focus?: unknown;
}

/**
 * El catedrático fabrica material de estudio a petición del alumno.
 *
 * El panel del chat manda el agente y la herramienta; el servidor elige la
 * unidad real (la que está en curso, si no la primera pendiente) y le pasa al
 * modelo SOLO ese contexto. El JSON se valida aquí: si no sirve, se responde
 * con un error en vez de devolver una tarjeta vacía.
 */
export async function POST(request: Request) {
  let body: ToolRequestBody;
  try {
    body = (await request.json()) as ToolRequestBody;
  } catch {
    return NextResponse.json({ error: 'Petición inválida.' }, { status: 400 });
  }

  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  const kind = body.kind;
  if (!agentId || !isStudyToolKind(kind)) {
    return NextResponse.json(
      { error: 'Faltan datos: se requiere el catedrático y un tipo de herramienta válido.' },
      { status: 400 }
    );
  }

  if (!(await hasAiProviderAsync())) {
    return NextResponse.json(
      {
        error:
          'Ahora mismo no hay ningún motor de IA disponible. La herramienta se genera cuando vuelva la IA o levantes un modelo local.',
      },
      { status: 503 }
    );
  }

  if (!hasAnyFreeKey()) {
    return NextResponse.json(
      { error: 'Todas las claves de IA están en frío. Espera un momento y vuelve a intentarlo.' },
      { status: 429 }
    );
  }

  const agent = await prisma.aiAgent.findUnique({
    where: { id: agentId },
    include: {
      subject: {
        include: { topics: { orderBy: [{ unitNumber: 'asc' }] } },
      },
    },
  });

  if (!agent) {
    return NextResponse.json({ error: 'Catedrático no encontrado.' }, { status: 404 });
  }

  const topics = agent.subject.topics;
  const requestedTopicId = typeof body.topicId === 'string' ? body.topicId : '';
  const topic =
    (requestedTopicId ? topics.find((row) => row.id === requestedTopicId) : undefined) ??
    topics.find((row) => row.status === 'en_curso') ??
    topics.find((row) => row.status === 'pendiente') ??
    topics[0];

  if (!topic) {
    return NextResponse.json(
      {
        error: `Todavía no hay temario de ${agent.subject.name}: carga las unidades y el material se generará sobre ellas.`,
      },
      { status: 409 }
    );
  }

  const user = await ensureUserProfile();
  const focus = typeof body.focus === 'string' ? body.focus.trim().slice(0, 800) : '';

  const measured = topics
    .filter((row) => row.masterySource !== 'sin_medir')
    .sort((a, b) => a.masteryLevel - b.masteryLevel)[0];

  const input: StudyToolInput = {
    kind,
    agentName: agent.name,
    specialty: agent.specialty,
    subjectName: agent.subject.name,
    studentName: user.name,
    topic: {
      title: topic.title,
      unitNumber: topic.unitNumber,
      status: topic.status,
      teacherMethod: topic.teacherMethod,
    },
    focus: focus.length > 0 ? focus : null,
    context: [
      measured
        ? `Unidad medida más floja: «${measured.title}»${measured.unitNumber ? ` (U${measured.unitNumber})` : ''} al ${measured.masteryLevel}%. Refuerza eso si encaja con el tema.`
        : 'No hay ninguna medición real de su nivel en esta materia: no supongas que domina nada.',
      `La herramienta se genera para su unidad actual, no para todo el curso.`,
    ],
  };

  const { system, message } = buildStudyToolPrompt(input);

  try {
    const result = await runAiText({
      systemInstruction: system,
      message,
      maxTokens: 3_500,
      priority: 'alumno',
    });

    const tool = parseStudyToolPayload(kind, result.text);
    if (!tool) {
      console.error(
        `[tutor/herramientas] ${kind} descartada por formato inválido:`,
        result.text.slice(0, 300)
      );
      return NextResponse.json(
        {
          error:
            'El catedrático ha devuelto el material incompleto. Vuelve a pedirlo: si insiste, cambia el foco («solo la parte de…»).',
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      tool,
      topic: { id: topic.id, title: topic.title, unitNumber: topic.unitNumber },
      provider: result.provider,
      model: result.model,
    });
  } catch (error) {
    if (error instanceof TutorError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[tutor/herramientas] error:', error);
    return NextResponse.json(
      { error: 'No se ha podido generar la herramienta. Revisa la consola del servidor.' },
      { status: 500 }
    );
  }
}
