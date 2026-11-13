'use server';

import { revalidatePath, updateTag } from 'next/cache';
import { currentTenant } from './tenantContext';
import { markSetupCompleted, reopenSetup } from './setupApply';
import { SETUP_CONVERSATION_TITLE } from './setup';

function revalidateSetup() {
  updateTag('setup');
  updateTag('temario');
  updateTag('cuartel');
  updateTag('perfil');
  revalidatePath('/');
  revalidatePath('/puesta-a-punto');
  revalidatePath('/temario');
  revalidatePath('/examenes');
  revalidatePath('/planificador');
  revalidatePath('/ajustes');
}

/** Cierra la puesta a punto: queda marcada como terminada con su fecha. */
export async function finishSetup() {
  const { user } = await currentTenant();
  await markSetupCompleted(user.id, new Date());
  revalidateSetup();
  return { success: true as const };
}

/** Vuelve a abrirla para seguir añadiendo temario, exámenes u horas. */
export async function reopenSetupConversation() {
  const { user } = await currentTenant();
  await reopenSetup(user.id);
  revalidateSetup();
  return { success: true as const };
}

/**
 * Borra la conversación de la puesta a punto (el temario y los exámenes que se
 * anotaron se quedan donde están: esto solo limpia el chat).
 */
export async function clearSetupConversation() {
  const { tenant: prisma } = await currentTenant();
  const conversations = await prisma.aiConversation.findMany({
    where: { agentId: null, title: SETUP_CONVERSATION_TITLE },
    select: { id: true },
  });

  if (conversations.length > 0) {
    await prisma.aiConversation.deleteMany({ where: { id: { in: conversations.map((row) => row.id) } } });
  }

  revalidateSetup();
  return { success: true as const, cleared: conversations.length };
}
