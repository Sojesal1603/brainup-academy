/**
 * `VisualSpec`: el contrato entre el tutor y el renderizador.
 *
 * El modelo no puede devolver SVG ni HTML. Devuelve un JSON pequeño y validado
 * que, o bien elige una construcción exacta del motor geométrico, o bien
 * describe primitivas para un esquema libre. Aquí se valida todo antes de que
 * llegue al DOM: ids únicos, referencias existentes, texto sin etiquetas y
 * coordenadas finitas.
 */
import { z } from 'zod';
import { compileConstruction, compilePrimitives } from '../geometry/constructions';
import type {
  Construction,
  GeometryConstraint,
  GeometryPrimitive,
  GeometrySolution,
  GeometryStep,
} from '../geometry/types';

const COORD_LIMIT = 100_000;

const coordinate = z.number().min(-COORD_LIMIT).max(COORD_LIMIT);
const pointSchema = z.tuple([coordinate, coordinate]);
const lineSchema = z.tuple([pointSchema, pointSchema]);

/** Texto visible: sin HTML ni etiquetas. React ya escapa, pero no queremos ni
 * que el modelo intente colar marcado en una etiqueta de figura. */
function safeText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[<>]/.test(value), 'El texto no puede contener HTML.');
}

const styleSchema = z.enum(['solid', 'dashed', 'muted', 'accent']);
const pointRoleSchema = z.enum(['given', 'auxiliary', 'result']);

const pointPrimitiveSchema = z.object({
  type: z.literal('point'),
  id: safeText(40),
  at: pointSchema,
  label: safeText(20).optional(),
  role: pointRoleSchema.optional(),
  style: styleSchema.optional(),
});

const segmentPrimitiveSchema = z.object({
  type: z.literal('segment'),
  id: safeText(40),
  from: pointSchema,
  to: pointSchema,
  label: safeText(40).optional(),
  style: styleSchema.optional(),
});

const circlePrimitiveSchema = z.object({
  type: z.literal('circle'),
  id: safeText(40),
  center: pointSchema,
  radius: z.number().min(0.0001).max(COORD_LIMIT),
  label: safeText(40).optional(),
  style: styleSchema.optional(),
});

const arcPrimitiveSchema = z.object({
  type: z.literal('arc'),
  id: safeText(40),
  center: pointSchema,
  radius: z.number().min(0.0001).max(COORD_LIMIT),
  startAngle: z.number().min(-100_000).max(100_000),
  endAngle: z.number().min(-100_000).max(100_000),
  label: safeText(40).optional(),
  style: styleSchema.optional(),
});

const polygonPrimitiveSchema = z.object({
  type: z.literal('polygon'),
  id: safeText(40),
  points: z.array(pointSchema).min(3).max(64),
  label: safeText(40).optional(),
  style: styleSchema.optional(),
  closed: z.boolean().optional(),
});

const labelPrimitiveSchema = z.object({
  type: z.literal('label'),
  id: safeText(40),
  at: pointSchema,
  text: safeText(60),
  style: styleSchema.optional(),
});

const dimensionPrimitiveSchema = z.object({
  type: z.literal('dimension'),
  id: safeText(40),
  from: pointSchema,
  to: pointSchema,
  offset: z.number().min(-500).max(500).optional(),
  label: safeText(40).optional(),
  style: styleSchema.optional(),
});

const anglePrimitiveSchema = z.object({
  type: z.literal('angle'),
  id: safeText(40),
  vertex: pointSchema,
  from: pointSchema,
  to: pointSchema,
  radius: z.number().min(0.0001).max(COORD_LIMIT).optional(),
  label: safeText(40).optional(),
  style: styleSchema.optional(),
});

export const visualPrimitiveSchema = z.discriminatedUnion('type', [
  pointPrimitiveSchema,
  segmentPrimitiveSchema,
  circlePrimitiveSchema,
  arcPrimitiveSchema,
  polygonPrimitiveSchema,
  labelPrimitiveSchema,
  dimensionPrimitiveSchema,
  anglePrimitiveSchema,
]);

export const constructionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('perpendicular_bisector'),
    a: pointSchema,
    b: pointSchema,
  }),
  z.object({
    kind: z.literal('perpendicular_through_point'),
    line: lineSchema,
    point: pointSchema,
  }),
  z.object({
    kind: z.literal('parallel_through_point'),
    line: lineSchema,
    point: pointSchema,
  }),
  z.object({
    kind: z.literal('angle_bisector'),
    vertex: pointSchema,
    from: pointSchema,
    to: pointSchema,
  }),
  z.object({
    kind: z.literal('line_intersection'),
    line1: lineSchema,
    line2: lineSchema,
  }),
  z.object({
    kind: z.literal('tangent_from_point'),
    center: pointSchema,
    radius: z.number().min(0.0001).max(COORD_LIMIT),
    point: pointSchema,
  }),
  z.object({
    kind: z.literal('rotate'),
    point: pointSchema,
    center: pointSchema,
    angleDeg: z.number().min(-3600).max(3600),
  }),
  z.object({
    kind: z.literal('midpoint'),
    a: pointSchema,
    b: pointSchema,
  }),
  z.object({
    kind: z.literal('regular_polygon'),
    center: pointSchema,
    radius: z.number().min(0.0001).max(COORD_LIMIT),
    sides: z.number().int().min(3).max(24),
    rotationDeg: z.number().min(-3600).max(3600).optional(),
  }),
  z.object({
    kind: z.literal('reflect_point'),
    point: pointSchema,
    line: lineSchema,
  }),
]);

const stepSchema = z.object({
  id: safeText(40),
  title: safeText(80),
  detail: safeText(220).optional(),
  visible: z.array(safeText(40)).min(1).max(64),
});

const constraintSchema = z.object({
  kind: z.enum([
    'perpendicular',
    'parallel',
    'tangent',
    'equal',
    'midpoint',
    'angle',
    'reflection',
  ]),
  refs: z.array(safeText(40)).min(1).max(12),
  label: safeText(100),
});

export const visualSpecSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['geometry', 'technical', 'diagram']).default('geometry'),
    title: safeText(90),
    description: safeText(260).optional(),
    construction: constructionSchema.optional(),
    primitives: z.array(visualPrimitiveSchema).max(160).default([]),
    steps: z.array(stepSchema).max(20).optional(),
    constraints: z.array(constraintSchema).max(24).optional(),
  })
  .superRefine((value, ctx) => {
    const hasConstruction = Boolean(value.construction);
    const hasPrimitives = value.primitives.length > 0;
    if (hasConstruction === hasPrimitives) {
      ctx.addIssue({
        code: 'custom',
        path: ['primitives'],
        message: 'Usa exactamente una forma: construction o primitives.',
      });
    }

    const ids = new Set<string>();
    for (const [index, primitive] of value.primitives.entries()) {
      if (ids.has(primitive.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['primitives', index, 'id'],
          message: `Identificador repetido: ${primitive.id}.`,
        });
      }
      ids.add(primitive.id);
    }

    const stepIds = new Set<string>();
    for (const [index, step] of (value.steps ?? []).entries()) {
      if (stepIds.has(step.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'id'],
          message: `Paso repetido: ${step.id}.`,
        });
      }
      stepIds.add(step.id);
    }
  });

export type VisualSpec = z.infer<typeof visualSpecSchema>;
export type VisualPrimitive = z.infer<typeof visualPrimitiveSchema>;

export interface CompiledVisual {
  spec: VisualSpec;
  solution: GeometrySolution;
  fingerprint: string;
}

export type VisualParseResult =
  | { ok: true; visual: CompiledVisual }
  | { ok: false; error: string };

/** Quita la valla ```visual si el contenido llega desde Markdown. */
export function unwrapVisualSource(source: string): string {
  const trimmed = source.trim();
  const fence = trimmed.match(/^```(?:visual|geometry)?\s*\r?\n([\s\S]*?)\r?\n?```$/i);
  return fence ? fence[1].trim() : trimmed;
}

/** JSON con claves ordenadas: el fingerprint no cambia por el orden del modelo. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

/** Hash djb2: suficiente para recordar el progreso de una figura en el navegador. */
export function visualSpecFingerprint(value: unknown): string {
  const text = stableStringify(value);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function toCompiledVisual(spec: VisualSpec): CompiledVisual {
  const base = spec.construction
    ? compileConstruction(spec.construction as unknown as Construction)
    : compilePrimitives(
        spec.primitives as unknown as GeometryPrimitive[],
        spec.steps as GeometryStep[] | undefined,
        spec.constraints as GeometryConstraint[] | undefined
      );

  // Cuando hay construcción, los pasos y restricciones salen del motor. Si el
  // modelo añade los suyos, se validan contra las primitivas reales; nunca se
  // aceptan referencias a elementos que no existen.
  const steps = spec.steps && spec.steps.length > 0 ? spec.steps : base.steps;
  const constraints =
    spec.constraints && spec.constraints.length > 0 ? spec.constraints : base.constraints;

  const solution = compilePrimitives(
    base.primitives,
    steps as GeometryStep[],
    constraints as GeometryConstraint[]
  );

  return {
    spec,
    solution,
    fingerprint: visualSpecFingerprint(spec),
  };
}

/**
 * Parsea y compila una spec. Acepta el JSON en crudo o el contenido de una
 * valla ```visual. Nunca devuelve una figura parcial: o es válida o hay error.
 */
export function parseVisualSpec(source: string | unknown): VisualParseResult {
  let data: unknown = source;

  if (typeof source === 'string') {
    const json = unwrapVisualSource(source);
    if (json.length === 0) {
      return { ok: false, error: 'La figura no trae ningún contenido.' };
    }
    try {
      data = JSON.parse(json);
    } catch {
      return { ok: false, error: 'La figura no es un JSON válido.' };
    }
  }

  const parsed = visualSpecSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` en ${issue.path.join('.')}` : '';
    return {
      ok: false,
      error: `La especificación visual no es válida${where}: ${issue?.message ?? 'datos incorrectos'}.`,
    };
  }

  try {
    return { ok: true, visual: toCompiledVisual(parsed.data) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'construcción imposible';
    return { ok: false, error: message };
  }
}
