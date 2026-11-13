/**
 * Cron local de los avisos Web Push.
 *
 *   npm run push:cron              → cada minuto hasta Ctrl+C
 *   npm run push:cron -- --once    → una pasada (para probar)
 *   npm run push:cron -- --every=30000
 *
 * El envío real lo hace la app (`/api/push/send-due`) porque allí están Prisma
 * y las claves VAPID; este proceso solo es el reloj. Sin `PUSH_CRON_SECRET` no
 * arranca.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const EVERY_ARG = args.find((arg) => arg.startsWith('--every='));
const EVERY_MS = Number(EVERY_ARG ? EVERY_ARG.split('=')[1] : 60_000) || 60_000;

function loadEnv() {
  try {
    const text = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=("?)(.*)\2$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[3];
    }
  } catch {
    // Sin .env se usan las variables del entorno.
  }
}

loadEnv();

const BASE = (process.env.APP_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const SECRET = (process.env.PUSH_CRON_SECRET || '').trim();

if (!SECRET) {
  console.error('Falta PUSH_CRON_SECRET. Añádelo a .env o al entorno.');
  process.exit(1);
}

let failures = 0;

async function tick() {
  try {
    const response = await fetch(`${BASE}/api/push/send-due`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (data.sent > 0 || data.errors > 0 || failures > 0) {
      const stamp = new Date().toISOString().slice(11, 19);
      console.log(
        `[${stamp}] avisos: enviados=${data.sent ?? 0} omitidos=${data.skipped ?? 0} errores=${data.errors ?? 0}`
      );
    }
    failures = 0;
  } catch (error) {
    failures += 1;
    // No se llena el diario: se avisa la primera vez y cada diez fallos.
    if (failures === 1 || failures % 10 === 0) {
      console.error(`[push-cron] ${error.message}`);
    }
  }
}

async function main() {
  if (ONCE) {
    await tick();
    return;
  }
  console.log(`Cron de avisos cada ${Math.round(EVERY_MS / 1000)} s contra ${BASE}`);
  await tick();
  setInterval(tick, EVERY_MS);
}

main();
