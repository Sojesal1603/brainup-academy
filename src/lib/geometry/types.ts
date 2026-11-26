/**
 * Tipos del motor geométrico.
 *
 * Una `VisualSpec` no guarda SVG: guarda una construcción (o unas primitivas)
 * con coordenadas en un sistema cartesiano con el eje Y hacia arriba. El
 * renderizador se encarga de pasarlo a pantalla. Así la figura es reproducible,
 * se puede validar sin navegador y el modelo nunca escribe HTML.
 */

/** Punto en coordenadas cartesianas: [x, y]. */
export type Point = readonly [number, number];

export interface Vec {
  x: number;
  y: number;
}

export type PrimitiveStyle = 'solid' | 'dashed' | 'muted' | 'accent';

/** Papel del punto en la construcción: dato, ayuda o resultado. */
export type PointRole = 'given' | 'auxiliary' | 'result';

interface PrimitiveBase {
  id: string;
  style?: PrimitiveStyle;
}

export interface PointPrimitive extends PrimitiveBase {
  type: 'point';
  at: Point;
  label?: string;
  role?: PointRole;
}

export interface SegmentPrimitive extends PrimitiveBase {
  type: 'segment';
  from: Point;
  to: Point;
  label?: string;
}

export interface CirclePrimitive extends PrimitiveBase {
  type: 'circle';
  center: Point;
  radius: number;
  label?: string;
}

export interface ArcPrimitive extends PrimitiveBase {
  type: 'arc';
  center: Point;
  radius: number;
  startAngle: number;
  endAngle: number;
  label?: string;
}

export interface PolygonPrimitive extends PrimitiveBase {
  type: 'polygon';
  points: readonly Point[];
  label?: string;
  closed?: boolean;
}

export interface LabelPrimitive extends PrimitiveBase {
  type: 'label';
  at: Point;
  text: string;
}

export interface DimensionPrimitive extends PrimitiveBase {
  type: 'dimension';
  from: Point;
  to: Point;
  offset?: number;
  label?: string;
}

export interface AnglePrimitive extends PrimitiveBase {
  type: 'angle';
  vertex: Point;
  from: Point;
  to: Point;
  radius?: number;
  label?: string;
}

export type GeometryPrimitive =
  | PointPrimitive
  | SegmentPrimitive
  | CirclePrimitive
  | ArcPrimitive
  | PolygonPrimitive
  | LabelPrimitive
  | DimensionPrimitive
  | AnglePrimitive;

export type ConstraintKind =
  | 'perpendicular'
  | 'parallel'
  | 'tangent'
  | 'equal'
  | 'midpoint'
  | 'angle'
  | 'reflection';

/** Restricción declarada por la construcción. No se dibuja: se explica. */
export interface GeometryConstraint {
  kind: ConstraintKind;
  refs: readonly string[];
  label: string;
}

/** Paso de construcción que el alumno puede ir revelando y validando. */
export interface GeometryStep {
  id: string;
  title: string;
  detail?: string;
  visible: readonly string[];
}

export interface VisualViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GeometrySolution {
  primitives: readonly GeometryPrimitive[];
  steps: readonly GeometryStep[];
  constraints: readonly GeometryConstraint[];
  viewBox: VisualViewBox;
}

export type LineDefinition = readonly [Point, Point];

/**
 * Construcciones exactas que puede pedir el modelo. El modelo elige la
 * construcción y sus datos; el motor calcula los puntos. No hay coordenadas de
 * resultado inventadas por la IA.
 */
export type Construction =
  | { kind: 'perpendicular_bisector'; a: Point; b: Point }
  | { kind: 'perpendicular_through_point'; line: LineDefinition; point: Point }
  | { kind: 'parallel_through_point'; line: LineDefinition; point: Point }
  | { kind: 'angle_bisector'; vertex: Point; from: Point; to: Point }
  | { kind: 'line_intersection'; line1: LineDefinition; line2: LineDefinition }
  | { kind: 'tangent_from_point'; center: Point; radius: number; point: Point }
  | { kind: 'rotate'; point: Point; center: Point; angleDeg: number }
  | { kind: 'midpoint'; a: Point; b: Point }
  | { kind: 'regular_polygon'; center: Point; radius: number; sides: number; rotationDeg?: number }
  | { kind: 'reflect_point'; point: Point; line: LineDefinition };

export type ConstructionKind = Construction['kind'];

export const CONSTRUCTION_KINDS: readonly ConstructionKind[] = [
  'perpendicular_bisector',
  'perpendicular_through_point',
  'parallel_through_point',
  'angle_bisector',
  'line_intersection',
  'tangent_from_point',
  'rotate',
  'midpoint',
  'regular_polygon',
  'reflect_point',
];
