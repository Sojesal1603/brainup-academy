import { z } from 'zod';

/**
 * Restricciones que el alumno pone para el plan de HOY.
 *
 * El modelo solo propone; el servidor valida con Zod antes de guardar y la
 * persona confirma lo que se va a aplicar. Una restricción inválida se rechaza
 * entera: no se guarda «lo que se haya podido entender».
 *
 * El esquema de respuesta de Gemini no contiene ningún `userId`: el dueño lo
 * pone el servidor desde la sesión.
 */

export const planConstraintSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('max_minutes'),
    minutes: z.number().int().min(10).max(480),
  }),
  z.object({
    kind: z.literal('avoid_subject'),
    subject: z.string().trim().min(1).max(80),
  }),
  z.object({
    kind: z.literal('only_subject'),
    subject: z.string().trim().min(1).max(80),
  }),
]);

export const planConstraintsSchema = z.array(planConstraintSchema).max(5);

export type PlanConstraintInput = z.infer<typeof planConstraintSchema>;

export const PLAN_CONSTRAINT_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    constraints: {
      type: 'ARRAY',
      description: 'Restricciones explícitas del alumno para el plan de hoy. Vacío si no hay.',
      items: {
        type: 'OBJECT',
        properties: {
          kind: {
            type: 'STRING',
            enum: ['max_minutes', 'avoid_subject', 'only_subject'],
          },
          minutes: {
            type: 'INTEGER',
            description: 'Solo para max_minutes: minutos máximos de estudio hoy (10–480).',
          },
          subject: {
            type: 'STRING',
            description: 'Solo para avoid_subject/only_subject: nombre exacto de la materia.',
          },
        },
        required: ['kind'],
      },
    },
  },
  required: ['constraints'],
} as const;

export function constraintLabel(constraint: PlanConstraintInput): string {
  if (constraint.kind === 'max_minutes') return `Máximo ${constraint.minutes} min hoy`;
  if (constraint.kind === 'avoid_subject') return `Sin ${constraint.subject} hoy`;
  return `Solo ${constraint.subject} hoy`;
}

export function constraintsToPrompt(
  constraints: PlanConstraintInput[],
  subjects: string[] = []
): string {
  if (constraints.length === 0) return '';
  const lines = constraints.map((constraint) => `- ${constraintLabel(constraint)}`);
  const note =
    subjects.length > 0
      ? `Materias reales del alumno: ${subjects.slice(0, 30).join(', ')}.`
      : '';
  return [
    'RESTRICCIONES DE HOY (las ha puesto el alumno; respétalas al proponer trabajo y no las cambies):',
    ...lines,
    note,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Motivo único y saneado cuando el modelo devuelve algo que no encaja. */
export const CONSTRAINT_INVALID_MESSAGE =
  'No he podido interpretar esa restricción con seguridad. Prueba con una frase como «hoy solo 45 minutos» o «hoy sin Filosofía»; no se ha guardado nada.';

/**
 * Convierte el JSON del modelo en restricciones validadas.
 *
 * Devuelve `ok:false` si el sobre no es JSON, si falta `constraints` o si
 * CUALQUIER elemento es inválido. No se descarta el malo y se guarda el resto:
 * eso sería aplicar una restricción que el alumno no ha confirmado.
 */
export function parseConstraintModelJson(
  raw: string
): { ok: true; constraints: PlanConstraintInput[] } | { ok: false } {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false };
  }

  const envelope = z.object({ constraints: z.array(z.unknown()).max(5) }).safeParse(payload);
  if (!envelope.success) return { ok: false };

  const constraints: PlanConstraintInput[] = [];
  for (const item of envelope.data.constraints) {
    const parsed = planConstraintSchema.safeParse(item);
    if (!parsed.success) return { ok: false };
    constraints.push(parsed.data);
  }
  return { ok: true, constraints };
}

/** Filtra candidatos por materia. Las restricciones ya vienen validadas. */
export function subjectAllowedByConstraints(
  constraints: PlanConstraintInput[],
  subjectName: string
): boolean {
  const name = subjectName.trim().toLocaleLowerCase('es');
  const only = constraints.filter(
    (constraint): constraint is Extract<PlanConstraintInput, { kind: 'only_subject' }> =>
      constraint.kind === 'only_subject'
  );
  if (only.length > 0 && !only.some((constraint) => constraint.subject.toLocaleLowerCase('es') === name)) {
    return false;
  }
  return !constraints.some(
    (constraint) =>
      constraint.kind === 'avoid_subject' &&
      constraint.subject.toLocaleLowerCase('es') === name
  );
}

/** Techo de minutos de hoy, si el alumno lo ha puesto. */
export function maxMinutesFromConstraints(constraints: PlanConstraintInput[]): number | null {
  const caps = constraints
    .filter(
      (constraint): constraint is Extract<PlanConstraintInput, { kind: 'max_minutes' }> =>
        constraint.kind === 'max_minutes'
    )
    .map((constraint) => constraint.minutes);
  return caps.length > 0 ? Math.min(...caps) : null;
}
