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
const units = require(path.join(outDir, 'units.js'));
const chemistry = require(path.join(outDir, 'chemistry.js'));
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
check('multiplicación implícita 3(2)', evalText('3(2)') === 6);
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
/* Unidades                                                            */
/* ------------------------------------------------------------------ */

console.log('\nUnidades: dimensiones y conversiones');

const newton = units.parseUnit('N');
check(
  'N es kg·m/s²',
  newton.ok && units.dimensionLabel(newton.unit.dim) === 'kg·m·s^-2',
  newton.ok ? units.dimensionLabel(newton.unit.dim) : newton.reason
);

const joule = units.parseUnit('J');
check(
  'J es kg·m²/s²',
  joule.ok && units.dimensionLabel(joule.unit.dim) === 'kg·m^2·s^-2',
  joule.ok ? units.dimensionLabel(joule.unit.dim) : joule.reason
);

const acceleration = units.parseUnit('m/s^2');
check(
  'm/s² es m·s⁻²',
  acceleration.ok && units.dimensionLabel(acceleration.unit.dim) === 'm·s^-2',
  acceleration.ok ? units.dimensionLabel(acceleration.unit.dim) : acceleration.reason
);

const speed = units.parseUnit('km/h');
check(
  'km/h se convierte a 0,2778 m/s',
  speed.ok && Math.abs(speed.unit.factor - 1000 / 3600) < 1e-12,
  speed.ok ? speed.unit.factor : speed.reason
);

const square = units.parseUnit('m²');
check('superíndice de unidad', square.ok && units.dimensionLabel(square.unit.dim) === 'm^2');
check('mmHg reconocido', units.parseUnit('mmHg').ok);
check('unidad inventada rechazada', !units.parseUnit('foo').ok);
check('temperatura con offset fuera de alcance', !units.parseUnit('ºC').ok);

const kmh = units.parseUnit('km/h');
const ms = units.parseUnit('m/s');
const converted = kmh.ok && ms.ok ? units.convert(36, kmh.unit, ms.unit) : null;
check('36 km/h = 10 m/s', converted !== null && Math.abs(converted - 10) < 1e-9, converted);

const sameUnit = units.checkQuantityEquality('1 km', '1000 m');
check('1 km = 1000 m', sameUnit && sameUnit.status === 'ok', sameUnit && sameUnit.status);

const derivedUnit = units.checkQuantityEquality('3.6*10^6 N/C', '3.6*10^6 V/m');
check(
  'N/C y V/m son homogéneas',
  derivedUnit && derivedUnit.status === 'ok' && derivedUnit.kind === 'conversion',
  derivedUnit && derivedUnit.status
);

const wrongDimension = units.checkQuantityEquality('5 m', '5 s');
check(
  'sumar metros y segundos se marca',
  wrongDimension && wrongDimension.status === 'fail' && wrongDimension.kind === 'dimensiones',
  wrongDimension && wrongDimension.status
);

const wrongConversion = units.checkQuantityEquality('1 km', '900 m');
check(
  'una conversión falsa se marca',
  wrongConversion && wrongConversion.status === 'fail' && wrongConversion.kind === 'conversion',
  wrongConversion && wrongConversion.status
);

check('sin unidad no se pronuncia', units.checkQuantityEquality('25', '25') === null);

/* ------------------------------------------------------------------ */
/* Química                                                             */
/* ------------------------------------------------------------------ */

console.log('\nQuímica: masas, cargas y ajuste');

const near = (value, target, tolerance = 0.05) =>
  value !== null && Math.abs(value - target) <= tolerance;

check('H2O ≈ 18,02 g/mol', near(chemistry.molarMass('H2O'), 18.015, 0.01));
check('Ca(OH)2 ≈ 74,09 g/mol', near(chemistry.molarMass('Ca(OH)2'), 74.093, 0.01));
check('CuSO4·5H2O ≈ 249,68 g/mol', near(chemistry.molarMass('CuSO4·5H2O'), 249.677, 0.05));
check('Fe2(SO4)3 ≈ 399,86 g/mol', near(chemistry.molarMass('Fe2(SO4)3'), 399.858, 0.05));

const nitrate = chemistry.parseFormula('NO3-');
check(
  'NO3⁻: 3 oxígenos y carga −1',
  nitrate.ok && nitrate.formula.charge === -1 && nitrate.formula.counts.O === 3,
  nitrate.ok ? JSON.stringify(nitrate.formula) : nitrate.reason
);

const iron = chemistry.parseFormula('Fe3+');
check(
  'Fe³⁺: un hierro y carga +3',
  iron.ok && iron.formula.charge === 3 && iron.formula.counts.Fe === 1,
  iron.ok ? JSON.stringify(iron.formula) : iron.reason
);

const ammonium = chemistry.parseFormula('NH4+');
check(
  'NH4⁺: 4 hidrógenos y carga +1',
  ammonium.ok && ammonium.formula.charge === 1 && ammonium.formula.counts.H === 4,
  ammonium.ok ? JSON.stringify(ammonium.formula) : ammonium.reason
);

const sulfate = chemistry.parseFormula('SO4^2-');
check('SO4²⁻ con caret', sulfate.ok && sulfate.formula.charge === -2);
check('elemento inexistente se rechaza', !chemistry.parseFormula('Xx2').ok);
check('paréntesis desemparejados se rechazan', !chemistry.parseFormula('Ca(OH2').ok);

check(
  '2H2 + O2 → 2H2O está ajustada',
  chemistry.checkBalance('2H2 + O2 -> 2H2O').status === 'ok'
);
check(
  'CH4 + 2O2 → CO2 + 2H2O está ajustada',
  chemistry.checkBalance('CH4 + 2O2 -> CO2 + 2H2O').status === 'ok'
);
check(
  'Na+ + Cl- → NaCl está ajustada (carga incluida)',
  chemistry.checkBalance('Na+ + Cl- -> NaCl').status === 'ok'
);
check(
  'redox con electrones ajustada',
  chemistry.checkBalance('MnO4^- + 8H+ + 5e- -> Mn^2+ + 4H2O').status === 'ok'
);

const unbalanced = chemistry.checkBalance('H2 + O2 -> H2O');
check('H2 + O2 → H2O se marca sin ajustar', unbalanced.status === 'fail', unbalanced.status);
check(
  'el ajuste propuesto es 2, 1, 2',
  Array.isArray(unbalanced.coefficients) && unbalanced.coefficients.join(',') === '2,1,2',
  unbalanced.coefficients
);

const rust = chemistry.checkBalance('Fe + O2 -> Fe2O3');
check(
  'Fe + O2 → Fe2O3 se ajusta como 4, 3, 2',
  rust.status === 'fail' && Array.isArray(rust.coefficients) && rust.coefficients.join(',') === '4,3,2',
  rust.coefficients
);

check(
  'una ecuación con dos ajustes posibles no se inventa',
  chemistry.checkBalance('H2 + O2 -> H2O + H2O2').status === 'no_verificable'
);

const stoich = chemistry.limitingReagent('2H2 + O2 -> 2H2O', {
  H2: { moles: 2 },
  O2: { moles: 1 },
});
check('reactivo limitante reconocido', stoich.ok && stoich.result.limiting === 'H2', stoich.ok ? stoich.result.limiting : stoich.reason);
check('se forman 2 mol de agua', stoich.ok && Math.abs(stoich.result.products[0].moles - 2) < 1e-9);
check(
  'se forman ≈ 36,03 g de agua',
  stoich.ok && near(stoich.result.products[0].grams, 36.03, 0.02),
  stoich.ok ? stoich.result.products[0].grams : '-'
);

const byMass = chemistry.limitingReagent('2H2 + O2 -> 2H2O', {
  H2: { grams: 4 },
  O2: { grams: 32 },
});
check(
  'con gramos, el limitante es el hidrógeno',
  byMass.ok && byMass.result.limiting === 'H2',
  byMass.ok ? byMass.result.limiting : byMass.reason
);
check(
  'una ecuación sin ajustar no calcula estequiometría',
  !chemistry.limitingReagent('H2 + O2 -> H2O', { H2: { moles: 2 } }).ok
);

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

const chemistryFail = verify.verifyBlock({
  subjectName: 'Química',
  answer: 'La reacción es $H2 + O2 → H2O$.',
});
check(
  'una ecuación sin ajustar se marca en el bloque',
  chemistryFail.status === 'fail' && chemistryFail.checks.some((item) => item.kind === 'balanceo'),
  chemistryFail.status
);

const chemistryOk = verify.verifyBlock({ subjectName: 'Química', answer: 'Ajustada: $2H2 + O2 → 2H2O$.' });
check('una ecuación ajustada se marca correcta', chemistryOk.status === 'ok', chemistryOk.status);

const unitsMismatch = verify.verifyBlock({ subjectName: 'Física', answer: 'Así que $5 m = 5 s$.' });
check(
  'unidades no homogéneas se marcan en el bloque',
  unitsMismatch.status === 'fail' && unitsMismatch.checks.some((item) => item.kind === 'dimensiones'),
  unitsMismatch.status
);

const conversionOk = verify.verifyBlock({ subjectName: 'Física', answer: '$36 km/h = 10 m/s$.' });
check('una conversión correcta se marca', conversionOk.status === 'ok', conversionOk.status);

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
/* Integración con el corrector y la interfaz                          */
/* ------------------------------------------------------------------ */

console.log('\nIntegración: evidencia, nunca nota');

const readSource = (relative) => fs.readFileSync(path.join(projectRoot, relative), 'utf8');
const correctorSource = readSource(path.join('src', 'lib', 'corrector.ts'));
const ebauSource = readSource(path.join('src', 'lib', 'ebauSimulator.ts'));
const resultsSource = readSource(path.join('src', 'components', 'examen', 'ExamResults.tsx'));
const typesSource = readSource(path.join('src', 'lib', 'examenTypes.ts'));

check(
  'el corrector adjunta la verificación al bloque',
  /verification:\s*verifications\[index\]/.test(correctorSource)
);
check(
  'el corrector la calcula antes de las pasadas',
  /const verifications = params\.blocks\.map/.test(correctorSource)
);
check(
  'la corrección EBAU también la adjunta',
  /verification:\s*verifications\[index\]/.test(ebauSource)
);
check(
  'la penalización EBAU sigue saliendo solo de notationIssues',
  /notationPenalty = Math\.min\(\s*1,\s*Math\.round\(notationIssues\.length/.test(ebauSource)
);
check('el tipo del bloque admite la verificación', /verification\?:\s*BlockVerification/.test(typesSource));
check('la interfaz pinta el resultado', /result\.verification/.test(resultsSource));

const examinadorSource = readSource(path.join('src', 'lib', 'examinador.ts'));
const pageSource = readSource(
  path.join('src', 'app', 'examinador', '[sessionId]', 'page.tsx')
);
const verificarRoute = readSource(path.join('src', 'app', 'api', 'verificar', 'route.ts'));

check(
  'la generación pide y guarda la solución de referencia',
  /"expected"/.test(examinadorSource) && /expected: asString\(entry\.expected\)/.test(examinadorSource)
);
check(
  'la generación EBAU también guarda la referencia',
  /expected: asString\(entry\.expected\)/.test(ebauSource)
);
check(
  'la página quita expected antes de enviarla al navegador',
  /delete copy\.expected/.test(pageSource) && /blocks=\{publicBlocks\}/.test(pageSource)
);
check(
  'la página ya no manda los bloques crudos',
  !/blocks=\{pkg\.blocks\}/.test(pageSource)
);
check('el endpoint de comprobación exige sesión', /await requireUser\(\)/.test(verificarRoute));
check(
  'el endpoint no llama a ningún modelo',
  !/runAiText|aiEngine|ensureAiAccess/.test(verificarRoute)
);

/* ------------------------------------------------------------------ */

fs.rmSync(outDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLO(S)`}`);
process.exit(failures === 0 ? 0 : 1);
