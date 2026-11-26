import { currentTenant } from '@/lib/tenantContext';

/**
 * GET /api/tutor/turns/[turnId]/stream
 *
 * Reanuda un turno concreto sin volver a preguntar al catedrático. `turnId` es
 * el id del mensaje del alumno, que el chat conoce en cuanto el servidor lo
 * persiste. Si la respuesta ya está escrita, se entrega tal cual; si el turno
 * sigue en marcha, se dice con claridad y el cliente puede reintentar con la
 * misma `clientKey` (el `POST` es idempotente).
 *
 * No pasa por la puerta de IA: leer una respuesta ya guardada no gasta cupo ni
 * necesita clave.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESUME_PENDING_MESSAGE =
  'El catedrático todavía está preparando esta respuesta. Espera unos segundos: se guardará sola y podrás recuperarla.';

export async function GET(
  _request: Request,
  context: { params: Promise<{ turnId: string }> }
) {
  const { tenant } = await currentTenant();
  const { turnId } = await context.params;
  const id = typeof turnId === 'string' ? turnId.trim() : '';

  const encoder = new TextEncoder();
  const sse = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const headers = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };

  if (id.length === 0) {
    return new Response(sse('error', { error: 'Turno no válido.', retryable: false }), {
      status: 400,
      headers,
    });
  }

  const message = await tenant.aiMessage.findFirst({
    where: { id, role: 'user' },
    select: { id: true, conversationId: true, createdAt: true },
  });

  if (!message) {
    return new Response(
      sse('error', {
        error: 'No encuentro ese turno en tu conversación. Vuelve a enviar el mensaje.',
        retryable: false,
      }),
      { status: 404, headers }
    );
  }

  const reply = await tenant.aiMessage.findFirst({
    where: {
      conversationId: message.conversationId,
      role: 'assistant',
      createdAt: { gte: message.createdAt },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, content: true, stepStage: true, createdAt: true },
  });

  if (!reply || reply.content.trim().length === 0) {
    const body = sse('error', {
      error: RESUME_PENDING_MESSAGE,
      retryable: true,
      code: 'turn_pending',
      turnId: message.id,
    });
    return new Response(body, { headers });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        sse('turn', {
          turnId: message.id,
          conversationId: message.conversationId,
          status: 'done',
        })
      );
      controller.enqueue(
        sse('done', {
          conversationId: message.conversationId,
          userMessageId: message.id,
          replayed: true,
          reply: {
            id: reply.id,
            role: 'assistant',
            content: reply.content,
            stage: reply.stepStage,
            createdAt: reply.createdAt,
          },
        })
      );
      controller.close();
    },
  });

  return new Response(stream, { headers });
}
