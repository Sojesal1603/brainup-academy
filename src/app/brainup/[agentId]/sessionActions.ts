'use server';

import { revalidatePath } from 'next/cache';
import { currentTenant } from '@/lib/tenantContext';
import { closeTutorSession, type CloseSessionResult } from '@/lib/sessionClose';

export interface CloseSessionState {
  ok: boolean;
  message: string;
  result?: CloseSessionResult;
}

/**
 * Cierre confirmado de la sesión con el catedrático.
 *
 * La clave de sesión la calcula el servidor a partir del agente y del día: es
 * estable aunque el alumno recargue o pulse dos veces, y por eso el índice
 * único puede evitar duplicados. Un segundo cierre el mismo día devuelve
 * `alreadyClosed` en vez de volver a escribir fichas y tarjetas.
 */
export async function closeSessionAction(
  agentId: string,
  payload: unknown
): Promise<CloseSessionState> {
  try {
    const { user } = await currentTenant();
    const day = new Date().toISOString().slice(0, 10);
    const sessionKey = `sesion:${agentId}:${day}`;

    const input = { ...(payload as Record<string, unknown>), sessionKey };
    const result = await closeTutorSession(user.id, input);

    revalidatePath(`/brainup/${agentId}`);
    revalidatePath('/planificador');
    revalidatePath('/errores');
    revalidatePath('/repaso');
    revalidatePath('/');

    return {
      ok: true,
      message: result.alreadyClosed
        ? `Esta sesión ya estaba cerrada: ${result.errorsCreated} ficha(s) y ${result.reviewCardsCreated} tarjeta(s), sin duplicar nada.`
        : `Sesión cerrada: ${result.errorsCreated} ficha(s) en el Banco de Errores y ${result.reviewCardsCreated} tarjeta(s) de repaso. El plan se recalcula.`,
      result,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : 'No se ha podido cerrar la sesión. Inténtalo de nuevo.',
    };
  }
}
