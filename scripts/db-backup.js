#!/usr/bin/env node
/**
 * Copia de seguridad de la base de datos del alumno.
 *
 * Por qué existe: el temario, los apuntes y las conversaciones de un curso son
 * trabajo de meses. Un comando de reseteo ejecutado sin querer (o una prueba a
 * medias) se los lleva por delante sin preguntar.
 *
 * En producción la base es PostgreSQL y las copias las gestiona el proveedor
 * (backups automáticos o `pg_dump`): aquí no hay fichero que copiar.
 *
 * En una instalación local con SQLite (`DATABASE_URL="file:…"`) sí se puede
 * sacar una foto coherente con `VACUUM INTO`, aunque la app esté abierta. Si la
 * base no existe todavía, no hay nada que copiar y se dice.
 *
 * Uso:
 *   node scripts/db-backup.js                 → copia ahora mismo
 *   node scripts/db-backup.js --list          → qué copias hay
 *   node scripts/db-backup.js --restore <f>   → deja esa copia como base actual
 *   node scripts/db-backup.js --restore last  → la copia más reciente
 *
 * Restaurar NUNCA borra: la base que había se guarda antes como
 * `db-antes-de-restaurar-<fecha>.db`, por si te has equivocado de copia.
 */

const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

const BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');

/**
 * El fichero de la base SOLO si es SQLite local (`file:…`).
 *
 * En producción la base es PostgreSQL: no hay fichero que copiar. Devolver
 * `null` deja que el seed siga funcionando y que `db:backup` explique que la
 * copia la gestiona el proveedor, en vez de intentar un `VACUUM INTO` imposible.
 */
function databaseFile() {
  const url = process.env.DATABASE_URL || 'file:./dev.db';
  if (!url.startsWith('file:')) return null;
  const raw = url.slice('file:'.length).trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), 'prisma', raw);
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/** Nombre de fichero seguro a partir de un motivo escrito por una persona. */
function slug(reason) {
  return (
    String(reason || 'copia')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'copia'
  );
}

/**
 * Saca una foto coherente de la base y devuelve la ruta del fichero creado.
 * Devuelve `null` cuando no hay base que copiar (instalación nueva).
 */
async function snapshotDatabase(reason = 'copia') {
  const file = databaseFile();
  if (!file) {
    console.log(
      '[copia] La base es PostgreSQL: las copias se hacen en el proveedor (backups automáticos o pg_dump). No hay fichero local que copiar.'
    );
    return null;
  }
  if (!fs.existsSync(file)) return null;

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const target = path.join(BACKUP_DIR, `db-${stamp()}-${slug(reason)}.db`);
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });

  const prisma = new PrismaClient();
  try {
    // VACUUM INTO crea una copia consistente sin necesidad de cerrar la app.
    await prisma.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } catch (error) {
    // Sin SQLite moderno, copia del fichero: mejor una copia imperfecta que nada.
    fs.copyFileSync(file, target);
    console.warn(`[copia] VACUUM INTO no ha funcionado (${error.message}); copia directa del fichero.`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }

  return target;
}

/** Las copias que hay, de la más nueva a la más vieja. */
function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => name.endsWith('.db'))
    .map((name) => {
      const full = path.join(BACKUP_DIR, name);
      const stats = fs.statSync(full);
      return { name, path: full, bytes: stats.size, at: stats.mtime };
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** Deja una copia como base actual, guardando antes la que había. */
function restoreBackup(which) {
  const file = databaseFile();
  if (!file) {
    throw new Error(
      'La base es PostgreSQL: restaura con pg_restore o desde el panel de tu proveedor. Este comando solo restaura copias SQLite locales.'
    );
  }

  let source = which;
  if (!source || source === 'last') {
    const [newest] = listBackups();
    if (!newest) throw new Error('No hay ninguna copia en data/backups.');
    source = newest.path;
  }
  if (!fs.existsSync(source)) throw new Error(`No encuentro la copia «${source}».`);

  if (fs.existsSync(file)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const safety = path.join(BACKUP_DIR, `db-antes-de-restaurar-${stamp()}.db`);
    fs.copyFileSync(file, safety);
    console.log(`[restaurar] La base que había se ha guardado en ${path.relative(process.cwd(), safety)}`);
  }

  fs.copyFileSync(source, file);
  // Los diarios de SQLite de la base vieja ya no valen para la nueva.
  for (const sidecar of ['-wal', '-shm', '-journal']) {
    fs.rmSync(`${file}${sidecar}`, { force: true });
  }

  return { from: source, to: file };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Uso: node scripts/db-backup.js [--list | --restore <fichero|last>] [motivo]');
    return;
  }

  if (args.includes('--list')) {
    const backups = listBackups();
    if (backups.length === 0) {
      console.log('Todavía no hay ninguna copia en data/backups.');
      return;
    }
    for (const backup of backups) {
      console.log(
        ` ${backup.name}  ${(backup.bytes / 1024).toFixed(0)} KB  (${backup.at.toLocaleString('es-ES')})`
      );
    }
    return;
  }

  const restoreIndex = args.indexOf('--restore');
  if (restoreIndex >= 0) {
    const result = restoreBackup(args[restoreIndex + 1]);
    console.log(`[restaurar] Base restaurada desde ${path.relative(process.cwd(), result.from)}`);
    console.log('           Reinicia la app (npm run sirve) para que la lea.');
    return;
  }

  const reason = args.filter((arg) => !arg.startsWith('--')).join(' ') || 'copia';
  const created = await snapshotDatabase(reason);
  if (!created) {
    console.log('[copia] No hay base de datos todavía: no hay nada que copiar.');
    return;
  }
  console.log(`[copia] Guardada en ${path.relative(process.cwd(), created)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[copia]', error.message);
    process.exit(1);
  });
}

module.exports = { snapshotDatabase, listBackups, restoreBackup, databaseFile, BACKUP_DIR };
