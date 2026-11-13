import { db } from './db';
import { storeCourseWithMaterials, storeTasks } from './moodleStore';
import {
  MoodleError,
  getAssignments,
  getCourseContents,
  getEnrolledCourses,
  getSiteInfo,
  getSubmissions,
  mapAssignments,
  mapCourseMaterials,
  matchSubjectForCourse,
  missingMoodleFunctions,
  normalizeMoodleBaseUrl,
  requestMoodleToken,
  type MoodleSiteInfo,
} from './moodleWs';

/**
 * Conexión real con Moodle (Web Services) y volcado a la base local.
 *
 * Aquí vive todo lo que escribe en SQLite: los cursos (`MoodleCourse`), sus
 * apuntes (`MoodleMaterial`) y las tareas con su estado de entrega
 * (`MoodleTask`). El token solo se usa en memoria, para llamar a Moodle.
 *
 * Nada se inventa: si Moodle no devuelve un archivo, no hay apunte; si no
 * devuelve la fecha de entrega, la tarea queda sin fecha (y así se ve).
 */

export interface MoodleConnection {
  baseUrl: string;
  token: string;
  siteName: string;
  userName: string;
  userId: number;
  connectedAt: Date | null;
}

export interface MoodleWsSyncStats {
  siteName: string;
  courses: number;
  materials: number;
  tasks: number;
  submitted: number;
  linkedSubjects: number;
  adoptedFromCalendar: number;
  perCourse: Array<{ name: string; materials: number; tasks: number }>;
}

export class MoodleNotConnectedError extends Error {
  constructor() {
    super(
      'Todavía no has conectado tu Moodle. En Ajustes, pega la dirección de tu Moodle y tu token de Web Services.'
    );
    this.name = 'MoodleNotConnectedError';
  }
}

/** Devuelve la conexión guardada, o null si nunca se ha conectado. */
export async function getMoodleConnection(userId: string): Promise<MoodleConnection | null> {
  const user = await db(userId).userProfile.findUnique({ where: { id: userId } });
  const baseUrl = (user?.moodleBaseUrl ?? '').trim();
  const token = (user?.moodleToken ?? '').trim();
  if (!baseUrl || !token) return null;

  return {
    baseUrl,
    token,
    siteName: (user?.moodleSiteName ?? 'Moodle').trim(),
    userName: user?.name ?? 'Estudiante',
    userId: user?.moodleUserId ?? 0,
    connectedAt: user?.moodleConnectedAt ?? null,
  };
}

export interface MoodlePublicStatus {
  connected: boolean;
  /** Vía elegida: «token» (clave de Web Services) o «sesion» (usuario y contraseña). */
  authMode: 'token' | 'sesion';
  /** El usuario con el que entra (solo en la vía de sesión). */
  username: string | null;
  /** Hay contraseña guardada, cifrada con la clave de este equipo. */
  passwordSaved: boolean;
  siteName: string | null;
  baseUrl: string | null;
  connectedAt: string | null;
  /** Cuándo se abrió la última sesión web de verdad (solo en la vía de sesión). */
  sessionAt: string | null;
  courses: number;
  materials: number;
  pendingTasks: number;
  /** El token nunca sale de aquí: solo decimos si está puesto. */
  tokenSaved: boolean;
}

/**
 * Estado de la conexión para pintarlo en Ajustes (sin la clave y sin la
 * contraseña). «Conectado» significa cosas distintas según la vía: con clave,
 * que hay clave; por sesión, que hay usuario y contraseña guardada.
 */
export async function getMoodleStatus(userId: string): Promise<MoodlePublicStatus> {
  const prisma = db(userId);
  const [user, courses, materials, pendingTasks] = await Promise.all([
    prisma.userProfile.findUnique({ where: { id: userId } }),
    prisma.moodleCourse.count(),
    prisma.moodleMaterial.count(),
    prisma.moodleTask.count({ where: { isCompleted: false, submitted: { not: true } } }),
  ]);

  const tokenSaved = Boolean((user?.moodleToken ?? '').trim());
  const authMode = user?.moodleAuthMode === 'sesion' ? 'sesion' : 'token';
  const username = (user?.moodleUsername ?? '').trim() || null;
  const passwordSaved = Boolean(user?.moodlePasswordSealed);
  const baseUrl = (user?.moodleBaseUrl ?? '').trim() || null;

  return {
    connected: Boolean(baseUrl) && (authMode === 'sesion' ? Boolean(username && passwordSaved) : tokenSaved),
    authMode,
    username,
    passwordSaved,
    siteName: user?.moodleSiteName ?? null,
    baseUrl,
    connectedAt: user?.moodleConnectedAt ? user.moodleConnectedAt.toISOString() : null,
    sessionAt: user?.moodleSessionAt ? user.moodleSessionAt.toISOString() : null,
    courses,
    materials,
    pendingTasks,
    tokenSaved,
  };
}

/**
 * Conecta con Moodle: valida dirección y token contra el propio sitio y guarda
 * la conexión solo si de verdad funciona y el token trae las funciones que
 * necesitamos. Si algo falla, no se toca nada de lo que ya estaba.
 */
export async function connectMoodle(
  userId: string,
  rawBaseUrl: string,
  rawToken: string
): Promise<MoodleSiteInfo> {
  const baseUrl = normalizeMoodleBaseUrl(rawBaseUrl);
  if (!baseUrl) {
    throw new MoodleError(
      'La dirección de tu Moodle no es válida. Debe ser algo como https://moodle.tuinstituto.es',
      'bad_url'
    );
  }

  const token = String(rawToken ?? '').trim();
  if (token.length < 8) {
    throw new MoodleError(
      'El token no parece un token de Moodle. Cópialo entero desde tu perfil (Preferencias → Seguridad → Claves).',
      'bad_token'
    );
  }

  const site = await getSiteInfo(baseUrl, token);

  const missing = missingMoodleFunctions(site);
  if (missing.length > 0) {
    throw new MoodleError(
      `El token funciona, pero a tu Moodle le faltan servicios web para leer apuntes y tareas (${missing.join(
        ', '
      )}). Pide a tu centro que habilite los Servicios web móviles; el resto de BrainUp sigue funcionando sin esto.`,
      'missing_functions'
    );
  }

  await db(userId).userProfile.update({
    where: { id: userId },
    data: {
      moodleBaseUrl: baseUrl,
      moodleToken: token,
      moodleSiteName: site.siteName,
      moodleUserId: site.userId,
      moodleConnectedAt: new Date(),
    },
  });

  return site;
}

/**
 * Conecta con Moodle por la vía fácil: el alumno escribe su usuario y su
 * contraseña y le pedimos la clave a Moodle (`login/token.php`, igual que la app
 * oficial del móvil). A partir de ahí todo es idéntico a la conexión por token:
 * se delega en `connectMoodle` para que la validación, la comprobación de las
 * funciones necesarias y el guardado ocurran en un solo sitio.
 *
 * La contraseña no se guarda en ningún momento: solo viaja en esa petición.
 */
export async function connectMoodleWithPassword(
  userId: string,
  rawBaseUrl: string,
  username: string,
  password: string
): Promise<MoodleSiteInfo> {
  const { token } = await requestMoodleToken(rawBaseUrl, username, password);
  return connectMoodle(userId, rawBaseUrl, token);
}

/**
 * Desconecta Moodle.
 *
 * Se borra **todo** lo que permitía entrar solo: la clave de Web Services y, si
 * estaba conectado por sesión, el usuario y la contraseña cifrada (esa es la que
 * de verdad hay que quitar cuando alguien pulsa «desconectar»). Lo que ya está
 * descargado —cursos, apuntes y tareas— no se toca: es del alumno.
 */
export async function disconnectMoodle(userId: string): Promise<void> {
  await db(userId).userProfile.update({
    where: { id: userId },
    data: {
      moodleBaseUrl: null,
      moodleToken: null,
      moodleAuthMode: 'token',
      moodleUsername: null,
      moodlePasswordSealed: null,
      moodleSessionAt: null,
      moodleSiteName: null,
      moodleUserId: null,
      moodleConnectedAt: null,
      moodleTokenState: 'sin_comprobar',
      moodleCheckedAt: null,
    },
  });
}

/** Nombre de archivo seguro para la copia local de un apunte. */
export function safeLocalFileName(name: string): string {
  const clean = String(name ?? 'apunte')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 0 ? clean.slice(0, 120) : 'apunte';
}

/**
 * Sincroniza cursos, apuntes y tareas del alumno desde Moodle y lo vuelca en la
 * base local. Devuelve un resumen honesto de lo que ha entrado.
 */
export async function syncMoodleWebServices(userId: string): Promise<MoodleWsSyncStats> {
  const prisma = db(userId);
  const connection = await getMoodleConnection(userId);
  if (!connection) throw new MoodleNotConnectedError();

  const { baseUrl, token } = connection;

  const site = await getSiteInfo(baseUrl, token);
  const moodleUserId = site.userId || connection.userId;
  if (!moodleUserId) throw new MoodleError('Moodle no ha dicho qué usuario eres: no puedo pedir tus cursos.', 'no_user');

  const courses = await getEnrolledCourses(baseUrl, token, moodleUserId);
  const subjects = await prisma.subject.findMany({ select: { id: true, name: true } });

  const courseIds = courses.map((course) => course.moodleId);
  const [contentsByCourse, assignmentCourses] = await Promise.all([
    getCourseContents(baseUrl, token, courseIds),
    getAssignments(baseUrl, token, courseIds),
  ]);

  const assignmentIds = assignmentCourses.flatMap((course) =>
    (course.assignments ?? []).map((assignment) => assignment.id ?? 0).filter(Boolean)
  );
  const submissions = await getSubmissions(baseUrl, token, assignmentIds);

  // Los ids de curso de Moodle se traducen a filas locales, para poder colgar
  // los apuntes de su curso y emparejar cada curso con una asignatura.
  const localCourseByMoodleId = new Map<number, { id: string; name: string; subjectId: string | null }>();
  let linkedSubjects = 0;

  for (const course of courses) {
    const subjectId = matchSubjectForCourse(`${course.fullName} ${course.shortName}`, subjects);
    const sections = contentsByCourse.get(course.moodleId) ?? [];

    // El guardado lo hace el escritor compartido: por aquí entran igual los
    // materiales que vengan de Web Services y los que vengan de la sesión web.
    const stored = await storeCourseWithMaterials(userId, {
      course,
      subjectId,
      sections: sections.length,
      materials: mapCourseMaterials(sections),
    });

    if (subjectId) linkedSubjects++;

    localCourseByMoodleId.set(course.moodleId, {
      id: stored.id,
      name: course.fullName,
      subjectId,
    });
  }

  const drafts = mapAssignments(assignmentCourses, submissions, moodleUserId, baseUrl);
  const perCourse = new Map<number, { name: string; materials: number; tasks: number }>();

  for (const course of courses) {
    perCourse.set(course.moodleId, {
      name: course.fullName,
      materials: (contentsByCourse.get(course.moodleId) ?? []).length,
      tasks: 0,
    });
  }

  // Guardado sin duplicados (y adoptando lo que ya entró por el calendario).
  const stored = await storeTasks(
    userId,
    drafts.map((draft) => ({
      externalId: null,
      assignmentId: draft.assignmentId,
      title: draft.title,
      description: draft.description,
      courseName: draft.courseName,
      subjectId: localCourseByMoodleId.get(draft.courseMoodleId)?.subjectId ?? null,
      dueDate: draft.dueDate,
      moodleUrl: draft.webUrl,
      source: 'web_services',
      submitted: draft.submitted,
      graded: draft.graded,
      grade: draft.grade,
    }))
  );

  const tasks = stored.tasks;
  const submitted = stored.submitted;
  const adoptedFromCalendar = stored.adopted;

  for (const draft of drafts) {
    const bucket = perCourse.get(draft.courseMoodleId);
    if (bucket) bucket.tasks++;
  }

  await db(userId).userProfile.update({
    where: { id: userId },
    data: {
      moodleSiteName: site.siteName,
      moodleUserId,
      moodleConnectedAt: connection.connectedAt ?? new Date(),
    },
  });

  return {
    siteName: site.siteName,
    courses: courses.length,
    materials: await prisma.moodleMaterial.count(),
    tasks,
    submitted,
    linkedSubjects,
    adoptedFromCalendar,
    perCourse: [...perCourse.values()],
  };
}
