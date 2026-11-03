/**
 * Apuntes escritos por los catedráticos IA.
 *
 * El catedrático no escribe apuntes por su cuenta: **primero pide permiso**. Este
 * módulo se ocupa de las tres piezas de ese trato:
 *
 *   1. **La propuesta.** El catedrático termina su mensaje con una etiqueta
 *      invisible `[[apunte:U4=Título]]`. Aquí se extrae del texto visible y se
 *      convierte en una propuesta que el alumno puede aceptar o rechazar. Si el
 *      alumno dice que no, no se escribe nada.
 *   2. **El contexto del cuaderno.** Para escribir un apunte que sirva, el
 *      catedrático necesita saber qué unidades hay, qué tiene medido y flojo,
 *      qué exámenes se acercan, **qué apuntes existen ya** (para completar, no
 *      para repetir) y qué material ha subido su profesor a Moodle. Todo eso se
 *      monta aquí, acotado.
 *   3. **El prompt de redacción.** Apuntes para imprimir y estudiar: estructura
 *      fija, fórmulas en LaTeX, ejemplo resuelto, errores típicos y bloques de
 *      Active Recall. Sin relleno.
 *
 * Módulo puro (sin Prisma ni red) para poder probarlo de forma aislada.
 */

export interface NoteProposal {
  /** Unidad del temario a la que pertenece el apunte. */
  unitNumber: number | null;
  /** Título propuesto para el apunte. */
  title: string;
}

/* ------------------------------------------------------------------ */
/* 1. La propuesta: [[apunte:U4=Título]]                                */
/* ------------------------------------------------------------------ */

/**
 * Instrucción que se añade al prompt del catedrático. Deliberadamente
 * restrictiva: un catedrático que propone apuntes en cada mensaje es un
 * catedrático que el alumno deja de leer.
 */
export const NOTE_PROPOSAL_TAG_INSTRUCTION = [
  'PUEDES ESCRIBIRLE APUNTES (solo si aporta de verdad):',
  'En el cuaderno del alumno puedes dejarle un apunte tuyo de una unidad. Para eso hace falta SU PERMISO, así que se pide en dos pasos:',
  '1. Pídeselo en el texto visible, en una sola frase clara (por ejemplo: «¿Te preparo unos apuntes de esta unidad para que los imprimas?»).',
  '2. Si es que sí, cierra el mensaje con una única etiqueta invisible: [[apunte:U<numero>=<Título del apunte>]] (por ejemplo [[apunte:U4=Límites y continuidad]]).',
  'Antes de escribir la etiqueta, mira el TEMARIO que llevas arriba y pon el número de la unidad DE LA QUE HABLAS, no el de la que está dando en clase: si te pide apuntes de otra, búscala en la lista. Si te baila el número, escribe el título de la unidad tal y como aparece en el temario.',
  'Reglas: como mucho UNA propuesta por mensaje; nunca propongas una unidad que no exista en su temario; no lo propongas en cada mensaje (solo cuando te lo pida, cuando se atasque en una unidad concreta o cuando tenga un examen cerca de esa materia); y NO escribas tú el apunte en el chat: el sistema lo redacta aparte y lo guarda en su cuaderno. Si el alumno te dice que no, no vuelvas a proponerlo en esa conversación.',
  'PROHIBIDO ESCRIBIR EL APUNTE EN EL CHAT: si te pide «los apuntes», «un resumen completo», «un esquema de la unidad» o «el tema entero», NO copies aquí el desarrollo, ni el índice, ni los apartados del apunte. Un apunte pegado en el chat no se puede imprimir y ocupa la conversación; el que sirve es el del cuaderno. Responde con tu método socrático de siempre (una idea corta como máximo, con una pregunta) y añade la propuesta con la etiqueta para que él diga que sí. Si de verdad necesita un esquema rápido, dale como mucho cuatro o cinco viñetas y ofrécele el apunte de verdad con la etiqueta.',
].join('\n');

const NOTE_TAG = /\[\[\s*apunte\s*:\s*U?\s*(\d{1,2})\s*=\s*([^\]\n]{1,120})\s*\]\]\s*$/i;

/**
 * Colapsa los espacios dobles de una línea SIN tocar la indentación: en
 * Markdown, los espacios del principio son estructura (listas anidadas, bloques
 * de código) y cargárselos estropea el apunte.
 */
function tidySpace(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const indent = (line.match(/^[ \t]*/) ?? [''])[0];
      return indent + line.slice(indent.length).replace(/[ \t]{2,}/g, ' ');
    })
    .join('\n');
}

/**
 * Separa la etiqueta `[[apunte:...]]` del texto visible. Se acepta al final del
 * mensaje (como la etiqueta de nivel) y también suelta dentro del texto, porque
 * el modelo a veces la mete en medio de una frase.
 */
export function parseNoteProposal(raw: string): { text: string; proposal: NoteProposal | null } {
  const text = String(raw ?? '');

  const atEnd = text.match(NOTE_TAG);
  if (atEnd) {
    const title = atEnd[2].trim();
    if (title.length === 0) return { text, proposal: null };
    return {
      text: text.slice(0, atEnd.index).trimEnd(),
      proposal: { unitNumber: Number(atEnd[1]), title },
    };
  }

  const anywhere = text.match(/\[\[\s*apunte\s*:\s*U?\s*(\d{1,2})\s*=\s*([^\]]{1,120})\s*\]\]/i);
  if (!anywhere) return { text, proposal: null };

  const title = anywhere[2].trim();
  if (title.length === 0) return { text, proposal: null };

  return {
    text: tidySpace(text.replace(anywhere[0], '')).trim(),
    proposal: { unitNumber: Number(anywhere[1]), title },
  };
}

/**
 * Red de seguridad: quita cualquier etiqueta invisible que se haya colado en un
 * texto visible, sin tocar la indentación del Markdown.
 */
export function stripHiddenTags(raw: string): string {
  return tidySpace(String(raw ?? '').replace(/\[\[\s*(etapa|nivel|apunte)\s*:[^\]]*\]\]/gi, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/* 2. El contexto: qué sabe el catedrático antes de escribir            */
/* ------------------------------------------------------------------ */

export interface NotebookContextInput {
  studentName: string;
  subjectName: string;
  /** Unidad del apunte propuesto, si se conoce. */
  unit: { title: string; unitNumber: number | null; status: string } | null;
  /** Temario completo de la materia: para situar la unidad en el curso. */
  syllabus: Array<{ unitNumber: number | null; title: string; status: string }>;
  /** Unidades con nivel MEDIDO (nunca supuesto). */
  measuredTopics: Array<{ title: string; unitNumber: number | null; masteryLevel: number; source: string }>;
  /** Exámenes próximos de esa materia. */
  upcomingExams: Array<{ title: string; examType: string; days: number }>;
  /** TODOS los apuntes que ya existen de la materia (para no repetir). */
  existingNotes: Array<{ title: string; unitNumber: number | null; author: string }>;
  /** Extractos de los apuntes más relevantes, ya recortados por quien llama. */
  existingNoteExcerpts: Array<{ title: string; excerpt: string }>;
  /** Material que ha subido el profesor a Moodle (solo los nombres). */
  teacherMaterials: Array<{ name: string; sectionName: string }>;
  /** Lo que el alumno ha pedido concretamente, si lo ha dicho. */
  focus: string | null;
  /** Anotaciones sobre cómo explicó el profesor el tema en clase o sus criterios. */
  teacherMethodology?: string | null;
}

const LIMIT_SYLLABUS = 40;
const LIMIT_MATERIALS = 14;
const LIMIT_EXISTING_NOTES = 30;

/**
 * Líneas de contexto para el redactor. Es la única puerta por la que entra lo
 * que sabe del alumno: si algo no está aquí, no lo sabe.
 */
export function buildNotebookContext(input: NotebookContextInput): string[] {
  const lines: string[] = [];

  lines.push(`Alumno: ${input.studentName}. Asignatura: ${input.subjectName}.`);

  if (input.unit) {
    lines.push(
      `Unidad del apunte: ${input.unit.unitNumber ? `U${input.unit.unitNumber} ` : ''}«${input.unit.title}» (estado en clase: ${input.unit.status}).`
    );
  }

  if (input.focus && input.focus.trim().length > 0) {
    lines.push(`Lo que ha pedido concretamente: «${input.focus.trim().slice(0, 400)}». Céntrate en eso dentro de la unidad.`);
  }

  if (input.measuredTopics.length > 0) {
    const weak = input.measuredTopics.filter((topic) => topic.masteryLevel < 55);
    if (weak.length > 0) {
      lines.push(
        'NIVEL MEDIDO (medido de verdad, con sus respuestas o un simulacro) y por debajo del objetivo: ' +
          weak
            .map((topic) => `«${topic.title}»${topic.unitNumber ? ` (U${topic.unitNumber})` : ''} ${topic.masteryLevel}%`)
            .join(', ') +
          '. Los puntos donde falla van con más detalle y más ejemplos.'
      );
    } else {
      lines.push(
        `Tiene ${input.measuredTopics.length} unidad(es) medidas y ninguna por debajo del objetivo: puedes ir más rápido en lo básico y centrarte en los casos difíciles.`
      );
    }
  } else {
    lines.push(
      'No hay ninguna medición real de su nivel: no supongas que domina nada ni que le falla nada. Escribe el apunte completo, de base sólida, y refuerza con ejemplos.'
    );
  }

  if (input.upcomingExams.length > 0) {
    lines.push(
      'Exámenes a la vista: ' +
        input.upcomingExams
          .map((exam) => `${exam.title} (${exam.examType}) en ${exam.days} días`)
          .join('; ') +
        '. Enfócalo a lo que cae en examen.'
    );
  }

  if (input.syllabus.length > 0) {
    const shown = input.syllabus.slice(0, LIMIT_SYLLABUS);
    lines.push(
      'Temario de la asignatura (para situar la unidad, no para explicarlo todo): ' +
        shown
          .map((unit) => `${unit.unitNumber ? `U${unit.unitNumber}` : '?'} «${unit.title}» (${unit.status})`)
          .join('; ') +
        (input.syllabus.length > shown.length ? `… y ${input.syllabus.length - shown.length} más.` : '.')
    );
  }

  if (input.existingNotes.length > 0) {
    const shown = input.existingNotes.slice(0, LIMIT_EXISTING_NOTES);
    lines.push(
      'APUNTES QUE YA TIENE de esta asignatura (NO repitas su contenido: completa lo que falte y no dupliques): ' +
        shown
          .map((note) => `«${note.title}»${note.unitNumber ? ` (U${note.unitNumber})` : ''}${note.author === 'catedratico' ? ' [tuyo]' : ''}`)
          .join('; ') +
        (input.existingNotes.length > shown.length ? `… y ${input.existingNotes.length - shown.length} más.` : '.')
    );
  } else {
    lines.push('Todavía no tiene ningún apunte de esta asignatura: este es el primero.');
  }

  if (input.existingNoteExcerpts.length > 0) {
    lines.push('Extracto de los apuntes suyos más cercanos a esta unidad (para enlazar con su vocabulario, no para copiarlos):');
    for (const note of input.existingNoteExcerpts) {
      lines.push(`- «${note.title}»: ${note.excerpt}`);
    }
  }

  if (input.teacherMaterials.length > 0) {
    lines.push(
      'Material que ha subido su profesor a Moodle para esta asignatura (cita sus nombres si encaja; NO inventes su contenido): ' +
        input.teacherMaterials
          .slice(0, LIMIT_MATERIALS)
          .map((material) => `«${material.name}» (${material.sectionName})`)
          .join('; ') +
        '.'
    );
  }

  if (input.teacherMethodology && input.teacherMethodology.trim().length > 0) {
    lines.push(
      `METODOLOGÍA DEL PROFESOR DE CLASE (prioridad absoluta en notación y criterios de corrección): «${input.teacherMethodology.trim()}». Sigue estrictamente este método para que coincida 100% con cómo le evalúan en su instituto y con su profesor.`
    );
  }

  return lines;
}

/* ------------------------------------------------------------------ */
/* 3. El prompt de redacción                                            */
/* ------------------------------------------------------------------ */

/**
 * Instrucciones de estilo y estructura. Es el listón de calidad: el apunte se
 * estudia en el Cuaderno Notion, se imprime y se repasa encima.
 */
export const NOTE_WRITER_INSTRUCTIONS = [
  'Eres redactor de apuntes de cátedra para Bachillerato y PAU en España. Escribes el material definitivo que el alumno va a consultar en su cuaderno Notion, imprimir y estudiar encima: riguroso, ordenado, visualmente estructurado y sin una sola línea de relleno.',
  '',
  'EMPIEZA por una única línea `# <Título del apunte>` (el sistema la usa como título de la página, así que no repitas el título después).',
  '',
  'DESPUÉS, esta estructura exacta en Markdown con callouts Notion e iconos destacados:',
  '1. `> 📌 ` Una sola frase que resuma de qué va la unidad, su propósito e importancia en Bachillerato y PAU.',
  '2. `## 🎯 Lo que tienes que saber` — los conceptos mínimos en viñetas ordenadas. Definiciones precisas con términos técnicos destacados en negrita.',
  '3. `## 👨‍🏫 Criterio y Metodología del Profesor / PAU` — RIGOR DE CORRECCIÓN: Notaciones exactas, convenios de signos, pasos formales que exigen los profesores del instituto y criterios oficiales de la PAU para no perder décimas.',
  '4. `## 📖 Desarrollo de la unidad` — EL CUERPO DEL APUNTE. Un apartado `### ` por CADA punto del tema, numerados (`### 1. ...`, `### 2. ...`). Dentro de cada punto: qué es (definición formal), justificación física/matemática o técnica, deducción o caso concreto, y contraste con conceptos vecinos. Usa callouts de apoyo cuando aporte valor: `> 💡 **Truco:**` o `> ⚡ **Fórmula clave:**`. Entre 140 y 280 palabras por punto desarrollado.',
  '5. `## ⚡ Fórmulas, Leyes y Reglas` — una tabla Markdown con las columnas Fórmula/Ley | Cuándo se usa | Criterio / Aviso. TODAS las fórmulas matemáticas en LaTeX entre `$...$`.',
  '6. `## 🛠️ Cómo se hace (método paso a paso)` — el algoritmo o procedimiento numerado para resolver los problemas típicos de examen.',
  '7. `## 🔗 Analogía para retenerlo` — una analogía corta, cotidiana y FIEL al concepto que sirva para recordarlo en el examen, con una frase que explique qué corresponde a qué. Si el concepto no admite una analogía honesta, escribe el recurso mnemotécnico que mejor funcione en su lugar.',
  '8. `## 📝 Ejemplo resuelto de examen` — un ejercicio típico de examen o PAU desarrollado COMPLETO, paso a paso, con su justificación teórica y resultado final destacado.',
  '9. `## ⚠️ Errores que te van a costar puntos` — los fallos más comunes cometidos por alumnos en exámenes y trampas de los correctores, con `> ⚠️ **Cuidado con:**` y cómo evitarlos.',
  '10. `## 🧠 Compruébalo tú (Active Recall)` — de 5 a 7 preguntas de autoevaluación numeradas. La respuesta va inmediatamente después de la pregunta en la forma `**Respuesta:** ` para que el cuaderno la convierta en desplegable interactivo.',
  '',
  'REGLAS DE FORMATO Y ESTÉTICA NOTION:',
  '- Callouts estilizados con formato: `> 💡 **Truco:** ...`, `> ⚠️ **Cuidado:** ...`, `> 📌 **Definición:** ...`, `> ⚡ **Fórmula:** ...` (el cuaderno los pinta con cajas de color e iconos temáticos).',
  '- Matemáticas SIEMPRE entre `$...$` (en línea) o `$$...$$` (bloque centrado). Escribe LaTeX válido y limpio.',
  '- PROHIBIDO Y ELIMINADO: bloques de código (vallas ``` salvo en programación), etiquetas HTML innecesarias, imágenes o enlaces rotos, y saludos de chat («aquí tienes el apunte»).',
  '',
  'REGLAS DE CONTENIDO:',
  '- Extensión: entre 1400 y 2400 palabras. Máxima densidad de conocimiento útil.',
  '- Si el alumno ha aportado anotaciones sobre cómo lo explicó su profesor de clase, adáptate prioritariamente a sus convenios y pasos.',
  '- FIDELIDAD A LA FUENTE: el apunte se escribe solo con el temario, los apuntes y los documentos que tienes delante. Cuando una idea venga de un documento, cítalo (documento y página) en el propio texto; NO completes de memoria lo que no está en sus materiales. Si falta un dato imprescindible, déjalo señalado con `> 🔎 **Falta en tus materiales:** ...` en vez de inventarlo.',
  '- Todo lo que escribas tiene que ser matemáticamente y científicamente EXACTO.',
  '- Redacción en español, tono de cátedra cercana (tuteo respetuoso y motivador).',
  '- El apunte es un DOCUMENTO, no un mensaje: no te dirijas «a ti» al lector salvo en `## 🧠 Compruébalo tú`.',
  '- La fecha y el encabezado los pone el sistema: no los escribas.',
].join('\n');

export interface NoteWriterInput extends NotebookContextInput {
  /** Título pedido por el catedrático al proponerlo (se usa como respaldo). */
  proposedTitle: string;
}

/* ------------------------------------------------------------------ */
/* 4. El apunte, limpio: aquí no entra ni un resto de código            */
/* ------------------------------------------------------------------ */

/** Texto plano de un trozo de HTML (para rescatar el texto de un `<summary>`). */
function stripHtml(value: string): string {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * ¿Este bloque de código es en verdad una fórmula? Los modelos meten el LaTeX
 * en vallas cuando se ponen nerviosos; en un apunte de estudio eso es un error
 * de formato, no un fragmento de programa.
 */
function looksLikeMath(body: string): boolean {
  const text = body.trim();
  if (!text || text.length > 400) return false;
  if (/\\[a-zA-Z]{2,}/.test(text)) return true; // \frac, \int, \sqrt, \vec…
  return /[=^_]/.test(text) && !/[.;:!?¿¡]/.test(text);
}

export interface NoteQuality {
  words: number;
  /** Apartados `## ` que tiene el apunte, en minúsculas y sin acentos. */
  sections: string[];
  /** Cuántos apartados de desarrollo (`### `) ha escrito. */
  developedPoints: number;
  /** Lo que falta de lo imprescindible, en palabras para el alumno. */
  missing: string[];
  /**
   * Solo lo que falta de ESTRUCTURA (apartados obligatorios y desarrollo punto
   * por punto), sin contar la extensión.
   *
   * Se separa de `missing` porque no es lo mismo quedarse corto de palabras —que
   * se arregla escribiendo más— que no desarrollar los puntos del tema: eso es
   * un apunte de otra clase, y quien lo lea tiene que saberlo.
   */
  structureMissing: string[];
  ok: boolean;
}

/** Lo que falta cuando el apunte no desarrolla los puntos uno a uno. */
const THIN_DEVELOPMENT = 'el desarrollo apartado por apartado de los puntos del tema';

/**
 * Título del aviso que se deja en el taller cuando un apunte sale sin la
 * estructura obligatoria. Lleva `[auto]` porque lo ha detectado el sistema, no
 * el alumno.
 */
export const NOTE_INCOMPLETE_ISSUE_TITLE = '[auto] Un apunte de cátedra ha salido sin el desarrollo punto por punto';

/** Apartados que un apunte de cátedra tiene que traer sí o sí. */
const CRITICAL_SECTIONS: Array<{ key: string; label: string; test: RegExp }> = [
  { key: 'saber', label: '«Lo que tienes que saber»', test: /lo que tienes que saber|conceptos (?:clave|mínimos)/ },
  { key: 'desarrollo', label: '«Desarrollo de la unidad» con un apartado por punto', test: /desarrollo de la unidad|desarrollo del tema/ },
  { key: 'ejemplo', label: '«Ejemplo resuelto»', test: /ejemplo resuelto|ejemplo (?:de examen|completo)/ },
  { key: 'recall', label: '«Compruébalo tú» con las respuestas', test: /compru[eé]balo t[uú]|active recall|autoevaluaci[oó]n/ },
];

/** Palabras reales del apunte (sin contar marcas de Markdown ni fórmulas). */
export function countNoteWords(content: string): number {
  return String(content ?? '')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ')
    .replace(/[|#*_>`-]+/g, ' ')
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/**
 * Qué le falta al apunte. Se usa para dos cosas: para reintentar la redacción
 * cuando el modelo se queda corto (una vez), y para no guardar un apunte que no
 * sirve para estudiar.
 */
export function noteQualityReport(content: string): NoteQuality {
  const flat = String(content ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const sections = [...flat.matchAll(/^\s*##\s+(.+)$/gm)].map((match) => match[1].trim());
  const developedPoints = (flat.match(/^\s*###\s+\S/gm) ?? []).length;
  const words = countNoteWords(content);

  const sectionProblems = CRITICAL_SECTIONS.filter((section) => !section.test.test(flat)).map(
    (section) => section.label
  );
  const thinDevelopment = developedPoints < 3;

  const missing = [...sectionProblems];
  // Un apunte sin cuerpo (palabras de verdad) tampoco vale, aunque tenga todos
  // los títulos: es el caso del modelo que escribe el índice y se para.
  if (words < 900) missing.push(`más contenido (solo tiene ${words} palabras)`);
  if (thinDevelopment) missing.push(THIN_DEVELOPMENT);

  return {
    words,
    sections,
    developedPoints,
    missing,
    structureMissing: [...sectionProblems, ...(thinDevelopment ? [THIN_DEVELOPMENT] : [])],
    ok: missing.length === 0,
  };
}

/**
 * Limpia un apunte antes de guardarlo: fuera vallas de código, HTML, etiquetas
 * invisibles, delimitadores que el cuaderno no pinta y muletillas de chat.
 *
 * Regla: la limpieza NUNCA puede comerse contenido de estudio. Por eso un
 * bloque de código con pinta de fórmula vuelve como fórmula (`$$…$$`) y uno con
 * texto normal vuelve como párrafo; no se borra ni una línea de contenido.
 */
export function sanitizeNoteContent(raw: string): string {
  let text = String(raw ?? '').replace(/\r\n?/g, '\n');

  // 0. Escapes literales («\n» de dos caracteres) que a veces llegan del modelo.
  //    El lookahead evita cargarse comandos de LaTeX como «\nu» o «\nabla».
  text = text
    .replace(/(?<!\\)\\n(?![a-zA-Z])/g, '\n')
    .replace(/(?<!\\)\\t(?![a-zA-Z])/g, '  ');

  // 1. Etiquetas invisibles del sistema (etapa, nivel, propuesta de apunte).
  text = text.replace(/\[\[\s*(?:etapa|nivel|apunte)\s*:[^\]]*\]\]/gi, '');

  // 2. Delimitadores de LaTeX alternativos → los que el cuaderno entiende.
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_m, body: string) => `\n\n$$${body.trim()}$$\n\n`);
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => `$${body.trim()}$`);

  // 3. Bloques de código: fórmula si es fórmula, texto llano si no.
  text = text.replace(
    /```[a-zA-Z0-9+#._-]*\n?([\s\S]*?)```/g,
    (_m, body: string) => {
      const inner = String(body).trim();
      if (inner.length === 0) return '';
      return looksLikeMath(inner) ? `\n\n$$${inner}$$\n\n` : `\n\n${inner}\n\n`;
    }
  );
  // Vallas sueltas (sin pareja): fuera, que no se imprimen.
  text = text.replace(/^[ \t]*```[a-zA-Z0-9+#._-]*[ \t]*$/gm, '');

  // 4. Desplegables de Active Recall → la marca que el cuaderno pinta.
  text = text.replace(/<details[^>]*>([\s\S]*?)<\/details>/gi, (_m, body: string) => {
    const summary = String(body).match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
    const label = summary ? stripHtml(summary[1]) : '';
    const rest = summary ? String(body).replace(summary[0], '') : String(body);
    const answer = stripHtml(rest).replace(/\n{2,}/g, '\n').trim();
    if (answer.length === 0) return '';
    return `\n\n**${label.length > 0 ? label : 'Respuesta'}:** ${answer}\n\n`;
  });

  // 5. Cualquier otra etiqueta HTML, fuera (con guarda: no toca «x < y»).
  text = text.replace(/<\/?[a-zA-Z][^<>]*>/g, '');

  // 6. Separadores sueltos al principio o al final (el sistema pone los suyos).
  text = text
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*\n+/, '')
    .replace(/\n+\s*(?:-{3,}|\*{3,}|_{3,})\s*$/, '');

  // 7. Muletillas de chat: no pintan nada en un documento.
  text = text.replace(
    /^\s*(?:aqu[ií] tienes|claro|por supuesto|a continuaci[oó]n (?:te|tienes)|como te (?:he|hemos) dicho)[^\n]*\n+/i,
    ''
  );

  // 8. Aire: sin espacios al final de línea ni tres saltos seguidos.
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Prompt de sistema para la llamada que redacta el apunte. */
export function buildNoteWriterSystemPrompt(input: NoteWriterInput): string {
  return [
    NOTE_WRITER_INSTRUCTIONS,
    '',
    'CONTEXTO REAL DEL ALUMNO (es lo único que sabes de él; no inventes nada más):',
    ...buildNotebookContext(input),
  ].join('\n');
}

/**
 * Mensaje del usuario para la llamada que redacta el apunte.
 *
 * `correction` lo usa el segundo intento: cuando el primero sale sin la
 * estructura obligatoria, se le dice qué faltaba en vez de tirarlo y empezar de
 * cero a ciegas.
 */
export function buildNoteWriterUserMessage(input: NoteWriterInput, correction: string | null = null): string {
  const unit = input.unit
    ? `${input.unit.unitNumber ? `U${input.unit.unitNumber} ` : ''}«${input.unit.title}»`
    : `«${input.proposedTitle}»`;

  return [
    `Escribe los apuntes completos de la unidad ${unit} de ${input.subjectName}.`,
    input.focus && input.focus.trim().length > 0
      ? `Enfócalo a lo que me hace falta: ${input.focus.trim().slice(0, 400)}`
      : 'Enfócalo a lo que cae en examen.',
    'Recuerda: empieza por la línea `# Título`, desarrolla punto por punto en `## Desarrollo de la unidad` y sigue la estructura obligatoria. Sin relleno y sin bloques de código.',
    ...(correction ? ['', `CORRECCIÓN DEL INTENTO ANTERIOR: ${correction}`] : []),
  ].join('\n');
}

/**
 * Separa el título del cuerpo. El título es la primera línea `# `; el cuerpo es
 * todo lo que viene después. Si el modelo no la escribió, se usa el título
 * propuesto y el contenido queda entero.
 */
export function splitNoteTitle(raw: string, fallbackTitle: string): { title: string; content: string } {
  const clean = String(raw ?? '').trim();
  // El título vive en SU línea: si se usara `\s`, un `#` vacío se tragaría los
  // saltos de línea y el primer párrafo acabaría de título.
  const match = clean.match(/^[^\S\n]*#[^\S\n]+([^\n]+?)[^\S\n]*(?:\n|$)/);

  if (!match) {
    return { title: fallbackTitle.trim() || 'Apuntes de la unidad', content: clean };
  }

  const title = match[1].replace(/[*_`]/g, '').trim();
  const content = clean.slice(match[0].length).trim();

  return {
    title: title.length > 0 ? title.slice(0, 160) : fallbackTitle.trim() || 'Apuntes de la unidad',
    content: content.length > 0 ? content : clean,
  };
}
