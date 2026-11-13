import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { db } from './db';
import { writeTemarioBackup } from './temarioBackup';

/**
 * Reponer el temario que se ha quedado vacío.
 *
 * Por qué existe este módulo: el 16 de octubre el temario de este alumno —111
 * unidades del currículo de la Comunidad de Madrid, más de un curso de trabajo—
 * desapareció de la base sin que nadie se enterara. La app lo detecta todo lo que
 * sabe medir, pero **no tenía ninguna puerta para reponerlo**: las copias estaban
 * en `data/backups/` y no las leía nadie.
 *
 * Aquí están las dos piezas que faltaban:
 *   1. **Leer las copias** que ya se escriben solas (antes de una sustitución de
 *      temario, antes de una importación) y decir qué hay dentro.
 *   2. **Reponer una materia vacía** desde la mejor copia disponible, y si no hay
 *      ninguna, desde el currículo oficial de `data/referencia/`. Solo se toca lo
 *      que está a cero: una materia con unidades no se toca jamás.
 *
 * Y una red más: `snapshotTemarioIfStale()` deja una copia del temario entero una
 * vez al día, así que a partir de ahora siempre hay de dónde volver.
 *
 * Nada de red y nada inventado: lo que se repone sale de un archivo, nunca de la
 * imaginación de un modelo.
 */

const BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');
const REFERENCE_DIR = path.join(process.cwd(), 'data', 'referencia');

/** Copias de temario: las que se escriben solas antes de tocar el temario. */
const TEMARIO_FILE = /^temario-.*\.json$/;

/** Lo que puede decir el campo `source` de una unidad. */
const SOURCES = ['curriculo', 'profesor', 'libro', 'ia', 'manual', 'entrevista', 'orientativo'];

/** Una unidad tal y como viaja en un archivo de copia. */
export interface TemarioUnit {
  unitNumber: number | null;
  title: string;
  term: number | null;
  status: string;
  source: string;
  difficulty: number;
  masteryLevel: number;
  masterySource: string;
}

/** Lo que se enseña de una copia, sin cargarla entera. */
export interface TemarioBackupFile {
  file: string;
  at: string;
  subjects: string[];
  units: number;
}

export interface TemarioRestoreResult {
  restored: Array<{ subject: string; units: number; from: string }>;
  problems: string[];
  safety: string[];
}

/* ------------------------------------------------------------------ */
/* Nombres y valores                                                   */
/* ------------------------------------------------------------------ */

/** Quita acentos y signos para comparar nombres de materias sin sorpresas. */
function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Una unidad limpia, con los valores por defecto de un temario sin medir. */
function toUnit(raw: unknown, order: number): TemarioUnit | null {
  if (typeof raw === 'string') {
    const title = raw.trim();
    if (title.length < 2) return null;
    return {
      unitNumber: order,
      title: title.slice(0, 200),
      term: null,
      status: 'pendiente',
      source: 'manual',
      difficulty: 3,
      masteryLevel: 0,
      masterySource: 'sin_medir',
    };
  }

  if (!raw || typeof raw !== 'object') return null;
  const unit = raw as Record<string, unknown>;
  const title = String(unit.title ?? unit.titulo ?? '').trim();
  if (title.length < 2) return null;

  const term = Number(unit.term);
  const difficulty = Number(unit.difficulty);
  const source = String(unit.source ?? 'manual').toLowerCase();

  return {
    unitNumber: Number.isInteger(unit.unitNumber) ? Number(unit.unitNumber) : order,
    title: title.slice(0, 200),
    term: Number.isInteger(term) && term >= 1 && term <= 3 ? term : null,
    status: 'pendiente',
    source: SOURCES.includes(source) ? source : 'manual',
    difficulty: Number.isFinite(difficulty) && difficulty >= 1 && difficulty <= 5 ? Math.round(difficulty) : 3,
    // El nivel nunca viene de una copia: apuntar un temario no es saberlo.
    masteryLevel: 0,
    masterySource: 'sin_medir',
  };
}

/**
 * Lee un archivo de temario y devuelve `Map<materia, unidades>`.
 *
 * Hay cuatro formatos vivos en el proyecto y todos tienen que entrar: los tres
 * que escriben los scripts del propio sistema (materia suelta, mapa de materias y
 * mapa de materias dentro de `unidades`) y el currículo de `data/referencia/`
 * (materia → { origen, unidades }). Un archivo que no se entienda se ignora sin
 * ruido: no se puede reponer con algo que no se ha leído bien.
 */
export function parseTemarioFile(text: string): Map<string, TemarioUnit[]> {
  const out = new Map<string, TemarioUnit[]>();

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return out;
  }

  const add = (subjectName: string, list: unknown): void => {
    const name = String(subjectName ?? '').trim();
    if (name.length < 2 || !Array.isArray(list)) return;
    const units = list
      .map((unit, index) => toUnit(unit, index + 1))
      .filter((unit): unit is TemarioUnit => unit !== null);
    if (units.length === 0) return;

    // Si el mismo nombre aparece dos veces, se queda el que trae más unidades.
    const key = normalize(name);
    const already = [...out.keys()].find((existing) => normalize(existing) === key);
    if (already) {
      if ((out.get(already)?.length ?? 0) < units.length) out.set(already, units);
      return;
    }
    out.set(name, units);
  };

  // Formato 1: una materia suelta — { asignatura, unidades: [ … ] }.
  if (typeof raw.asignatura === 'string' && Array.isArray(raw.unidades)) {
    add(raw.asignatura, raw.unidades);
  }

  // Formato 4: mapa de materias dentro de `unidades` — { unidades: { 'Matemáticas I': [ … ] } }.
  if (raw.unidades && typeof raw.unidades === 'object' && !Array.isArray(raw.unidades)) {
    for (const [name, list] of Object.entries(raw.unidades as Record<string, unknown>)) {
      add(name, list);
    }
  }

  // Formato 2 y 3: — { asignaturas: { 'Matemáticas I': [ … ] } } y
  // { asignaturas: { 'Matemáticas I': { origen, unidades: [ … ] } } }.
  if (raw.asignaturas && typeof raw.asignaturas === 'object' && !Array.isArray(raw.asignaturas)) {
    for (const [name, value] of Object.entries(raw.asignaturas as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        add(name, value);
        continue;
      }
      if (value && typeof value === 'object') {
        const entry = value as Record<string, unknown>;
        add(name, entry.unidades ?? entry.temario ?? null);
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Las copias que hay en disco                                         */
/* ------------------------------------------------------------------ */

/** Lee un archivo de texto sin reventar si no se puede. */
function readTextSafe(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Los nombres de un directorio, o lista vacía si no existe. */
function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Fecha de la copia: la que dice dentro y, si no, la del propio archivo. */
function dateOf(raw: Record<string, unknown>, file: string): string {
  const inside = raw.fecha ?? raw.actualizado;
  if (typeof inside === 'string' && inside.length >= 10) return inside;
  const stamp = file.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (stamp) return `${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}Z`;
  return '';
}

interface LoadedBackup {
  file: string;
  at: string;
  subjects: Map<string, TemarioUnit[]>;
}

/**
 * Carga las copias de temario del proyecto. Es sincrono a proposito: el listado
 * se usa tambien desde sitios que no pueden esperar (el taller y las pruebas), y
 * son unos pocos kilobytes de JSON.
 */
function loadBackups(): LoadedBackup[] {
  const files = readDirSafe(BACKUP_DIR)
    .filter((name) => TEMARIO_FILE.test(name))
    .sort();
  const loaded: LoadedBackup[] = [];

  for (const name of files) {
    const text = readTextSafe(path.join(BACKUP_DIR, name));
    if (!text) continue;
    const subjects = parseTemarioFile(text);
    if (subjects.size === 0) continue;
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      raw = {};
    }
    loaded.push({ file: `data/backups/${name}`, at: dateOf(raw, name), subjects });
  }

  // Más reciente primero: la copia de hace un rato describe mejor su curso que
  // la de hace un mes.
  return loaded.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** Las copias de temario que hay, de la más reciente a la más antigua. */
export function listTemarioBackups(): TemarioBackupFile[] {
  return loadBackups().map((backup) => ({
    file: backup.file,
    at: backup.at,
    subjects: [...backup.subjects.keys()],
    units: [...backup.subjects.values()].reduce((total, units) => total + units.length, 0),
  }));
}

/** El currículo de referencia: existe aunque no haya ninguna copia. */
function loadReference(): LoadedBackup[] {
  const files = readDirSafe(REFERENCE_DIR).filter((name) => name.endsWith('.json'));
  const loaded: LoadedBackup[] = [];

  for (const name of files) {
    const text = readTextSafe(path.join(REFERENCE_DIR, name));
    if (!text) continue;
    const subjects = parseTemarioFile(text);
    if (subjects.size === 0) continue;
    loaded.push({ file: `data/referencia/${name}`, at: '0000-00-00T00:00:00Z', subjects });
  }

  return loaded;
}

/** Busca la materia en una copia por nombre normalizado. */
function findSubject(backup: LoadedBackup, subjectName: string): TemarioUnit[] | null {
  const key = normalize(subjectName);
  const exact = [...backup.subjects.entries()].find(([name]) => normalize(name) === key);
  if (exact) return exact[1];
  const partial = [...backup.subjects.entries()].find(([name]) => {
    const other = normalize(name);
    return other.startsWith(key) || key.startsWith(other);
  });
  return partial ? partial[1] : null;
}

/* ------------------------------------------------------------------ */
/* La copia automática (una al día)                                    */
/* ------------------------------------------------------------------ */

/**
 * Escribe una copia del temario ENTERO si la última tiene más de `hours` horas.
 *
 * Es la red que faltaba: hasta ahora solo se copiaba el temario justo antes de
 * sustituirlo o importarlo, así que lo que se perdía por cualquier otra vía no
 * tenía vuelta. Se llama desde la ronda del vigilante y no cuesta ni una llamada
 * de IA: son unos kilobytes de JSON.
 */
export async function snapshotTemarioIfStale(userId: string, hours = 20): Promise<string | null> {
  const prisma = db(userId);
  const files = readDirSafe(BACKUP_DIR).filter((name) => TEMARIO_FILE.test(name));
  const newest = files
    .map((name) => {
      const text = readTextSafe(path.join(BACKUP_DIR, name));
      if (!text) return '';
      try {
        return dateOf(JSON.parse(text) as Record<string, unknown>, name);
      } catch {
        return '';
      }
    })
    .filter((at) => at.length > 0)
    .sort()
    .pop();

  if (newest) {
    const ageMs = Date.now() - new Date(newest).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < hours * 3600 * 1000) return null;
  }

  const subjects = await prisma.subject.findMany({
    orderBy: [{ order: 'asc' }, { name: 'asc' }],
    include: { topics: { orderBy: [{ unitNumber: 'asc' }] } },
  });

  const unidades: Record<string, unknown[]> = {};
  let total = 0;
  for (const subject of subjects) {
    if (subject.topics.length === 0) continue;
    unidades[subject.name] = subject.topics.map((topic) => ({
      unitNumber: topic.unitNumber,
      title: topic.title,
      term: topic.term,
      status: topic.status,
      source: topic.source,
      difficulty: topic.difficulty,
      masteryLevel: topic.masteryLevel,
      masterySource: topic.masterySource,
      seenInClassAt: topic.seenInClassAt,
    }));
    total += subject.topics.length;
  }

  // Sin temario no hay nada que copiar: una copia vacía no sirve de red y solo
  // ensuciaría la lista de copias.
  if (total === 0) return null;

  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `temario-auto-${stamp}.json`;
  await writeFile(
    path.join(BACKUP_DIR, name),
    JSON.stringify(
      {
        motivo: 'Copia automática del temario (una al día)',
        fecha: new Date().toISOString(),
        unidades,
      },
      null,
      2
    ),
    'utf8'
  );

  return `data/backups/${name}`;
}

/* ------------------------------------------------------------------ */
/* La reposición                                                       */
/* ------------------------------------------------------------------ */

/**
 * Repone el temario de las materias que se han quedado **sin ninguna unidad**.
 *
 * Nunca toca una materia que tenga unidades, escribe una copia de seguridad
 * antes de escribir nada y, si no puede reponer una materia, lo dice con su
 * motivo en vez de dejarla a medias en silencio.
 */
export async function restoreEmptyTemarios(
  userId: string,
  reason = 'Reposición automática del temario perdido'
): Promise<TemarioRestoreResult> {
  const prisma = db(userId);
  const restored: TemarioRestoreResult['restored'] = [];
  const problems: string[] = [];
  const safety: string[] = [];

  const subjects = await prisma.subject.findMany({
    orderBy: [{ order: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { topics: true } } },
  });

  const empty = subjects.filter((subject) => subject._count.topics === 0);
  if (empty.length === 0) {
    return { restored, problems, safety };
  }

  // Copia de seguridad ANTES de tocar nada: lo que sí tiene temario se guarda por
  // materia (con el mismo formato que usan las demás puertas).
  for (const subject of subjects) {
    if (subject._count.topics === 0) continue;
    const file = await writeTemarioBackup(userId, subject.id, subject.name, reason).catch(() => null);
    if (file) safety.push(file);
  }

  const backups = loadBackups();
  const reference = loadReference();

  for (const subject of empty) {
    // Mejor fuente: la copia más reciente que traiga ESA materia y, si hay varias,
    // la que traiga más unidades (una copia completa es mejor que un resto).
    let best: { from: string; units: TemarioUnit[] } | null = null;
    for (const backup of backups) {
      const units = findSubject(backup, subject.name);
      if (!units || units.length === 0) continue;
      if (!best || units.length > best.units.length) best = { from: backup.file, units };
    }

    if (!best) {
      for (const ref of reference) {
        const units = findSubject(ref, subject.name);
        if (!units || units.length === 0) continue;
        if (!best || units.length > best.units.length) best = { from: ref.file, units };
      }
    }

    if (!best) {
      problems.push(
        `No he podido reponer el temario de ${subject.name}: no hay ninguna copia ni currículo de referencia con esa materia.`
      );
      continue;
    }

    // Numeración correlativa, empezando por la del archivo si la trae.
    const ordered = [...best.units].sort((a, b) => (a.unitNumber ?? 999) - (b.unitNumber ?? 999));
    let created = 0;

    for (let index = 0; index < ordered.length; index++) {
      const unit = ordered[index];
      try {
        await prisma.topic.create({
          data: {
            subjectId: subject.id,
            title: unit.title,
            unitNumber: index + 1,
            term: unit.term,
            status: 'pendiente',
            source: unit.source,
            difficulty: unit.difficulty,
            masteryLevel: 0,
            masterySource: 'sin_medir',
          },
        });
        created++;
      } catch (error) {
        problems.push(
          `Se ha quedado a medias el temario de ${subject.name}: «${unit.title}» no se ha podido escribir (${error instanceof Error ? error.message : String(error)}).`
        );
        break;
      }
    }

    if (created > 0) {
      restored.push({ subject: subject.name, units: created, from: best.from });
    }
  }

  return { restored, problems, safety };
}
