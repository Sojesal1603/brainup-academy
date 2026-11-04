import { NextResponse, after } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  MEMORY_SCOPE_COORDINATOR,
  loadMemoryBlock,
  rememberConversation,
} from '@/lib/agentMemory';
import { polishMemoryWithAi } from '@/lib/agentMemoryPolish';
import {
  hasAiProviderAsync,
  runAiText,
  TUTOR_MAX_HISTORY_MESSAGES,
  TutorError,
  type ChatMessage,
} from '@/lib/aiEngine';
import { buildSetupSystemPrompt, parseSetupTags, SETUP_CONVERSATION_TITLE } from '@/lib/setup';
import { armPendingReplace, hasReplaceIntent, matchSubjectInMessage } from '@/lib/setupReplaceIntent';
import { applySetupActions, getSetupState, undoLastSetupChange } from '@/lib/setupApply';
import { auditSetup } from '@/lib/setupAudit';
import { hoursFromMessage, reviewArea, wantsUndo } from '@/lib/setupIntent';
import { snapshotTemarioIfStale } from '@/lib/temarioRestore';
import {
  buildLocalSetupReply,
  isLocalModeReply,
  LOCAL_MODE_PROVIDER,
  stripLocalModeNotice,
} from '@/lib/setupFallback';
import { prismaErrorCode } from '@/lib/databaseDiagnostics';
import { isTransientDbError, withDbRetry } from '@/lib/prismaRetry';

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
    // Los turnos que contestó el respaldo local NO se le reenvían al modelo: los
    // imitaba y acababa diciendo «⚠️ Sin IA ahora mismo…» con la IA funcionando
    // (`provider: groq`, `degraded: false`). El alumno veía «sin IA», y encima
    // esa respuesta no traía etiquetas, así que tampoco guardaba nada.
    .filter((row) => row.role !== 'assistant' || !isLocalModeReply(row.content))
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
  // Se comprueba (y se sondea el motor local) antes de decidir nada: en una
  // instancia serverless recién arrancada, Ollama todavía no constaba.
  const aiAvailable = await hasAiProviderAsync();

  /** «Deshaz eso»: el resultado se devuelve junto al turno del coordinador. */
  let undoResult: { restored: string[]; problems: string[] } | null = null;
  let undoChanged = false;

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

    /**
     * OBEDIENCIA: si dice «deshaz eso» o «vuelve atrás», se hace ANTES de llamar
     * al modelo. Obedecer al alumno no puede depender de que el proveedor emita
     * una etiqueta, y menos cuando pide que se repare lo que ha quedado mal.
     */
    if (wantsUndo(message)) {
      undoResult = await undoLastSetupChange();
      undoChanged = undoResult.restored.length > 0;
      if (undoChanged) {
        console.log('[puesta-a-punto] deshecho el último cambio:', undoResult.restored.join(' | '));
      }
    }

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

    /**
     * «Revísame el temario»: la auditoría se ejecuta de verdad ANTES del modelo,
     * así contesta con los problemas que existen en la base y no de memoria.
     */
    const auditArea = reviewArea(message);
    const audit = auditArea ? await auditSetup(auditArea).catch(() => null) : null;

    const undoNote =
      undoResult && (undoResult.restored.length > 0 || undoResult.problems.length > 0)
        ? `YA HAS HECHO ESTO EN ESTE TURNO (lo ha ejecutado el sistema por orden suya; no lo repitas, cuéntaselo): ${[
            ...undoResult.restored,
            ...undoResult.problems,
          ].join(' · ')}`
        : '';

    const systemInstruction = buildSetupSystemPrompt(
      state.snapshot,
      state.checklist,
      memoryBlock,
      [undoNote, audit?.summary ?? ''].filter(Boolean).join('\n\n')
    );
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
    /** Por qué se ha respondido en local (se le enseña al alumno, no se calla). */
    let degradeReason: string | null = null;

    if (aiAvailable) {
      try {
        const reply = await runAiText({
          systemInstruction,
          messages: toChatMessages(recent),
          message,
        });
        // Si el modelo copia el aviso de modo local de algún turno viejo, se
        // quita: la IA SÍ ha contestado y decir lo contrario es mentirle.
        const cleaned = stripLocalModeNotice(reply.text);
        replyText = cleaned.length > 0 ? cleaned : reply.text;
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
        // El motivo real, corto: sin esto «Sin IA» no dice si es cupo, red o un
        // modelo que ya no existe, y arreglarlo se convierte en adivinar.
        degradeReason = error.message;
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

    // Un «deshacer» ya se ha ejecutado antes de llamar al modelo: no se repite.
    let setupActions = parsed.actions.filter(
      (action) => !(undoResult !== null && action.kind === 'undo')
    );

    /**
     * Obediencia determinista de las horas: «3 horas al día entre semana» es un
     * dato que él ha dicho. Si el modelo no ha emitido [[horas:…]], se apunta
     * igual (15 h/semana en ese ejemplo).
     */
    if (!setupActions.some((action) => action.kind === 'hours')) {
      const weekly = hoursFromMessage(message);
      if (weekly !== null) setupActions = [{ kind: 'hours', weekly }, ...setupActions];
    }

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

    // Lo que el modelo ha anotado se aplica aquí. Si la escritura falla, el
    // turno NO se pierde: la respuesta ya está escrita y se devuelve con el
    // problema explicado, en vez de un 500 que borra la conversación entera.
    let applied: Awaited<ReturnType<typeof applySetupActions>>;
    try {
      applied =
        setupActions.length > 0
          ? await applySetupActions(setupActions, {
              allowReplace: replaceIntent,
              allowReplaceSubject: intentSubject,
            })
          : { applied: [], problems: [], changed: false, blocks: 0, ...state };
    } catch (applyError) {
      console.error('[puesta-a-punto] no se han podido guardar los datos del turno:', applyError);
      applied = {
        applied: [],
        problems: [
          'He entendido lo que me dices, pero NO se ha podido guardar en el sistema (la base de datos no ha respondido). Dímelo otra vez en un momento y lo aplico.',
        ],
        changed: false,
        blocks: 0,
        ...state,
      };
    }

    // Guardar el turno es importante (es la memoria del chat) pero no puede
    // tumbar la respuesta: si falla, se sigue con el texto ya generado.
    // Si el modelo contesta SOLO con etiquetas, el chat se quedaría con una
    // burbuja vacía. Se confirma lo aplicado en una línea y se sigue.
    const baseText =
      parsed.text.trim().length > 0
        ? parsed.text
        : applied.applied.length > 0
          ? `Anotado: ${applied.applied.join(' · ')}`
          : 'Entendido. Dime cuál es el siguiente dato y lo anoto.';
    /**
     * La revisión REAL se le enseña siempre, la haya pedido el alumno (auditoría
     * ejecutada antes del modelo) o el modelo ([[revisar:…]]).
     *
     * Es deliberado: el modelo contó «no hay ninguna unidad» con 95 unidades en
     * la base cuando el prompt se recortó. Los datos reales no pueden depender de
     * que el modelo se acuerde de decirlos: si ha habido revisión, va en el chat.
     */
    const auditBlock = audit?.summary ?? applied.report ?? null;
    const assistantText = auditBlock ? `${baseText}\n\n---\n\n${auditBlock}` : baseText;
    let assistantId = `local-${Date.now()}`;
    let assistantCreatedAt = new Date();
    try {
      // Guardar el turno se reintenta: con el pooler de Supabase una conexión
      // puede cerrarse a mitad (P1017) y el chat no debe perder lo hablado.
      const [, assistantMessage] = await withDbRetry(() => prisma.$transaction([
        prisma.aiMessage.create({
          data: { conversationId: activeConversation.id, role: 'user', content: message },
        }),
        prisma.aiMessage.create({
          data: {
            conversationId: activeConversation.id,
            role: 'assistant',
            content: assistantText,
          },
        }),
      ]), { label: 'puesta-a-punto: guardar turno' });
      assistantId = assistantMessage.id;
      assistantCreatedAt = assistantMessage.createdAt;
    } catch (persistError) {
      console.error('[puesta-a-punto] el turno no se ha podido guardar:', persistError);
    }

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
      // Un turno que cambia datos deja copia del temario: si algo se monta mal,
      // hay de dónde volver aunque el proceso se reinicie.
      if (applied.changed) {
        const file = await snapshotTemarioIfStale(0).catch(() => null);
        if (file) console.log(`[puesta-a-punto] copia de seguridad del temario: ${file}`);
      }
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
      changed: applied.changed || undoChanged,
      blocks: applied.blocks,
      applied: [...(undoResult?.restored ?? []), ...applied.applied],
      problems: [
        ...(undoResult?.problems ?? []),
        ...applied.problems,
        // Las etiquetas son protocolo interno: «[[unidad:1|…]]» no le dice nada al
        // alumno y parece que la app está rota. Se le cuenta qué ha pasado y qué
        // hacer; el detalle crudo queda en el log de arriba para poder afinarlo.
        ...(parsed.rejected.length > 0
          ? [
              `No he sabido anotar ${
                parsed.rejected.length === 1 ? 'un dato' : `${parsed.rejected.length} datos`
              } de este mensaje. Dímelo otra vez con tus palabras y lo guardo.`,
            ]
          : []),
        ...(degradeReason ? [`Modo local: ${degradeReason}`] : []),
      ],
      /** Auditoría real de este turno (si la ha habido). */
      audit: audit?.summary ?? applied.report ?? null,
      checklist: applied.checklist,
      snapshot: applied.snapshot,
      reply: {
        id: assistantId,
        role: 'assistant',
        content: assistantText,
        createdAt: assistantCreatedAt,
      },
    });
  } catch (error) {
    if (error instanceof TutorError) {
      console.error('[puesta-a-punto]', error.status, error.message, error.detail ?? '');
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // Un fallo de base de datos tiene un mensaje propio y accionable: el genérico
    // («Revisa la consola del servidor») no le dice nada a quien está montando
    // el curso desde el móvil.
    // El código se busca también en `errorCode`: un fallo de conexión llega como
    // `PrismaClientInitializationError`, que NO lo pone en `.code`. Mirando solo
    // `.code` el error salía como «inesperado» y sin pista de qué arreglar.
    const prismaCode = prismaErrorCode(error);
    if (prismaCode) {
      console.error('[puesta-a-punto] error de base de datos:', prismaCode, error);
      return NextResponse.json(
        {
          error: isTransientDbError(error)
            ? 'Se ha cortado la conexión con la base de datos en este turno y no se ha recuperado tras reintentar. No se ha guardado nada: vuelve a enviar el mensaje y lo aplico (el reintento suele funcionar al segundo).'
            : `La base de datos ha rechazado la operación (${prismaCode}) y no se ha guardado nada de este turno. El detalle está en /diagnostico y en la consola del servidor.`,
          /** El turno no se ha guardado: el mensaje se puede reenviar sin miedo. */
          retryable: isTransientDbError(error),
        },
        { status: 503 }
      );
    }
    console.error('[puesta-a-punto] Error inesperado:', error);
    return NextResponse.json(
      { error: 'Error inesperado de la puesta a punto. Revisa la consola del servidor.' },
      { status: 500 }
    );
  }
}
