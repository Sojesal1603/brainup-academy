/**
 * Aritmética geométrica pura, sin DOM y sin dependencias.
 *
 * Todo se calcula en coordenadas cartesianas (Y hacia arriba). Las funciones
 * devuelven `null` cuando una construcción es imposible; el compilador de
 * `VisualSpec` convierte ese `null` en un error legible en vez de dibujar una
 * figura rota.
 */
import type { Point, Vec } from './types';

export const EPS = 1e-7;

export function vec(point: Point): Vec {
  return { x: point[0], y: point[1] };
}

export function point(value: Vec): Point {
  return [value.x, value.y];
}

export function add(a: Vec, b: Vec): Vec {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec, b: Vec): Vec {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(value: Vec, factor: number): Vec {
  return { x: value.x * factor, y: value.y * factor };
}

export function dot(a: Vec, b: Vec): number {
  return a.x * b.x + a.y * b.y;
}

export function cross(a: Vec, b: Vec): number {
  return a.x * b.y - a.y * b.x;
}

export function norm(value: Vec): number {
  return Math.hypot(value.x, value.y);
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function midpoint(a: Point, b: Point): Point {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** Normaliza sin lanzar: si el vector es nulo devuelve `null`. */
export function unit(value: Vec): Vec | null {
  const length = norm(value);
  if (length < EPS) return null;
  return { x: value.x / length, y: value.y / length };
}

export function perpendicular(value: Vec): Vec {
  return { x: -value.y, y: value.x };
}

/** Ángulo en radianes, en el rango (-π, π]. */
export function angleOf(value: Vec): number {
  return Math.atan2(value.y, value.x);
}

export function angleDegOf(value: Vec): number {
  return (angleOf(value) * 180) / Math.PI;
}

export function rotateAround(pointValue: Point, center: Point, angleDeg: number): Point {
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = pointValue[0] - center[0];
  const dy = pointValue[1] - center[1];
  return [center[0] + dx * cos - dy * sin, center[1] + dx * sin + dy * cos];
}

/**
 * Intersección de dos rectas infinitas definidas por dos puntos cada una.
 * Devuelve `null` si son paralelas o coincidentes.
 */
export function lineIntersection(a: Point, b: Point, c: Point, d: Point): Vec | null {
  const r = sub(vec(b), vec(a));
  const s = sub(vec(d), vec(c));
  const denominator = cross(r, s);
  if (Math.abs(denominator) < EPS) return null;

  const t = cross(sub(vec(c), vec(a)), s) / denominator;
  return add(vec(a), scale(r, t));
}

/** Pie de la perpendicular desde `p` a la recta `a-b`. */
export function projectOnLine(p: Point, a: Point, b: Point): Vec | null {
  const direction = sub(vec(b), vec(a));
  const lengthSquared = dot(direction, direction);
  if (lengthSquared < EPS * EPS) return null;
  const t = dot(sub(vec(p), vec(a)), direction) / lengthSquared;
  return add(vec(a), scale(direction, t));
}

/**
 * Intersecciones de dos circunferencias. Devuelve 0, 1 o 2 puntos; nunca lanza.
 * Los puntos se ordenan de forma estable para que la figura sea determinista.
 */
export function circleIntersections(
  center1: Point,
  radius1: number,
  center2: Point,
  radius2: number
): Vec[] {
  if (radius1 <= EPS || radius2 <= EPS) return [];

  const delta = sub(vec(center2), vec(center1));
  const d = norm(delta);
  if (d < EPS) return [];
  if (d > radius1 + radius2 + EPS) return [];
  if (d < Math.abs(radius1 - radius2) - EPS) return [];

  const a = (radius1 * radius1 - radius2 * radius2 + d * d) / (2 * d);
  const hSquared = radius1 * radius1 - a * a;
  const h = hSquared > 0 ? Math.sqrt(hSquared) : 0;
  const base = add(vec(center1), scale(delta, a / d));
  if (h < EPS) return [base];

  const perpendicularUnit = unit(perpendicular(delta));
  if (!perpendicularUnit) return [base];
  const offset = scale(perpendicularUnit, h);
  const first = add(base, offset);
  const second = sub(base, offset);

  return [first, second].sort((left, right) =>
    Math.abs(left.y - right.y) > EPS ? left.y - right.y : left.x - right.x
  );
}

/** Simetría axial de `p` respecto a la recta `a-b` (el abatimiento plano). */
export function reflectAcrossLine(p: Point, a: Point, b: Point): Vec | null {
  const foot = projectOnLine(p, a, b);
  if (!foot) return null;
  return { x: foot.x * 2 - p[0], y: foot.y * 2 - p[1] };
}

/** Vértices de un polígono regular, en orden y con radio exacto. */
export function regularPolygonVertices(
  center: Point,
  radius: number,
  sides: number,
  rotationDeg = 0
): Point[] {
  if (sides < 3 || radius <= EPS) return [];
  const start = (rotationDeg * Math.PI) / 180;
  const vertices: Point[] = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = start + (index * 2 * Math.PI) / sides;
    vertices.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
  }
  return vertices;
}

/** ¿Está el punto dentro de la circunferencia (con margen numérico)? */
export function isInsideCircle(p: Point, center: Point, radius: number): boolean {
  return distance(p, center) < radius - EPS;
}

export function nearlyEqual(a: number, b: number, epsilon = 1e-5): boolean {
  return Math.abs(a - b) <= epsilon;
}

export function nearlyEqualPoint(a: Point, b: Point, epsilon = 1e-5): boolean {
  return nearlyEqual(a[0], b[0], epsilon) && nearlyEqual(a[1], b[1], epsilon);
}
