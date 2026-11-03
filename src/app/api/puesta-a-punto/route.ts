import { NextResponse, after } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  MEMORY_SCOPE_COORDINATOR,
  loadMemoryBlock,
  rememberConversation,
} from '@/lib/agentMemory';
import { polishMemoryWithAi } from '@/lib/agentMemoryPolish';
import {
  hasAiProvider,
  runAiText,
  TUTOR_MAX_HISTORY_MESSAGES,
  TutorError,
  type ChatMessage,
} from '@/lib/aiEngine';
import { buildSetupSystemPrompt, parseSetupTags, SETUP_CONVERSATION_TITLE } from '@/lib/setup';
import { armPendingReplace, hasReplaceIntent, matchSubjectInMessage } from '@/lib/setupReplaceIntent';
import { applySetupActions, getSetupState } from '@/lib/setupApply';
import { buildLocalSetupReply, LOCAL_MODE_PROVIDER } from '@/lib/setupFallback';

/**
 * Un turno de la puesta a punto: el coordinador pregunta, el alumno responde y
 * lo que el coordinador anota con etiquetas se aplica en la misma petición.
 *
 * El chat es sin estado (como el del tutor): el historial vive en SQLite y se
 * reenvía en cada turno. Ojo: en un route.ts solo se pueden exportar handlers y
 * opciones de Next, así que el título vive en `lib/setup.ts`.
 *
 * **Esta ruta no falla por culpa de los proveedores.** Si ningún modelo responde
 * (saturados, sin clave, red caída), contesta el coordinador local
 * (`setupFallback.ts`): sigue la entrevista por el mismo checklist, explica la
 * app con lo que sabe de sí misma y lo dice con claridad. La pantalla con la que
 * se empieza el curso no puede quedarse en un «error».
 */

interface SetupRequestBody {
  message?: unknown;
  conversationId?: unknown;
}

function toChatMessages(rows: Array<{ role: string; content: string }>): ChatMessage[] {
  return rows
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({
      role: row.role === 'user' ? ('user' as const) : ('assistant' as const),
      content: row.content,
    }));
}

function trimHistory<T>(rows: T[]): T[] {
  const recent = rows.slice(-TUTOR_MAX_HISTORY_MESSAGES);
  const firstUser = recent.findIndex((row) => (row as { role?: string }).role === 'user');
  return firstUser > 0 ? recent.slice(firstUser) : recent;
}

export async function POST(request: Request) {
  let body: SetupRequestBody;
  try {
    body = (await request.json()) as SetupRequestBody;
  } catch {
    return NextResponse.json({ error: 'Petición inválida.' }, { status: 400 });
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const conversationId =
    typeof body.conversationId === 'string' && body.conversationId.length > 0 ? body.conversationId : null;

  if (!message) {
    return NextResponse.json({ error: 'Falta el mensaje.' }, { status: 400 });
  }
  if (message.length > 4000) {
    return NextResponse.json({ error: 'El mensaje es demasiado largo (máximo 4000 caracteres).' }, { status: 400 });
  }

  // Sin clave configurada NO se corta la conversación: se responde en modo local
  // y se le dice al alumno cómo poner la clave para tener la entrevista completa.
  const aiAvailable = hasAiProvider();

  try {
    const conversation = conversationId
      ? await prisma.aiConversation.findFirst({
          where: { id: conversationId, agentId: null, title: SETUP_CONVERSATION_TITLE },
        })
      : await prisma.aiConversation.findFirst({
          where: { agentId: null, title: SETUP_CONVERSATION_TITLE },
          orderBy: { createdAt: 'desc' },
        });

    const activeConversation =
      conversation ??
      (await prisma.aiConversation.create({
        data: { title: SETUP_CONVERSATION_TITLE },
      }));

    const [historyRows, state, memoryBlock] = await Promise.all([
      prisma.aiMessage.findMany({
        where: { conversationId: activeConversation.id },
        orderBy: { createdAt: 'asc' },
        select: { role: true, content: true },
      }),
      getSetupState(),
      // La memoria entre días del coordinador: la entrevista dura varios días y
      // no puede empezar cada mañana preguntando lo que ya se dijo ayer.
      loadMemoryBlock(MEMORY_SCOPE_COORDINATOR),
    ]);

    const systemInstruction = buildSetupSystemPrompt(state.snapshot, state.checklist, memoryBlock);
    const recent = trimHistory(historyRows);

    /**
     * ¿Ha pedido ÉL reemplazar un temario?
     *
     * La red que impide borrar datos por iniciativa del modelo no puede hacer
     * que la app desobedezca: si el alumno dice «sustituye el temario de Lengua
     * por este», se hace aunque la lista sea más corta. Se mira su mensaje, no
     * la respuesta del modelo, y se deja apuntado por si la lista llega en el
     * mensaje siguiente.
     */
    const replaceIntent = hasReplaceIntent(message);
    const intentSubject = replaceIntent
      ? matchSubjectInMessage(
          message,
          state.snapshot.subjects.map((subject) => subject.name)
        )
      : null;
    const intentSubjectId = intentSubject
      ? state.snapshot.subjects.find((subject) => subject.name === intentSubject)?.id ?? null
      : null;
    if (intentSubjectId) armPendingReplace(intentSubjectId);

    // 1. Se intenta con IA. 2. Si no hay clave o ningún modelo responde, contesta
    // el modo local: la entrevista no se interrumpe por un proveedor saturado.
    let replyText: string;
    let provider: string;
    let model: string;
    let degraded = false;

    if (aiAvailable) {
      try {
        const reply = await runAiText({
          systemInstruction,
          messages: toChatMessages(recent),
          message,
        });
        replyText = reply.text;
        provider = reply.provider;
        model = reply.model;
      } catch (error) {
        if (!(error instanceof TutorError)) throw error;
        console.error(
          '[puesta-a-punto] sin IA disponible, se responde en local:',
          error.status,
          error.message
        );
        replyText = buildLocalSetupReply({ snapshot: state.snapshot, checklist: state.checklist, message });
        provider = LOCAL_MODE_PROVIDER;
        model = 'coordinador local';
        degraded = true;
      }
    } else {
      replyText = [
        '**Falta la clave de IA**, así que te contesto en modo local. Con GEMINI_API_KEY (o GROQ_API_KEY) en el archivo .env tendrías la entrevista completa y podría anotarlo todo al vuelo.',
        '',
        buildLocalSetupReply({ snapshot: state.snapshot, checklist: state.checklist, message }),
      ].join('\n');
      provider = LOCAL_MODE_PROVIDER;
      model = 'coordinador local';
      degraded = true;
    }

    // Etiquetas → acciones reales. Nada se aplica si el modelo no lo ha anotado…
    // salvo el reemplazo que el alumno ha pedido: si ha traído la lista y el
    // modelo solo ha emitido las unidades (sin [[sustituir:…]]), se antepone el
    // reemplazo. Es su orden, no una invención del modelo.
    const parsed = parseSetupTags(replyText);

    let setupActions = parsed.actions;
    if (replaceIntent && intentSubject) {
      const hasReplace = setupActions.some((action) => action.kind === 'replace');
      const hasUnits = setupActions.some((action) => action.kind === 'unit');
      if (hasUnits && !hasReplace) {
        setupActions = [
          { kind: 'focus', subject: intentSubject },
          { kind: 'replace', subject: intentSubject },
          ...setupActions,
        ];
      }
    }

    const applied =
      setupActions.length > 0
        ? await applySetupActions(setupActions, {
            allowReplace: replaceIntent,
            allowReplaceSubject: intentSubject,
          })
        : { applied: [], problems: [], changed: false, blocks: 0, ...state };

    const [, assistantMessage] = await prisma.$transaction([
      prisma.aiMessage.create({
        data: { conversationId: activeConversation.id, role: 'user', content: message },
      }),
      prisma.aiMessage.create({
        data: {
          conversationId: activeConversation.id,
          role: 'assistant',
          content: parsed.text,
        },
      }),
    ]);

    if (applied.applied.length > 0) {
      console.log(
        `[puesta-a-punto] aplicado: ${applied.applied.join(' | ')}${applied.blocks ? ` · ${applied.blocks} bloques` : ''}`
      );
    }
    if (parsed.rejected.length > 0) {
      console.log(`[puesta-a-punto] etiquetas no aplicadas: ${parsed.rejected.join(' ')}`);
    }

    // El recuerdo del día se escribe después de contestar: la entrevista no se
    // retrasa por apuntar lo que se acaba de hablar.
    after(async () => {
      try {
        const remembered = await rememberConversation({
          scope: MEMORY_SCOPE_COORDINATOR,
          conversationId: activeConversation.id,
          polish: (raw) => polishMemoryWithAi(raw, 'el coordinador de la puesta a punto'),
        });
        if (remembered) {
          console.log(
            `[memoria] coordinador: ${remembered.polished ? 'pulida' : 'de reglas'} · ${remembered.summary.slice(0, 110)}`
          );
        }
      } catch (error) {
        console.error('[memoria] no se pudo escribir la del coordinador:', error);
      }
    });

    return NextResponse.json({
      conversationId: activeConversation.id,
      model,
      provider,
      /** Respuesta sin IA: el cliente puede avisar de que el modo es local. */
      degraded,
      changed: applied.changed,
      blocks: applied.blocks,
      applied: applied.applied,
      problems: [...applied.problems, ...parsed.rejected.map((tag) => `Etiqueta que no entendí: ${tag}`)],
      checklist: applied.checklist,
      snapshot: applied.snapshot,
      reply: {
        id: assistantMessage.id,
        role: 'assistant',
        content: assistantMessage.content,
        createdAt: assistantMessage.createdAt,
      },
    });
  } catch (error) {
    if (error instanceof TutorError) {
      console.error('[puesta-a-punto]', error.status, error.message, error.detail ?? '');
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[puesta-a-punto] Error inesperado:', error);
    return NextResponse.json(
      { error: 'Error inesperado de la puesta a punto. Revisa la consola del servidor.' },
      { status: 500 }
    );
  }
}
