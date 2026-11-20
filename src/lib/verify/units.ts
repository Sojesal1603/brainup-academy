/**
 * Análisis dimensional y conversión de unidades SI.
 *
 * El objetivo no es convertir cualquier cosa: es detectar el error que más
 * puntos cuesta en Física y Química —sumar magnitudes que no son homogéneas o
 * firmar un resultado con la unidad equivocada— sin depender de un modelo.
 *
 * Fuera de alcance declarado: temperaturas con offset (°C, °F), unidades
 * angulares no SI y magnitudes logarítmicas (dB, pH). Si aparecen, el llamante
 * recibe `ok: false` y responde `no_verificable`.
 */

import { numericValue } from './cas';
import { normalizeLatex, splitQuantity } from './latex';

/** Orden: kg, m, s, A, K, mol, cd. */
export type Dimension = number[];

export interface ParsedUnit {
  dim: Dimension;
  /** Factor a unidades SI base. */
  factor: number;
  text: string;
}

export type UnitParse = { ok: true; unit: ParsedUnit } | { ok: false; reason: string };

const DIMENSION_NAMES = ['kg', 'm', 's', 'A', 'K', 'mol', 'cd'];

const BASE_UNITS: Record<string, { dim: Dimension; factor: number }> = {
  kg: { dim: [1, 0, 0, 0, 0, 0, 0], factor: 1 },
  g: { dim: [1, 0, 0, 0, 0, 0, 0], factor: 0.001 },
  m: { dim: [0, 1, 0, 0, 0, 0, 0], factor: 1 },
  s: { dim: [0, 0, 1, 0, 0, 0, 0], factor: 1 },
  A: { dim: [0, 0, 0, 1, 0, 0, 0], factor: 1 },
  K: { dim: [0, 0, 0, 0, 1, 0, 0], factor: 1 },
  mol: { dim: [0, 0, 0, 0, 0, 1, 0], factor: 1 },
  cd: { dim: [0, 0, 0, 0, 0, 0, 1], factor: 1 },

  // Derivadas coherentes.
  N: { dim: [1, 1, -2, 0, 0, 0, 0], factor: 1 },
  J: { dim: [1, 2, -2, 0, 0, 0, 0], factor: 1 },
  W: { dim: [1, 2, -3, 0, 0, 0, 0], factor: 1 },
  Pa: { dim: [1, -1, -2, 0, 0, 0, 0], factor: 1 },
  C: { dim: [0, 0, 1, 1, 0, 0, 0], factor: 1 },
  V: { dim: [1, 2, -3, -1, 0, 0, 0], factor: 1 },
  ohm: { dim: [1, 2, -3, -2, 0, 0, 0], factor: 1 },
  S: { dim: [-1, -2, 3, 2, 0, 0, 0], factor: 1 },
  F: { dim: [-1, -2, 4, 2, 0, 0, 0], factor: 1 },
  H: { dim: [1, 2, -2, -2, 0, 0, 0], factor: 1 },
  T: { dim: [1, 0, -2, -1, 0, 0, 0], factor: 1 },
  Wb: { dim: [1, 2, -2, -1, 0, 0, 0], factor: 1 },
  Hz: { dim: [0, 0, -1, 0, 0, 0, 0], factor: 1 },
  Bq: { dim: [0, 0, -1, 0, 0, 0, 0], factor: 1 },
  Gy: { dim: [0, 2, -2, 0, 0, 0, 0], factor: 1 },
  Sv: { dim: [0, 2, -2, 0, 0, 0, 0], factor: 1 },
  kat: { dim: [0, 0, -1, 0, 0, 1, 0], factor: 1 },

  // Aceptadas en el aula.
  L: { dim: [0, 3, 0, 0, 0, 0, 0], factor: 0.001 },
  min: { dim: [0, 0, 1, 0, 0, 0, 0], factor: 60 },
  h: { dim: [0, 0, 1, 0, 0, 0, 0], factor: 3600 },
  day: { dim: [0, 0, 1, 0, 0, 0, 0], factor: 86_400 },
  eV: { dim: [1, 2, -2, 0, 0, 0, 0], factor: 1.602176634e-19 },
  cal: { dim: [1, 2, -2, 0, 0, 0, 0], factor: 4.184 },
  Wh: { dim: [1, 2, -2, 0, 0, 0, 0], factor: 3600 },
  atm: { dim: [1, -1, -2, 0, 0, 0, 0], factor: 101_325 },
  bar: { dim: [1, -1, -2, 0, 0, 0, 0], factor: 100_000 },
  mmHg: { dim: [1, -1, -2, 0, 0, 0, 0], factor: 133.322387415 },
  torr: { dim: [1, -1, -2, 0, 0, 0, 0], factor: 133.322387415 },
  psi: { dim: [1, -1, -2, 0, 0, 0, 0], factor: 6_894.757 },
  u: { dim: [1, 0, 0, 0, 0, 0, 0], factor: 1.6605390666e-27 },
  Da: { dim: [1, 0, 0, 0, 0, 0, 0], factor: 1.6605390666e-27 },
};

const PREFIXES: Record<string, number> = {
  da: 1,
  y: -24,
  z: -21,
  a: -18,
  f: -15,
  p: -12,
  n: -9,
  u: -6,
  m: -3,
  c: -2,
  d: -1,
  h: 2,
  k: 3,
  M: 6,
  G: 9,
  T: 12,
  P: 15,
  E: 18,
};

function emptyDimension(): Dimension {
  return [0, 0, 0, 0, 0, 0, 0];
}

function addDimensions(left: Dimension, right: Dimension, sign: 1 | -1): Dimension {
  return left.map((value, index) => value + sign * (right[index] ?? 0));
}

function multiplyDimension(dim: Dimension, exponent: number): Dimension {
  return dim.map((value) => value * exponent);
}

function resolveSymbol(symbol: string): { dim: Dimension; factor: number } | null {
  if (Object.prototype.hasOwnProperty.call(BASE_UNITS, symbol)) {
    return BASE_UNITS[symbol];
  }

  // Prefijos: primero `da` (dos letras) y después una letra. La unidad exacta
  // siempre gana: `min` es minuto, no mili-pulgada; `kg` es kilogramo.
  for (const prefix of ['da']) {
    if (symbol.startsWith(prefix) && symbol.length > prefix.length) {
      const rest = symbol.slice(prefix.length);
      if (Object.prototype.hasOwnProperty.call(BASE_UNITS, rest)) {
        const base = BASE_UNITS[rest];
        return { dim: base.dim, factor: base.factor * Math.pow(10, PREFIXES[prefix]) };
      }
    }
  }

  const prefix = symbol[0];
  if (Object.prototype.hasOwnProperty.call(PREFIXES, prefix) && symbol.length > 1) {
    const rest = symbol.slice(1);
    if (Object.prototype.hasOwnProperty.call(BASE_UNITS, rest)) {
      const base = BASE_UNITS[rest];
      return { dim: base.dim, factor: base.factor * Math.pow(10, PREFIXES[prefix]) };
    }
  }

  return null;
}

const SUPERSCRIPT_MAP: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁻': '-',
};

function normalizeUnitText(input: string): string {
  let text = input.trim();
  text = text.replace(/^\$+|\$+$/g, '');
  text = text.replace(/[·⋅×.]/g, '*').replace(/[µμ]/g, 'u').replace(/Ω/g, 'ohm');
  text = text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, (run) => {
    let exponent = '';
    for (const char of run) exponent += SUPERSCRIPT_MAP[char] ?? '';
    return `^${exponent}`;
  });
  return text.replace(/\s+/g, '');
}

/** Analiza `kg*m/s^2`, `N/C`, `km/h`, `m²`… */
export function parseUnit(input: string): UnitParse {
  const text = normalizeUnitText(input);
  if (!text) return { ok: false, reason: 'unidad vacía' };

  const parts = text.split(/([*/])/);
  let dim = emptyDimension();
  let factor = 1;
  let sign: 1 | -1 = 1;
  let sawUnit = false;

  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (part === '*') {
      sign = 1;
      continue;
    }
    if (part === '/') {
      sign = -1;
      continue;
    }
    if (part === '1') continue;

    const match = part.match(/^([A-Za-z]+)(?:\^\(?(-?\d+)\)?)?$/);
    if (!match) return { ok: false, reason: `término de unidad no válido: «${part}»` };

    const symbol = match[1];
    const exponent = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isInteger(exponent)) return { ok: false, reason: 'exponente de unidad no entero' };

    const resolved = resolveSymbol(symbol);
    if (!resolved) return { ok: false, reason: `unidad desconocida: «${symbol}»` };

    dim = addDimensions(dim, multiplyDimension(resolved.dim, exponent), sign);
    factor *= Math.pow(resolved.factor, exponent * sign);
    sawUnit = true;
  }

  if (!sawUnit) return { ok: false, reason: 'no se ha reconocido ninguna unidad' };
  return { ok: true, unit: { dim, factor, text: input.trim() } };
}

/** Etiqueta legible de una dimensión: `kg·m²·s⁻³·A⁻¹` se escribe en ASCII. */
export function dimensionLabel(dim: Dimension): string {
  const parts: string[] = [];
  DIMENSION_NAMES.forEach((name, index) => {
    const exponent = dim[index] ?? 0;
    if (exponent === 0) return;
    parts.push(exponent === 1 ? name : `${name}^${exponent}`);
  });
  return parts.length > 0 ? parts.join('·') : 'adimensional';
}

export function sameDimension(left: Dimension, right: Dimension): boolean {
  return DIMENSION_NAMES.every((_, index) => (left[index] ?? 0) === (right[index] ?? 0));
}

export interface Quantity {
  value: number;
  unit: ParsedUnit;
}

export type QuantityParse = { ok: true; quantity: Quantity } | { ok: false; reason: string };

/** `3.6*10^6 N/C` → `{ value: 3600000, unit: N/C }`. */
export function parseQuantity(input: string): QuantityParse {
  const normalized = normalizeLatex(input);
  if ('reason' in normalized) return { ok: false, reason: normalized.reason };

  const split = splitQuantity(normalized.expression);
  if (!split.unit) return { ok: false, reason: 'la expresión no lleva unidad' };

  const value = numericValue(split.value);
  if (value === null) return { ok: false, reason: 'la parte numérica no se puede evaluar' };

  const unit = parseUnit(split.unit);
  if ('reason' in unit) return { ok: false, reason: unit.reason };

  return { ok: true, quantity: { value, unit: unit.unit } };
}

/** Convierte un valor entre dos unidades de la misma dimensión. */
export function convert(value: number, from: ParsedUnit, to: ParsedUnit): number | null {
  if (!sameDimension(from.dim, to.dim)) return null;
  return (value * from.factor) / to.factor;
}

export interface UnitEqualityCheck {
  kind: 'dimensiones' | 'conversion';
  status: 'ok' | 'fail' | 'no_verificable';
  detail: string;
}

/**
 * Comprueba `1 km = 1000 m`, `E = 3.6*10^6 N/C` frente a otra unidad, etc.
 * Solo se pronuncia cuando **los dos lados** son magnitudes con unidad.
 */
export function checkQuantityEquality(left: string, right: string): UnitEqualityCheck | null {
  const a = parseQuantity(left);
  const b = parseQuantity(right);
  if (!a.ok || !b.ok) return null;

  if (!sameDimension(a.quantity.unit.dim, b.quantity.unit.dim)) {
    return {
      kind: 'dimensiones',
      status: 'fail',
      detail: `Las unidades no son homogéneas: $ ${a.quantity.unit.text} $ es ${dimensionLabel(
        a.quantity.unit.dim
      )} y $ ${b.quantity.unit.text} $ es ${dimensionLabel(b.quantity.unit.dim)}.`,
    };
  }

  const converted = convert(a.quantity.value, a.quantity.unit, b.quantity.unit);
  if (converted === null) return null;

  const scale = Math.max(1, Math.abs(converted), Math.abs(b.quantity.value));
  const same = Math.abs(converted - b.quantity.value) <= 1e-6 * scale;

  return {
    kind: 'conversion',
    status: same ? 'ok' : 'fail',
    detail: same
      ? `Unidades coherentes: $ ${a.quantity.value} ${a.quantity.unit.text} = ${b.quantity.value} ${b.quantity.unit.text} $.`
      : `La conversión no cuadra: $ ${a.quantity.value} ${a.quantity.unit.text} $ son $ ${converted} ${b.quantity.unit.text} $, no $ ${b.quantity.value} $.`,
  };
}
