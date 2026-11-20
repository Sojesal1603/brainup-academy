/**
 * LaTeX → expresión del motor determinista.
 *
 * No es un conversor de LaTeX completo ni pretende serlo: acepta la notación
 * que de verdad escriben los modelos y los alumnos (fracciones, raíces,
 * potencias, subíndices, unidades entre `\text{}`, decimales con coma y
 * superíndices Unicode) y **rechaza con motivo** todo lo que quede fuera de esa
 * gramática. Un rechazo se convierte en `no_verificable`, nunca en un fallo.
 *
 * Regla de oro: si esta función devuelve `ok: false`, el llamante no debe
 * intentar adivinar la expresión.
 */

export type LatexNormalization =
  | { ok: true; expression: string }
  | { ok: false; reason: string };

/** Nombres griegos que se aceptan como variables (no como comandos). */
const GREEK: Record<string, string> = {
  alpha: 'alpha',
  beta: 'beta',
  gamma: 'gamma',
  delta: 'delta',
  epsilon: 'epsilon',
  varepsilon: 'epsilon',
  zeta: 'zeta',
  eta: 'eta',
  theta: 'theta',
  iota: 'iota',
  kappa: 'kappa',
  lambda: 'lambda',
  mu: 'mu',
  nu: 'nu',
  xi: 'xi',
  rho: 'rho',
  sigma: 'sigma',
  tau: 'tau',
  upsilon: 'upsilon',
  phi: 'phi',
  varphi: 'phi',
  chi: 'chi',
  psi: 'psi',
  omega: 'omega',
  Gamma: 'Gamma',
  Delta: 'Delta',
  Theta: 'Theta',
  Lambda: 'Lambda',
  Sigma: 'Sigma',
  Phi: 'Phi',
  Psi: 'Psi',
  Omega: 'Omega',
};

const FUNCTIONS = ['arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'sin', 'cos', 'tan', 'ln', 'log', 'exp', 'sqrt', 'abs'];

const SUPERSCRIPTS: Record<string, string> = {
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
  '⁺': '+',
};

function count(input: string, char: string): number {
  let total = 0;
  for (const current of input) if (current === char) total += 1;
  return total;
}

/** Quita los delimitadores matemáticos de fuera, no los de dentro. */
function stripDelimiters(input: string): string {
  let text = input.trim();
  if (!text) return text;
  // Puede venir con uno o dos dólares a cada lado: se quitan todos.
  while (text.startsWith('$')) text = text.slice(1);
  while (text.endsWith('$')) text = text.slice(0, -1);
  text = text.replace(/^\\\[/, '').replace(/\\\]$/, '');
  text = text.replace(/^\\\(/, '').replace(/\\\)$/, '');
  return text.trim();
}

/** `10⁻⁶` → `10^(-6)`; `m²` → `m^(2)`. */
function expandSuperscripts(input: string): string {
  return input.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, (run) => {
    let digits = '';
    for (const char of run) digits += SUPERSCRIPTS[char] ?? '';
    return digits ? `^(${digits})` : '';
  });
}

/** Reemplaza `\frac{a}{b}` de dentro hacia fuera (el regex solo pilla llaves simples). */
function replaceFractions(input: string): string {
  let text = input;
  const pattern = /\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/;
  let guard = 0;
  while (pattern.test(text) && guard < 50) {
    text = text.replace(pattern, '($1)/($2)');
    guard += 1;
  }
  return text;
}

/** Reemplaza `\sqrt[n]{x}` y `\sqrt{x}`. */
function replaceRoots(input: string): string {
  let text = input;
  const nth = /\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/;
  let guard = 0;
  while (nth.test(text) && guard < 50) {
    text = text.replace(nth, '(($2)^(1/($1)))');
    guard += 1;
  }

  const plain = /\\sqrt\s*\{([^{}]*)\}/;
  guard = 0;
  while (plain.test(text) && guard < 50) {
    text = text.replace(plain, 'sqrt($1)');
    guard += 1;
  }
  return text;
}

export function normalizeLatex(raw: string): LatexNormalization {
  if (typeof raw !== 'string') return { ok: false, reason: 'la expresión no es texto' };
  if (raw.length > 4_000) return { ok: false, reason: 'la expresión es demasiado larga' };

  let text = stripDelimiters(raw);
  if (!text) return { ok: false, reason: 'la expresión está vacía' };

  // Entornos de alineación, matrices e integrales: fuera de alcance declarado.
  if (/\\(begin|end)\s*\{/.test(text)) {
    return { ok: false, reason: 'entornos de alineación o matrices fuera de alcance' };
  }
  if (/\\(int|iint|iiint|sum|prod|lim|oint)(?![A-Za-z])/.test(text)) {
    return { ok: false, reason: 'integrales, sumatorios y límites fuera de alcance' };
  }
  if (/\\(pm|mp)\b/.test(text)) {
    return { ok: false, reason: '± devuelve dos valores y no se puede verificar' };
  }
  if (/\\infty\b/.test(text)) {
    return { ok: false, reason: 'el infinito no se puede evaluar' };
  }

  // Unicode habitual en respuestas reales.
  text = text
    .replace(/[−–—]/g, '-')
    .replace(/[·⋅×]/g, '*')
    .replace(/÷/g, '/')
    .replace(/[µμ]/g, 'u')
    .replace(/π/g, 'pi')
    .replace(/Ω/g, 'ohm')
    .replace(/√/g, 'sqrt')
    .replace(/°/g, '*(pi/180)')
    .replace(/\\%/g, '/100');

  text = expandSuperscripts(text);

  // Comandos de formato que no cambian el valor.
  text = text
    .replace(/\\(left|right|displaystyle|limits|nolimits|big|Big|bigg|Bigg)\b/g, '')
    .replace(/\\(,|;|:|!|quad|qquad)/g, ' ')
    .replace(/\\ /g, ' ')
    .replace(/~/g, ' ')
    .replace(/\^\s*\\circ/g, '*(pi/180)')
    .replace(/\\circ/g, '*(pi/180)')
    .replace(/\\(vec|hat|bar|overline|underline|tilde)\s*/g, '');

  // Texto y operadores con argumento: se conserva el contenido.
  text = text
    .replace(/\\(text|mathrm|mathit|mathbf|operatorname|mbox)\s*\{([^{}]*)\}/g, '$2')
    .replace(/\\mathrm\s*\{([^{}]*)\}/g, '$1');

  // Multiplicación y división.
  text = text.replace(/\\(cdot|times|ast)/g, '*').replace(/\\div/g, '/');

  text = replaceFractions(text);
  text = replaceRoots(text);

  // Potencias y subíndices con llaves.
  text = text.replace(/\^\s*\{([^{}]*)\}/g, '^($1)');
  text = text.replace(/_\s*\{([^{}]*)\}/g, '_$1');
  // `v_0` y `v_{rad}` se leen como una sola variable: `v0`, `vrad`.
  text = text.replace(/([A-Za-z])_([A-Za-z0-9]+)/g, '$1$2');

  // Llaves restantes: agrupación normal.
  if (count(text, '{') !== count(text, '}')) {
    return { ok: false, reason: 'llaves desemparejadas' };
  }
  text = text.replace(/\{/g, '(').replace(/\}/g, ')');

  // Letras griegas como variables.
  for (const [name, replacement] of Object.entries(GREEK)) {
    text = text.replace(new RegExp(`\\\\${name}\\b`, 'g'), replacement);
  }

  // Funciones trigonométricas y logaritmos.
  for (const name of FUNCTIONS) {
    text = text.replace(new RegExp(`\\\\${name}\\b`, 'g'), name);
  }

  // Cualquier comando que quede es gramática no soportada: se dice cuál.
  const unknown = text.match(/\\[A-Za-z]+/);
  if (unknown) {
    return { ok: false, reason: `comando LaTeX no soportado: ${unknown[0]}` };
  }

  // Decimales con coma (solo entre dígitos: no toca `f(x, y)`).
  text = text.replace(/(\d),(\d)/g, '$1.$2');

  // Espacios finos y saltos de línea: una expresión es una sola línea.
  text = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();

  if (!text) return { ok: false, reason: 'la expresión queda vacía tras normalizarla' };
  if (!/[0-9A-Za-z]/.test(text)) return { ok: false, reason: 'la expresión no contiene números ni variables' };

  return { ok: true, expression: text };
}

/**
 * Separa la parte numérica de la unidad: `3.6*10^6 N/C` → `{ value, unit }`.
 * Si no hay unidad reconocible, `unit` es `null`; eso no es un error aquí.
 */
export function splitQuantity(expression: string): { value: string; unit: string | null } {
  const text = expression.trim();
  const match = text.match(/^(.*?)(?:\s+|\s*\*\s*)([A-Za-zµμΩ][A-Za-z0-9µμΩ/*^·.\s-]*)$/);
  if (!match) return { value: text, unit: null };
  return { value: match[1].trim(), unit: match[2].trim() };
}
