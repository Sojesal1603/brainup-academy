/**
 * Verificación determinista de un bloque (Paso 12).
 *
 * Qué aporta: una segunda opinión que **no es un modelo**. Comprueba lo que se
 * puede comprobar con cuentas —una igualdad aritmética, el resultado frente a
 * una referencia, la homogeneidad de unidades, el ajuste de una ecuación— y
 * deja escrito el resultado.
 *
 * Qué no hace: decidir la nota. Un `fail` se marca y se le enseña al corrector
 * como evidencia; el encargo (`docs/ENCARGO.md` §3.7) prohíbe convertirlo en un
 * cero automático. Si algo queda fuera de alcance, la respuesta es
 * `no_verificable` con el motivo, nunca un fallo inventado.
 *
 * Módulo puro: sin Prisma, sin red, sin IA y sin Python.
 */

import { normalizeLatex } from './latex';
import { closeEnough, equivalent, numericValue, parseExpression, variablesOf } from './cas';
import { checkBalance, looksLikeEquation } from './chemistry';
import { checkQuantityEquality } from './units';

export type VerificationStatus = 'ok' | 'fail' | 'no_verificable';

export type VerificationKind =
  | 'equivalencia'
  | 'sustitucion'
  | 'aritmetica'
  | 'dimensiones'
  | 'conversion'
  | 'balanceo'
  | 'estequiometria';

export interface VerificationCheck {
  kind: VerificationKind;
  status: VerificationStatus;
  /** En español y con LaTeX opcional (`$...$`): la interfaz ya pinta KaTeX. */
  detail: string;
}

export interface BlockVerification {
  status: 'ok' | 'fail' | 'mixed' | 'no_verificable';
  checks: VerificationCheck[];
}

export const VERIFICATION_STATUS_LABELS: Record<BlockVerification['status'], string> = {
  ok: 'Comprobado',
  fail: 'No cuadra',
  mixed: 'Con fallos',
  no_verificable: 'Sin verificación',
};

/** Tope de comprobaciones por bloque: más ruido no ayuda a nadie. */
const MAX_CHECKS = 6;

function normalize(fragment: string): string | null {
  const result = normalizeLatex(fragment);
  return result.ok ? result.expression : null;
}

/** Fragmentos entre `$...$` (inline o display). */
export function mathSpans(text: string): string[] {
  const spans: string[] = [];
  const regex = /\$([^$]+)\$/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const value = match[1].trim();
    if (value) spans.push(value);
  }
  return spans;
}

export interface Equality {
  left: string;
  right: string;
  raw: string;
}

/**
 * Igualdades del texto: las que están dentro de `$...$` y las que aparecen en
 * una línea suelta (`E = 3,6·10^6 N/C`). Se descartan comparaciones (`==`, `=>`)
 * y las que no tienen los dos lados.
 */
export function equalitiesIn(text: string): Equality[] {
  const found: Equality[] = [];
  const seen = new Set<string>();

  const add = (raw: string) => {
    if (raw.includes('==') || raw.includes('=>') || raw.includes('<=')) return;
    const parts = raw.split('=');
    if (parts.length !== 2) return;
    const left = parts[0].trim().replace(/^[^0-9A-Za-z\\(-]+/, '').trim();
    const right = parts[1].trim().replace(/[.,;:]+$/, '').trim();
    if (!left || !right) return;
    const key = `${left}=${right}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ left, right, raw });
  };

  for (const span of mathSpans(text)) add(span);
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('=')) continue;
    // Una línea con varias igualdades se trocea por la primera que se pueda leer.
    const cleaned = line.replace(/^[\s>*-]+/, '').replace(/^[a-z]\)\s*/i, '');
    add(cleaned);
  }

  return found;
}

/**
 * Comprueba una igualdad.
 *
 * - Numérica (`3+4=7`): correcta o fallo, sin ambigüedad.
 * - Simbólica: solo se marca `ok` cuando es una **identidad**
 *   (`x²−1=(x−1)(x+1)`). Una ecuación que no es identidad (`x²=4`) no es un
 *   fallo: no se devuelve nada y el bloque queda sin esa comprobación.
 */
function arithmeticCheck(equality: Equality): VerificationCheck | null {
  const left = normalize(equality.left);
  const right = normalize(equality.right);
  if (!left || !right) return null;

  const a = numericValue(left);
  const b = numericValue(right);
  if (a !== null && b !== null) {
    const same = closeEnough(a, b);
    return {
      kind: 'aritmetica',
      status: same ? 'ok' : 'fail',
      detail: same
        ? `$ ${equality.left.trim()} = ${equality.right.trim()} $`
        : `La igualdad no se cumple: $ ${equality.left.trim()} $ da ${a} y $ ${equality.right.trim()} $ da ${b}.`,
    };
  }

  const leftNode = parseExpression(left);
  const rightNode = parseExpression(right);
  if (!leftNode.ok || !rightNode.ok) return null;
  if (variablesOf(leftNode.node).size === 0 && variablesOf(rightNode.node).size === 0) return null;

  if (equivalent(leftNode.node, rightNode.node)) {
    return {
      kind: 'equivalencia',
      status: 'ok',
      detail: `Identidad comprobada: $ ${equality.left.trim()} = ${equality.right.trim()} $`,
    };
  }

  return null;
}

/**
 * ¿El alumno llega al resultado de referencia?
 *
 * `ok` si en algún paso aparece una expresión equivalente. `fail` solo cuando
 * la referencia es un número y el **último** resultado numérico del texto no
 * coincide: es el caso claro de «resuelvo bien y firmo mal». Si la referencia
 * no es numérica y no se encuentra, se declara `no_verificable`, no un fallo.
 */
export function expectedCheck(expected: string, answer: string): VerificationCheck {
  const reference = normalize(expected);
  if (!reference) {
    return {
      kind: 'equivalencia',
      status: 'no_verificable',
      detail: 'La referencia del bloque no se puede leer con el motor determinista.',
    };
  }

  const referenceNode = parseExpression(reference);
  if (!referenceNode.ok) {
    return {
      kind: 'equivalencia',
      status: 'no_verificable',
      detail: 'La referencia del bloque queda fuera de la gramática soportada.',
    };
  }

  const candidates = [
    ...mathSpans(answer),
    ...equalitiesIn(answer).flatMap((equality) => [equality.left, equality.right]),
  ];

  for (const candidate of candidates) {
    const normalized = normalize(candidate);
    if (!normalized) continue;
    const node = parseExpression(normalized);
    if (!node.ok) continue;
    if (equivalent(node.node, referenceNode.node)) {
      return {
        kind: 'equivalencia',
        status: 'ok',
        detail: 'El resultado coincide con la solución de referencia.',
      };
    }
  }

  // Solo se acusa un fallo cuando la referencia y el último resultado son
  // números: así no se confunde un paso intermedio con el resultado final.
  const referenceValue = numericValue(reference);
  if (referenceValue === null) {
    return {
      kind: 'equivalencia',
      status: 'no_verificable',
      detail: 'No se localiza el resultado de referencia en la respuesta.',
    };
  }

  // El «resultado final» es lo que va después de un marcador de cierre; si no
  // hay marcador, solo se mira el último fragmento matemático. Así no se acusa
  // a un paso intermedio ni a una línea de comprobación anterior.
  const marker = /(por tanto|luego|en conclusi[oó]n|resultado|soluci[oó]n|se obtiene|obtenemos|as[ií] que)/gi;
  let lastMarkerIndex = -1;
  let markerMatch: RegExpExecArray | null;
  while ((markerMatch = marker.exec(answer)) !== null) lastMarkerIndex = markerMatch.index;

  const tail = lastMarkerIndex >= 0 ? answer.slice(lastMarkerIndex) : answer;
  const finalSpans = mathSpans(tail);
  if (finalSpans.length === 0 && lastMarkerIndex < 0) finalSpans.push(...mathSpans(answer).slice(-1));

  for (const candidate of [...finalSpans].reverse()) {
    const normalized = normalize(candidate);
    if (!normalized) continue;

    // Se acepta tanto un número suelto como el lado derecho de `x = 5`.
    const pieces = normalized.split('=').map((piece) => piece.trim());
    const value = pieces.length === 2 ? numericValue(pieces[1]) : numericValue(normalized);
    if (value === null) continue;

    if (closeEnough(value, referenceValue)) {
      return {
        kind: 'equivalencia',
        status: 'ok',
        detail: 'El resultado coincide con la solución de referencia.',
      };
    }

    return {
      kind: 'equivalencia',
      status: 'fail',
      detail: `El último resultado numérico no coincide con la referencia (${referenceValue}).`,
    };
  }

  return {
    kind: 'equivalencia',
    status: 'no_verificable',
    detail: 'No se localiza un resultado final numérico en la respuesta.',
  };
}

function dedupe(checks: VerificationCheck[]): VerificationCheck[] {
  const seen = new Set<string>();
  const unique: VerificationCheck[] = [];
  for (const check of checks) {
    const key = `${check.kind}|${check.status}|${check.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(check);
    if (unique.length >= MAX_CHECKS) break;
  }
  return unique;
}

export function summarizeChecks(checks: VerificationCheck[]): BlockVerification {
  const failures = checks.filter((check) => check.status === 'fail').length;
  const passes = checks.filter((check) => check.status === 'ok').length;

  let status: BlockVerification['status'];
  if (failures > 0 && passes > 0) status = 'mixed';
  else if (failures > 0) status = 'fail';
  else if (passes > 0) status = 'ok';
  else status = 'no_verificable';

  return { status, checks };
}

/**
 * Ecuaciones químicas del texto. Solo se devuelven las que el motor ha podido
 * decidir (`ok` o `fail`): un intento de lectura fallido no ensucia el informe.
 */
function chemistryChecks(text: string): VerificationCheck[] {
  const segments = new Set<string>();

  for (const span of mathSpans(text)) {
    if (/(->|→|⟶)/.test(span)) segments.add(span);
  }
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/^[\s>*-]+/, '').trim();
    if (/(->|→|⟶)/.test(clean)) segments.add(clean);
  }

  const checks: VerificationCheck[] = [];
  for (const segment of segments) {
    if (!looksLikeEquation(segment)) continue;
    const result = checkBalance(segment);
    if (result.status === 'no_verificable') continue;
    checks.push({ kind: 'balanceo', status: result.status, detail: result.detail });
  }
  return checks;
}

/** Homogeneidad y conversión de unidades en las igualdades del texto. */
function unitChecks(text: string): VerificationCheck[] {
  const checks: VerificationCheck[] = [];

  for (const equality of equalitiesIn(text)) {
    const result = checkQuantityEquality(equality.left, equality.right);
    if (!result) continue;
    checks.push({ kind: result.kind, status: result.status, detail: result.detail });
  }

  return checks;
}

export interface VerifyBlockInput {
  /** Materia del bloque; decide qué comprobaciones tienen sentido. */
  subjectName?: string | null;
  prompt?: string;
  answer: string;
  /** Solución de referencia en LaTeX. Solo existe en el servidor. */
  expected?: string | null;
}

/** Verificación de un bloque corregido. Nunca lanza: si falla, es `no_verificable`. */
export function verifyBlock(input: VerifyBlockInput): BlockVerification {
  try {
    const checks: VerificationCheck[] = [];
    const answer = input.answer ?? '';

    if (input.expected && input.expected.trim() && answer.trim()) {
      checks.push(expectedCheck(input.expected, answer));
    }

    checks.push(...chemistryChecks(answer));
    checks.push(...unitChecks(answer));

    for (const equality of equalitiesIn(answer)) {
      const check = arithmeticCheck(equality);
      if (check) checks.push(check);
    }

    return summarizeChecks(dedupe(checks));
  } catch (error) {
    return {
      status: 'no_verificable',
      checks: [
        {
          kind: 'equivalencia',
          status: 'no_verificable',
          detail: `El motor de verificación no pudo analizar la respuesta: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    };
  }
}

/** Verificación de un texto libre (respuesta del catedrático). */
export function verifyText(input: {
  text: string;
  subjectName?: string | null;
}): BlockVerification {
  return verifyBlock({ subjectName: input.subjectName, answer: input.text });
}

/**
 * Resumen compacto para el prompt del corrector. No se le manda el detalle
 * completo de cada paso: solo lo que necesita para no dar por bueno un cálculo
 * que no cuadra.
 */
export function summarizeVerification(verification: BlockVerification): string {
  const failures = verification.checks.filter((check) => check.status === 'fail');
  const passes = verification.checks.filter((check) => check.status === 'ok');
  const unknown = verification.checks.filter((check) => check.status === 'no_verificable');

  if (verification.checks.length === 0) return 'sin comprobaciones aplicables';

  const counts = `${passes.length} correcta(s), ${failures.length} fallo(s), ${unknown.length} no verificable(s)`;
  const lines = [`verificación determinista: ${counts}`];

  for (const check of failures.slice(0, 3)) {
    lines.push(`- FALLO (${check.kind}): ${check.detail}`);
  }
  for (const check of passes.slice(0, 2)) {
    lines.push(`- correcto (${check.kind}): ${check.detail}`);
  }

  return lines.join(' ');
}

/** ¿Merece la pena enseñar el sello en la interfaz? */
export function hasUsefulVerification(verification: BlockVerification): boolean {
  return verification.checks.some((check) => check.status !== 'no_verificable');
}
