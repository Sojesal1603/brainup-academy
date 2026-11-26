/**
 * Construcciones exactas de dibujo técnico.
 *
 * El modelo no dibuja: elige una de estas construcciones y pasa sus datos. El
 * motor calcula mediatrices, tangentes, intersecciones, giros, abatimientos y
 * polígonos con aritmética real, y genera también los pasos que el alumno puede
 * ir validando en pantalla.
 */
import {
  angleDegOf,
  circleIntersections,
  distance,
  lineIntersection,
  midpoint,
  projectOnLine,
  reflectAcrossLine,
  regularPolygonVertices,
  rotateAround,
  sub,
  unit,
  vec,
} from './core';
import { computeViewBox } from './bounds';
import type {
  AnglePrimitive,
  ArcPrimitive,
  CirclePrimitive,
  Construction,
  DimensionPrimitive,
  GeometryConstraint,
  GeometryPrimitive,
  GeometrySolution,
  GeometryStep,
  LabelPrimitive,
  Point,
  PointPrimitive,
  PointRole,
  PolygonPrimitive,
  SegmentPrimitive,
} from './types';

const EPS = 1e-7;

function fail(message: string): never {
  throw new Error(message);
}

function assertFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value)) fail(`La coordenada ${name} no es un número válido.`);
}

function assertPoint(value: Point, name: string): void {
  assertFiniteNumber(value[0], `${name}.x`);
  assertFiniteNumber(value[1], `${name}.y`);
}

function pointPrimitive(
  id: string,
  at: Point,
  label: string,
  role: PointRole
): PointPrimitive {
  return { type: 'point', id, at, label, role };
}

function segmentPrimitive(
  id: string,
  from: Point,
  to: Point,
  style: SegmentPrimitive['style'] = 'solid',
  label?: string
): SegmentPrimitive {
  return { type: 'segment', id, from, to, style, ...(label ? { label } : {}) };
}

function circlePrimitive(
  id: string,
  center: Point,
  radius: number,
  style: CirclePrimitive['style'] = 'dashed',
  label?: string
): CirclePrimitive {
  return { type: 'circle', id, center, radius, style, ...(label ? { label } : {}) };
}

function arcPrimitive(
  id: string,
  center: Point,
  radius: number,
  startAngle: number,
  endAngle: number,
  style: ArcPrimitive['style'] = 'dashed'
): ArcPrimitive {
  return { type: 'arc', id, center, radius, startAngle, endAngle, style };
}

function polygonPrimitive(
  id: string,
  points: readonly Point[],
  style: PolygonPrimitive['style'] = 'accent'
): PolygonPrimitive {
  return { type: 'polygon', id, points, style, closed: true };
}

function labelPrimitive(
  id: string,
  at: Point,
  text: string,
  style: LabelPrimitive['style'] = 'muted'
): LabelPrimitive {
  return { type: 'label', id, at, text, style };
}

function dimensionPrimitive(
  id: string,
  from: Point,
  to: Point,
  offset: number,
  label: string
): DimensionPrimitive {
  return { type: 'dimension', id, from, to, offset, label, style: 'muted' };
}

function anglePrimitive(
  id: string,
  vertex: Point,
  from: Point,
  to: Point,
  radius: number,
  label?: string
): AnglePrimitive {
  return { type: 'angle', id, vertex, from, to, radius, ...(label ? { label } : {}) };
}

function step(id: string, title: string, detail: string, visible: string[]): GeometryStep {
  return { id, title, detail, visible };
}

function constraint(
  kind: GeometryConstraint['kind'],
  refs: string[],
  label: string
): GeometryConstraint {
  return { kind, refs, label };
}

/** Comprueba que todo lo que va a pintarse es finito y tiene ids únicos. */
function finalize(
  primitives: GeometryPrimitive[],
  steps: GeometryStep[],
  constraints: GeometryConstraint[]
): GeometrySolution {
  if (primitives.length === 0) fail('La construcción no ha producido ninguna primitiva.');
  if (steps.length === 0) fail('La construcción no tiene pasos.');

  const ids = new Set<string>();
  for (const primitive of primitives) {
    if (!primitive.id.trim()) fail('Hay una primitiva sin identificador.');
    if (ids.has(primitive.id)) fail(`El identificador «${primitive.id}» está repetido.`);
    ids.add(primitive.id);

    switch (primitive.type) {
      case 'point':
      case 'label':
        assertPoint(primitive.at, primitive.id);
        break;
      case 'segment':
      case 'dimension':
        assertPoint(primitive.from, primitive.id);
        assertPoint(primitive.to, primitive.id);
        break;
      case 'circle':
      case 'arc':
        assertPoint(primitive.center, primitive.id);
        assertFiniteNumber(primitive.radius, `${primitive.id}.radio`);
        if (primitive.radius <= EPS) fail(`El radio de «${primitive.id}» debe ser positivo.`);
        break;
      case 'polygon':
        if (primitive.points.length < 3) fail(`El polígono «${primitive.id}» necesita 3 vértices.`);
        for (const vertex of primitive.points) assertPoint(vertex, primitive.id);
        break;
      case 'angle':
        assertPoint(primitive.vertex, primitive.id);
        assertPoint(primitive.from, primitive.id);
        assertPoint(primitive.to, primitive.id);
        break;
      default:
        break;
    }
  }

  for (const stepItem of steps) {
    if (!stepItem.id.trim()) fail('Hay un paso sin identificador.');
    if (stepItem.visible.length === 0) fail(`El paso «${stepItem.id}» no muestra nada.`);
    for (const id of stepItem.visible) {
      if (!ids.has(id)) fail(`El paso «${stepItem.id}» referencia una primitiva inexistente: ${id}.`);
    }
  }

  for (const item of constraints) {
    for (const id of item.refs) {
      if (!ids.has(id)) fail(`La restricción referencia una primitiva inexistente: ${id}.`);
    }
  }

  return {
    primitives,
    steps,
    constraints,
    viewBox: computeViewBox(primitives),
  };
}

/* ------------------------------------------------------------------ */
/* Las diez construcciones                                             */
/* ------------------------------------------------------------------ */

function perpendicularBisector(a: Point, b: Point): GeometrySolution {
  assertPoint(a, 'A');
  assertPoint(b, 'B');
  const length = distance(a, b);
  if (length < EPS) fail('La mediatriz necesita dos puntos distintos.');

  const middle = midpoint(a, b);
  const radius = length * 0.72;
  const intersections = circleIntersections(a, radius, b, radius);
  if (intersections.length < 2) fail('No se han podido trazar los arcos de la mediatriz.');

  const [first, second] = intersections;
  const c1: Point = [first.x, first.y];
  const c2: Point = [second.x, second.y];

  return finalize(
    [
      pointPrimitive('p-a', a, 'A', 'given'),
      pointPrimitive('p-b', b, 'B', 'given'),
      segmentPrimitive('seg-ab', a, b, 'muted'),
      circlePrimitive('circ-a', a, radius, 'dashed'),
      circlePrimitive('circ-b', b, radius, 'dashed'),
      pointPrimitive('p-c1', c1, 'C₁', 'auxiliary'),
      pointPrimitive('p-c2', c2, 'C₂', 'auxiliary'),
      pointPrimitive('p-m', middle, 'M', 'result'),
      segmentPrimitive('seg-mediatriz', c1, c2, 'accent'),
    ],
    [
      step('paso-1', 'Dibuja el segmento AB', 'Marca los dos extremos y únelos.', [
        'p-a',
        'p-b',
        'seg-ab',
      ]),
      step(
        'paso-2',
        'Traza dos arcos con el mismo radio',
        'Con el compás en A y en B, usa el mismo radio para que los cortes sean simétricos.',
        ['circ-a', 'circ-b', 'p-c1', 'p-c2']
      ),
      step(
        'paso-3',
        'Une los dos cortes',
        'La recta que pasa por C₁ y C₂ es la mediatriz: corta AB en su punto medio y en ángulo recto.',
        ['p-m', 'seg-mediatriz']
      ),
    ],
    [
      constraint('perpendicular', ['seg-ab', 'seg-mediatriz'], 'AB ⟂ mediatriz'),
      constraint('midpoint', ['seg-ab', 'p-m'], 'M es el punto medio de AB'),
      constraint('equal', ['p-a', 'p-b'], 'La mediatriz equidista de A y B'),
    ]
  );
}

function perpendicularThroughPoint(line: readonly [Point, Point], p: Point): GeometrySolution {
  const [a, b] = line;
  assertPoint(a, 'A');
  assertPoint(b, 'B');
  assertPoint(p, 'P');
  const direction = sub(vec(b), vec(a));
  const directionUnit = unit(direction);
  if (!directionUnit) fail('La recta de referencia necesita dos puntos distintos.');

  const foot = projectOnLine(p, a, b);
  if (!foot) fail('No se ha podido calcular el pie de la perpendicular.');
  const footPoint: Point = [foot.x, foot.y];
  const onLine = distance(p, footPoint) < EPS;
  const normal = unit({ x: -directionUnit.y, y: directionUnit.x });
  if (!normal) fail('No se ha podido calcular la dirección perpendicular.');
  const length = Math.max(distance(a, b), 40);
  const end: Point = onLine
    ? [p[0] + normal.x * length, p[1] + normal.y * length]
    : footPoint;

  const visible: GeometryPrimitive[] = [
    pointPrimitive('p-a', a, 'A', 'given'),
    pointPrimitive('p-b', b, 'B', 'given'),
    segmentPrimitive('seg-recta', a, b, 'muted'),
    pointPrimitive('p-p', p, 'P', 'given'),
    pointPrimitive('p-f', footPoint, 'F', 'result'),
    segmentPrimitive('seg-perp', p, end, 'accent'),
  ];

  if (!onLine) {
    visible.push(anglePrimitive('ang-recto', footPoint, a, p, Math.max(10, length * 0.16), '90°'));
  }

  return finalize(
    visible,
    [
      step('paso-1', 'Dibuja la recta y el punto P', 'Puede estar sobre la recta o fuera de ella.', [
        'p-a',
        'p-b',
        'seg-recta',
        'p-p',
      ]),
      step(
        'paso-2',
        'Baja la perpendicular',
        'El pie F es el punto de la recta más cercano a P. La perpendicular pasa por P y por F.',
        ['p-f', 'seg-perp', 'ang-recto']
      ),
    ],
    [
      constraint('perpendicular', ['seg-recta', 'seg-perp'], 'La recta PF es perpendicular a AB'),
      ...(onLine ? [] : [constraint('angle', ['ang-recto'], 'El ángulo en F es recto')]),
    ]
  );
}

function parallelThroughPoint(line: readonly [Point, Point], p: Point): GeometrySolution {
  const [a, b] = line;
  assertPoint(a, 'A');
  assertPoint(b, 'B');
  assertPoint(p, 'P');
  const direction = sub(vec(b), vec(a));
  const directionUnit = unit(direction);
  if (!directionUnit) fail('La recta de referencia necesita dos puntos distintos.');

  const length = Math.max(distance(a, b), 40);
  const end: Point = [p[0] + directionUnit.x * length, p[1] + directionUnit.y * length];

  return finalize(
    [
      pointPrimitive('p-a', a, 'A', 'given'),
      pointPrimitive('p-b', b, 'B', 'given'),
      segmentPrimitive('seg-recta', a, b, 'muted'),
      pointPrimitive('p-p', p, 'P', 'given'),
      segmentPrimitive('seg-paralela', p, end, 'accent'),
      labelPrimitive('lbl-paralela', [p[0], p[1] + 14], 'paralela', 'accent'),
    ],
    [
      step('paso-1', 'Dibuja la recta AB y el punto P', 'P no tiene por qué estar sobre la recta.', [
        'p-a',
        'p-b',
        'seg-recta',
        'p-p',
      ]),
      step(
        'paso-2',
        'Copia la dirección',
        'La paralela conserva la misma dirección que AB y pasa por P.',
        ['seg-paralela', 'lbl-paralela']
      ),
    ],
    [constraint('parallel', ['seg-recta', 'seg-paralela'], 'Las dos rectas son paralelas')]
  );
}

function angleBisector(vertex: Point, from: Point, to: Point): GeometrySolution {
  assertPoint(vertex, 'V');
  assertPoint(from, 'A');
  assertPoint(to, 'B');
  const first = sub(vec(from), vec(vertex));
  const second = sub(vec(to), vec(vertex));
  const firstUnit = unit(first);
  const secondUnit = unit(second);
  if (!firstUnit || !secondUnit) fail('La bisectriz necesita dos lados con longitud positiva.');

  let direction = unit({ x: firstUnit.x + secondUnit.x, y: firstUnit.y + secondUnit.y });
  if (!direction) {
    // Ángulo llano: la bisectriz es la perpendicular a uno de los lados.
    direction = { x: -firstUnit.y, y: firstUnit.x };
  }

  const length = Math.max(distance(vertex, from), distance(vertex, to)) * 1.18;
  const end: Point = [vertex[0] + direction.x * length, vertex[1] + direction.y * length];

  return finalize(
    [
      pointPrimitive('p-v', vertex, 'V', 'given'),
      pointPrimitive('p-a', from, 'A', 'given'),
      pointPrimitive('p-b', to, 'B', 'given'),
      segmentPrimitive('seg-va', vertex, from, 'muted'),
      segmentPrimitive('seg-vb', vertex, to, 'muted'),
      segmentPrimitive('seg-bisectriz', vertex, end, 'accent'),
      anglePrimitive('ang-mitad', vertex, from, end, Math.min(length * 0.27, 44), 'α/2'),
    ],
    [
      step('paso-1', 'Dibuja el ángulo AVB', 'Los dos lados salen del mismo vértice V.', [
        'p-v',
        'p-a',
        'p-b',
        'seg-va',
        'seg-vb',
      ]),
      step(
        'paso-2',
        'Traza la bisectriz',
        'La semirrecta que divide el ángulo en dos partes iguales se apoya en la suma de los vectores unitarios de los lados.',
        ['seg-bisectriz', 'ang-mitad']
      ),
    ],
    [constraint('angle', ['ang-mitad', 'seg-bisectriz'], 'Los dos ángulos son iguales')]
  );
}

function intersectionOfLines(
  line1: readonly [Point, Point],
  line2: readonly [Point, Point]
): GeometrySolution {
  const [a, b] = line1;
  const [c, d] = line2;
  for (const [value, name] of [
    [a, 'A'],
    [b, 'B'],
    [c, 'C'],
    [d, 'D'],
  ] as const) {
    assertPoint(value, name);
  }
  const intersection = lineIntersection(a, b, c, d);
  if (!intersection) fail('Las dos rectas son paralelas o coincidentes: no hay un único corte.');
  const x: Point = [intersection.x, intersection.y];

  return finalize(
    [
      pointPrimitive('p-a', a, 'A', 'given'),
      pointPrimitive('p-b', b, 'B', 'given'),
      pointPrimitive('p-c', c, 'C', 'given'),
      pointPrimitive('p-d', d, 'D', 'given'),
      segmentPrimitive('seg-recta-1', a, b, 'muted'),
      segmentPrimitive('seg-recta-2', c, d, 'muted'),
      pointPrimitive('p-x', x, 'X', 'result'),
    ],
    [
      step('paso-1', 'Dibuja las dos rectas', 'Cada recta queda definida por dos puntos.', [
        'p-a',
        'p-b',
        'p-c',
        'p-d',
        'seg-recta-1',
        'seg-recta-2',
      ]),
      step(
        'paso-2',
        'Marca el punto de corte',
        'X es el único punto que pertenece a las dos rectas a la vez.',
        ['p-x']
      ),
    ],
    [constraint('equal', ['p-x'], 'X pertenece a las dos rectas')]
  );
}

function tangentsFromPoint(center: Point, radius: number, p: Point): GeometrySolution {
  assertPoint(center, 'O');
  assertPoint(p, 'P');
  assertFiniteNumber(radius, 'radio');
  if (radius <= EPS) fail('La circunferencia necesita un radio positivo.');

  const distanceToCenter = distance(center, p);
  if (distanceToCenter <= radius + EPS) {
    fail('El punto debe estar fuera de la circunferencia para trazar dos tangentes.');
  }

  const middle = midpoint(center, p);
  const helperRadius = distanceToCenter / 2;
  const cuts = circleIntersections(center, radius, middle, helperRadius);
  if (cuts.length < 2) fail('No se han podido calcular los puntos de tangencia.');

  const [t1v, t2v] = cuts;
  const t1: Point = [t1v.x, t1v.y];
  const t2: Point = [t2v.x, t2v.y];

  return finalize(
    [
      pointPrimitive('p-o', center, 'O', 'given'),
      pointPrimitive('p-p', p, 'P', 'given'),
      circlePrimitive('circ-base', center, radius, 'solid'),
      segmentPrimitive('seg-op', center, p, 'muted'),
      pointPrimitive('p-m', middle, 'M', 'auxiliary'),
      circlePrimitive('circ-thales', middle, helperRadius, 'dashed'),
      pointPrimitive('p-t1', t1, 'T₁', 'result'),
      pointPrimitive('p-t2', t2, 'T₂', 'result'),
      segmentPrimitive('seg-t1', p, t1, 'accent'),
      segmentPrimitive('seg-t2', p, t2, 'accent'),
      anglePrimitive('ang-t1', t1, center, p, Math.max(8, radius * 0.18), '90°'),
    ],
    [
      step('paso-1', 'Dibuja la circunferencia y el punto P', 'P tiene que quedar fuera de la circunferencia.', [
        'p-o',
        'p-p',
        'circ-base',
        'seg-op',
      ]),
      step(
        'paso-2',
        'Traza la circunferencia de Thales',
        'Con centro en el punto medio M de OP y radio MP, los cortes con la circunferencia original son los puntos de tangencia.',
        ['p-m', 'circ-thales', 'p-t1', 'p-t2']
      ),
      step(
        'paso-3',
        'Une P con los puntos de tangencia',
        'PT₁ y PT₂ son tangentes: tocan la circunferencia en un único punto y forman 90° con el radio.',
        ['seg-t1', 'seg-t2', 'ang-t1']
      ),
    ],
    [
      constraint('tangent', ['circ-base', 'seg-t1', 'p-t1'], 'PT₁ es tangente en T₁'),
      constraint('tangent', ['circ-base', 'seg-t2', 'p-t2'], 'PT₂ es tangente en T₂'),
      constraint('perpendicular', ['p-o', 'p-t1', 'p-p'], 'OT₁ ⟂ PT₁'),
    ]
  );
}

function rotation(p: Point, center: Point, angleDeg: number): GeometrySolution {
  assertPoint(p, 'P');
  assertPoint(center, 'O');
  assertFiniteNumber(angleDeg, 'ángulo');
  const radius = distance(center, p);
  if (radius < EPS) fail('El punto que se gira no puede coincidir con el centro.');

  const result = rotateAround(p, center, angleDeg);
  const startAngle = angleDegOf(sub(vec(p), vec(center)));
  const endAngle = startAngle + angleDeg;

  return finalize(
    [
      pointPrimitive('p-o', center, 'O', 'given'),
      pointPrimitive('p-p', p, 'P', 'given'),
      pointPrimitive('p-q', result, "P'", 'result'),
      segmentPrimitive('seg-op', center, p, 'muted'),
      segmentPrimitive('seg-oq', center, result, 'muted'),
      arcPrimitive('arc-giro', center, radius, startAngle, endAngle, 'accent'),
      labelPrimitive('lbl-giro', [center[0], center[1] + Math.max(18, radius * 0.25)], `${angleDeg}°`, 'accent'),
    ],
    [
      step('paso-1', 'Marca el centro y el punto', 'La distancia OP se conserva durante todo el giro.', [
        'p-o',
        'p-p',
        'seg-op',
      ]),
      step(
        'paso-2',
        'Gira el radio el ángulo pedido',
        'El arco marca el recorrido; P’ queda a la misma distancia de O que P.',
        ['p-q', 'seg-oq', 'arc-giro', 'lbl-giro']
      ),
    ],
    [
      constraint('equal', ['seg-op', 'seg-oq'], 'OP = OP′'),
      constraint('angle', ['arc-giro', 'lbl-giro'], `Giro de ${angleDeg}° alrededor de O`),
    ]
  );
}

function midpointConstruction(a: Point, b: Point): GeometrySolution {
  assertPoint(a, 'A');
  assertPoint(b, 'B');
  if (distance(a, b) < EPS) fail('El punto medio necesita dos puntos distintos.');
  const middle = midpoint(a, b);

  return finalize(
    [
      pointPrimitive('p-a', a, 'A', 'given'),
      pointPrimitive('p-b', b, 'B', 'given'),
      segmentPrimitive('seg-ab', a, b, 'muted'),
      pointPrimitive('p-m', middle, 'M', 'result'),
      dimensionPrimitive('dim-am', a, middle, 20, 'AM'),
      dimensionPrimitive('dim-mb', middle, b, 20, 'MB'),
    ],
    [
      step('paso-1', 'Dibuja el segmento AB', 'Mide o localiza sus extremos.', ['p-a', 'p-b', 'seg-ab']),
      step(
        'paso-2',
        'Señala el punto medio',
        'M divide AB en dos segmentos iguales: AM = MB.',
        ['p-m', 'dim-am', 'dim-mb']
      ),
    ],
    [
      constraint('midpoint', ['seg-ab', 'p-m'], 'M es el punto medio de AB'),
      constraint('equal', ['dim-am', 'dim-mb'], 'AM = MB'),
    ]
  );
}

function regularPolygon(
  center: Point,
  radius: number,
  sides: number,
  rotationDeg = 0
): GeometrySolution {
  assertPoint(center, 'O');
  assertFiniteNumber(radius, 'radio');
  assertFiniteNumber(rotationDeg, 'rotación');
  if (radius <= EPS) fail('El polígono necesita un radio positivo.');
  if (!Number.isInteger(sides) || sides < 3 || sides > 24) {
    fail('El número de lados debe ser un entero entre 3 y 24.');
  }

  const vertices = regularPolygonVertices(center, radius, sides, rotationDeg);
  if (vertices.length !== sides) fail('No se han podido calcular los vértices del polígono.');

  const primitives: GeometryPrimitive[] = [
    pointPrimitive('p-o', center, 'O', 'given'),
    circlePrimitive('circ-circunscrita', center, radius, 'dashed'),
    ...vertices.map((vertex, index) => pointPrimitive(`p-v${index + 1}`, vertex, `V${index + 1}`, 'result')),
    polygonPrimitive('poly', vertices, 'accent'),
    dimensionPrimitive('dim-lado', vertices[0], vertices[1], -radius * 0.18, 'lado'),
  ];

  return finalize(
    primitives,
    [
      step('paso-1', 'Dibuja la circunferencia circunscrita', 'Todos los vértices están a la misma distancia del centro O.', [
        'p-o',
        'circ-circunscrita',
      ]),
      step(
        'paso-2',
        'Reparte los vértices',
        `Divide la circunferencia en ${sides} partes iguales y une los vértices consecutivos.`,
        [...vertices.map((_vertex, index) => `p-v${index + 1}`), 'poly', 'dim-lado']
      ),
    ],
    [
      constraint('equal', ['poly'], 'Todos los lados y ángulos son iguales'),
      constraint('equal', ['p-o', 'circ-circunscrita'], 'Los vértices equidistan de O'),
    ]
  );
}

function reflection(p: Point, line: readonly [Point, Point]): GeometrySolution {
  const [a, b] = line;
  assertPoint(a, 'A');
  assertPoint(b, 'B');
  assertPoint(p, 'P');
  if (distance(a, b) < EPS) fail('El eje de simetría necesita dos puntos distintos.');

  const foot = projectOnLine(p, a, b);
  if (!foot) fail('No se ha podido calcular la proyección sobre el eje.');
  const footPoint: Point = [foot.x, foot.y];
  if (distance(p, footPoint) < EPS) fail('El punto ya está sobre el eje: su simétrico es él mismo.');

  const reflected = reflectAcrossLine(p, a, b);
  if (!reflected) fail('No se ha podido calcular el punto simétrico.');
  const q: Point = [reflected.x, reflected.y];

  return finalize(
    [
      pointPrimitive('p-a', a, 'A', 'given'),
      pointPrimitive('p-b', b, 'B', 'given'),
      segmentPrimitive('seg-eje', a, b, 'muted'),
      pointPrimitive('p-p', p, 'P', 'given'),
      pointPrimitive('p-f', footPoint, 'F', 'auxiliary'),
      pointPrimitive('p-q', q, "P'", 'result'),
      segmentPrimitive('seg-pp', p, q, 'dashed'),
      segmentPrimitive('seg-pf', p, footPoint, 'accent'),
      segmentPrimitive('seg-fq', footPoint, q, 'dashed'),
      anglePrimitive('ang-recto', footPoint, a, p, Math.max(9, distance(a, b) * 0.14), '90°'),
    ],
    [
      step('paso-1', 'Dibuja el eje y el punto P', 'El eje es la recta AB; P no está sobre él.', [
        'p-a',
        'p-b',
        'seg-eje',
        'p-p',
      ]),
      step(
        'paso-2',
        'Baja la perpendicular al eje',
        'F es el pie de la perpendicular. El eje corta PP′ en ángulo recto.',
        ['p-f', 'seg-pf', 'ang-recto']
      ),
      step(
        'paso-3',
        'Lleva la distancia al otro lado',
        'PF = FP′. Así P′ es el abatimiento de P sobre el eje.',
        ['p-q', 'seg-pp', 'seg-fq']
      ),
    ],
    [
      constraint('reflection', ['seg-eje', 'p-p', 'p-q'], 'P′ es el simétrico de P respecto al eje'),
      constraint('perpendicular', ['seg-eje', 'seg-pp'], 'El eje es perpendicular a PP′'),
      constraint('equal', ['seg-pf', 'seg-fq'], 'PF = FP′'),
    ]
  );
}

/** Compila una construcción y devuelve primitivas, pasos y viewBox. */
export function compileConstruction(construction: Construction): GeometrySolution {
  switch (construction.kind) {
    case 'perpendicular_bisector':
      return perpendicularBisector(construction.a, construction.b);
    case 'perpendicular_through_point':
      return perpendicularThroughPoint(construction.line, construction.point);
    case 'parallel_through_point':
      return parallelThroughPoint(construction.line, construction.point);
    case 'angle_bisector':
      return angleBisector(construction.vertex, construction.from, construction.to);
    case 'line_intersection':
      return intersectionOfLines(construction.line1, construction.line2);
    case 'tangent_from_point':
      return tangentsFromPoint(construction.center, construction.radius, construction.point);
    case 'rotate':
      return rotation(construction.point, construction.center, construction.angleDeg);
    case 'midpoint':
      return midpointConstruction(construction.a, construction.b);
    case 'regular_polygon':
      return regularPolygon(
        construction.center,
        construction.radius,
        construction.sides,
        construction.rotationDeg ?? 0
      );
    case 'reflect_point':
      return reflection(construction.point, construction.line);
    default: {
      const exhaustive: never = construction;
      return fail(`Construcción desconocida: ${String(exhaustive)}`);
    }
  }
}

/** Resuelve primitivas escritas a mano (esquemas libres) sin construcción. */
export function compilePrimitives(
  primitives: readonly GeometryPrimitive[],
  steps?: readonly GeometryStep[],
  constraints?: readonly GeometryConstraint[]
): GeometrySolution {
  const resolvedSteps =
    steps && steps.length > 0
      ? [...steps]
      : [
          {
            id: 'paso-1',
            title: 'Esquema completo',
            detail: 'La figura ya está trazada.',
            visible: primitives.map((primitive) => primitive.id),
          },
        ];

  return finalize([...primitives], resolvedSteps, [...(constraints ?? [])]);
}
