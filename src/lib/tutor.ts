/**
 * BrainUp Tutor IA — Pedagogía socrática server-side.
 *
 * Este módulo se ocupa del *prompt* y del *parseo*. El transporte (claves,
 * catálogo real de modelos, selección automática del mejor modelo gratuito y
 * respaldo entre proveedores) vive en `aiEngine.ts`.
 *
 * Usa la API de Interactions de Gemini en modo sin estado (`store: false`):
 * el historial vive en nuestra base de datos local (AiMessage.rawStepsJson)
 * y se reenvía en cada turno, manteniendo la filosofía Local-First.
 */

import {
  runAiText,
  TutorError,
  type AiAttachmentPart,
  type AiProvider,
  type AiTextResult,
  type ChatMessage,
} from './aiEngine';
import { buildStudentLevelLines, LEVEL_TAG_INSTRUCTION, parseLevelTag } from './knowledge';
import {
  NOTE_PROPOSAL_TAG_INSTRUCTION,
  parseNoteProposal,
  stripHiddenTags,
  type NoteProposal,
} from './apuntesIa';
import type { SharedNote } from './tutorNotes';

export {
  getConfiguredModelLabel,
  getGeminiKey,
  getGroqKey,
  hasAiProvider,
  hasAiProviderAsync,
  getEngineStatus,
  extractTutorText,
  runAiText,
  TUTOR_MAX_HISTORY_MESSAGES,
  TutorError,
} from './aiEngine';

export type { NoteProposal } from './apuntesIa';

export type {
  AiAttachmentPart,
  AiProvider,
  AiTextResult,
  ChatMessage,
  EngineStatus,
  EngineModelStatus,
  EngineProviderStatus,
  ModelCandidate,
  SelectionTrace,
} from './aiEngine';

export const TUTOR_STAGES = [
  'diagnostico',
  'pista_1',
  'pista_2',
  'verificacion',
  'resolucion',
  'explicacion_directa',
] as const;

export type TutorStage = (typeof TUTOR_STAGES)[number];

export interface TutorAgentInfo {
  name: string;
  specialty: string;
  systemPrompt: string;
  subject: {
    name: string;
    currentGrade: number;
    /** "sin_medir" | "declarada" | "simulacro": si nadie la ha declarado, no se cita. */
    gradeSource: string;
    targetGrade: number;
  };
}

export interface TutorContext {
  studentName: string;
  modality: string;
  /**
   * Unidades con nivel MEDIDO de verdad (autoevaluación, diagnóstico, sesión o
   * simulacro). El catedrático solo puede hablar de estas: el resto no se sabe.
   */
  measuredTopics: Array<{
    title: string;
    masteryLevel: number;
    unitNumber: number | null;
    source: string;
  }>;
  /** Unidades de la materia que nadie ha medido todavía. */
  unmeasuredCount: number;
  /**
   * El temario completo de la materia, con la numeración real. Sin esto el
   * catedrático no sabe qué número es cada unidad y acaba proponiendo los
   * apuntes de la unidad que está dando en clase cuando le piden otra cosa
   * («le pido orgánica y me escribe trabajo mecánico»: U9 y U16 de Física y
   * Química). Es opcional para no romper a quien arme el contexto sin temario.
   */
  syllabus?: Array<{ unitNumber: number | null; title: string }>;
  /** Unidad que está dando en clase según su temario (dato real, no medición). */
  courseUnit: { title: string; unitNumber: number | null; status: string } | null;
  upcomingExams: Array<{ title: string; examDate: Date; examType: string }>;
  pendingErrors: number;
  /**
   * Extracto de los apuntes que el alumno ha escrito de esta materia. Vacío si
   * no ha compartido sus apuntes o si todavía no ha escrito ninguno.
   */
  notes: SharedNote[];
  /** ¿Ha pulsado «compartir mis apuntes» en esta consulta? */
  notesShared: boolean;
  /** Cuántos apuntes tiene en total de esta materia (aunque solo entren 6). */
  notesTotal: number;
  /**
   * Lo que ya hablaste con él los días anteriores en esta materia (lo escribe
   * `agentMemory.ts`). Cadena vacía el primer día. Se le da como algo que **ya
   * sabe**: lo que tiene que hacer es no volver a preguntarlo.
   */
  memory?: string;
  /**
   * El texto de los documentos que ha subido en este turno, ya troceado y
   * buscado por relevancia (lo arma `docContext.ts`). Un libro entero no cabe en
   * una petición, así que aquí llega el mapa del documento y los extractos que
   * le tocan a la pregunta, con su página, y la instrucción de pedir más si le
   * hace falta. Cadena vacía si el turno no llevaba documentos.
   */
  documents?: string;
}

/* ------------------------------------------------------------------ */
/* Prompt de sistema                                                   */
/* ------------------------------------------------------------------ */

/** Cuántas unidades del temario caben en el prompt sin inflarlo. */
const MAX_SYLLABUS_LINES = 24;

function daysUntil(date: Date): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/**
 * Construye el prompt de sistema: identidad del catedrático + contexto real
 * del alumno + protocolo socrático obligatorio con etiqueta de etapa.
 */
export function buildTutorSystemPrompt(agent: TutorAgentInfo, ctx: TutorContext): string {
  const lines: string[] = [];

  lines.push(`Eres ${agent.name}, ${agent.specialty}.`);
  lines.push(agent.systemPrompt.trim());
  lines.push('');
  lines.push(
    `Alumno: ${ctx.studentName}, ${ctx.modality}, preparando la PAU en España.`
  );
  lines.push(`Asignatura: ${agent.subject.name}.`);

  // Expediente honesto: solo entra lo medido; lo demás se declara desconocido.
  lines.push(
    ...buildStudentLevelLines({
      subjectName: agent.subject.name,
      grade: {
        currentGrade: agent.subject.currentGrade,
        gradeSource: agent.subject.gradeSource,
      },
      targetGrade: agent.subject.targetGrade,
      measuredTopics: ctx.measuredTopics,
      unmeasuredCount: ctx.unmeasuredCount,
      courseUnit: ctx.courseUnit,
    })
  );

  if (ctx.upcomingExams.length > 0) {
    lines.push(
      'Próximos exámenes: ' +
        ctx.upcomingExams
          .map((e) => `${e.title} (${e.examType}) en ${daysUntil(e.examDate)} días`)
          .join('; ') +
        '.'
    );
  }

  if (ctx.pendingErrors > 0) {
    lines.push(`Tiene ${ctx.pendingErrors} errores pendientes en el banco de errores de esta materia.`);
  }

  // Apuntes del alumno: lo que ha escrito ÉL. Es contexto, no verdad revelada.
  if (!ctx.notesShared) {
    lines.push(
      'APUNTES DEL ALUMNO: no te ha dado acceso a sus apuntes en esta consulta, así que no los conoces. Si te vendría bien saber qué tiene escrito, pídeselo (puede activar «compartir mis apuntes» en el chat) en lugar de suponerlo.'
    );
  } else if (ctx.notes.length === 0) {
    lines.push(
      'APUNTES DEL ALUMNO: te ha dado acceso a su cuaderno, pero todavía no tiene ningún apunte escrito de esta materia. No menciones apuntes que no existen: si hace falta, proponle escribir uno de la unidad que está dando.'
    );
  } else {
    lines.push(
      `APUNTES DEL ALUMNO (los ha escrito él; tiene ${ctx.notesTotal} apunte(s) de esta materia y estos son los que te corresponden ahora mismo):`
    );
    for (const note of ctx.notes) {
      lines.push(`- «${note.title}»${note.topicLabel ? ` [${note.topicLabel}]` : ''}: ${note.excerpt}`);
    }
    lines.push(
      'Cómo usarlos: son SU material, no un examen. Apóyate en ellos cuando pregunten por algo que ya tiene escrito y cítalos («en tus apuntes de esa unidad pones…»); si algo no está en sus apuntes ni en su temario, no lo des por escrito y pregúntale. Nunca contradigas sus apuntes sin avisar: si ves un error en lo que ha escrito, señálalo y hazle razonar por qué.'
    );
  }
  // Memoria entre días: lo hablado con él en esta materia los días anteriores.
  // Va aquí, con el resto del contexto real, y no al final del prompt: después
  // mandan las instrucciones de formato y el modelo se queda con lo último.
  if (typeof ctx.memory === 'string' && ctx.memory.trim().length > 0) {
    lines.push('');
    lines.push(ctx.memory.trim());
  }

  // Los documentos que el alumno acaba de darle (un tema, un libro, sus apuntes
  // escaneados). Va con el contexto real, antes del protocolo: es material de
  // estudio, no una instrucción, y el bloque ya dice cómo citarlo y cómo pedir
  // las páginas que falten.
  if (typeof ctx.documents === 'string' && ctx.documents.trim().length > 0) {
    lines.push('');
    lines.push(ctx.documents.trim());
  }

  lines.push('');
  lines.push('');
  lines.push('PROTOCOLO DUAL: SOCRÁTICO PERO OBEDIENTE (Obligatorio - Principio 2):');
  lines.push(
    'A) MODO SOCRÁTICO (por defecto cuando plantea una duda o ejercicio):\n' +
    '   1. Diagnóstico: haz una pregunta breve para localizar el punto exacto donde se atasca. No asumas el fallo.\n' +
    '   2. Pistas escalonadas: no des la solución completa de entrada; da la pista mínima necesaria para que razone.\n' +
    '   3. Verificación: pide al alumno que ejecute el paso y corrige guiando.\n' +
    '   4. Resolución: cuando llegue por sí mismo, consolida regla general, error típico y comprobación.'
  );
  lines.push(
    'B) MODO OBEDIENTE (OBLIGATORIO ANTE PETICIONES DIRECTAS):\n' +
    '   Si el alumno pide explícitamente: "explícamelo sin preguntas", "no me preguntes", "explícame este concepto", "hazme un resumen", "dame un ejemplo resuelto paso a paso", "corrige este ejercicio", "dame la solución" o "dime la fórmula":\n' +
    '   ¡DEBES OBEDECER SIN RESISTIRTE NI HACERLE PREGUNTAS DE VUELTA!\n' +
    '   Usa la etiqueta [[etapa:explicacion_directa]] y entrega al instante la explicación con la ESTRUCTURA DE ÉLITE de abajo: secciones 1-3 limpias y completas, y la 4 como comprobación opcional («si quieres comprobarlo…»), sin esperar su respuesta. Nada de rodeos ni de devolverle la pregunta.'
  );
  lines.push('');
  lines.push(
    'REGLA DE LAS FUENTES (Principio 1): NUNCA inventes contenidos, definiciones, ejemplos, fórmulas, fechas, autores o métodos fuera del temario oficial o de los materiales y notas del profesor. Si un documento, apunte o PDF está delante, CITA de dónde sale cada idea («pág. 12 de <documento>», «<título del apunte>»); una explicación sin la cita de la fuente no se da por buena. Si un dato no está en los apuntes, el temario o los documentos, dilo explícitamente («esto no lo tengo en tus materiales») y pídele el documento o los apuntes antes de asumirlo.'
  );
  lines.push('');
  lines.push('ESTRUCTURA DE ÉLITE (obligatoria siempre que expliques, resumas, corrijas o redactes apuntes):');
  lines.push(
    'Sigue este orden, sin saltarte ninguna sección:\n' +
    '1. **Enfoque del profesor** — cómo se ha explicado esto en SU clase y qué exige su profesor: notación, pasos, convenios y criterios de corrección (usa la metodología que él te haya contado; si no la tienes, dilo y pregúntale en lugar de suponerla).\n' +
    '2. **Desarrollo desde las fuentes** — solo con su temario, sus apuntes o los documentos que te ha dado. Cada idea que venga de un documento lleva su cita (documento y página). Lo que no esté en las fuentes no se completa de memoria: se marca como «falta en tus materiales» y se le pide el documento.\n' +
    '3. **Analogía de retención** — una analogía corta, cotidiana y FIEL al concepto (que aclare, no que confunda), pensada para que lo recuerde en el examen.\n' +
    '4. **Comprobación socrática** — dos o tres preguntas breves al final para que sea él quien demuestre que lo ha entendido.'
  );
  lines.push(
    'En modo socrático, esta estructura se despliega a medida que avanza el diálogo (no sueltas las cuatro secciones de golpe): primero el enfoque del profesor y una pregunta, y el desarrollo se construye con sus respuestas. En modo obediente se entregan las secciones de una vez, limpias y completas.'
  );
  lines.push('');
  lines.push(
    'Estilo: responde en español, tutea, riguroso pero motivador, frases claras. Si pide una explicación profunda o resumen, dale formato limpio de cuaderno: negritas, listas con "- ", citas con "> " para reglas clave y fórmulas en LaTeX entre $...$ (display: $$...$$).'
  );
  lines.push(
    'Instrucción especial: en asignaturas de idiomas, explica y dialoga en español, pero ejemplos, gramática y redacciones en el idioma de la materia.'
  );
  lines.push('');
  lines.push(
    'FORMATO OBLIGATORIO: comienza SIEMPRE tu respuesta con una única etiqueta de etapa en su propia línea, exactamente con uno de estos formatos:'
  );
  lines.push(
    '[[etapa:diagnostico]] | [[etapa:pista_1]] | [[etapa:pista_2]] | [[etapa:verificacion]] | [[etapa:resolucion]] | [[etapa:explicacion_directa]]'
  );
  lines.push('Después de la etiqueta, escribe tu mensaje al alumno. Nada más.');
  lines.push('');
  lines.push(
    'NUNCA inventes su nivel ni sus notas. Si no hay medición de una unidad, no la des por sabida ni por floja: pregúntale.'
  );
  lines.push(
    'CORRECCIONES DEL ALUMNO: cuando te corrija un dato que él mismo te dio antes (una nota, una unidad, una fecha, una definición de su profesor), la versión buena es la SUYA. Aplícala y sigue desde ahí; no vuelvas a la anterior, no se la discutas y no le pidas que repita la corrección. Si te pide «explícamelo sin preguntas», obedece y explica.'
  );
  lines.push(LEVEL_TAG_INSTRUCTION);
  lines.push('');

  // El temario con su numeración real. Va justo antes de la propuesta de
  // apuntes porque es lo que necesita para poner el número correcto: el título
  // de la unidad lo escribe él, pero el número solo lo acierta si lo tiene
  // delante (si no, usa el de la unidad que está dando en clase).
  const syllabus = ctx.syllabus ?? [];
  if (syllabus.length > 0) {
    lines.push(`TEMARIO DE ${agent.subject.name.toUpperCase()} (numeración real de su curso):`);
    for (const unit of syllabus.slice(0, MAX_SYLLABUS_LINES)) {
      lines.push(`- U${unit.unitNumber ?? '?'} · ${unit.title}`);
    }
    if (syllabus.length > MAX_SYLLABUS_LINES) {
      lines.push(`- … y ${syllabus.length - MAX_SYLLABUS_LINES} unidades más de la materia.`);
    }
    lines.push(
      'Cuando nombres una unidad en una etiqueta o en una propuesta de apuntes, usa el número de ESTA lista y comprueba que el título es el de esa unidad. El número de la unidad que está dando en clase no sirve para otra: si te pide otra cosa, búscala aquí.'
    );
    lines.push('');
  }

  lines.push(NOTE_PROPOSAL_TAG_INSTRUCTION);

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Parseo de respuestas                                                */
/* ------------------------------------------------------------------ */

/**
 * Separa la etiqueta [[etapa:...]] del texto visible del mensaje.
 */
export function parseTutorReply(raw: string): { text: string; stage: TutorStage | null } {
  const match = raw.match(
    /^\s*\[\[\s*etapa\s*:\s*(diagnostico|pista_1|pista_2|verificacion|resolucion|explicacion_directa)\s*\]\]\s*/i
  );

  if (!match) {
    return { text: raw.trim(), stage: null };
  }

  return {
    text: raw.slice(match[0].length).trim(),
    stage: match[1].toLowerCase() as TutorStage,
  };
}

/** Lo que devuelve un turno ya parseado: texto visible + lo que la app anota. */
export interface TutorReply {
  text: string;
  stage: TutorStage | null;
  level: { unitNumber: number; mastery: number } | null;
  proposal: NoteProposal | null;
  steps: unknown[];
  model: string;
  provider: AiProvider;
}

/**
 * Convierte la respuesta cruda del motor en el turno del catedrático: quita las
 * tres etiquetas internas (etapa, nivel medido y propuesta de apuntes), se queda
 * con el texto visible y devuelve lo anotado aparte.
 */
export function parseTutorResult(result: AiTextResult): TutorReply {
  const measured = parseLevelTag(result.text);
  const proposed = parseNoteProposal(measured.text);
  const { text: withoutLevel, stage } = parseTutorReply(proposed.text);
  const visibleText = stripHiddenTags(withoutLevel);

  // Un catedrático que contesta **solo** con las etiquetas internas deja el chat
  // con un recuadro de respuesta vacío: es el fallo que reportó el alumno («le he
  // preguntado una cosa y me ha devuelto un recuadro sin nada escrito»). Antes se
  // guardaba y se pintaba tal cual; ahora se trata como lo que es, una respuesta
  // que no sirve, y se le pide al alumno que lo repita en vez de dejarlo mirando
  // una caja vacía.
  if (visibleText.length === 0) {
    throw new TutorError(
      'El catedrático ha contestado en blanco. Repite la pregunta (o reformúlala) y esta vez sí responderá.',
      502,
      `Respuesta sin texto visible tras quitar las etiquetas internas: ${result.text.slice(0, 200)}`
    );
  }

  return {
    text: visibleText,
    stage,
    level: measured.level,
    proposal: proposed.proposal,
    steps: result.steps,
    model: result.model,
    provider: result.provider,
  };
}
