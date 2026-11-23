import type { TenantPrisma } from './db';
import { applyCourseToProfile } from './courseApply';
import { baseSubjectsFor, resolveCourse } from './courseCatalog';
import { normalizeTopicTitle } from './temarioImport';
import type {
  SetupToolImpact,
  SetupToolName,
  SetupToolProposal,
  SetupToolResult,
} from './setupToolTypes';

/**
 * Herramientas del coordinador de puesta a punto.
 *
 * Por qué existe este módulo: el coordinador ya sabía anotar datos (etiquetas
 * `[[unidad:…]]`, `[[clase:…]]`), pero las operaciones que **destruyen** o
 * reescriben el curso entero no tenían canal. El modelo acababa diciendo «he
 * borrado esa materia» sin haber tocado nada, y el alumno se quedaba con la
 * asignatura cruzada y con la sensación de que la app le miente.
 *
 * Reglas que este archivo hace cumplir:
 *
 *   1. **Ninguna herramienta escribe por su cuenta.** `previewSetupTool` valida
 *      y describe el impacto; `executeSetupTool` es la única que escribe y solo
 *      se llama tras una confirmación explícita del alumno.
 *   2. **El `userId` sale de la sesión, nunca del cuerpo de la petición.** El
 *      input que llega del cliente/modelo puede traer `userId`, y se IGNORA.
 *      Todo va por `tenant`, que ya inyecta el dueño en cada `where`.
 *   3. **Se revalida en la ejecución.** Entre la tarjeta y el clic puede pasar
 *      cualquier cosa (otra pestaña, otro dispositivo); la ejecución vuelve a
 *      comprobar que la materia existe y es de esta cuenta. Un `id` de otra
 *      cuenta no se encuentra → P2025, nunca una escritura.
 *   4. **El modelo propone, el alumno decide.** Las tarjetas se pintan con
 *      botones reales; nada se borra con un «sí» dicho en prosa que el modelo
 *      interpreta.
 */

/** Lo que recibe el modelo: catálogo de herramientas en texto (sin API nativa). */
export const SETUP_TOOLS_PROMPT = [
  'HERRAMIENTAS (acciones reales que el alumno confirma con un botón):',
  'No puedes ejecutar estas acciones tú: las PROPONES y el sistema pinta una tarjeta con botones. Emite la etiqueta y, en el texto, di en una frase qué hará la tarjeta y que él tiene que confirmarla. Nunca digas que ya está hecho.',
  '- [[tool:deleteSubject|{"subjectId":"ID"}]] — borrar una materia entera (sus unidades, exámenes, clases y su catedrático). Úsala solo si pide borrar una materia concreta, o si confirma la que tú has propuesto. Si no tienes el id, usa {"subjectName":"Nombre exacto"}.',
  '- [[tool:purgeOrphanSubjects|{}]] — limpiar de una vez las materias que le sobran: las que no son de su curso y no tienen ni una unidad, ni un examen, ni una clase, ni un error. Úsala cuando diga «quítame las asignaturas que no son mías» o «limpia las que sobran».',
  '- [[tool:updateStudentCurriculum|{"course":"2º de Bachillerato","subjects":["Matemáticas II","Física"]}]] — cambiar el curso y fijar su lista de materias. Crea las que falten; NO borra ninguna (para eso está deleteSubject).',
  'Una etiqueta de herramienta por línea, JSON válido y sin comentarios. Si el alumno solo habla de una materia, no propongas purgas masivas.',
].join('\n');

const TOOL_NAMES: readonly SetupToolName[] = [
  'deleteSubject',
  'updateStudentCurriculum',
  'purgeOrphanSubjects',
];

/** Una llamada tal y como la ha emitido el modelo (aún sin validar). */
export interface SetupToolCall {
  tool: SetupToolName;
  input: Record<string, unknown>;
  /** Texto crudo de la etiqueta, por si hay que registrarlo. */
  raw: string;
}

/**
 * Separa las etiquetas de herramienta del texto que ve el alumno.
 *
 * Se acepta `[[tool:nombre|{json}]]`. El JSON no puede contener `]]` fuera de
 * cadenas en un caso real, así que el corte perezoso es suficiente; si el JSON
 * está roto, la llamada se descarta y el texto se queda como está (mejor una
 * frase rara que una tarjeta que borra lo que no debe).
 */
export function parseSetupToolCalls(text: string): { text: string; calls: SetupToolCall[] } {
  const calls: SetupToolCall[] = [];
  const pattern = /\[\[tool:([a-zA-Z]+)\|\s*(\{[\s\S]*?\})\s*\]\]/g;

  const remaining = text.replace(pattern, (raw, name: string, json: string) => {
    if (!TOOL_NAMES.includes(name as SetupToolName)) return '';
    try {
      const parsed: unknown = JSON.parse(json);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
      calls.push({
        tool: name as SetupToolName,
        input: parsed as Record<string, unknown>,
        raw,
      });
      return '';
    } catch {
      return '';
    }
  });

  return { text: remaining.replace(/[ \t]+\n/g, '\n').trim(), calls };
}

/* ------------------------------------------------------------------ */
/* Intención determinista                                             */
/* ------------------------------------------------------------------ */

/**
 * Lo que el alumno ha pedido con sus palabras, sin depender del modelo.
 *
 * El fallo que esto cierra: «borra la materia de Religión» y el coordinador
 * contestando «hecho» sin que nada se borrara. Si el modelo no emite la
 * etiqueta, la tarjeta se propone igual; si la emite, manda la del modelo y
 * esta no duplica. Nunca ejecuta: solo propone.
 */
export function detectToolIntent(
  message: string,
  subjects: ReadonlyArray<{ id: string; name: string }>
): SetupToolCall[] {
  const text = message.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return [];

  const wantsDelete = /\b(borra|borrar|elimina|eliminar|quita|quitar|saca|sacar|suprime|suprimir)\b/i.test(text);
  if (wantsDelete) {
    const normalized = normalizeTopicTitle(text);
    const match = subjects
      .filter((subject) => subject.name.trim().length > 2)
      .map((subject) => ({ subject, key: normalizeTopicTitle(subject.name) }))
      // La materia más larga primero: «Física y Química» antes que «Física».
      .sort((a, b) => b.key.length - a.key.length)
      .find(({ key }) => normalized.includes(key));
    if (match) {
      return [{ tool: 'deleteSubject', input: { subjectId: match.subject.id }, raw: '' }];
    }
  }

  const wantsPurge =
    /\b(limpia|limpiar|purga|purgar)\b/i.test(text) ||
    /\b(sobran|que no son m[ií]as|hu[eé]rfan)/i.test(text);
  if (wantsPurge) {
    return [{ tool: 'purgeOrphanSubjects', input: {}, raw: '' }];
  }

  return [];
}

/* ------------------------------------------------------------------ */
/* Validación de entrada                                               */
/* ------------------------------------------------------------------ */

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `prop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface PreviewOutcome {
  proposal?: SetupToolProposal;
  problem?: string;
  /** Datos ya resueltos que la ejecución reutiliza sin volver a decidir. */
  resolved?: { subjectIds?: string[]; course?: string; subjects?: string[] };
}

const DATA_COUNTS = {
  topics: true,
  exams: true,
  classPeriods: true,
  errorLogs: true,
} as const;

/** Recuento de lo que se lleva por delante borrar una materia. */
function countLabel(counts: { topics: number; exams: number; classPeriods: number; errorLogs: number }): string {
  const parts: string[] = [];
  if (counts.topics > 0) parts.push(`${counts.topics} ${counts.topics === 1 ? 'unidad' : 'unidades'}`);
  if (counts.exams > 0) parts.push(`${counts.exams} ${counts.exams === 1 ? 'examen' : 'exámenes'}`);
  if (counts.classPeriods > 0) parts.push(`${counts.classPeriods} ${counts.classPeriods === 1 ? 'clase' : 'clases'}`);
  if (counts.errorLogs > 0) parts.push(`${counts.errorLogs} ${counts.errorLogs === 1 ? 'error registrado' : 'errores registrados'}`);
  return parts.join(' · ');
}

/**
 * Resuelve una materia **de esta cuenta**. Primero por id; si el modelo solo
 * dio el nombre, por nombre normalizado. Nunca busca sin `userId`: el cliente
 * acotado lo añade, y aquí se vuelve a comprobar el resultado.
 */
async function findOwnedSubject(
  tenant: TenantPrisma,
  userId: string,
  input: Record<string, unknown>
) {
  const id = cleanText(input.subjectId);
  if (id.length > 0) {
    return tenant.subject.findFirst({
      where: { id, userId },
      select: {
        id: true,
        name: true,
        _count: { select: DATA_COUNTS },
      },
    });
  }

  const name = cleanText(input.subjectName);
  if (name.length === 0) return null;
  const key = normalizeTopicTitle(name);
  const subjects = await tenant.subject.findMany({
    where: { userId },
    select: { id: true, name: true, _count: { select: DATA_COUNTS } },
  });
  return subjects.find((subject) => normalizeTopicTitle(subject.name) === key) ?? null;
}

/* ------------------------------------------------------------------ */
/* Previsualización (sin escribir)                                     */
/* ------------------------------------------------------------------ */

/**
 * Valida una llamada y devuelve la tarjeta que verá el alumno.
 *
 * No escribe NADA: ni siquiera un contador. La ejecución vuelve a pasar por
 * aquí, así que la tarjeta y lo que se aplica no pueden divergir por un `id`
 * manipulado entre medias.
 */
export async function previewSetupTool(
  tenant: TenantPrisma,
  userId: string,
  call: SetupToolCall
): Promise<PreviewOutcome> {
  const input = asRecord(call.input);

  if (call.tool === 'deleteSubject') {
    const subject = await findOwnedSubject(tenant, userId, input);
    if (!subject) {
      return {
        problem:
          'Esa materia no está en tu cuenta (o ya no existe). No he borrado nada: dime el nombre exacto tal y como aparece en tu lista.',
      };
    }

    const impact: SetupToolImpact[] = [
      { label: `Se borra la materia «${subject.name}»`, detail: 'y su catedrático IA' },
    ];
    const counts = countLabel(subject._count);
    if (counts.length > 0) {
      impact.push({ label: 'También se borran sus datos', detail: counts });
    } else {
      impact.push({ label: 'No tiene datos asociados', detail: 'solo la materia y su catedrático' });
    }

    return {
      resolved: { subjectIds: [subject.id] },
      proposal: {
        id: randomId(),
        tool: 'deleteSubject',
        // Se devuelve el id resuelto, no el que llegó: la tarjeta se ejecuta
        // contra la materia que se ha validado, no contra un nombre ambiguo.
        input: { subjectId: subject.id },
        title: `Borrar «${subject.name}»`,
        description:
          counts.length > 0
            ? `Esto borra la materia y todo lo que cuelga de ella: ${counts}.`
            : 'La materia no tiene unidades, exámenes ni clases: solo se borra la ficha y su catedrático.',
        confirmLabel: 'Borrar materia',
        destructive: true,
        impact,
        warnings: [
          'No se puede deshacer desde el chat.',
          'Si tiene unidades, se pierden: no están en la copia de la puesta a punto.',
        ],
      },
    };
  }

  if (call.tool === 'purgeOrphanSubjects') {
    const [profile, subjects] = await Promise.all([
      tenant.userProfile.findFirst({ select: { modality: true } }),
      tenant.subject.findMany({
        select: { id: true, name: true, _count: { select: DATA_COUNTS } },
      }),
    ]);

    const course = resolveCourse(profile?.modality);
    const catalog = new Set(baseSubjectsFor(course).map((base) => normalizeTopicTitle(base.name)));

    /**
     * «Huérfana» = no está en el catálogo del curso Y no tiene ni un dato. Es
     * deliberadamente conservador: con el catálogo vacío (Bachillerato y
     * Universidad lo tienen vacío porque las materias dependen del centro) no
     * se puede distinguir una materia que sobra de una recién creada, así que
     * no se propone borrar nada. Borrar por parecido sería peor que no borrar.
     */
    const orphans =
      catalog.size === 0
        ? []
        : subjects.filter((subject) => {
            if (catalog.has(normalizeTopicTitle(subject.name))) return false;
            const counts = subject._count;
            return (
              counts.topics === 0 &&
              counts.exams === 0 &&
              counts.classPeriods === 0 &&
              counts.errorLogs === 0
            );
          });

    if (catalog.size === 0) {
      return {
        problem:
          'Con un curso de Bachillerato o Universidad no puedo saber cuáles sobran: las materias dependen de tu centro. Dime los nombres exactos y las borro una a una.',
      };
    }
    if (orphans.length === 0) {
      return {
        problem:
          'No hay materias que sobren: todas las que tienes están en el catálogo de tu curso o tienen datos dentro. Si quieres quitar una concreta, dime cuál.',
      };
    }

    return {
      resolved: { subjectIds: orphans.map((subject) => subject.id) },
      proposal: {
        id: randomId(),
        tool: 'purgeOrphanSubjects',
        input: {},
        title: `Limpiar ${orphans.length} ${orphans.length === 1 ? 'materia que sobra' : 'materias que sobran'}`,
        description: `Estas no son de ${course.label} y no tienen nada dentro: ${orphans
          .map((subject) => subject.name)
          .join(', ')}.`,
        confirmLabel: `Borrar ${orphans.length === 1 ? 'materia' : 'materias'}`,
        destructive: true,
        impact: orphans.map((subject) => ({
          label: `Se borra «${subject.name}»`,
          detail: 'sin unidades, exámenes ni clases',
        })),
        warnings: [
          'Solo se borran materias vacías que no son de tu curso.',
          'Las que tengan cualquier dato dentro se quedan: esas se quitan una a una.',
        ],
      },
    };
  }

  // updateStudentCurriculum
  const courseText = cleanText(input.course);
  if (courseText.length === 0 || courseText.length > 80) {
    return { problem: 'No he entendido el curso. Dímelo tal cual: «2º de Bachillerato», «1º ESO»…' };
  }
  if (!/eso|bachillerato|universidad|grado|pau/i.test(courseText)) {
    return { problem: `«${courseText}» no parece un curso. Dime ESO, Bachillerato o Universidad.` };
  }

  const rawSubjects = Array.isArray(input.subjects) ? input.subjects : [];
  const subjects = Array.from(
    new Set(
      rawSubjects
        .map((value) => cleanText(value))
        .filter((name) => name.length > 0 && name.length <= 80)
    )
  ).slice(0, 30);
  if (subjects.length === 0) {
    return { problem: 'Para cambiar el currículo necesito la lista de materias, aunque sea una.' };
  }

  const course = resolveCourse(courseText);
  const existing = await tenant.subject.findMany({ select: { name: true } });
  const existingKeys = new Set(existing.map((subject) => normalizeTopicTitle(subject.name)));
  const toCreate = subjects.filter((name) => !existingKeys.has(normalizeTopicTitle(name)));
  const bundled = baseSubjectsFor(course)
    .filter((base) => !existingKeys.has(normalizeTopicTitle(base.name)))
    .map((base) => base.name);
  const created = Array.from(new Set([...bundled, ...toCreate]));

  return {
    resolved: { course: courseText, subjects },
    proposal: {
      id: randomId(),
      tool: 'updateStudentCurriculum',
      input: { course: courseText, subjects },
      title: `Aplicar el currículo de ${course.label}`,
      description:
        created.length > 0
          ? `Se guarda el curso y se crean ${created.length} ${created.length === 1 ? 'materia' : 'materias'}: ${created.join(', ')}.`
          : 'Se guarda el curso. No hay materias nuevas que crear: ya estaban todas.',
      confirmLabel: 'Aplicar cambios',
      destructive: false,
      impact: [
        { label: `Curso: ${course.label}`, detail: course.curriculum },
        ...(created.length > 0
          ? [{ label: 'Materias que se crean', detail: created.join(', ') }]
          : [{ label: 'No se crea ninguna materia nueva' }]),
        { label: 'No se borra nada', detail: 'quitar materias es otra acción y también se confirma' },
      ],
      warnings: [],
    },
  };
}

/* ------------------------------------------------------------------ */
/* Ejecución (solo tras confirmación explícita)                        */
/* ------------------------------------------------------------------ */

/**
 * Ejecuta una herramienta. El llamador (la ruta) exige `confirmed === true`.
 *
 * Vuelve a previsualizar para revalidar la propiedad y usa los ids resueltos
 * en esa previsualización: el `input` del cliente no puede colar un id ajeno
 * entre la tarjeta y el clic.
 */
export async function executeSetupTool(
  tenant: TenantPrisma,
  userId: string,
  call: SetupToolCall
): Promise<SetupToolResult> {
  const preview = await previewSetupTool(tenant, userId, call);
  if (!preview.proposal || !preview.resolved) {
    return { ok: false, applied: [], problems: [preview.problem ?? 'No se ha podido validar la acción.'] };
  }

  try {
    if (call.tool === 'deleteSubject') {
      const ids = preview.resolved.subjectIds ?? [];
      if (ids.length === 0) return { ok: false, applied: [], problems: ['No hay ninguna materia que borrar.'] };

      /**
       * `deleteMany` + `userId` en el `where`: aunque el id llegara manipulado,
       * la cuenta se aplica en la misma consulta. Si no coincide, borra 0 filas
       * y se lo decimos en vez de mentir con un «hecho».
       */
      const result = await tenant.subject.deleteMany({ where: { id: { in: ids }, userId } });
      if (result.count === 0) {
        return {
          ok: false,
          applied: [],
          problems: ['Esa materia ya no existe o no es de tu cuenta. No se ha borrado nada.'],
        };
      }
      return { ok: true, applied: [`Materia borrada: ${preview.proposal.title.replace(/^Borrar /, '')}`], problems: [] };
    }

    if (call.tool === 'purgeOrphanSubjects') {
      const ids = preview.resolved.subjectIds ?? [];
      if (ids.length === 0) return { ok: false, applied: [], problems: ['No hay materias que sobren.'] };
      const result = await tenant.subject.deleteMany({ where: { id: { in: ids }, userId } });
      return {
        ok: result.count > 0,
        applied: result.count > 0 ? [`${result.count} ${result.count === 1 ? 'materia borrada' : 'materias borradas'}`] : [],
        problems: result.count > 0 ? [] : ['No se ha borrado ninguna materia: ya no estaban.'],
      };
    }

    // updateStudentCurriculum
    const course = preview.resolved.course ?? '';
    const subjects = preview.resolved.subjects ?? [];
    const applied = await applyCourseToProfile(tenant, userId, course, subjects);
    return {
      ok: true,
      applied: [
        `Curso: ${applied.course.label}`,
        ...(applied.created.length > 0
          ? [`Materias creadas: ${applied.created.join(', ')}`]
          : ['No ha hecho falta crear materias']),
      ],
      problems: [],
    };
  } catch (error) {
    // P2025: la fila desapareció entre la validación y el borrado. No es un
    // fallo del alumno y no se disfraza de éxito.
    if ((error as { code?: string }).code === 'P2025') {
      return { ok: false, applied: [], problems: ['Esa materia ya no existe. No se ha borrado nada.'] };
    }
    throw error;
  }
}
