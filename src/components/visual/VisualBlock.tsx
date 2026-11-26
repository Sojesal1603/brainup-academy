'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  RotateCcw,
  Ruler,
} from 'lucide-react';
import clsx from 'clsx';
import { parseVisualSpec, type CompiledVisual } from '@/lib/visual/spec';
import type {
  AnglePrimitive,
  DimensionPrimitive,
  GeometryPrimitive,
  PointPrimitive,
  PrimitiveStyle,
  VisualViewBox,
} from '@/lib/geometry/types';

const STYLE_COLOR: Record<PrimitiveStyle, string> = {
  solid: '#e2e8f0',
  dashed: '#94a3b8',
  muted: '#64748b',
  accent: '#fbbf24',
};

function stroke(style: PrimitiveStyle | undefined): string {
  return STYLE_COLOR[style ?? 'solid'];
}

function dash(style: PrimitiveStyle | undefined): string | undefined {
  return style === 'dashed' || style === 'muted' ? '7 5' : undefined;
}

function radians(value: number): number {
  return (value * Math.PI) / 180;
}

function polar(cx: number, cy: number, radius: number, angleDeg: number): [number, number] {
  const angle = radians(angleDeg);
  return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
}

/** Arco en coordenadas matemáticas (el grupo SVG lo voltea para pantalla). */
function arcPath(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number
): string {
  let sweep = endAngle - startAngle;
  if (Math.abs(sweep) > 360) sweep = 360 * Math.sign(sweep || 1);
  if (Math.abs(sweep) < 0.001) return '';

  const start = polar(cx, cy, radius, startAngle);
  const end = polar(cx, cy, radius, endAngle);
  const large = Math.abs(sweep) > 180 ? 1 : 0;
  const direction = sweep >= 0 ? 1 : 0;
  return `M ${start[0]} ${start[1]} A ${radius} ${radius} 0 ${large} ${direction} ${end[0]} ${end[1]}`;
}

/** Arco pequeño entre dos vectores, usado por las marcas de ángulo. */
function angleArcPath(primitive: AnglePrimitive): string {
  const start = Math.atan2(
    primitive.from[1] - primitive.vertex[1],
    primitive.from[0] - primitive.vertex[0]
  );
  const end = Math.atan2(
    primitive.to[1] - primitive.vertex[1],
    primitive.to[0] - primitive.vertex[0]
  );
  let delta = end - start;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;

  const fromLength = Math.hypot(
    primitive.from[0] - primitive.vertex[0],
    primitive.from[1] - primitive.vertex[1]
  );
  const toLength = Math.hypot(
    primitive.to[0] - primitive.vertex[0],
    primitive.to[1] - primitive.vertex[1]
  );
  const radius = Math.max(
    8,
    Math.min(primitive.radius ?? Math.min(fromLength, toLength) * 0.28, Math.min(fromLength, toLength) * 0.9)
  );
  return arcPath(
    primitive.vertex[0],
    primitive.vertex[1],
    radius,
    (start * 180) / Math.PI,
    ((start + delta) * 180) / Math.PI
  );
}

function angleLabelPosition(primitive: AnglePrimitive): [number, number] {
  const start = Math.atan2(
    primitive.from[1] - primitive.vertex[1],
    primitive.from[0] - primitive.vertex[0]
  );
  const end = Math.atan2(
    primitive.to[1] - primitive.vertex[1],
    primitive.to[0] - primitive.vertex[0]
  );
  let delta = end - start;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const radius = Math.max(
    10,
    Math.min(primitive.radius ?? 22, Math.hypot(primitive.to[0] - primitive.vertex[0], primitive.to[1] - primitive.vertex[1]) * 0.8)
  );
  return polar(
    primitive.vertex[0],
    primitive.vertex[1],
    radius + 10,
    ((start + delta / 2) * 180) / Math.PI
  );
}

function dimensionLabelPosition(primitive: DimensionPrimitive): [number, number] {
  const dx = primitive.to[0] - primitive.from[0];
  const dy = primitive.to[1] - primitive.from[1];
  const length = Math.hypot(dx, dy) || 1;
  const offset = primitive.offset ?? 20;
  const nx = (-dy / length) * offset;
  const ny = (dx / length) * offset;
  return [
    (primitive.from[0] + primitive.to[0]) / 2 + nx,
    (primitive.from[1] + primitive.to[1]) / 2 + ny,
  ];
}

function midpoint(a: readonly [number, number], b: readonly [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function pointColor(primitive: PointPrimitive): string {
  if (primitive.role === 'result') return '#fbbf24';
  if (primitive.role === 'auxiliary') return '#94a3b8';
  return '#e2e8f0';
}

function PrimitiveShape({
  primitive,
  emphasis,
  markerId,
}: {
  primitive: GeometryPrimitive;
  emphasis: boolean;
  markerId: string;
}) {
  const width = emphasis ? 2.6 : 1.8;

  switch (primitive.type) {
    case 'point':
      return (
        <g>
          <circle
            cx={primitive.at[0]}
            cy={primitive.at[1]}
            r={emphasis ? 5.4 : 4.2}
            fill={pointColor(primitive)}
            stroke="#0b1120"
            strokeWidth={1.5}
          />
        </g>
      );

    case 'segment':
      return (
        <line
          x1={primitive.from[0]}
          y1={primitive.from[1]}
          x2={primitive.to[0]}
          y2={primitive.to[1]}
          stroke={stroke(primitive.style)}
          strokeWidth={width}
          strokeDasharray={dash(primitive.style)}
          strokeLinecap="round"
        />
      );

    case 'circle':
      return (
        <circle
          cx={primitive.center[0]}
          cy={primitive.center[1]}
          r={primitive.radius}
          fill="none"
          stroke={stroke(primitive.style)}
          strokeWidth={width}
          strokeDasharray={dash(primitive.style)}
          opacity={primitive.style === 'muted' ? 0.6 : 0.9}
        />
      );

    case 'arc': {
      const path = arcPath(
        primitive.center[0],
        primitive.center[1],
        primitive.radius,
        primitive.startAngle,
        primitive.endAngle
      );
      if (!path) return null;
      return (
        <path
          d={path}
          fill="none"
          stroke={stroke(primitive.style)}
          strokeWidth={width}
          strokeDasharray={dash(primitive.style)}
          strokeLinecap="round"
        />
      );
    }

    case 'polygon': {
      const path = primitive.points.map((vertex) => `${vertex[0]},${vertex[1]}`).join(' ');
      return (
        <polygon
          points={path}
          fill="none"
          stroke={stroke(primitive.style ?? 'accent')}
          strokeWidth={emphasis ? 2.8 : 2.2}
          strokeLinejoin="round"
        />
      );
    }

    case 'dimension': {
      const dx = primitive.to[0] - primitive.from[0];
      const dy = primitive.to[1] - primitive.from[1];
      const length = Math.hypot(dx, dy) || 1;
      const offset = primitive.offset ?? 20;
      const nx = (-dy / length) * offset;
      const ny = (dx / length) * offset;
      const from: [number, number] = [primitive.from[0] + nx, primitive.from[1] + ny];
      const to: [number, number] = [primitive.to[0] + nx, primitive.to[1] + ny];
      return (
        <g>
          <line
            x1={primitive.from[0]}
            y1={primitive.from[1]}
            x2={from[0]}
            y2={from[1]}
            stroke="#475569"
            strokeWidth={1}
            strokeDasharray="3 4"
          />
          <line
            x1={primitive.to[0]}
            y1={primitive.to[1]}
            x2={to[0]}
            y2={to[1]}
            stroke="#475569"
            strokeWidth={1}
            strokeDasharray="3 4"
          />
          <line
            x1={from[0]}
            y1={from[1]}
            x2={to[0]}
            y2={to[1]}
            stroke="#94a3b8"
            strokeWidth={1.2}
            markerStart={`url(#${markerId})`}
            markerEnd={`url(#${markerId})`}
          />
        </g>
      );
    }

    case 'angle': {
      const path = angleArcPath(primitive);
      if (!path) return null;
      return (
        <path
          d={path}
          fill="none"
          stroke="#fbbf24"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      );
    }

    case 'label':
      return null;

    default:
      return null;
  }
}

function PrimitiveText({
  primitive,
  viewBox,
  fontSize,
}: {
  primitive: GeometryPrimitive;
  viewBox: VisualViewBox;
  fontSize: number;
}) {
  const bottom = viewBox.y + viewBox.height;
  const render = (x: number, y: number, text: string, color: string, anchor: 'start' | 'middle' = 'start') => (
    <text
      key={primitive.id}
      x={x}
      y={bottom - y}
      fill={color}
      fontSize={fontSize}
      fontWeight={primitive.type === 'point' && primitive.role === 'result' ? 700 : 600}
      textAnchor={anchor}
      paintOrder="stroke"
      stroke="#080d17"
      strokeWidth={3}
      strokeLinejoin="round"
    >
      {text}
    </text>
  );

  switch (primitive.type) {
    case 'point':
      if (!primitive.label) return null;
      return render(
        primitive.at[0] + 7,
        primitive.at[1] + (primitive.role === 'auxiliary' ? 10 : 8),
        primitive.label,
        primitive.role === 'result' ? '#fcd34d' : '#cbd5e1'
      );

    case 'label':
      return render(primitive.at[0], primitive.at[1], primitive.text, stroke(primitive.style ?? 'muted'), 'middle');

    case 'segment':
      if (!primitive.label) return null;
      return render(
        midpoint(primitive.from, primitive.to)[0],
        midpoint(primitive.from, primitive.to)[1] + 8,
        primitive.label,
        '#94a3b8',
        'middle'
      );

    case 'dimension':
      if (!primitive.label) return null;
      {
        const [x, y] = dimensionLabelPosition(primitive);
        return render(x, y + 6, primitive.label, '#cbd5e1', 'middle');
      }

    case 'angle':
      if (!primitive.label) return null;
      {
        const [x, y] = angleLabelPosition(primitive);
        return render(x, y, primitive.label, '#fcd34d', 'middle');
      }

    case 'circle':
      if (!primitive.label) return null;
      return render(primitive.center[0], primitive.center[1] + primitive.radius + 14, primitive.label, '#94a3b8', 'middle');

    case 'polygon':
      if (!primitive.label) return null;
      {
        const center = primitive.points.reduce(
          (acc, vertex) => [acc[0] + vertex[0] / primitive.points.length, acc[1] + vertex[1] / primitive.points.length],
          [0, 0]
        );
        return render(center[0], center[1], primitive.label, '#fcd34d', 'middle');
      }

    default:
      return null;
  }
}

function VisualCard({
  visual,
  className,
}: {
  visual: CompiledVisual;
  className?: string;
}) {
  const { spec, solution, fingerprint } = visual;
  const steps = solution.steps;
  const [current, setCurrent] = useState(0);
  const [checked, setChecked] = useState<boolean[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [progressReady, setProgressReady] = useState(false);
  const markerId = useId().replace(/:/g, '');

  useEffect(() => {
    setCurrent(0);
    setShowAll(false);
    let saved: boolean[] = [];
    try {
      const raw = window.localStorage.getItem(`brainup.visual.${fingerprint}`);
      const parsed = raw ? (JSON.parse(raw) as { checked?: unknown }) : null;
      const savedChecked = parsed?.checked;
      if (Array.isArray(savedChecked)) {
        saved = steps.map((_step, index) => savedChecked[index] === true);
      }
    } catch {
      saved = [];
    }
    setChecked(steps.map((_step, index) => saved[index] === true));
    setProgressReady(true);
  }, [fingerprint, steps]);

  useEffect(() => {
    if (!progressReady) return;
    try {
      window.localStorage.setItem(`brainup.visual.${fingerprint}`, JSON.stringify({ checked }));
    } catch {
      // Almacenamiento lleno o bloqueado: la figura sigue funcionando.
    }
  }, [checked, fingerprint, progressReady]);

  const safeCurrent = Math.min(current, Math.max(0, steps.length - 1));
  const currentStep = steps[safeCurrent];
  const completed = steps.reduce((total, _step, index) => total + (checked[index] ? 1 : 0), 0);
  const allChecked = steps.length > 0 && completed === steps.length;

  const visibleIds = useMemo(() => {
    if (showAll) return new Set(solution.primitives.map((primitive) => primitive.id));
    const ids = new Set<string>();
    for (let index = 0; index <= safeCurrent; index += 1) {
      for (const id of steps[index]?.visible ?? []) ids.add(id);
    }
    return ids;
  }, [safeCurrent, showAll, solution.primitives, steps]);

  const emphasisIds = useMemo(
    () => (showAll ? new Set<string>() : new Set(currentStep?.visible ?? [])),
    [currentStep, showAll]
  );

  const visiblePrimitives = solution.primitives.filter((primitive) => visibleIds.has(primitive.id));
  const fontSize = Math.max(12, Math.min(18, solution.viewBox.width * 0.032));
  const bottom = solution.viewBox.y + solution.viewBox.height;
  const kindLabel =
    spec.kind === 'technical' ? 'Dibujo técnico' : spec.kind === 'diagram' ? 'Esquema' : 'Geometría';

  const goTo = (index: number) => {
    setCurrent(Math.max(0, Math.min(index, steps.length - 1)));
    setShowAll(false);
  };

  const toggleCurrent = () => {
    setChecked((previous) => {
      const next = steps.map((_step, index) => previous[index] === true);
      next[safeCurrent] = !next[safeCurrent];
      return next;
    });
  };

  return (
    <div
      className={clsx(
        'my-3 overflow-hidden rounded-2xl border border-white/10 bg-[#080d17] text-slate-100 shadow-[0_10px_30px_rgba(0,0,0,0.25)]',
        className
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md border border-amber-400/25 bg-amber-400/10">
              <Ruler className="h-3.5 w-3.5 text-amber-300" />
            </span>
            <p className="truncate text-sm font-bold text-slate-100">{spec.title}</p>
          </div>
          {spec.description ? (
            <p className="mt-1 pl-8 text-[11.5px] leading-5 text-slate-400">{spec.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-[9.5px] font-mono uppercase tracking-wider text-slate-400">
            {kindLabel}
          </span>
          <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-[9.5px] font-mono uppercase tracking-wider text-emerald-300">
            {completed}/{steps.length} pasos
          </span>
        </div>
      </div>

      <div className="px-3 pt-3">
        <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-[#05080f]">
          <svg
            viewBox={`${solution.viewBox.x} ${solution.viewBox.y} ${solution.viewBox.width} ${solution.viewBox.height}`}
            role="img"
            aria-label={spec.title}
            className="block h-auto w-full"
            style={{ maxHeight: 430 }}
          >
            <defs>
              <pattern
                id={`${markerId}-grid`}
                width="34"
                height="34"
                patternUnits="userSpaceOnUse"
                x={solution.viewBox.x}
                y={solution.viewBox.y}
              >
                <path d="M 34 0 L 0 0 0 34" fill="none" stroke="#1e293b" strokeWidth="0.7" opacity="0.55" />
              </pattern>
              <marker
                id={markerId}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
              </marker>
            </defs>

            <rect
              x={solution.viewBox.x}
              y={solution.viewBox.y}
              width={solution.viewBox.width}
              height={solution.viewBox.height}
              fill={`url(#${markerId}-grid)`}
            />

            <g transform={`translate(0 ${bottom}) scale(1 -1)`}>
              {visiblePrimitives.map((primitive) => (
                <PrimitiveShape
                  key={primitive.id}
                  primitive={primitive}
                  emphasis={emphasisIds.has(primitive.id)}
                  markerId={markerId}
                />
              ))}
            </g>

            <g>
              {visiblePrimitives.map((primitive) => (
                <PrimitiveText
                  key={`text-${primitive.id}`}
                  primitive={primitive}
                  viewBox={solution.viewBox}
                  fontSize={fontSize}
                />
              ))}
            </g>
          </svg>
        </div>
      </div>

      <div className="px-4 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            {steps.map((step, index) => (
              <button
                key={step.id}
                type="button"
                onClick={() => goTo(index)}
                aria-label={`Ir al paso ${index + 1}: ${step.title}`}
                aria-current={index === safeCurrent ? 'step' : undefined}
                className={clsx(
                  'flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-bold transition-colors',
                  index === safeCurrent
                    ? 'border-amber-400/60 bg-amber-400/20 text-amber-200'
                    : checked[index]
                      ? 'border-emerald-400/40 bg-emerald-400/15 text-emerald-300'
                      : 'border-white/10 bg-white/[0.04] text-slate-500 hover:border-white/20 hover:text-slate-300'
                )}
              >
                {checked[index] ? <Check className="h-3 w-3" /> : index + 1}
              </button>
            ))}
          </div>
          <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500">
            {showAll ? 'Completa' : `Paso ${safeCurrent + 1} de ${steps.length}`}
          </span>
        </div>

        <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-amber-400/25 bg-amber-400/10 text-[10px] font-bold text-amber-300">
              {safeCurrent + 1}
            </span>
            <div className="min-w-0">
              <p className="text-[12.5px] font-semibold leading-5 text-slate-100">{currentStep?.title}</p>
              {currentStep?.detail ? (
                <p className="mt-0.5 text-[11.5px] leading-5 text-slate-400">{currentStep.detail}</p>
              ) : null}
            </div>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={toggleCurrent}
              className={clsx(
                'inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors',
                checked[safeCurrent]
                  ? 'border-emerald-400/35 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/15'
                  : 'border-white/10 bg-white/[0.04] text-slate-300 hover:border-emerald-400/30 hover:text-emerald-300'
              )}
            >
              {checked[safeCurrent] ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
              {checked[safeCurrent] ? 'Paso validado' : 'Ya lo he trazado'}
            </button>

            <button
              type="button"
              onClick={() => goTo(safeCurrent - 1)}
              disabled={safeCurrent === 0}
              className="inline-flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] font-medium text-slate-400 transition-colors hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Anterior
            </button>

            <button
              type="button"
              onClick={() => goTo(safeCurrent + 1)}
              disabled={safeCurrent >= steps.length - 1 || !checked[safeCurrent]}
              className="inline-flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:border-amber-400/30 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-35"
            >
              Siguiente
              <ChevronRight className="h-3.5 w-3.5" />
            </button>

            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] font-medium text-slate-400 transition-colors hover:text-slate-200"
            >
              <Eye className="h-3.5 w-3.5" />
              {showAll ? 'Ver por pasos' : 'Ver completa'}
            </button>

            <button
              type="button"
              onClick={() => {
                setChecked(steps.map(() => false));
                setCurrent(0);
                setShowAll(false);
              }}
              className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[10.5px] font-medium text-slate-500 transition-colors hover:text-slate-300"
            >
              <RotateCcw className="h-3 w-3" />
              Reiniciar
            </button>
          </div>

          {allChecked ? (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] font-semibold text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Trazado validado paso a paso.
            </p>
          ) : null}
        </div>

        {solution.constraints.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {solution.constraints.slice(0, 8).map((constraint) => (
              <span
                key={`${constraint.kind}-${constraint.label}`}
                className="rounded-full border border-white/[0.07] bg-white/[0.03] px-2 py-1 text-[10px] text-slate-400"
              >
                {constraint.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function VisualBlock({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const parsed = useMemo(() => parseVisualSpec(source), [source]);

  if (!parsed.ok) {
    return (
      <div
        role="status"
        className={clsx(
          'my-3 flex items-start gap-2.5 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-3.5 py-3',
          className
        )}
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
        <div>
          <p className="text-[12px] font-semibold text-rose-200">No se puede mostrar esta figura.</p>
          <p className="mt-0.5 text-[11px] leading-5 text-rose-200/65">{parsed.error}</p>
        </div>
      </div>
    );
  }

  return <VisualCard visual={parsed.visual} className={className} />;
}
