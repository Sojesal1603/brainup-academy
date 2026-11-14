'use server';

import { revalidatePath } from 'next/cache';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { dayKeyInZone, invalidatePlan, planDayFromKey } from './state';
import {
  planConstraintsSchema,
  type PlanConstraintInput,
} from './constraints';
import { interpretPlanConstraints, ConstraintAiError } from './constraintAi';
import { readTodayPlanConstraints } from './constraintStore';

export interface ConstraintActionResult {
  ok: boolean;
  message: string;
  constraints?: PlanConstraintInput[];
}

const confirmSchema = z.object({
  constraints: planConstraintsSchema,
});

async function trackedSubjectNames(userId: string): Promise<string[]> {
  const subjects = await db(userId).subject.findMany({
    where: { isTracked: true },
    select: { name: true },
    orderBy: [{ order: 'asc' }, { name: 'asc' }],
  });
  return subjects.map((subject) => subject.name);
}

/** Interpreta la frase. NO guarda: la interfaz enseña la propuesta. */
export async function interpretMyPlanConstraints(
  formData: FormData
): Promise<ConstraintActionResult> {
  const user = await requireUser();
  const text = String(formData.get('text') ?? '').trim();
  if (text.length === 0) {
    return { ok: false, message: 'Escribe qué restricción quieres poner para hoy.' };
  }

  const subjects = await trackedSubjectNames(user.id);
  try {
    const constraints = await interpretPlanConstraints({ userId: user.id, text, subjects });
    if (constraints.length === 0) {
      return {
        ok: false,
        message:
          'No he encontrado una restricción clara. Prueba con «hoy solo 45 minutos» o «hoy sin Filosofía».',
      };
    }
    return {
      ok: true,
      message: 'Esto es lo que he entendido. Revísalo antes de aplicarlo.',
      constraints,
    };
  } catch (error) {
    if (error instanceof ConstraintAiError) {
      return { ok: false, message: error.message };
    }
    console.error('[plan] no se pudo interpretar la restricción:', error instanceof Error ? error.name : 'error');
    return {
      ok: false,
      message: 'No se pudo interpretar la restricción. No se ha guardado nada.',
    };
  }
}

/**
 * Confirma y guarda. Vuelve a validar TODO en servidor (el JSON del cliente no
 * es de fiar) y comprueba que las materias existen de verdad.
 */
export async function confirmMyPlanConstraints(rawJson: string): Promise<ConstraintActionResult> {
  const user = await requireUser();

  let payload: unknown;
  try {
    payload = JSON.parse(rawJson);
  } catch {
    return { ok: false, message: 'La propuesta ha llegado dañada. Vuelve a interpretarla.' };
  }

  const parsed = confirmSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      message: 'Hay una restricción inválida (materia o minutos fuera de rango). No se ha guardado nada.',
    };
  }
  const constraints = parsed.data.constraints;

  const subjects = await trackedSubjectNames(user.id);
  const known = new Set(subjects.map((name) => name.toLocaleLowerCase('es')));
  for (const constraint of constraints) {
    if (
      (constraint.kind === 'avoid_subject' || constraint.kind === 'only_subject') &&
      !known.has(constraint.subject.toLocaleLowerCase('es'))
    ) {
      return {
        ok: false,
        message: `«${constraint.subject}» no es una de tus materias. No se ha guardado nada.`,
      };
    }
  }

  const prisma = db(user.id);
  const profile = await prisma.userProfile.findUnique({
    where: { id: user.id },
    select: { timezone: true },
  });
  const timezone = profile?.timezone || 'Europe/Madrid';
  const planDay = planDayFromKey(dayKeyInZone(new Date(), timezone));

  try {
    await prisma.$transaction(async (tx) => {
      const state = await tx.planState.upsert({
        where: { userId_day: { userId: user.id, day: planDay } },
        create: {
          userId: user.id,
          day: planDay,
          status: 'invalidated',
          invalidatedAt: new Date(),
          invalidationReason: 'restricciones confirmadas',
        },
        update: {
          status: 'invalidated',
          invalidatedAt: new Date(),
          invalidationReason: 'restricciones confirmadas',
          version: { increment: 1 },
        },
      });
      await tx.planConstraint.deleteMany({ where: { planId: state.id } });
      for (const constraint of constraints) {
        await tx.planConstraint.create({
          data: {
            userId: user.id,
            planId: state.id,
            kind: constraint.kind,
            payload: constraint as unknown as Prisma.InputJsonValue,
          },
        });
      }
    });
    await invalidatePlan(user.id, 'restricciones confirmadas');
    revalidatePath('/');
    revalidatePath('/ajustes');
    return {
      ok: true,
      message:
        constraints.length === 0
          ? 'Restricciones borradas. El plan vuelve a decidirse solo con el expediente.'
          : 'Restricciones aplicadas. El plan de hoy se reconstruye con ellas.',
      constraints,
    };
  } catch (error) {
    console.error('[plan] no se pudieron guardar las restricciones:', error instanceof Error ? error.name : 'error');
    return { ok: false, message: 'No se pudieron guardar las restricciones. Inténtalo de nuevo.' };
  }
}

/** Quita todas las restricciones de hoy. */
export async function clearMyPlanConstraints(): Promise<ConstraintActionResult> {
  return confirmMyPlanConstraints(JSON.stringify({ constraints: [] }));
}

/** Las que hay ahora mismo, para que la tarjeta pinte el estado real. */
export async function readMyPlanConstraints(): Promise<PlanConstraintInput[]> {
  const user = await requireUser();
  const today = await readTodayPlanConstraints(user.id);
  return today.constraints;
}
