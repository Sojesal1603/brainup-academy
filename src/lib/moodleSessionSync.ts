/**
 * Sincronizar Moodle **sin clave de Web Services**: entrando como el navegador.
 *
 * Es la vía para los centros que no dejan crear claves al alumnado. Con la
 * dirección del sitio, el usuario y la contraseña:
 *
 *   1. Se abre la sesión (`loginToMoodle`) y se piden los cursos.
 *   2. Se recorre cada curso y se lee su HTML: temas, recursos y tareas.
 *   3. A los recursos que no traen el archivo a la vista (casi todos en Moodle 4)
 *      se les pide su propia página, que es donde está el enlace real al archivo.
 *   4. Se guarda todo con los mismos escritores que usa la vía de la clave, así
 *      que da igual por dónde haya entrado: en la base queda lo mismo.
 *
 * Límites, dichos claros: no se hace un rastreo sin fin. Por curso se piden como
 * mucho `MAX_RESOURCE_PAGES` páginas de recurso, y si una falla se salta y sigue
 * (una carpeta rota no puede tumbar la sincronización entera).
 */

import { db } from './db';
import { MoodleError, matchSubjectForCourse, type MoodleCourseInfo, type MoodleMaterialDraft } from './moodleWs';
import { getMoodleSessionAuth, saveMoodleSessionAuth } from './moodleAuth';
import {
  fetchCoursePage,
  fetchEnrolledCourses,
  fetchMoodlePage,
  loginToMoodle,
  parseCoursePage,
  parseResourcePage,
  type MoodleSession,
} from './moodleSession';
import { storeCourseWithMaterials, storeTasks, type MoodleTaskWrite } from './moodleStore';
import type { MoodleWsSyncStats } from './moodleWsSync';

/** Páginas de recurso que se piden como mucho por curso (para no rastrear sin fin). */
export const MAX_RESOURCE_PAGES = 30;

/** Módulos cuya página puede esconder un archivo o un enlace de verdad. */
const ENRICHABLE_MODULES = new Set([
  'resource',
  'folder',
  'url',
  'file',
  'book',
  'page',
  'imscp',
  'scorm',
]);

/** Sin credenciales de sesión guardadas no se puede sincronizar por esta vía. */
export class MoodleSessionNotConnectedError extends Error {
  constructor() {
    super(
      'Todavía no has conectado tu Moodle con usuario y contraseña. En Ajustes, elige «Usuario y contraseña», pon tus datos y la app entra por ti.'
    );
    this.name = 'MoodleSessionNotConnectedError';
  }
}

export interface MoodleSessionCheck {
  siteName: string;
  userName: string;
  userId: number;
}

/**
 * Comprobación rápida: ¿siguen valiendo la dirección, el usuario y la contraseña?
 * Solo entra y mira quién es. La usa el vigilante para saber si la conexión está
 * viva sin sincronizar todo.
 */
export async function checkMoodleSession(userId: string): Promise<MoodleSessionCheck> {
  const prisma = db(userId);
  const auth = await getMoodleSessionAuth(userId);
  if (!auth) throw new MoodleSessionNotConnectedError();

  const session = await loginToMoodle(auth);

  // Se apunta la comprobación: es un dato, no una promesa.
  await prisma.userProfile.update({
    where: { id: userId },
    data: {
      moodleSessionAt: new Date(),
      moodleTokenState: 'ok',
      moodleCheckedAt: new Date(),
      moodleSiteName: session.siteName,
      ...(session.userId > 0 ? { moodleUserId: session.userId } : {}),
    },
  });

  return { siteName: session.siteName, userName: session.userName, userId: session.userId };
}

/**
 * A los recursos que no enseñan el archivo en la página del curso les pide su
 * propia página. Devuelve la lista de materiales ya con los archivos de verdad.
 */
async function enrichMaterials(
  session: MoodleSession,
  materials: MoodleMaterialDraft[],
  log: (line: string) => void
): Promise<MoodleMaterialDraft[]> {
  const pending = materials.filter(
    (material) =>
      !material.downloadUrl && Boolean(material.webUrl) && ENRICHABLE_MODULES.has(material.moduleType)
  );

  if (pending.length === 0) return materials;

  const toVisit = pending.slice(0, MAX_RESOURCE_PAGES);
  if (pending.length > toVisit.length) {
    log(
      `se han quedado ${pending.length - toVisit.length} recurso(s) sin abrir por el tope de ${MAX_RESOURCE_PAGES} por curso`
    );
  }

  const found = new Map<string, MoodleMaterialDraft[]>();

  for (const material of toVisit) {
    try {
      const html = await fetchMoodlePage(session, material.webUrl!, { maxBytes: 1_500_000 });
      const cmid = Number(material.externalId.split(':')[0]);
      const parsed = parseResourcePage(html, session.baseUrl, {
        cmid: Number.isFinite(cmid) ? cmid : 0,
        modname: material.moduleType,
        sectionName: material.sectionName,
        fallbackName: material.name,
      });
      if (parsed.length > 0) found.set(material.externalId, parsed);
    } catch (error) {
      // Un recurso que falla no puede tumbar la sincronización del curso entero.
      log(
        `no se ha podido abrir «${material.name}»: ${
          error instanceof Error ? error.message.slice(0, 100) : String(error)
        }`
      );
    }
  }

  if (found.size === 0) return materials;

  const out: MoodleMaterialDraft[] = [];
  for (const material of materials) {
    const replacement = found.get(material.externalId);
    if (replacement) out.push(...replacement);
    else out.push(material);
  }
  return out;
}

/**
 * Sincroniza cursos, apuntes y tareas entrando por sesión web, y lo guarda en la
 * base local. Devuelve el mismo resumen que la vía de la clave, para que la app
 * lo pinte igual.
 */
export async function syncMoodleViaSession(
  userId: string,
  options: { log?: (line: string) => void } = {}
): Promise<MoodleWsSyncStats> {
  const prisma = db(userId);
  const log = options.log ?? (() => {});

  const auth = await getMoodleSessionAuth(userId);
  if (!auth) throw new MoodleSessionNotConnectedError();

  const session = await loginToMoodle(auth);

  const courses = await fetchEnrolledCourses(session);
  if (courses.length === 0) {
    throw new MoodleError(
      'He entrado en tu Moodle, pero no he visto ningún curso tuyo con materiales. Si la plataforma tiene los cursos en otra página, dímelo y lo miro.',
      'no_courses'
    );
  }

  const subjects = await prisma.subject.findMany({ select: { id: true, name: true } });
  const perCourse: Array<{ name: string; materials: number; tasks: number }> = [];

  const allTasks: MoodleTaskWrite[] = [];
  let linkedSubjects = 0;

  for (const course of courses) {
    const subjectId = matchSubjectForCourse(`${course.fullName} ${course.shortName}`, subjects);
    if (subjectId) linkedSubjects++;

    let materials: MoodleMaterialDraft[] = [];
    let taskCount = 0;
    let sections = 0;

    try {
      const html = await fetchCoursePage(session, course.moodleId);
      const page = parseCoursePage(html, session.baseUrl);
      sections = page.sections;
      materials = await enrichMaterials(session, page.materials, log);
      taskCount = page.assignments.length;

      for (const assignment of page.assignments) {
        allTasks.push({
          // El `cmid` identifica el módulo dentro del sitio: sirve para no
          // duplicar la misma tarea en cada sincronización.
          externalId: `sesion:cmid:${assignment.cmid}`,
          assignmentId: null,
          title: assignment.title,
          description: assignment.description,
          courseName: course.fullName,
          subjectId,
          dueDate: assignment.dueDate,
          moodleUrl: assignment.url,
          source: 'sesion',
          submitted: assignment.submitted,
          graded: false,
          grade: null,
        });
      }
    } catch (error) {
      log(
        `el curso «${course.fullName}» no se ha podido leer: ${
          error instanceof Error ? error.message.slice(0, 120) : String(error)
        }`
      );
    }

    await storeCourseWithMaterials(userId, { course, subjectId, sections, materials });
    perCourse.push({ name: course.fullName, materials: materials.length, tasks: taskCount });
  }

  const storedTasks = await storeTasks(userId, allTasks);

  // La conexión queda dada por buena: se acaba de entrar de verdad.
  await prisma.userProfile.update({
    where: { id: userId },
    data: {
      moodleSiteName: session.siteName,
      moodleSessionAt: new Date(),
      moodleTokenState: 'ok',
      moodleCheckedAt: new Date(),
      lastMoodleSync: new Date(),
      ...(session.userId > 0 ? { moodleUserId: session.userId } : {}),
    },
  });

  // Se refrescan los datos de la conexión respetando lo que el alumno eligió: si
  // dijo que NO se guardara su contraseña, no se guarda ahora por la puerta de
  // atrás. Solo se actualiza la marca de la última sesión.
  const profile = await prisma.userProfile.findUnique({
    where: { id: userId },
    select: { moodlePasswordSealed: true },
  });

  await saveMoodleSessionAuth(userId, {
    baseUrl: session.baseUrl,
    username: auth.username,
    password: auth.password,
    siteName: session.siteName,
    userId: session.userId,
    seal: Boolean(profile?.moodlePasswordSealed),
  });

  return {
    siteName: session.siteName,
    courses: courses.length,
    materials: await prisma.moodleMaterial.count(),
    tasks: storedTasks.tasks,
    submitted: storedTasks.submitted,
    linkedSubjects,
    adoptedFromCalendar: storedTasks.adopted,
    perCourse,
  };
}

/** Cursos del alumno, entrando por sesión (para diagnósticos y pruebas). */
export async function listMoodleSessionCourses(userId: string): Promise<MoodleCourseInfo[]> {
  const auth = await getMoodleSessionAuth(userId);
  if (!auth) throw new MoodleSessionNotConnectedError();
  const session = await loginToMoodle(auth);
  return fetchEnrolledCourses(session);
}
