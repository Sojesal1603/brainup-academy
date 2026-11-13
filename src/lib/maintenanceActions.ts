'use server';

import { revalidatePath } from 'next/cache';
import { currentTenant } from './tenantContext';
import { runAiText, hasAiProvider, TutorError } from './aiEngine';
import { loadMaintenanceInput } from './maintenanceData';
import { applyMaintenanceFixes as runApplyFixes, type ApplyFixesResult } from './maintenanceApply';
import {
  parseAuditReply,
  summarizeFindings,
  type MaintenanceFix,
  type MaintenanceFinding,
} from './maintenance';
import { allFixes, scanAll } from './maintenanceScan';
import { MEMORY_SCOPE_MAINTENANCE, loadMemoryBlock } from './agentMemory';
import {
  triageReportedIssues as runIssueTriage,
  type IssueTriageResult,
} from './issueTriage';

/**
 * El taller: revisar, reparar y anotar fallos.
 *
 * Todo lo que se arregla aquí es **reversible por naturaleza** (renombrar,
 * renumerar, acotar rangos) o está **demostrablemente vacío** (una unidad
 * repetida sin nada colgando). Lo que borraría información de valor no se hace
 * solo: se explica y se deja en manos del alumno.
 */

export interface MaintenanceScanResult {
  success: boolean;
  error?: string;
  scannedAt: string;
  findings: MaintenanceFinding[];
  fixes: MaintenanceFix[];
  summary: ReturnType<typeof summarizeFindings>;
}

export type { ApplyFixesResult };

function revalidateEverything() {
  for (const path of [
    '/mantenimiento',
    '/',
    '/temario',
    '/planificador',
    '/repaso',
    '/retos',
    '/estadisticas',
    '/horario',
    '/examenes',
  ]) {
    revalidatePath(path);
  }
}

/** Ejecuta todas las comprobaciones y devuelve los hallazgos con su plan. */
export async function scanSystem(): Promise<MaintenanceScanResult> {
  const { user } = await currentTenant();
  const scannedAt = new Date().toISOString();

  try {
    const input = await loadMaintenanceInput(user.id);
    const findings = scanAll(input);
    const fixes = allFixes(input);

    return {
      success: true,
      scannedAt,
      findings,
      fixes,
      summary: summarizeFindings(findings),
    };
  } catch (error) {
    console.error('[mantenimiento] error al revisar:', error);
    return {
      success: false,
      error: 'No se ha podido revisar el sistema. Revisa la consola del servidor.',
      scannedAt,
      findings: [],
      fixes: [],
      summary: { critico: 0, aviso: 0, info: 0, total: 0, fixable: 0 },
    };
  }
}

/**
 * Aplica los arreglos pedidos (por su id). Si no se pasa ninguno, aplica todos
 * los que están marcados como seguros: es lo que hace el vigilante sin que nadie
 * se lo diga.
 *
 * La escritura no vive aquí: vive en `maintenanceApply.ts`, para que la página y
 * el vigilante ejecuten exactamente el mismo bucle. Lo único que se añade en esta
 * capa es lo exclusivo de Next: decirle qué vistas han dejado de ser ciertas.
 */
export async function applyMaintenanceFixes(fixIds?: string[]): Promise<ApplyFixesResult> {
  const { user } = await currentTenant();
  const result = await runApplyFixes(user.id, fixIds);
  if (result.success) revalidateEverything();
  return result;
}

/* ------------------------------------------------------------------ */
/* Incidencias: lo que tú cuentas y lo que detecta el vigilante         */
/* ------------------------------------------------------------------ */

export async function reportSystemIssue(input: {
  title: string;
  detail?: string;
  context?: Record<string, unknown>;
  source?: 'alumno' | 'vigilante' | 'ia';
}): Promise<{ success: boolean; error?: string; id?: string }> {
  const title = String(input?.title ?? '').trim().slice(0, 160);
  if (title.length < 3) {
    return { success: false, error: 'Cuéntame algo más: el título necesita al menos 3 caracteres.' };
  }

  try {
    const { tenant: prisma } = await currentTenant();
    const issue = await prisma.systemIssue.create({
      data: {
        title,
        detail: input.detail ? String(input.detail).slice(0, 4000) : null,
        contextJson: input.context ? JSON.stringify(input.context).slice(0, 4000) : null,
        source: input.source ?? 'alumno',
        status: 'abierto',
      },
    });

    console.log(`[mantenimiento] incidencia reportada (${issue.source}): ${title}`);
    revalidatePath('/mantenimiento');
    return { success: true, id: issue.id };
  } catch (error) {
    console.error('[mantenimiento] no se pudo guardar la incidencia:', error);
    return { success: false, error: 'No se ha podido guardar la incidencia.' };
  }
}

export async function updateIssueStatus(input: {
  id: string;
  status: 'abierto' | 'revisado' | 'resuelto';
  resolution?: string;
}): Promise<{ success: boolean; error?: string }> {
  const id = String(input?.id ?? '');
  if (!id) return { success: false, error: 'Falta la incidencia.' };
  if (!['abierto', 'revisado', 'resuelto'].includes(input.status)) {
    return { success: false, error: 'Ese estado no existe.' };
  }

  try {
    const { tenant: prisma } = await currentTenant();
    await prisma.systemIssue.update({
      where: { id },
      data: {
        status: input.status,
        resolution: input.resolution ? String(input.resolution).slice(0, 1000) : undefined,
      },
    });
    revalidatePath('/mantenimiento');
    return { success: true };
  } catch (error) {
    console.error('[mantenimiento] no se pudo actualizar la incidencia:', error);
    return { success: false, error: 'No se ha podido actualizar la incidencia.' };
  }
}

/* ------------------------------------------------------------------ */
/* Los reportes del alumno: los atiende la IA                        */
/* ------------------------------------------------------------------ */

/**
 * Que la IA revise los fallos que has reportado tú.
 *
 * El trabajo vive en `issueTriage.ts` (sin `next/cache`, para que el vigilante
 * pueda usar exactamente el mismo código). Aquí solo se añade lo exclusivo de
 * Next: revalidar la pantalla del taller para que veas el resultado sin recargar.
 */
export async function triageReportedIssues(): Promise<IssueTriageResult> {
  const { user } = await currentTenant();
  const result = await runIssueTriage(user.id);
  if (result.success) revalidatePath('/mantenimiento');
  return result;
}

/* ------------------------------------------------------------------ */
/* La auditoría de IA: ordenar el temario y detectar errores            */
/* ------------------------------------------------------------------ */

export interface SyllabusAuditProposal {
  /** «renombrar», «borrar», «renumerar», «fusionar» o «duda». */
  action: string;
  target: string;
  reason: string;
}

export interface SyllabusAuditResult {
  success: boolean;
  error?: string;
  subjectId?: string;
  subjectName?: string;
  model?: string;
  proposals: SyllabusAuditProposal[];
  /** Los cambios que se pueden aplicar de una vez (solo propuestas accionables). */
  fix: MaintenanceFix | null;
  summary: string;
}

const AUDIT_MAX_TOKENS = 1200;

/**
 * Una IA revisa el temario de una materia y propone cómo ordenarlo y qué está
 * mal. Devuelve **propuestas**, no cambios: lo que se aplica sale por la misma
 * puerta que el resto del taller (un plan de arreglos que se enseña antes).
 */
export async function auditSyllabusWithAi(subjectId: string): Promise<SyllabusAuditResult> {
  const id = String(subjectId ?? '');
  if (!id) return { success: false, error: 'Falta la asignatura.', proposals: [], fix: null, summary: '' };

  if (!hasAiProvider()) {
    return {
      success: false,
      error:
        'La auditoría con IA necesita una clave (GEMINI_API_KEY o GROQ_API_KEY). Las comprobaciones normales del taller funcionan sin ella.',
      proposals: [],
      fix: null,
      summary: '',
    };
  }

  try {
    const { user, tenant: prisma } = await currentTenant();
    const subject = await prisma.subject.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        topics: {
          select: { id: true, title: true, unitNumber: true, term: true, difficulty: true, status: true },
          orderBy: [{ unitNumber: 'asc' }, { title: 'asc' }],
        },
      },
    });

    if (!subject) {
      return { success: false, error: 'Esa asignatura no existe.', proposals: [], fix: null, summary: '' };
    }

    const listing = subject.topics
      .map((topic) => `${topic.unitNumber ?? '?'} | ${topic.title} | ev${topic.term ?? '-'} | dif${topic.difficulty}`)
      .join('\n');

    // La memoria del mantenimiento: qué se revisó los días anteriores y cómo
    // quedó el sistema. Evita proponer otra vez lo que ya se decidió no tocar.
    const memoryBlock = await loadMemoryBlock(user.id, MEMORY_SCOPE_MAINTENANCE);

    const systemInstruction = [
      'Eres el revisor de temarios de una academia de Bachillerato. Recibes la lista de unidades de UNA asignatura tal como la tiene cargada un alumno y tienes que detectar errores y proponer el orden correcto.',
      '',
      'Qué buscas:',
      '- Unidades repetidas (mismo contenido con distinto título).',
      '- Unidades que no pertenecen a esa asignatura o que son claramente otra cosa (material, un examen, un tema de otra materia).',
      '- Numeración incoherente, unidades sin número o títulos cortados/duplicados con prefijos («Tema 3», «Tema 3: …»).',
      '- Huecos evidentes: temario de una materia que va sin las unidades básicas que suelen acompañarla.',
      '',
      'FORMATO DE SALIDA: SOLO líneas con esta forma exacta, una por propuesta, sin texto adicional:',
      'ACCION | TÍTULO EXACTO DE LA UNIDAD | MOTIVO (máximo 120 caracteres)',
      '',
      'Acciones admitidas: renombrar, borrar, renumerar, dudar.',
      '- renombrar | Título exacto actual | Título nuevo propuesto en el motivo («poner: Límites y continuidad»)',
      '- borrar | Título exacto | por qué no debería estar',
      '- renumerar | Título exacto | número que le corresponde',
      '- dudar | Título exacto | qué no está claro',
      '',
      'Si el temario está bien, no escribas nada. NUNCA inventes unidades que no estén en la lista: solo puedes proponer renombrar, borrar, renumerar o dudar sobre las que existen.',
    ].join('\n');

    const auditInstruction =
      memoryBlock.length > 0 ? `${systemInstruction}\n\n${memoryBlock}` : systemInstruction;

    const message = [
      `Asignatura: ${subject.name}`,
      `Unidades (número | título | evaluación | dificultad):`,
      listing.length > 0 ? listing : '(sin unidades cargadas)',
      '',
      'Revisa la lista y responde solo con las líneas ACCION | UNIDAD | MOTIVO.',
    ].join('\n');

    const reply = await runAiText({
      systemInstruction: auditInstruction,
      message,
      maxTokens: AUDIT_MAX_TOKENS,
      // La auditoría del temario es mantenimiento, no una respuesta que alguien
      // esté esperando: con el cupo justo se aparta (y la asignatura se queda
      // como está hasta la próxima ronda).
      priority: 'fondo',
    });

    const proposals = parseAuditReply(reply.text);
    const fix = buildAuditFix(subject.id, subject.name, subject.topics, proposals);

    console.log(
      `[mantenimiento] auditoría de ${subject.name}: ${proposals.length} propuesta(s) con ${reply.provider}/${reply.model}`
    );

    return {
      success: true,
      subjectId: subject.id,
      subjectName: subject.name,
      model: `${reply.provider}/${reply.model}`,
      proposals,
      fix,
      summary:
        proposals.length === 0
          ? `El temario de ${subject.name} está ordenado: no hay nada que corregir.`
          : `${proposals.length} propuesta(s) para ${subject.name}. Revísalas antes de aplicar nada.`,
    };
  } catch (error) {
    if (error instanceof TutorError) {
      console.error('[mantenimiento] auditoría sin IA:', error.status, error.message);
      return { success: false, error: error.message, proposals: [], fix: null, summary: '' };
    }
    console.error('[mantenimiento] error en la auditoría:', error);
    return {
      success: false,
      error: 'La auditoría no ha podido completarse. Revisa la consola del servidor.',
      proposals: [],
      fix: null,
      summary: '',
    };
  }
}

/**
 * De las propuestas, las que se pueden convertir en operaciones concretas:
 * renombrar y renumerar (con el número leído del motivo) y borrar. Las dudas se
 * quedan como información.
 */
function buildAuditFix(
  subjectId: string,
  subjectName: string,
  topics: Array<{ id: string; title: string; unitNumber: number | null }>,
  proposals: SyllabusAuditProposal[]
): MaintenanceFix | null {
  const operations: MaintenanceFix['operations'] = [];
  const byTitle = new Map(
    topics.map((topic) => [topic.title.toLowerCase().trim(), topic] as const)
  );

  for (const proposal of proposals) {
    const topic = byTitle.get(proposal.target.toLowerCase().trim());
    if (!topic) continue;

    if (proposal.action === 'borrar') {
      operations.push({ kind: 'delete_topic', topicId: topic.id });
      continue;
    }

    if (proposal.action === 'renombrar') {
      // El título nuevo va en el motivo, precedido de «poner:».
      const match = proposal.reason.match(/poner\s*:\s*(.+)$/i);
      const newTitle = match ? match[1].trim().replace(/^[«"']|[»"']$/g, '') : '';
      if (newTitle.length > 0 && newTitle.length <= 180) {
        operations.push({ kind: 'rename_topic', topicId: topic.id, title: newTitle });
      }
      continue;
    }

    if (proposal.action === 'renumerar') {
      const match = proposal.reason.match(/(\d{1,3})/);
      if (match) {
        operations.push({
          kind: 'renumber_topic',
          topicId: topic.id,
          unitNumber: Number(match[1]),
        });
      }
    }
  }

  if (operations.length === 0) return null;

  const deletes = operations.filter((operation) => operation.kind === 'delete_topic').length;

  return {
    id: `auditoria_ia_${subjectId}`,
    label: `Aplicar la auditoría de ${subjectName}`,
    description: `Cambia ${operations.length} unidad(es) de ${subjectName} según la revisión (${deletes} borrado(s)). Comprueba antes las propuestas: la IA propone, tú decides.`,
    count: operations.length,
    // Los cambios de la IA nunca son «seguros» por definición: hay que leerlos.
    safe: false,
    operations,
  };
}
