/**
 * Mide el corrector contra el banco de referencia y publica su MAE.
 *
 * Cada caso se corrige dos veces (mediana) con el motor real, así que tarda
 * varios minutos y consume cupo. El resultado se guarda en `data/eval-runs/` y
 * el Examinador lo enseña; no se inventa ninguna cifra si la IA falla.
 *
 * Uso: npm run exam:mae   (necesita claves de IA en .env; NUNCA en producción)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');

function loadEnv() {
  const file = path.join(projectRoot, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}
loadEnv();

// El motor solo acepta credenciales «de plataforma» en pruebas explícitas y
// fuera de producción: este script es exactamente ese caso.
process.env.BRAINUP_AI_TEST_MODE = '1';

const outDir = path.join(projectRoot, '.tmp-exam-mae');

async function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      path.join('src', 'lib', 'evalBank.ts'),
      '--outDir',
      '.tmp-exam-mae',
      '--module',
      'commonjs',
      '--target',
      'es2022',
      '--moduleResolution',
      'node',
      '--skipLibCheck',
      '--esModuleInterop',
      '--resolveJsonModule',
    ],
    { cwd: projectRoot, stdio: 'inherit' }
  );

  const { EVAL_CASES, runEvalBank, saveEvalRun } = require(path.join(outDir, 'evalBank.js'));

  console.log(`\nMidiendo ${EVAL_CASES.length} caso(s): dos pasadas por caso…\n`);
  const run = await runEvalBank(EVAL_CASES);

  for (const result of run.results) {
    const marker = result.absoluteError === 0 ? 'ok  ' : result.absoluteError <= 0.5 ? '~   ' : 'mal ';
    console.log(
      `${marker}${result.id.padEnd(24)} ref ${result.expectedScore.toFixed(2)} · corregido ${result.gotScore.toFixed(2)} · error ${result.absoluteError.toFixed(2)}`
    );
  }

  console.log(
    `\nError absoluto medio: ${run.summary.mae.toFixed(2)} pts sobre ${run.summary.cases} caso(s)`
  );
  console.log(`Modelo: ${run.model ?? 'desconocido'} · pasadas: ${run.passes}`);
  console.log('\nPor materia:');
  for (const group of run.summary.bySubject) {
    console.log(`  ${group.label}: MAE ${group.mae.toFixed(2)} (${group.cases} caso/s)`);
  }
  console.log('\nPor bloque:');
  for (const group of run.summary.byBlock) {
    console.log(`  ${group.label}: MAE ${group.mae.toFixed(2)} (${group.cases} caso/s)`);
  }

  const file = await saveEvalRun(run);
  console.log(`\nGuardado para el Examinador: ${path.relative(projectRoot, file)}`);
}

main()
  .catch((error) => {
    console.error('\nNo se ha podido medir:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });
