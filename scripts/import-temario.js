/**
 * Importa un temario a la base local de BrainUp desde un archivo (por asignatura
 * y por unidades, ordenado y con su evaluación).
 *
 * Camino normal: pegar el índice en la app (Temario → «Cargar tu temario»).
 * Este script es para cargas en bloque o para un índice ya guardado en JSON.
 *
 * Uso:
 *   node scripts/import-temario.js                      # data/temario-1bach.json
 *   node scripts/import-temario.js --file "C:\ruta\mi-temario.json"
 *   node scripts/import-temario.js --subject "Matemáticas I"
 *   node scripts/import-temario.js --replace            # sustituye el temario de esa asignatura
 *   node scripts/import-temario.js --dry                # solo enseña lo que haría
 *
 * Formatos de JSON aceptados:
 *   { "asignaturas": { "Matemáticas I": { "origen": "curriculo", "unidades": [ { "title": "...", "term": 1, "difficulty": 4 } ] } } }
 *   { "asignaturas": { "Matemáticas I": [ { "title": "...", "term": 1 } ] } }
 *   { "Matemáticas I": [ "Radicales", "Trigonometría" ] }              // lista simple de títulos
 *
 * Semántica:
 *   - Por defecto (sin --replace) es un MERGE: añade las unidades que faltan por
 *     título y renumera las que sí están. Tus unidades propias se conservan.
 *   - Con --replace, el temario de esa asignatura se sustituye por el del archivo
 *     (se borran sus temas y, en cascada, bloques de estudio y errores asociados).
 *   - SIEMPRE se escribe una copia de seguridad en data/backups/ antes de tocar nada.
 *
 * Las unidades nuevas entran como "pendiente" con dominio 0%, sin fecha de clase.
 * El estado real (en curso / visto) se marca luego donde se da la clase:
 * en el Cuartel (chequeo diario) o en /temario.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const DEFAULT_FILE = path.join(process.cwd(), 'data', 'temario-1bach.json');
const BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');

/** origen del archivo → campo `source` del tema (etiqueta visible en /temario). */
const SOURCE_BY_ORIGIN = {
  curriculo: 'curriculo',
  oficial: 'curriculo',
  profesor: 'profesor',
  libro: 'libro',
  manual: 'manual',
  propuesta: 'ia',
  orientativo: 'ia',
  ia: 'ia',
};

/** Quita acentos y signos para comparar nombres sin sorpresas. */
function normalize(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseArgs(argv) {
  const args = { file: DEFAULT_FILE, subject: null, replace: false, dry: false, create: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' || arg === '-f') args.file = argv[++i];
    else if (arg === '--subject' || arg === '-s') args.subject = argv[++i];
    else if (arg === '--replace') args.replace = true;
    else if (arg === '--dry') args.dry = true;
    else if (arg === '--no-create') args.create = false;
    else if (!arg.startsWith('--') && args.file === DEFAULT_FILE) args.file = arg;
    else throw new Error(`Argumento no reconocido: ${arg}`);
  }
  if (!args.file) throw new Error('Falta la ruta del archivo (--file).');
  return args;
}

/** Lee el JSON y lo normaliza a Map<nombre, { origen, nota, unidades }>. */
function loadFile(file) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `No encuentro el archivo de temario: ${file}\n` +
        'El temario se carga pegándolo en la app (Temario → «Cargar tu temario»). ' +
        'Si lo tienes en un archivo, pásame su ruta con --file.'
    );
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const source = raw.asignaturas ?? raw;

  const asignaturas = new Map();

  for (const [name, value] of Object.entries(source)) {
    if (name === 'curso' || name === 'comunidad' || name === 'fuente' || name === 'actualizado') continue;

    let unidadesRaw = [];
    let origen = 'curriculo';
    let nota = null;

    if (Array.isArray(value)) {
      unidadesRaw = value;
      origen = raw.origen ?? origen;
    } else if (value && typeof value === 'object') {
      unidadesRaw = value.unidades ?? value.temario ?? [];
      origen = value.origen ?? raw.origen ?? origen;
      nota = value.nota ?? null;
    }

    const unidades = unidadesRaw
      .map((unit, index) => {
        if (typeof unit === 'string') {
          return { order: index + 1, title: unit.trim(), term: null, difficulty: 3 };
        }
        if (!unit || typeof unit !== 'object' || !unit.title) return null;
        return {
          order: index + 1,
          title: String(unit.title).trim(),
          term: Number.isInteger(unit.term) ? unit.term : null,
          difficulty: Number.isInteger(unit.difficulty) ? Math.min(5, Math.max(1, unit.difficulty)) : 3,
        };
      })
      .filter(Boolean);

    asignaturas.set(name, { origen, nota, unidades });
  }

  return { meta: { curso: raw.curso ?? null, fuente: raw.fuente ?? null }, asignaturas };
}

/** Devuelve la asignatura de la base que corresponde al nombre del archivo. */
function resolveSubject(subjects, name) {
  const key = normalize(name);
  const exact = subjects.find((s) => normalize(s.name) === key);
  if (exact) return exact;

  const partial = subjects.find((s) => {
    const other = normalize(s.name);
    return other.startsWith(key) || key.startsWith(other);
  });
  return partial ?? null;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** Copia de seguridad de los temas implicados (antes de tocar nada). */
async function writeBackup(subjectNames, mode) {
  const topics = await prisma.topic.findMany({
    where: { subject: { name: { in: subjectNames } } },
    include: { subject: { select: { name: true } } },
    orderBy: [{ subjectId: 'asc' }, { unitNumber: 'asc' }],
  });

  if (topics.length === 0) return null;

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const target = path.join(BACKUP_DIR, `temario-${stamp()}-${mode}.json`);

  const payload = {
    motivo: `Copia previa al import de temario (modo ${mode})`,
    fecha: new Date().toISOString(),
    asignaturas: {},
  };

  for (const topic of topics) {
    const list = payload.asignaturas[topic.subject.name] ?? (payload.asignaturas[topic.subject.name] = []);
    list.push({
      unitNumber: topic.unitNumber,
      term: topic.term,
      title: topic.title,
      status: topic.status,
      source: topic.source,
      difficulty: topic.difficulty,
      masteryLevel: topic.masteryLevel,
      seenInClassAt: topic.seenInClassAt,
    });
  }

  fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
  return path.relative(process.cwd(), target);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { meta, asignaturas } = loadFile(args.file);

  console.log(`Archivo: ${path.relative(process.cwd(), args.file)}`);
  if (meta.curso) console.log(`Curso: ${meta.curso}`);
  if (meta.fuente) console.log(`Fuente: ${meta.fuente}`);
  console.log(`Modo: ${args.replace ? 'SUSTITUIR (--replace)' : 'merge (añade y renumera)'}${args.dry ? ' · SIMULACIÓN (--dry)' : ''}\n`);

  const wanted = [...asignaturas.entries()].filter(
    ([name]) => !args.subject || normalize(name) === normalize(args.subject)
  );
  if (wanted.length === 0) {
    throw new Error(`El archivo no trae ninguna asignatura que coincida con "${args.subject}".`);
  }

  // Solo se hace copia de seguridad de las asignaturas que van a cambiar.
  const existingSubjects = await prisma.subject.findMany({ orderBy: { order: 'asc' } });
  const targets = [];
  const missing = [];

  for (const [name, entry] of wanted) {
    const subject = resolveSubject(existingSubjects, name);
    if (subject) targets.push({ name, entry, subject });
    else missing.push(name);
  }

  if (missing.length > 0) {
    const message = `Asignaturas del archivo que no existen en la base: ${missing.join(', ')}. ` +
      'Añádelas antes (o créalas desde Ajustes) y vuelve a lanzar el import.';
    if (args.create) {
      console.warn(`AVISO · ${message} Se crearán como asignaturas nuevas sin ponderación PAU.`);
      for (const name of missing) {
        if (args.dry) continue;
        const created = await prisma.subject.create({
          data: {
            name,
            color: '#64748b',
            pauWeight: 0,
            isPhaseGeneral: false,
            order: existingSubjects.length + targets.length + 1,
          },
        });
        existingSubjects.push(created);
        targets.push({ name, entry: asignaturas.get(name), subject: created });
      }
    } else {
      console.warn(`AVISO · ${message}`);
    }
  }

  const backup = args.dry ? null : await writeBackup(targets.map((t) => t.subject.name), args.replace ? 'replace' : 'merge');
  if (backup) console.log(`Copia de seguridad: ${backup}\n`);

  const summary = [];

  for (const { name, entry, subject } of targets) {
    const existing = await prisma.topic.findMany({
      where: { subjectId: subject.id },
      orderBy: [{ unitNumber: 'asc' }, { createdAt: 'asc' }],
    });

    const byTitle = new Map(existing.map((topic) => [normalize(topic.title), topic]));
    const source = SOURCE_BY_ORIGIN[entry.origen] ?? 'manual';

    let added = 0;
    let updated = 0;
    let removed = 0;

    if (args.replace && !args.dry) {
      const deleted = await prisma.topic.deleteMany({ where: { subjectId: subject.id } });
      removed = deleted.count;
      byTitle.clear();
    }

    for (const unit of entry.unidades) {
      const data = {
        unitNumber: unit.order,
        term: unit.term,
        difficulty: unit.difficulty,
        source,
      };

      const match = byTitle.get(normalize(unit.title));
      if (match && !args.replace) {
        const changed =
          match.unitNumber !== data.unitNumber ||
          match.term !== data.term ||
          match.difficulty !== data.difficulty ||
          match.source !== data.source;
        if (changed && !args.dry) {
          await prisma.topic.update({ where: { id: match.id }, data });
        }
        if (changed) updated++;
        byTitle.delete(normalize(unit.title));
      } else if (!args.dry) {
        await prisma.topic.create({
          data: {
            ...data,
            subjectId: subject.id,
            title: unit.title,
            masteryLevel: 0,
            completedHours: 0,
            status: 'pendiente',
          },
        });
        added++;
      } else {
        added++;
      }
    }

    // Las unidades que ya tenías y no están en el archivo se conservan al final.
    const leftovers = [...byTitle.values()];
    let cursor = entry.unidades.length;
    for (const topic of leftovers) {
      cursor++;
      if (!args.dry && topic.unitNumber !== cursor) {
        await prisma.topic.update({ where: { id: topic.id }, data: { unitNumber: cursor } });
      }
    }

    const total = await prisma.topic.count({ where: { subjectId: subject.id } });
    summary.push({
      name,
      origin: entry.origen,
      added,
      updated,
      removed,
      kept: leftovers.length,
      total: args.dry ? entry.unidades.length + leftovers.length : total,
    });
  }

  console.log('Resumen por asignatura:');
  for (const row of summary) {
    const parts = [`${row.total} unidades`];
    if (row.added) parts.push(`+${row.added} nuevas`);
    if (row.updated) parts.push(`${row.updated} renumeradas/ajustadas`);
    if (row.removed) parts.push(`-${row.removed} sustituidas`);
    if (row.kept) parts.push(`${row.kept} propias conservadas`);
    console.log(`  ${row.name.padEnd(34)} ${parts.join(' · ')}  [${row.origin}]`);
  }

  const totalTopics = await prisma.topic.count();
  const pending = await prisma.topic.count({ where: { status: 'pendiente' } });
  console.log(`\nTemario total en la base: ${totalTopics} unidades (${pending} pendientes).`);
  console.log('Marca lo que vas dando en clase desde el Cuartel o desde /temario.');
}

main()
  .catch((error) => {
    console.error('FALLO:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
