/**
 * El catedrático cuando no hay ninguna IA disponible.
 *
 * El chat del catedrático era el único sitio de la app que se quedaba en un
 * error cuando Gemini, Groq, OpenRouter y el modelo local fallaban a la vez (un
 * día de cupo gastado, o los tres proveedores saturados). La puesta a punto ya
 * tenía su respuesta local; esto es lo mismo para el chat, con una diferencia:
 * aquí **no se puede inventar una explicación**. Un catedrático que se inventa
 * la física es peor que uno que dice «ahora no puedo».
 *
 * Lo que sí puede hacer sin modelo es lo que ya sabe de su curso: qué examen
 * tiene cerca, qué unidad está floja, cuántas quedan sin medir y cuántos errores
 * tiene sin dominar. Con eso se le da un plan de acción real para esos minutos,
 * y se le dice con claridad que la explicación llegará cuando vuelva la IA.
 *
 * Módulo puro: sin base de datos ni red.
 */

export const LOCAL_TUTOR_PROVIDER = 'local';

export interface LocalTutorInput {
  agentName: string;
  subjectName: string;
  studentName: string;
  /** Lo que ha preguntado, tal cual. */
  message: string;
  /** Unidad medida más floja, si la hay. */
  weakTopic: { title: string; masteryLevel: number } | null;
  /** Próximo examen, si lo hay. */
  nextExam: { title: string; days: number } | null;
  /** Unidades del temario que nadie ha medido todavía. */
  unmeasuredCount: number;
  /** Errores de dominio sin dominar en esta materia. */
  pendingErrors: number;
  /** Unidad que se está dando en clase ahora. */
  courseUnit: string | null;
  /** Apuntes del alumno en esta materia (títulos). */
  noteTitles: string[];
}

/** «1 día» / «3 días». */
function daysLabel(days: number): string {
  if (days <= 0) return 'hoy';
  if (days === 1) return 'mañana';
  return `en ${days} días`;
}

/**
 * Construye la respuesta. Es deliberadamente corta: no pretende dar clase, sino
 * dejar al alumno con algo útil que hacer y con la verdad por delante.
 */
export function buildLocalTutorReply(input: LocalTutorInput): string {
  const first = (input.studentName || 'Estudiante').split(' ')[0];
  const lines: string[] = [];

  lines.push(
    '⚠️ **Sin IA ahora mismo**: los modelos gratuitos están saturados o el cupo del día está gastado. Te contesto con lo que el sistema sí sabe de tu curso; en un par de minutos podrás preguntarme lo que quieras.'
  );
  lines.push('');
  lines.push(`**Dónde estás en ${input.subjectName}**`);

  if (input.nextExam) {
    lines.push(
      `- Examen más próximo: **«${input.nextExam.title}»**, ${daysLabel(input.nextExam.days)}.`
    );
  }
  if (input.weakTopic) {
    lines.push(
      `- Unidad más floja de las medidas: **«${input.weakTopic.title}»** (${input.weakTopic.masteryLevel}%).`
    );
  }
  if (input.courseUnit) {
    lines.push(`- En clase estáis con **«${input.courseUnit}»**.`);
  }
  if (input.unmeasuredCount > 0) {
    lines.push(`- ${input.unmeasuredCount} unidades sin medir todavía (no sé si las llevas bien).`);
  }
  if (input.pendingErrors > 0) {
    lines.push(`- ${input.pendingErrors} errores de dominio sin dominar en el banco.`);
  }
  if (lines[lines.length - 1] === `**Dónde estás en ${input.subjectName}**`) {
    lines.push('- Todavía no hay mediciones ni exámenes apuntados en esta materia.');
  }

  lines.push('');
  lines.push('**Qué puedes hacer en este rato (sin IA)**');

  if (input.courseUnit) {
    lines.push(
      `1. Coge los apuntes de **«${input.courseUnit}»** y explica en voz alta, sin mirar, las tres ideas principales. Lo que no te salga es exactamente lo que hay que repasar.`
    );
  } else if (input.weakTopic) {
    lines.push(
      `1. Vuelve a **«${input.weakTopic.title}»**: haz tres ejercicios seguidos y anota en qué paso te atascas.`
    );
  } else {
    lines.push(
      '1. Elige la unidad que estés dando en clase y haz un resumen de memoria de cinco líneas. Después compáralo con tus apuntes.'
    );
  }

  if (input.pendingErrors > 0) {
    lines.push(
      '2. Abre el **banco de errores** (`/errores`) y rehaz dos de los que siguen sin dominar: es lo que más sube la nota por minuto invertido.'
    );
  } else if (input.noteTitles.length > 0) {
    lines.push(
      `2. Relee **«${input.noteTitles[0]}»** y subraya solo lo que no recordabas: eso es lo que hay que preguntar cuando vuelva la IA.`
    );
  } else {
    lines.push(
      '2. Anota la duda exacta que ibas a preguntarme (con el paso donde te bloqueas). Con eso la respuesta será mucho mejor.'
    );
  }

  lines.push(
    '3. Si la duda es de un ejercicio, déjala escrita tal cual: en cuanto vuelva el catedrático, la atacamos con el método socrático.'
  );

  lines.push('');
  lines.push(
    `No te voy a inventar la explicación, ${first}: cuando vuelva la IA te la doy con el detalle y el rigor que toca. Esto no ha perdido nada de tu curso.`
  );

  return lines.join('\n');
}
