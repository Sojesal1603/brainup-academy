import { answerSystemQuestion } from './systemKnowledge';
import type { SetupChecklist, SetupSnapshot } from './setup';

/**
 * El coordinador cuando no hay IA.
 *
 * Las claves gratuitas se saturan (y a veces la red falla). Antes, eso dejaba la
 * puesta a punto con un «error» y el alumno sin poder montar su curso: justo lo
 * que no puede pasar en la pantalla con la que se empieza. Ahora, si ningún
 * modelo responde, contesta este módulo.
 *
 * Y contesta de verdad, con dos capacidades:
 *
 *   - **Preguntas sobre la app**: usa el conocimiento que BrainUp tiene de sí
 *     misma (`systemKnowledge.ts`), así que puede explicar el temario, el SRS,
 *     los retos o Moodle sin inventarse nada.
 *   - **La entrevista**: sigue el mismo guion que la IA (el checklist que ve el
 *     alumno en el panel), así que la conversación no se atasca ni repite
 *     preguntas.
 *
 * Lo que **no** puede hacer es interpretar lenguaje natural para anotar datos:
 * eso es del modelo. Y lo dice, en vez de fingir que lo ha guardado.
 *
 * Módulo puro (sin Prisma ni red).
 */

export const LOCAL_MODE_PROVIDER = 'local';

/**
 * Aviso de modo local. Va en el propio texto (una línea) para que se vea sin
 * depender del cliente, y desaparece solo en cuanto un proveedor responde.
 */
export const LOCAL_MODE_NOTICE =
  '⚠️ **Sin IA ahora mismo**: los modelos gratuitos están saturados, así que te contesto en modo local.';

/**
 * La marca que comparten TODAS las respuestas de respaldo (coordinador y
 * catedráticos): el texto del aviso, no el proveedor.
 */
const LOCAL_NOTICE_MARKER = 'Sin IA ahora mismo';

/**
 * ¿Este mensaje del chat lo escribió el respaldo local (no el modelo)?
 *
 * Importa porque esos turnos se guardan como mensajes del asistente igual que
 * los demás, y al reenviar el historial el modelo los IMITA: acabó contestando
 * «⚠️ Sin IA ahora mismo…» con Groq funcionando y `degraded: false`. El alumno
 * veía «sin IA» teniendo IA, y sin una sola etiqueta (no guardaba nada).
 */
export function isLocalModeReply(content: string): boolean {
  return String(content ?? '').includes(LOCAL_NOTICE_MARKER);
}

/**
 * Quita el aviso de modo local de una respuesta del modelo.
 *
 * Red de seguridad para conversaciones ya contaminadas: si el modelo copia el
 * aviso, no se le enseña al alumno una mentira («no hay IA» con el proveedor
 * contestando).
 */
export function stripLocalModeNotice(text: string): string {
  const value = String(text ?? '');
  if (!value.includes(LOCAL_NOTICE_MARKER)) return value.trim();
  return value
    .split('\n')
    .filter((line) => !line.includes(LOCAL_NOTICE_MARKER))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** «la unidad 4», «los exámenes», «cuántas horas»… */
function nextStepHint(checklist: SetupChecklist): string | null {
  const next = checklist.nextQuestion;

  if (next.about === 'temario') {
    return null; // el propio prompt del checklist ya explica cómo dictar las unidades
  }
  if (next.about === 'examenes') {
    return 'Dime la fecha con el día exacto (por ejemplo «el 14 de noviembre») y, cuando volvamos a tener IA, la anoto tal cual.';
  }
  if (next.about === 'horas') {
    return 'Con las horas reales que puedas dedicar, el planificador calcula sola la semana.';
  }
  return null;
}

/** Cierre cuando ya no falta nada por preguntar. */
function closingText(snapshot: SetupSnapshot, checklist: SetupChecklist): string {
  return [
    `Ya está todo lo que necesito para montar tu curso, ${snapshot.studentName.split(' ')[0]}: ${checklist.doneItems} de ${checklist.totalItems} datos puestos.`,
    '',
    'Puedes seguir contándome cosas cuando quieras (corregir una unidad, añadir un examen, cambiar tus horas) y lo vamos ajustando. Mientras tanto, en /temario puedes pegar tu índice a mano y en /ajustes declarar tus notas reales.',
  ].join('\n');
}

/**
 * Respuesta local, lista para guardar y mostrar. Siempre devuelve texto: no hay
 * caso en el que esto falle.
 */
export function buildLocalSetupReply(input: {
  snapshot: SetupSnapshot;
  checklist: SetupChecklist;
  message: string;
}): string {
  const { snapshot, checklist, message } = input;
  const first = snapshot.studentName.split(' ')[0];
  const body: string[] = [];

  // Se intenta SIEMPRE (no solo cuando lleva «?»): «no me sale el temario» es una
  // pregunta del sistema aunque no lleve interrogante, y la función no devuelve
  // nada si no encuentra nada que encaje.
  const faq = answerSystemQuestion(message);

  if (faq) {
    body.push(faq);

    // Si la pregunta era sobre la app, se retoma la entrevista donde estaba.
    if (!checklist.complete) {
      body.push('');
      body.push(`Y sigamos con lo tuyo: ${checklist.nextQuestion.prompt}`);
      const hint = nextStepHint(checklist);
      if (hint) body.push(hint);
    }
    return [LOCAL_MODE_NOTICE, '', ...body].join('\n');
  }

  if (checklist.complete) {
    return [LOCAL_MODE_NOTICE, '', closingText(snapshot, checklist)].join('\n');
  }

  // No era una pregunta sobre la app: seguimos la entrevista desde donde toca.
  body.push(`Gracias, ${first}. Te lo dejo pendiente de anotar.`);
  body.push('');
  body.push(checklist.nextQuestion.prompt);

  const hint = nextStepHint(checklist);
  if (hint) body.push(hint);

  body.push('');
  body.push(
    'En modo local no puedo interpretar y guardar lo que me dictes (eso lo hace el modelo). Si quieres adelantarlo tú: el temario se pega en **/temario**, las fechas de examen y las notas en **/ajustes**, y las horas también en **/ajustes**.'
  );

  return [LOCAL_MODE_NOTICE, '', ...body].join('\n');
}
