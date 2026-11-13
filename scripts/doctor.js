/**
 * El médico: un diagnóstico completo del sistema, sin tocar nada.
 *
 * Responde a la pregunta «¿por qué me da error?» en un solo comando. A diferencia
 * del vigilante (`npm run vigilante`), que repara, este **solo mira**: ni aplica
 * arreglos, ni escribe incidencias, ni pide cambios a la IA. Es lo que se ejecuta
 * cuando algo va mal y quieres ver el parte antes de decidir.
 *
 * Revisa, en orden:
 *   1. Entorno: versión de Node, dónde está el proyecto y qué claves hay puestas
 *      (los nombres, nunca los valores: un diagnóstico no filtra secretos).
 *   2. La app: `/api/salud`, que toca la base de verdad.
 *   3. La base: cuántas materias, unidades, apuntes, exámenes y retos hay.
 *   4. La IA: qué proveedores están configurados y cuántos modelos quedan libres.
 *   5. El mantenimiento: qué encuentra el motor y qué se arreglaría solo.
 *   6. Los logs: dónde están y cuándo se escribieron por última vez.
 *
 * Uso:
 *   npm run doctor
 *
 * Código de salida: 1 si la app no responde o hay algún hallazgo crítico, 0 si
 * todo está en orden. Así sirve también dentro de un script.
 */
const path = require('path');
const { getTestUserId } = require('./testUser.js');
const fs = require('fs');
const { compilaTs, projectRoot } = require('./lib/compilaTs');

const SERVER_URL = process.env.APP_URL || 'http://127.0.0.1:3000';
const LOG_DIR = path.join(projectRoot, 'data', 'logs');

function section(title) {
  console.log('');
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}`);
}

function line(label, value) {
  console.log(`   ${label.padEnd(26)} ${value}`);
}

/** Las claves que existen en `.env`, por nombre: nunca su valor. */
function envKeys() {
  const file = path.join(projectRoot, '.env');
  if (!fs.existsSync(file)) return null;
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((row) => row.trim())
    .filter((row) => row && !row.startsWith('#') && row.includes('='))
    .map((row) => row.split('=')[0].trim());
}

function lastWrite(file) {
  try {
    const stat = fs.statSync(file);
    const minutes = Math.round((Date.now() - stat.mtimeMs) / 60000);
    return `${new Date(stat.mtimeMs).toISOString().replace('T', ' ').slice(0, 19)} (hace ${minutes} min) · ${Math.round(stat.size / 1024)} KB`;
  } catch {
    return 'no existe todavía';
  }
}

(async () => {
  console.log('');
  console.log('  BrainUp Academy · diagnóstico del sistema');
  console.log('  ════════════════════════════════════════');

  let critical = 0;
  let appDown = false;

  /* 1. Entorno ---------------------------------------------------- */
  section('Entorno');
  line('Node', process.version);
  line('Proyecto', projectRoot);
  const keys = envKeys();
  line('.env', keys ? `${keys.length} clave(s): ${keys.join(', ')}` : 'no hay fichero .env');

  /* 2 y 5. El motor, compilado igual que lo usa la app ------------- */
  let vigilante;
  let maintenance;
  let maintenanceScan;
  let maintenanceData;
  let prismaModule;

  try {
    const outDir = compilaTs('vigilante.ts', '.tmp-doctor');
    vigilante = require(path.join(outDir, 'vigilante.js'));
    maintenance = require(path.join(outDir, 'maintenance.js'));
    maintenanceScan = require(path.join(outDir, 'maintenanceScan.js'));
    maintenanceData = require(path.join(outDir, 'maintenanceData.js'));
    prismaModule = require(path.join(outDir, 'prisma.js'));
  } catch (error) {
    console.log('');
    console.log('  ✗ El código no compila, así que no se puede diagnosticar nada más.');
    console.log(`    ${error.message}`);
    process.exit(1);
  }

  /* 2. La app ----------------------------------------------------- */
  section('La app');
  const health = await vigilante.checkHealth(SERVER_URL);
  if (health.reachable) {
    line('Estado', health.ok ? '✓ responde y su base está bien' : '✗ responde con problemas');
    line('Respuesta', `${health.responseMs} ms`);
    line('Detalle', health.detail);
  } else {
    appDown = true;
    line('Estado', '✗ no responde (esto es el ERR_FAILED del navegador)');
    line('Detalle', health.detail);
    line('Qué hacer', 'npm run sirve   (lo levanta y lo deja vigilado)');
  }

  /* 3. La base ---------------------------------------------------- */
  section('La base de datos');
  const prisma = prismaModule.prisma;
  try {
    const [subjects, topics, notes, exams, challenges, issues, reviews] = await Promise.all([
      prisma.subject.count(),
      prisma.topic.count(),
      prisma.note.count(),
      prisma.exam.count(),
      prisma.weeklyChallenge.count(),
      prisma.systemIssue.count({ where: { status: { not: 'resuelto' } } }),
      prisma.srsReview.count(),
    ]);
    line('Materias', String(subjects));
    line('Unidades', String(topics));
    line('Apuntes', String(notes));
    line('Exámenes', String(exams));
    line('Retos semanales', String(challenges));
    line('Repasos registrados', String(reviews));
    line('Incidencias abiertas', String(issues));
  } catch (error) {
    critical += 1;
    line('✗ Error', error instanceof Error ? error.message : String(error));
  }

  /* 4. La IA ------------------------------------------------------ */
  section('El motor de IA');
  const capacity = await vigilante.aiCapacity();
  const providers = health.aiProviders.length > 0 ? health.aiProviders.join(', ') : 'ninguno detectado desde la app';
  line('Proveedores', providers);
  line('Modelos libres', String(capacity.available));
  line('En enfriamiento', String(capacity.coolingDown));

  /* 5. El mantenimiento (en seco: no toca nada) ------------------- */
  section('Mantenimiento (solo mirar)');
  const report = await vigilante.runVigilanteCycle({ serverUrl: SERVER_URL, dry: true });

  line('Hallazgos', String(report.findingsAfter.length));
  line('Incidencias nuevas', String(report.issues.opened.length));
  line('Incidencias que se cerrarían', String(report.issues.resolved.length));
  line('Motor de IA', report.ai.configured ? 'configurado' : 'sin claves (el taller funciona igual)');

  // Los arreglos incluyen los de funcionamiento (reiniciar la app si está en
  // bucle de caídas): el doctor tiene que ver lo mismo que el taller y el vigilante.
  const fixes = maintenanceScan.allFixes(await maintenanceData.loadMaintenanceInput(await getTestUserId()));
  if (fixes.length > 0) {
    line('Arreglos disponibles', String(fixes.length));
    for (const fix of fixes) {
      console.log(`     ${fix.safe ? '✓ se arregla solo ' : '· para revisar    '} ${fix.label} (${fix.count})`);
    }
  } else {
    line('Arreglos disponibles', 'ninguno: no hay nada roto');
  }

  if (report.findingsAfter.length > 0) {
    console.log('');
    console.log('   Hallazgos, uno a uno:');
    for (const finding of report.findingsAfter) {
      const mark = finding.severity === 'critico' ? '✗' : finding.severity === 'aviso' ? '!' : 'i';
      console.log(`     ${mark} [${finding.severity}] ${finding.title} (×${finding.count})`);
      console.log(`        ${finding.detail.slice(0, 150)}`);
      if (finding.samples.length > 0) console.log(`        ejemplos: ${finding.samples.join(' · ')}`);
      if (finding.severity === 'critico') critical += 1;
    }
  }

  await prisma.$disconnect().catch(() => {});

  /* 6. Los logs --------------------------------------------------- */
  section('Logs');
  for (const name of ['servidor.log', 'vigilante.log', 'sirve.pid', 'vigilante.pid', 'vigilante-ultimo.json']) {
    line(name, lastWrite(path.join(LOG_DIR, name)));
  }

  /* Veredicto ----------------------------------------------------- */
  section('Veredicto');
  if (appDown) {
    console.log('   La app no está en pie: ese es el problema que tienes delante.');
    console.log('   Levántala con `npm run sirve` (y déjala vigilada para que no vuelva a caerse).');
  } else if (critical > 0) {
    console.log(`   La app funciona, pero hay ${critical} cosa(s) que revisar.`);
    console.log('   Mira el taller en /mantenimiento: dice qué pasa y qué se arregla solo.');
  } else {
    console.log('   Todo en orden: la app responde y el mantenimiento no encuentra nada roto.');
  }
  console.log('');

  process.exit(appDown || critical > 0 ? 1 : 0);
})();
