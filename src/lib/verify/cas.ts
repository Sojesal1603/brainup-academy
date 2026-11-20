/**
 * Motor CAS determinista y acotado.
 *
 * Qué hace: analiza expresiones aritméticas y algebraicas elementales
 * (números, variables, `+ - * / ^`, paréntesis, multiplicación implícita y
 * funciones habituales), las evalúa y decide si dos expresiones son
 * equivalentes. Lo segundo se resuelve por muestreo determinista en puntos
 * fijos: si difieren en cualquiera de ellos, no son equivalentes.
 *
 * Qué NO hace (a propósito): resolver ecuaciones simbólicamente, integrales,
 * límites, sistemas o trigonometría identitaria. Eso queda fuera de alcance y
 * el llamante debe responder `no_verificable`, no `fallo`.
 *
 * Sin dependencias: solo aritmética de JavaScript. Así el mismo código corre en
 * Netlify, en Render y en un portátil sin Python ni SymPy.
 */

export type CasNode =
  | { type: 'num'; value: number }
  | { type: 'var'; name: string }
  | { type: 'neg'; value: CasNode }
  | { type: 'bin'; op: '+' | '-' | '*' | '/' | '^'; left: CasNode; right: CasNode }
  | { type: 'call'; name: string; arg: CasNode };

export type CasParse = { ok: true; node: CasNode } | { ok: false; reason: string };

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'id'; value: string }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' | '^' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' };

const FUNCTIONS = new Set([
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'sinh',
  'cosh',
  'tanh',
  'ln',
  'log',
  'exp',
  'sqrt',
  'abs',
]);

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

const PRECEDENCE: Record<'+' | '-' | '*' | '/' | '^', number> = {
  '+': 10,
  '-': 10,
  '*': 20,
  '/': 20,
  '^': 40,
};

/** Puntos fijos de muestreo. Deterministas a propósito: el resultado se repite. */
const SAMPLES = [0.5, 1, 2, -1, 3, -2, 0.25, 7, -0.5, 11];

function tokenize(input: string): { ok: true; tokens: Token[] } | { ok: false; reason: string } {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      let end = index;
      while (end < input.length && /[0-9.]/.test(input[end])) end += 1;
      // Exponente científico: 1.5e-3. Solo si hay dígitos detrás de la e.
      if (end < input.length && /[eE]/.test(input[end]) && /[0-9+-]/.test(input[end + 1] ?? '')) {
        let expEnd = end + 1;
        if (/[+-]/.test(input[expEnd])) expEnd += 1;
        while (expEnd < input.length && /[0-9]/.test(input[expEnd])) expEnd += 1;
        if (expEnd > end + 1) end = expEnd;
      }
      const raw = input.slice(index, end);
      const value = Number(raw);
      if (!Number.isFinite(value)) return { ok: false, reason: `número no válido: ${raw}` };
      tokens.push({ kind: 'num', value });
      index = end;
      continue;
    }

    if (/[A-Za-z]/.test(char)) {
      let end = index;
      while (end < input.length && /[A-Za-z0-9]/.test(input[end])) end += 1;
      tokens.push({ kind: 'id', value: input.slice(index, end) });
      index = end;
      continue;
    }

    if ('+-*/^'.includes(char)) {
      tokens.push({ kind: 'op', value: char as '+' | '-' | '*' | '/' | '^' });
      index += 1;
      continue;
    }

    if (char === '(' || char === '[') {
      tokens.push({ kind: 'lparen' });
      index += 1;
      continue;
    }
    if (char === ')' || char === ']') {
      tokens.push({ kind: 'rparen' });
      index += 1;
      continue;
    }
    if (char === ',') {
      tokens.push({ kind: 'comma' });
      index += 1;
      continue;
    }

    return { ok: false, reason: `carácter no soportado: «${char}»` };
  }

  return { ok: true, tokens };
}

class Parser {
  private tokens: Token[];
  private position = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | null {
    return this.tokens[this.position] ?? null;
  }

  private next(): Token | null {
    const token = this.tokens[this.position] ?? null;
    if (token) this.position += 1;
    return token;
  }

  parse(): CasParse {
    if (this.tokens.length === 0) return { ok: false, reason: 'expresión vacía' };

    const node = this.parseExpression(0);
    if (!node.ok) return node;
    if (this.position !== this.tokens.length) {
      return { ok: false, reason: 'sobran términos al final de la expresión' };
    }
    return node;
  }

  private parseExpression(minPrecedence: number): CasParse {
    const left = this.parseUnary();
    if (!left.ok) return left;

    let current = left.node;

    for (;;) {
      const token = this.peek();
      if (!token) break;

      // Operador explícito.
      if (token.kind === 'op') {
        const precedence = PRECEDENCE[token.value];
        if (precedence <= minPrecedence) break;
        this.next();
        const right = this.parseExpression(token.value === '^' ? precedence - 1 : precedence);
        if (!right.ok) return right;
        current = { type: 'bin', op: token.value, left: current, right: right.node };
        continue;
      }

      // Multiplicación implícita: 2x, 4xy, 3(x+1), 2*pi.
      if (token.kind === 'num' || token.kind === 'id' || token.kind === 'lparen') {
        const precedence = PRECEDENCE['*'];
        if (precedence <= minPrecedence) break;
        const right = this.parseExpression(precedence);
        if (!right.ok) return right;
        current = { type: 'bin', op: '*', left: current, right: right.node };
        continue;
      }

      break;
    }

    return { ok: true, node: current };
  }

  private parseUnary(): CasParse {
    const token = this.peek();
    if (token?.kind === 'op' && (token.value === '-' || token.value === '+')) {
      this.next();
      const operand = this.parseExpression(30);
      if (!operand.ok) return operand;
      return { ok: true, node: token.value === '-' ? { type: 'neg', value: operand.node } : operand.node };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): CasParse {
    const token = this.next();
    if (!token) return { ok: false, reason: 'falta un término' };

    if (token.kind === 'num') return { ok: true, node: { type: 'num', value: token.value } };

    if (token.kind === 'id') {
      const following = this.peek();
      if (FUNCTIONS.has(token.value.toLowerCase()) && following?.kind === 'lparen') {
        this.next(); // (
        const arg = this.parseExpression(0);
        if (!arg.ok) return arg;
        const closing = this.next();
        if (closing?.kind !== 'rparen') return { ok: false, reason: 'falta el paréntesis de cierre' };
        return {
          ok: true,
          node: { type: 'call', name: token.value.toLowerCase(), arg: arg.node },
        };
      }
      return { ok: true, node: { type: 'var', name: token.value } };
    }

    if (token.kind === 'lparen') {
      const inner = this.parseExpression(0);
      if (!inner.ok) return inner;
      const closing = this.next();
      if (closing?.kind !== 'rparen') return { ok: false, reason: 'falta el paréntesis de cierre' };
      return inner;
    }

    return { ok: false, reason: 'se esperaba un número, una variable o un paréntesis' };
  }
}

/** Analiza una expresión ya normalizada (sin LaTeX). */
export function parseExpression(input: string): CasParse {
  const tokens = tokenize(input);
  if ('reason' in tokens) return { ok: false, reason: tokens.reason };
  return new Parser(tokens.tokens).parse();
}

/** Evalúa un árbol. Una variable desconocida devuelve NaN, no 0. */
export function evaluate(node: CasNode, env: Record<string, number> = {}): number {
  switch (node.type) {
    case 'num':
      return node.value;
    case 'var': {
      if (Object.prototype.hasOwnProperty.call(env, node.name)) return env[node.name];
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, node.name)) return CONSTANTS[node.name];
      return Number.NaN;
    }
    case 'neg':
      return -evaluate(node.value, env);
    case 'bin': {
      const left = evaluate(node.left, env);
      const right = evaluate(node.right, env);
      switch (node.op) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return left / right;
        case '^':
          return Math.pow(left, right);
        default:
          return Number.NaN;
      }
    }
    case 'call': {
      const value = evaluate(node.arg, env);
      switch (node.name) {
        case 'sin':
          return Math.sin(value);
        case 'cos':
          return Math.cos(value);
        case 'tan':
          return Math.tan(value);
        case 'asin':
          return Math.asin(value);
        case 'acos':
          return Math.acos(value);
        case 'atan':
          return Math.atan(value);
        case 'sinh':
          return Math.sinh(value);
        case 'cosh':
          return Math.cosh(value);
        case 'tanh':
          return Math.tanh(value);
        case 'ln':
          return Math.log(value);
        case 'log':
          return Math.log10(value);
        case 'exp':
          return Math.exp(value);
        case 'sqrt':
          return Math.sqrt(value);
        case 'abs':
          return Math.abs(value);
        default:
          return Number.NaN;
      }
    }
    default:
      return Number.NaN;
  }
}

/** Variables libres del árbol (los nombres que no son constantes). */
export function variablesOf(node: CasNode, found: Set<string> = new Set()): Set<string> {
  switch (node.type) {
    case 'var':
      if (!Object.prototype.hasOwnProperty.call(CONSTANTS, node.name)) found.add(node.name);
      break;
    case 'neg':
      variablesOf(node.value, found);
      break;
    case 'bin':
      variablesOf(node.left, found);
      variablesOf(node.right, found);
      break;
    case 'call':
      variablesOf(node.arg, found);
      break;
    default:
      break;
  }
  return found;
}

/** Diferencia relativa con suelo absoluto: no convierte 1e-15 en un fallo. */
export function closeEnough(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= 1e-9 * scale;
}

/**
 * ¿Son equivalentes? Sin variables, comparación numérica directa. Con
 * variables, muestreo determinista: hacen falta al menos 3 muestras válidas y
 * que todas coincidan.
 */
export function equivalent(left: CasNode, right: CasNode): boolean {
  const variables = [...new Set([...variablesOf(left), ...variablesOf(right)])];

  if (variables.length === 0) {
    return closeEnough(evaluate(left), evaluate(right));
  }

  let valid = 0;
  for (const sample of SAMPLES) {
    const env: Record<string, number> = {};
    variables.forEach((name, index) => {
      // Cada variable toma un valor distinto para no confundir x² con x·y.
      env[name] = sample + index * 0.37;
    });
    const a = evaluate(left, env);
    const b = evaluate(right, env);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (!closeEnough(a, b)) return false;
    valid += 1;
  }

  return valid >= 3;
}

/** Atajo: normaliza ya hecha, analiza y compara. */
export function equivalentText(left: string, right: string): boolean | null {
  const a = parseExpression(left);
  const b = parseExpression(right);
  if (!a.ok || !b.ok) return null;
  return equivalent(a.node, b.node);
}

/**
 * ¿La expresión es un número? Devuelve `null` si quedan variables o no se puede
 * evaluar: el llamante debe tratarlo como «no verificable», no como fallo.
 */
export function numericValue(input: string): number | null {
  const parsed = parseExpression(input);
  if (!parsed.ok) return null;
  if (variablesOf(parsed.node).size > 0) return null;
  const value = evaluate(parsed.node);
  return Number.isFinite(value) ? value : null;
}
