/**
 * Verificación end-to-end de la sincronización con Moodle (enlace iCal) por su
 * interfaz real (HTTP): descarga el feed demo, comprueba que la segunda
 * sincronización no duplica tareas y que el perfil queda restaurado.
 *
 * Requisitos: servidor de desarrollo en http://localhost:3000.
 *
 * Uso:
 *   node scripts/verify-moodle-sync.js            → modo «run» (por defecto)
 *   node scripts/verify-moodle-sync.js cleanup    → borra las tareas demo y restaura el perfil
 *   npm run verify:moodle / npm run verify:moodle -- cleanup
 *
 * El modo «run» deja las tareas demo en la base para que las veas en el Cuartel;
 * cuando termines, lanza «cleanup». La URL y la fecha de sync del perfil se
 * guardan en un temporal antes de tocar nada.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const p = new PrismaClient();
const BASE = 'http://localhost:3000';
const DEMO_URL = `${BASE}/moodle-demo.ics`;
const TMP_FILE = path.join(os.tmpdir(), 'brainup-moodle-profile.json');
const mode = process.argv[2] ?? 'run';

async function post(url) {
  const res = await fetch(`${BASE}/api/moodle/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function run() {
  const profile = await p.userProfile.findUnique({ where: { id: 'user_default' } });
  fs.writeFileSync(
    TMP_FILE,
    JSON.stringify({ moodleFeedUrl: profile.moodleFeedUrl, lastMoodleSync: profile.lastMoodleSync }),
    'utf8'
  );
  console.log('Perfil original guardado en', TMP_FILE);

  const first = await post(DEMO_URL);
  console.log('\n1ª sincronización:', first.status, JSON.stringify(first.data?.stats || first.data));

  const second = await post(DEMO_URL);
  console.log('2ª sincronización:', second.status, JSON.stringify(second.data?.stats || second.data));

  const tasks = await p.moodleTask.findMany({
    where: { externalId: { startsWith: 'demo-' } },
    include: { subject: true },
    orderBy: { dueDate: 'asc' },
  });
  console.log('\nTareas demo en BD:', tasks.length);
  for (const t of tasks) {
    console.log(
      `- ${t.subject ? `[${t.subject.name}]` : `[${t.courseName}]`} ${t.title} · vence ${t.dueDate
        .toISOString()
        .slice(0, 10)} · externalId=${t.externalId}`
    );
  }

  const bad = await post('https://moodle.invalido.example/calendario.ics');
  console.log('\nEnlace inválido →', bad.status, '|', bad.data?.error);

  const profileAfter = await p.userProfile.findUnique({ where: { id: 'user_default' } });
  console.log('\nÚltima sincronización registrada:', profileAfter.lastMoodleSync?.toISOString());
  console.log('\nLas tareas demo siguen en la base para que las veas en el Cuartel.');
  console.log('Para dejarla como estaba: npm run verify:moodle -- cleanup');
}

async function cleanup() {
  const del = await p.moodleTask.deleteMany({ where: { externalId: { startsWith: 'demo-' } } });
  const saved = JSON.parse(fs.readFileSync(TMP_FILE, 'utf8'));
  await p.userProfile.update({
    where: { id: 'user_default' },
    data: { moodleFeedUrl: saved.moodleFeedUrl, lastMoodleSync: saved.lastMoodleSync },
  });
  const total = await p.moodleTask.count();
  console.log(`Limpiadas ${del.count} tareas demo · URL y fecha de sync restauradas · moodleTask total: ${total}`);
}

const actions = { run, cleanup };
const action = actions[mode];
if (!action) {
  console.log('Uso: node scripts/verify-moodle-sync.js [run|cleanup]   (run es el modo por defecto)');
  process.exit(1);
}

action()
  .catch((e) => console.error('FALLO:', e))
  .finally(() => p.$disconnect());
