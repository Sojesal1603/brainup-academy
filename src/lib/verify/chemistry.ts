/**
 * Química determinista: fórmulas, masas molares, ajuste de ecuaciones y
 * estequiometría.
 *
 * Fase 1 declarada: fórmulas neutras, iones sencillos y ecuaciones con
 * coeficientes enteros. El ajuste se resuelve por eliminación gaussiana exacta
 * (fracciones de enteros pequeños, sin coma flotante), incluyendo la carga.
 * Redox con semirreacciones, compuestos orgánicos con nomenclatura y ecuaciones
 * que no admiten una única solución se responden como `no_verificable`.
 *
 * Sin dependencias y sin Python: es aritmética de enteros.
 */

import { ATOMIC_MASS, isElementSymbol } from './elements';

export interface ParsedFormula {
  counts: Record<string, number>;
  charge: number;
  text: string;
}

export type FormulaParse = { ok: true; formula: ParsedFormula } | { ok: false; reason: string };

function readNumber(input: string, index: number): { value: number; next: number } {
  let end = index;
  while (end < input.length && /\d/.test(input[end])) end += 1;
  if (end === index) return { value: 1, next: index };
  return { value: Number(input.slice(index, end)), next: end };
}

function addCounts(target: Record<string, number>, source: Record<string, number>, factor: number): void {
  for (const [element, amount] of Object.entries(source)) {
    target[element] = (target[element] ?? 0) + amount * factor;
  }
}

/** Extrae la carga final: `SO4^2-`, `Na+`, `Fe3+`, `Cl-`. */
function splitCharge(input: string): { body: string; charge: number } {
  const caret = input.match(/\^(\d*)([+-])$/);
  if (caret) {
    const amount = caret[1] ? Number(caret[1]) : 1;
    return { body: input.slice(0, caret.index), charge: caret[2] === '-' ? -amount : amount };
  }

  const plain = input.match(/(\d*)([+-])$/);
  const base = input.slice(0, -1);
  if (plain && /[A-Za-z0-9)\]]$/.test(base)) {
    const sign = plain[2] === '-' ? -1 : 1;
    const digits = plain[1];

    if (digits) {
      // `Fe3+` y `O2-` son cargas (el ion de un solo elemento); `NO3-` y
      // `NH4+` llevan el número como subíndice y la carga es ±1. Sin caret no
      // hay forma perfecta de saberlo, así que se aplica la convención de aula.
      const withoutDigits = base.slice(0, -digits.length);
      if (/^[A-Z][a-z]?$/.test(withoutDigits) && isElementSymbol(withoutDigits)) {
        return { body: withoutDigits, charge: sign * Number(digits) };
      }
    }

    return { body: base, charge: sign };
  }

  return { body: input, charge: 0 };
}

function parseSimple(body: string): FormulaParse {
  if (!body) return { ok: false, reason: 'fórmula vacía' };

  const stack: Array<Record<string, number>> = [{}];
  let index = 0;

  while (index < body.length) {
    const char = body[index];

    if (char === '(' || char === '[') {
      stack.push({});
      index += 1;
      continue;
    }

    if (char === ')' || char === ']') {
      if (stack.length === 1) return { ok: false, reason: 'paréntesis desemparejados' };
      const group = stack.pop() as Record<string, number>;
      index += 1;
      const multiplier = readNumber(body, index);
      addCounts(stack[stack.length - 1], group, multiplier.value);
      index = multiplier.next;
      continue;
    }

    if (/[A-Z]/.test(char)) {
      const two = body.slice(index, index + 2);
      const symbol = /^[A-Z][a-z]$/.test(two) && isElementSymbol(two) ? two : char;
      if (!isElementSymbol(symbol)) {
        return { ok: false, reason: `elemento desconocido: «${symbol}»` };
      }
      index += symbol.length;
      const multiplier = readNumber(body, index);
      const current = stack[stack.length - 1];
      current[symbol] = (current[symbol] ?? 0) + multiplier.value;
      index = multiplier.next;
      continue;
    }

    if (/[a-z]/.test(char)) {
      return { ok: false, reason: `símbolo químico mal escrito cerca de «${body.slice(index, index + 3)}»` };
    }

    if (/\d/.test(char)) {
      return { ok: false, reason: 'coeficiente dentro de la fórmula' };
    }

    return { ok: false, reason: `carácter no válido en la fórmula: «${char}»` };
  }

  if (stack.length !== 1) return { ok: false, reason: 'paréntesis desemparejados' };
  if (Object.keys(stack[0]).length === 0) return { ok: false, reason: 'la fórmula no tiene ningún elemento' };

  return { ok: true, formula: { counts: stack[0], charge: 0, text: body } };
}

/** Analiza una fórmula, incluidos hidratos (`CuSO4·5H2O`) y cargas. */
export function parseFormula(input: string): FormulaParse {
  const raw = String(input ?? '').trim().replace(/[−–—]/g, '-');
  if (!raw) return { ok: false, reason: 'fórmula vacía' };

  if (raw === 'e-' || raw === 'e^-') {
    return { ok: true, formula: { counts: {}, charge: -1, text: 'e-' } };
  }

  const parts = raw.split(/[·⋅*]/).filter((part) => part.trim().length > 0);
  if (parts.length === 0) return { ok: false, reason: 'fórmula vacía' };

  const counts: Record<string, number> = {};
  let charge = 0;
  const labels: string[] = [];

  for (const part of parts) {
    const leading = part.match(/^(\d+)(?=[A-Z([])/);
    const multiplier = leading ? Number(leading[1]) : 1;
    const withoutCoefficient = leading ? part.slice(leading[1].length) : part;

    const { body, charge: partCharge } = splitCharge(withoutCoefficient);
    const parsed = parseSimple(body);
    if (!parsed.ok) return parsed;

    addCounts(counts, parsed.formula.counts, multiplier);
    charge += partCharge * multiplier;
    labels.push(part);
  }

  return { ok: true, formula: { counts, charge, text: labels.join('·') } };
}

/** Masa molar en g/mol; `null` si la fórmula no se puede leer. */
export function molarMass(input: string): number | null {
  const parsed = parseFormula(input);
  if (!parsed.ok) return null;

  let total = 0;
  for (const [element, amount] of Object.entries(parsed.formula.counts)) {
    total += (ATOMIC_MASS[element] ?? Number.NaN) * amount;
  }
  return Number.isFinite(total) ? total : null;
}

/* ------------------------------------------------------------------ */
/* Ecuaciones                                                          */
/* ------------------------------------------------------------------ */

export interface Species {
  /** Coeficiente tal y como está escrito (1 si no se indica). */
  coefficient: number;
  formula: string;
  counts: Record<string, number>;
  charge: number;
  /** ¿Llevaba coeficiente explícito? */
  explicit: boolean;
}

export interface ParsedEquation {
  reactants: Species[];
  products: Species[];
  text: string;
}

export type EquationParse = { ok: true; equation: ParsedEquation } | { ok: false; reason: string };

const MAX_SPECIES = 10;

function splitSide(side: string): string[] {
  const spaced = side.split(/\s+\+\s+/);
  if (spaced.length > 1) return spaced;
  // Sin espacios: se separa en el `+` que abre una especie nueva. El `+` de una
  // carga (`Na+`) no va seguido de letra, número ni paréntesis; si va seguido
  // de un espacio la ecuación es ambigua y se deja sin verificar.
  return side.split(/\+(?=[A-Z0-9([])/);
}

function parseSpecies(text: string): { ok: true; species: Species } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: 'especie vacía' };

  // El coeficiente puede preceder a un elemento (`2H2`) o al electrón (`5e-`).
  const leading = trimmed.match(/^(\d+)(?=[A-Z([]|e[-+]$)/);
  const coefficient = leading ? Number(leading[1]) : 1;
  if (!Number.isInteger(coefficient) || coefficient <= 0) {
    return { ok: false, reason: 'coeficiente no válido' };
  }

  const body = leading ? trimmed.slice(leading[1].length) : trimmed;
  const formula = parseFormula(body);
  if ('reason' in formula) return { ok: false, reason: formula.reason };

  return {
    ok: true,
    species: {
      coefficient,
      formula: body,
      counts: formula.formula.counts,
      charge: formula.formula.charge,
      explicit: Boolean(leading),
    },
  };
}

/** Analiza `2 H2 + O2 -> 2 H2O`. */
export function parseEquation(input: string): EquationParse {
  const text = String(input ?? '')
    .replace(/[−–—]/g, '-')
    .replace(/⟶|→|-->|=>/g, '->')
    .trim();

  if (!text.includes('->')) return { ok: false, reason: 'no hay flecha de reacción' };

  const sides = text.split('->');
  if (sides.length !== 2) return { ok: false, reason: 'hay más de una flecha de reacción' };

  const parseList = (side: string): { ok: true; list: Species[] } | { ok: false; reason: string } => {
    const chunks = splitSide(side).map((chunk) => chunk.trim()).filter(Boolean);
    if (chunks.length === 0) return { ok: false, reason: 'un lado de la ecuación está vacío' };
    if (chunks.length > MAX_SPECIES) return { ok: false, reason: 'demasiadas especies para verificar' };

    const list: Species[] = [];
    for (const chunk of chunks) {
      const parsed = parseSpecies(chunk);
      if ('reason' in parsed) return { ok: false, reason: parsed.reason };
      list.push(parsed.species);
    }
    return { ok: true, list };
  };

  const reactants = parseList(sides[0]);
  if ('reason' in reactants) return { ok: false, reason: reactants.reason };
  const products = parseList(sides[1]);
  if ('reason' in products) return { ok: false, reason: products.reason };

  return { ok: true, equation: { reactants: reactants.list, products: products.list, text } };
}

/* ------------------------------------------------------------------ */
/* Aritmética racional exacta                                          */
/* ------------------------------------------------------------------ */

interface Fraction {
  n: number;
  d: number;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const temp = y;
    y = x % y;
    x = temp;
  }
  return x || 1;
}

function fraction(n: number, d = 1): Fraction {
  if (d === 0) throw new Error('división por cero');
  const sign = d < 0 ? -1 : 1;
  const divisor = gcd(n, d);
  return { n: (sign * n) / divisor, d: Math.abs(d) / divisor };
}

const ZERO: Fraction = { n: 0, d: 1 };

function subtract(left: Fraction, right: Fraction): Fraction {
  return fraction(left.n * right.d - right.n * left.d, left.d * right.d);
}

function multiply(left: Fraction, right: Fraction): Fraction {
  return fraction(left.n * right.n, left.d * right.d);
}

function divide(left: Fraction, right: Fraction): Fraction {
  return fraction(left.n * right.d, left.d * right.n);
}

function add(left: Fraction, right: Fraction): Fraction {
  return fraction(left.n * right.d + right.n * left.d, left.d * right.d);
}

function isZero(value: Fraction): boolean {
  return value.n === 0;
}

interface MatrixSolution {
  /** Un vector del espacio nulo, con enteros positivos. */
  coefficients: number[] | null;
  reason?: string;
}

/**
 * Resuelve A·x = 0 con x de enteros positivos.
 *
 * Si el espacio nulo tiene dimensión distinta de 1, la ecuación admite varias
 * combinaciones y no se puede afirmar cuál es «la» ajustada: se declara fuera de
 * alcance en vez de elegir una al azar.
 */
function solveBalance(matrix: Fraction[][], columns: number): MatrixSolution {
  const rows = matrix.map((row) => row.slice());
  const pivotColumns: number[] = [];
  let pivotRow = 0;

  for (let column = 0; column < columns && pivotRow < rows.length; column += 1) {
    let selected = -1;
    for (let row = pivotRow; row < rows.length; row += 1) {
      if (!isZero(rows[row][column])) {
        selected = row;
        break;
      }
    }
    if (selected === -1) continue;

    const temp = rows[pivotRow];
    rows[pivotRow] = rows[selected];
    rows[selected] = temp;

    const pivot = rows[pivotRow][column];
    for (let index = column; index < columns; index += 1) {
      rows[pivotRow][index] = divide(rows[pivotRow][index], pivot);
    }

    for (let row = 0; row < rows.length; row += 1) {
      if (row === pivotRow) continue;
      const factor = rows[row][column];
      if (isZero(factor)) continue;
      for (let index = column; index < columns; index += 1) {
        rows[row][index] = subtract(rows[row][index], multiply(factor, rows[pivotRow][index]));
      }
    }

    pivotColumns.push(column);
    pivotRow += 1;
  }

  const nullity = columns - pivotColumns.length;
  if (nullity <= 0) return { coefficients: null, reason: 'no hay solución no trivial' };
  if (nullity > 1) return { coefficients: null, reason: 'la ecuación admite varias combinaciones' };

  const freeColumn = Array.from({ length: columns }, (_, index) => index).find(
    (column) => !pivotColumns.includes(column)
  );
  if (freeColumn === undefined) return { coefficients: null, reason: 'no hay variable libre' };

  const solution: Fraction[] = Array.from({ length: columns }, () => ZERO);
  solution[freeColumn] = fraction(1);

  // En forma escalonada reducida, cada pivote depende solo de la variable libre.
  pivotColumns.forEach((column, index) => {
    const row = rows[index];
    solution[column] = fraction(-row[freeColumn].n * solution[freeColumn].n, row[freeColumn].d * solution[freeColumn].d);
  });

  // Denominador común y mínimo común múltiplo para pasar a enteros.
  let commonDenominator = 1;
  for (const value of solution) {
    commonDenominator = (commonDenominator * value.d) / gcd(commonDenominator, value.d);
  }

  let integers = solution.map((value) => (value.n * commonDenominator) / value.d);
  let commonDivisor = integers.reduce((acc, value) => gcd(acc, value), 0) || 1;
  integers = integers.map((value) => value / commonDivisor);

  if (integers.every((value) => value < 0)) integers = integers.map((value) => -value);
  if (integers.some((value) => value <= 0)) {
    return { coefficients: null, reason: 'el ajuste exige coeficientes negativos: fuera de alcance' };
  }

  return { coefficients: integers };
}

function buildMatrix(equation: ParsedEquation): { matrix: Fraction[][]; columns: number; species: Species[] } {
  const species = [...equation.reactants, ...equation.products];
  const elements = Array.from(
    new Set(species.flatMap((item) => Object.keys(item.counts)))
  ).sort();

  const matrix: Fraction[][] = [];

  for (const element of elements) {
    matrix.push(
      species.map((item, index) =>
        fraction((item.counts[element] ?? 0) * (index < equation.reactants.length ? 1 : -1))
      )
    );
  }

  // La carga también se conserva. Sin esta fila, una redox podría «cuadrar»
  // solo en masa y dar por buena una ecuación imposible.
  matrix.push(
    species.map((item, index) =>
      fraction(item.charge * (index < equation.reactants.length ? 1 : -1))
    )
  );

  return { matrix, columns: species.length, species };
}

function formatSide(species: Species[], coefficients: number[]): string {
  return species
    .map((item, index) => {
      const coefficient = coefficients[index] ?? item.coefficient;
      return `${coefficient === 1 ? '' : coefficient}${item.formula}`;
    })
    .join(' + ');
}

export interface BalanceResult {
  status: 'ok' | 'fail' | 'no_verificable';
  detail: string;
  /** Coeficientes del ajuste correcto, si se ha podido calcular. */
  coefficients?: number[];
}

/** Comprueba si la ecuación está ajustada tal y como está escrita. */
export function checkBalance(input: string): BalanceResult {
  const parsed = parseEquation(input);
  if ('reason' in parsed) {
    return { status: 'no_verificable', detail: `No se puede leer la ecuación: ${parsed.reason}.` };
  }

  const { matrix, columns, species } = buildMatrix(parsed.equation);
  const written = species.map((item) => fraction(item.coefficient));

  const residual = matrix.map((row) =>
    row.reduce((acc, value, index) => add(acc, multiply(value, written[index])), ZERO)
  );

  if (residual.every(isZero)) {
    return {
      status: 'ok',
      detail: 'La ecuación está ajustada en masa y en carga.',
      coefficients: species.map((item) => item.coefficient),
    };
  }

  const solution = solveBalance(matrix, columns);
  if (!solution.coefficients) {
    return {
      status: 'no_verificable',
      detail: `No se puede determinar un ajuste único: ${solution.reason ?? 'fuera de alcance'}.`,
    };
  }

  const reactantsCount = parsed.equation.reactants.length;
  const left = formatSide(parsed.equation.reactants, solution.coefficients.slice(0, reactantsCount));
  const right = formatSide(parsed.equation.products, solution.coefficients.slice(reactantsCount));

  return {
    status: 'fail',
    detail: `La ecuación no está ajustada. El ajuste correcto es: ${left} → ${right}.`,
    coefficients: solution.coefficients,
  };
}

/* ------------------------------------------------------------------ */
/* Estequiometría                                                      */
/* ------------------------------------------------------------------ */

export function molesFromMass(formula: string, grams: number): number | null {
  const mass = molarMass(formula);
  if (mass === null || mass <= 0) return null;
  return grams / mass;
}

export function massFromMoles(formula: string, moles: number): number | null {
  const mass = molarMass(formula);
  if (mass === null) return null;
  return moles * mass;
}

export interface Amount {
  moles?: number;
  grams?: number;
}

export interface StoichiometryResult {
  limiting: string;
  extent: number;
  products: Array<{ formula: string; moles: number; grams: number | null }>;
  detail: string;
}

export type Stoichiometry = { ok: true; result: StoichiometryResult } | { ok: false; reason: string };

/**
 * Reactivo limitante y productos para una ecuación ajustada.
 *
 * `amounts` se indexa por la fórmula **tal y como está escrita** en la ecuación
 * (`H2`, `O2`…). Se aceptan moles o gramos, no ambos.
 */
export function limitingReagent(equationText: string, amounts: Record<string, Amount>): Stoichiometry {
  const parsed = parseEquation(equationText);
  if ('reason' in parsed) return { ok: false, reason: parsed.reason };

  const balanced = checkBalance(equationText);
  if (balanced.status !== 'ok' || !balanced.coefficients) {
    return { ok: false, reason: 'la ecuación no está ajustada, no se puede calcular la estequiometría' };
  }

  const reactantsCount = parsed.equation.reactants.length;
  const coefficients = balanced.coefficients;

  const extents: Array<{ formula: string; extent: number }> = [];

  parsed.equation.reactants.forEach((species, index) => {
    const provided = amounts[species.formula];
    if (!provided) return;

    let moles: number | null = null;
    if (typeof provided.moles === 'number' && Number.isFinite(provided.moles)) {
      moles = provided.moles;
    } else if (typeof provided.grams === 'number' && Number.isFinite(provided.grams)) {
      moles = molesFromMass(species.formula, provided.grams);
    }
    if (moles === null || moles <= 0) return;

    extents.push({ formula: species.formula, extent: moles / coefficients[index] });
  });

  if (extents.length === 0) {
    return { ok: false, reason: 'no hay cantidades válidas de ningún reactivo' };
  }

  const limiting = extents.reduce((min, item) => (item.extent < min.extent ? item : min));
  const extent = limiting.extent;

  const products = parsed.equation.products.map((species, index) => {
    const coefficient = coefficients[reactantsCount + index] ?? species.coefficient;
    const moles = coefficient * extent;
    return { formula: species.formula, moles, grams: massFromMoles(species.formula, moles) };
  });

  return {
    ok: true,
    result: {
      limiting: limiting.formula,
      extent,
      products,
      detail: `Reactivo limitante: ${limiting.formula}. Se forman ${products
        .map((item) => `${item.moles.toFixed(3)} mol de ${item.formula}`)
        .join(' y ')}.`,
    },
  };
}

/** ¿El texto parece una ecuación química? Sirve para no intentarlo con prosa. */
export function looksLikeEquation(text: string): boolean {
  return /(->|→|⟶)/.test(text) && /[A-Z][a-z]?\d*/.test(text);
}
