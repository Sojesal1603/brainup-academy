/**
 * Verificación del motor determinista del Paso 12.
 *
 * No gasta IA: compila `src/lib/verify` con `tsc` y prueba el normalizador de
 * LaTeX, el CAS, las unidades, la química y el contrato de marcado. Es el mismo
 * patrón que `scripts/verify-corrector.js`.
 *
 * Uso: node scripts/verify-verificacion.js   (o npm run verify:verificacion)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, '.tmp-verify-verificacion');

let failures = 0;
function check(label, condition, extra) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FALLO ${label}`, extra === undefined ? '' : extra);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    path.join('src', 'lib', 'verify', 'index.ts'),
    '--outDir',
    '.tmp-verify-verificacion',
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck',
    '--esModuleInterop',
  ],
  { cwd: projectRoot, stdio: 'inherit' }
);

const latex = require(path.join(outDir, 'latex.js'));
const cas = require(path.join(outDir, 'cas.js'));
const verify = require(path.join(outDir, 'index.js'));

/* ------------------------------------------------------------------ */
/* LaTeX                                                               */
/* ------------------------------------------------------------------ */

console.log('\nLaTeX: lo que se puede leer y lo que se rechaza con motivo');

const frac = latex.normalizeLatex('\\frac{1}{2}mv^2');
check('fracción', frac.ok && frac.expression.includes('(1)/(2)'), frac.expression);

const root = latex.normalizeLatex('\\sqrt{x^2+y^2}');
check('raíz cuadrada', root.ok && root.expression.includes('sqrt('), root.expression);

const nthRoot = latex.normalizeLatex('\\sqrt[3]{8}');
check('raíz cúbica', nthRoot.ok && nthRoot.expression.includes('1/(3)'), nthRoot.expression);

const unitText = latex.normalizeLatex('9{,}8\\ \\text{m/s}^2'.replace('{,}', ','));
check('coma decimal y unidad en \\text', unitText.ok && unitText.expression.includes('m/s'), unitText.expression);

const unicode = latex.normalizeLatex('3,6·10⁶ N/C');
check(
  'coma, producto y superíndice Unicode',
  unicode.ok && unicode.expression.includes('3.6*10^(6)'),
  unicode.expression
);

const sub = latex.normalizeLatex('v_{0}');
check('subíndice', sub.ok && sub.expression === 'v0', sub.expression);

const delimiters = latex.normalizeLatex('$$x^2$$');
check('delimitadores display', delimiters.ok && delimiters.expression === 'x^2', delimiters.expression);

const matrix = latex.normalizeLatex('\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}');
check('matriz rechazada con motivo', !matrix.ok && /matrices|alineaci/.test(matrix.reason), matrix.reason);

const integral = latex.normalizeLatex('\\int_0^1 x dx');
check('integral rechazada con motivo', !integral.ok && /integrales/.test(integral.reason), integral.reason);

const unknown = latex.normalizeLatex('\\foo{x}');
check('comando desconocido rechazado', !unknown.ok && /no soportado/.test(unknown.reason), unknown.reason);

const plusMinus = latex.normalizeLatex('x = \\pm 2');
check('± se rechaza (dos valores)', !plusMinus.ok, plusMinus.reason);

const broken = latex.normalizeLatex('\\frac{1}{2');
check('llaves desemparejadas', !broken.ok, broken.reason);

const empty = latex.normalizeLatex('   ');
check('expresión vacía', !empty.ok, empty.reason);

/* ------------------------------------------------------------------ */
/* CAS                                                                 */
/* ------------------------------------------------------------------ */

console.log('\nCAS: precedencia, evaluación y equivalencia');

const evalText = (text) => cas.numericValue(text);

check('suma y producto', evalText('2+3*4') === 14);
check('potencia antes que producto', evalText('2*3^2') === 18);
check('menos unario con potencia: -x^2 = -(x^2)', evalText('-2^2') === -4);
check('paréntesis', evalText('(2+3)*4') === 20);
check('multiplicación implícita 2x', evalText('2*pi') !== null);
check('división', evalText('10/4') === 2.5);
check('coma ya normalizada', evalText('0.5+0.25') === 0.75);
check('notación científica', evalText('1.5e-3') === 0.0015);
check('función trigonométrica', Math.abs(evalText('sin(pi/2)') - 1) < 1e-12);
check('logaritmo decimal', Math.abs(evalText('log(1000)') - 3) < 1e-12);
check('logaritmo neperiano', Math.abs(evalText('ln(e)') - 1) < 1e-12);
check('raíz', evalText('sqrt(16)') === 4);
check('una variable no es un número', evalText('2x') === null);
check('expresión inválida no es un número', evalText('2+*3') === null);

const a = cas.parseExpression('2(x+1)');
const b = cas.parseExpression('2x+2');
check('equivalencia algebraica', a.ok && b.ok && cas.equivalent(a.node, b.node));

const c = cas.parseExpression('x+1');
const d = cas.parseExpression('x+2');
check('no equivalencia algebraica', c.ok && d.ok && !cas.equivalent(c.node, d.node));

const e = cas.parseExpression('(x^2-1)/(x-1)');
const f = cas.parseExpression('x+1');
check('equivalencia con dominio recortado (muestreo)', e.ok && f.ok && cas.equivalent(e.node, f.node));

check('diferencia relativa tolerante', cas.closeEnough(1, 1 + 1e-12));
check('diferencia real no es tolerante', !cas.closeEnough(1, 1.01));
check('NaN nunca es equivalente', !cas.closeEnough(Number.NaN, Number.NaN));

/* ------------------------------------------------------------------ */
/* Contrato de marcado                                                 */
/* ------------------------------------------------------------------ */

console.log('\nContrato: marcar, no puntuar');

const expectedOk = verify.verifyBlock({
  subjectName: 'Matemáticas II',
  answer: 'Por tanto, $x = 2$.',
  expected: '2',
});
check('la referencia numérica se reconoce', expectedOk.status === 'ok', expectedOk.status);
check('la comprobación correcta se marca como ok', expectedOk.checks[0].status === 'ok');

const expectedFail = verify.verifyBlock({
  subjectName: 'Matemáticas II',
  answer: 'Por tanto, $x = 5$.',
  expected: '2',
});
check('un resultado final distinto se marca', expectedFail.status === 'fail', expectedFail.status);
check('el detalle explica el fallo', /no coincide/.test(expectedFail.checks[0].detail));

const expectedMissing = verify.verifyBlock({
  subjectName: 'Matemáticas II',
  answer: 'No llego al final.',
  expected: '2',
});
check('sin resultado localizable no se acusa', expectedMissing.status === 'no_verificable', expectedMissing.status);

const arithmeticOk = verify.verifyBlock({ answer: 'Compruebo: $3^2+4^2 = 25$.' });
check('igualdad aritmética correcta', arithmeticOk.status === 'ok', arithmeticOk.status);

const arithmeticFail = verify.verifyBlock({ answer: 'Compruebo: $3^2+4^2 = 30$.' });
check('igualdad aritmética incorrecta', arithmeticFail.status === 'fail', arithmeticFail.status);

const symbolicOnly = verify.verifyBlock({ answer: 'Sea $x^2-1=(x-1)(x+1)$.' });
check('una identidad simbólica se comprueba', symbolicOnly.status === 'ok', symbolicOnly.status);

const nothing = verify.verifyBlock({ answer: 'Comentario de texto sin cuentas.' });
check('sin cuentas es no_verificable', nothing.status === 'no_verificable', nothing.status);
check('sin cuentas no hay fallo', nothing.checks.filter((x) => x.status === 'fail').length === 0);

const emptyAnswer = verify.verifyBlock({ answer: '', expected: '2' });
check('respuesta en blanco no lanza ni falla', emptyAnswer.status === 'no_verificable', emptyAnswer.status);

const weird = verify.verifyBlock({ answer: '$\\foo{2}$', expected: '2' });
check('texto inclasificable no rompe el motor', weird.status === 'no_verificable', weird.status);

const mixed = verify.summarizeChecks([
  { kind: 'aritmetica', status: 'ok', detail: 'una bien' },
  { kind: 'aritmetica', status: 'fail', detail: 'una mal' },
]);
check('ok + fail = mixed', mixed.status === 'mixed', mixed.status);

const summaryText = verify.summarizeVerification(expectedFail);
check('el resumen nombra el fallo', /FALLO/.test(summaryText), summaryText);
check('el resumen no es enorme', summaryText.length < 600);

check(
  'la verificación no devuelve nota ni puntos',
  !('score' in expectedOk) && !('points' in expectedOk)
);

check('las etiquetas de estado están en español', verify.VERIFICATION_STATUS_LABELS.ok === 'Comprobado');

/* ------------------------------------------------------------------ */

fs.rmSync(outDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLO(S)`}`);
process.exit(failures === 0 ? 0 : 1);
