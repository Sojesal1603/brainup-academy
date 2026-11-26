/**
 * Narración del director, siempre DESPUÉS de la decisión.
 *
 * La apertura del Cuartel no llama a este módulo: el plan y la decisión ya están
 * calculados por reglas. `after()` lo ejecuta en segundo plano, una vez al día
 * por alumno, y guarda una o dos frases en `AgentMemory`. Si no hay proveedor o
 * falla, queda la narración determinista: el alumno nunca ve un hueco ni espera
 * a un modelo para abrir su plan.
 */

import { revalidateTag } from 'next/cache';
import { db } from '../db';
import { resolveAllAiCredentials, runWithAiCredentials } from '../ai/credentials';
import { runAiText } from '../aiEngine';
import type { DayPlan } from '../dayPlan';
import { buildDirectorNarrationFacts } from './studentState';

const DIRECTOR_SCOPE = 'director';

function cleanNarration(raw: string): string {
  return String(raw ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 420);
}

function fallbackNarration(plan: DayPlan): string {
  return plan.director?.summary?.trim() || plan.headline;
}

/**
 * Genera y guarda la narración del día. Es idempotente: si ya existe la fila de
 * hoy, devuelve lo guardado y no gasta otra llamada.
 */
export async function ensureDirectorNarration(
  userId: string,
  plan: DayPlan
): Promise<string> {
  const state = plan.director;
  // Una foto antigua de caché puede no traer el estado: se sirve la frase del
  // plan y no se intenta inventar una narración sin hechos.
  if (!state) return fallbackNarration(plan);

  const prisma = db(userId);
  const existing = await prisma.agentMemory.findUnique({
    where: { userId_scope_day: { userId, scope: DIRECTOR_SCOPE, day: plan.dayKey } },
    select: { summary: true },
  });
  if (existing?.summary?.trim()) return existing.summary;

  let narration = fallbackNarration(plan);
  let writtenBy: 'reglas' | 'ia' = 'reglas';

  try {
    const credentials = await resolveAllAiCredentials(userId, { tolerateVaultErrors: true });
    if (credentials.length > 0) {
      const facts = buildDirectorNarrationFacts(state);
      const result = await runWithAiCredentials(credentials, () =>
        runAiText({
          systemInstruction: [
            'Eres el director de estudio de un alumno de instituto.',
            'Recibes una decisión YA calculada por reglas. No la cambies, no añadas bloques, no inventes minutos ni datos.',
            'Escribe una o dos frases en español, directas y humanas, explicando qué prioriza hoy el plan y por qué.',
            'No menciones modelos, proveedores, embeddings ni detalles técnicos.',
            'Si hay una desviación, dilo sin dramatizar y sin culpar al alumno.',
          ].join('\n'),
          message: facts.join('\n'),
          maxTokens: 160,
          budgetMs: 9_000,
          priority: 'fondo',
        })
      );
      const candidate = cleanNarration(result.text);
      if (candidate.length >= 20) {
        narration = candidate;
        writtenBy = 'ia';
      }
    }
  } catch (error) {
    // La narración es un extra: el plan ya está servido. Se guarda la versión de
    // reglas para no reintentar en cada apertura.
    console.warn('[director] narración IA no disponible, se guarda la determinista:', error);
  }

  await prisma.agentMemory.upsert({
    where: { userId_scope_day: { userId, scope: DIRECTOR_SCOPE, day: plan.dayKey } },
    create: {
      userId,
      scope: DIRECTOR_SCOPE,
      day: plan.dayKey,
      summary: narration,
      factsJson: JSON.stringify({
        version: state.version,
        decision: state.decision,
        deviations: state.deviations.map((deviation) => deviation.code),
      }),
      writtenBy,
    },
    update: {
      summary: narration,
      factsJson: JSON.stringify({
        version: state.version,
        decision: state.decision,
        deviations: state.deviations.map((deviation) => deviation.code),
      }),
      writtenBy,
    },
  });

  // La siguiente apertura debe ver la narración sin esperar al TTL de un minuto.
  try {
    revalidateTag('daily-brief', 'max');
  } catch {
    // Fuera de una petición de Next (script/cron): no hay caché que purgar.
  }

  return narration;
}
