/**
 * Avance real de la clase, contado por el alumno con sus palabras.
 *
 * El planificador no puede ser un bloque rígido que decide solo: en mitad del
 * curso el profesor avanza por donde quiere y una unidad «pendiente» puede
 * estar explicada desde ayer. Aquí vive la pieza que traduce una frase suelta
 * («hemos empezado la U5, pero solo el primer apartado») a unidades REALES del
 * temario, y la que le pide esa lectura a la IA sin permitirle inventarse nada.
 *
 * Dos ideas sostienen este módulo:
 *
 *  1. **La IA interpreta, el código escribe.** El modelo no toca la base de
 *     datos ni puede crear unidades: devuelve números de la lista que tiene
 *     delante y el servidor los aplica. Una alucinación se queda en un número
 *     que no existe y se descarta.
 *  2. **Sin cupo, el flujo sigue.** Si no hay ninguna clave de IA o están todas
 *     saturadas, la lectura local (números de unidad y títulos) mantiene el
 *     chequeo funcionando. La app no se queda sin la función por un 429.
 *
 * Módulo puro: sin Prisma, sin red y sin `Date`, para poder probarlo aislado.
 */

/** Una unidad tal y como la necesita la lectura de la frase. */
export interface ClassUnitRef {
  id: string;
  unitNumber: number | null;
  title: string;
  status: string;
}

export interface ClassProgress {
  /** Unidades explicadas o avanzadas de forma sustancial hoy. */
  vistos: number[];
  /** Unidad empezada hoy y todavía sin terminar. */
  enCurso: number | null;
  /** Hoy no se dio temario nuevo (examen, excursión, clase perdida). */
  sinTemario: boolean;
  /** Cómo lo ha entendido, en una frase. */
  resumen: string;
  /** De dónde sale la lectura: de la IA o del respaldo local. */
  fuente: 'ia' | 'local';
}

/** Sin acentos y en minúsculas: «Filosofía» y «filosofia» son lo mismo. */
function normalize(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Números de unidad escritos como «U5», «unidad 5», «tema 5» o «la 5». */
const NUMBER_PATTERNS: RegExp[] = [
  /\b(?:u|ud|uds|unidad|unidades|tema|temas|t)\s*\.?\s*(\d{1,2})\b/g,
  /\b(?:por la|en la|vamos por la|estamos en la|hemos empezado la|empezamos la|tocaba la|la|el)\s+(\d{1,2})\s*(?:ª|a)?\b/g,
];

/** Pistas de que el tema se ha empezado pero NO se ha terminado. */
const STARTED_CUE =
  /a medias|sin terminar|sin acabar|empezad|empezamos|hemos empezado|solo (?:el|la|hemos dado|dimos)|primera parte|aun no|todavia no|no hemos terminado|no terminamos|queda pendiente|por la mitad|la mitad/;

/** Pistas de que el tema se ha terminado (o se ha repasado entero). */
const FINISHED_CUE =
  /terminad|acabad|entera|completa|completo|visto toda|hemos visto toda|repas|lo hemos dado todo|ya esta/;

/** Pistas de que hoy no ha habido temario nuevo. */
const NO_SYLLABUS_CUE =
  /no hubo|no hemos dado|no se dio|no dio clase|no hubo temario|no dimos|no avanzamos|examen|excursion|pelicula|charla|tutoria|festivo|no tuvimos clase/;

/** Limpia un número: descarta 0 y valores que no pueden ser una unidad. */
function cleanNumber(value: number): number | null {
  return Number.isInteger(value) && value > 0 && value <= 60 ? value : null;
}

/**
 * Números de unidad que aparecen en la frase. No inventa: devuelve lo escrito.
 */
export function findUnitNumbers(text: string): number[] {
  const clean = normalize(text);
  const found = new Set<number>();

  for (const pattern of NUMBER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(clean)) !== null) {
      const value = cleanNumber(Number(match[1]));
      if (value !== null) found.add(value);
    }
  }

  return [...found].sort((a, b) => a - b);
}

/**
 * Unidades cuyo título aparece en la frase, aunque el alumno no diga el número.
 *
 * Se exigen dos palabras significativas (o una sola si el título es de una
 * palabra) para que «la parte de matrices» no marque media asignatura.
 */
export function findUnitsByTitle(text: string, units: ClassUnitRef[]): number[] {
  const haystack = ` ${normalize(text).replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const found: number[] = [];

  for (const unit of units) {
    if (unit.unitNumber === null) continue;
    const tokens = normalize(unit.title)
      .replace(/[^a-z0-9ñ ]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 4);
    if (tokens.length === 0) continue;

    const hits = tokens.filter((token) => haystack.includes(` ${token} `)).length;
    if (hits >= Math.min(2, tokens.length)) found.push(unit.unitNumber);
  }

  return [...new Set(found)].sort((a, b) => a - b);
}

function labelOf(unit: ClassUnitRef): string {
  return unit.unitNumber !== null ? `U${unit.unitNumber} «${unit.title}»` : `«${unit.title}»`;
}

/**
 * Lectura local de la frase: números y títulos. Es el respaldo cuando la IA no
 * está disponible, y también la red que evita que el modelo invente.
 */
export function interpretClassAnswerLocally(
  answer: string,
  units: ClassUnitRef[] = []
): ClassProgress {
  const clean = normalize(answer);
  // Números escritos («U5») y títulos («sistemas de ecuaciones»), sin repetir.
  const numbers = [
    ...new Set([...findUnitNumbers(answer), ...findUnitsByTitle(answer, units)]),
  ].sort((a, b) => a - b);

  if (numbers.length === 0) {
    const sinTemario = NO_SYLLABUS_CUE.test(clean);
    return {
      vistos: [],
      enCurso: null,
      sinTemario,
      resumen: sinTemario
        ? 'Entiendo que hoy no ha habido temario nuevo: el plan no cambia por esto.'
        : 'No he sabido a qué unidad te refieres.',
      fuente: 'local',
    };
  }

  const highest = numbers[numbers.length - 1];
  const lower = numbers.slice(0, -1);
  // Solo se da por terminada si lo dice de forma explícita y no se contradice
  // («la hemos terminado» sí; «la hemos empezado, no hemos terminado» no).
  const finished = FINISHED_CUE.test(clean) && !STARTED_CUE.test(clean);

  // Por defecto, la unidad más alta que menciona es la que está en curso: si
  // dice «vamos por la 5», la 5 es lo que se está dando, no lo ya cerrado.
  if (!finished) {
    return {
      vistos: lower,
      enCurso: highest,
      sinTemario: false,
      resumen: `Entiendo que hoy habéis empezado la U${highest}${lower.length > 0 ? ` y que la U${lower.join(', U')} ya está vista` : ''}.`,
      fuente: 'local',
    };
  }

  return {
    vistos: numbers,
    enCurso: null,
    sinTemario: false,
    resumen: `Entiendo que hoy habéis terminado la U${numbers.join(', U')}.`,
    fuente: 'local',
  };
}

/**
 * Prompt de la llamada que traduce la frase. Deliberadamente cerrado: el modelo
 * solo puede elegir entre los números del temario que recibe.
 */
export function buildClassProgressPrompt(input: {
  subjectName: string;
  units: ClassUnitRef[];
  answer: string;
}): string {
  const lines: string[] = [];
  lines.push('Eres el coordinador académico de BrainUp Academy (Bachillerato y PAU, España).');
  lines.push(
    'El alumno acaba de salir de clase y cuenta con sus palabras qué se ha dado hoy. Tu única tarea es traducir su frase a unidades REALES de su temario.'
  );
  lines.push('');
  lines.push(`ASIGNATURA: ${input.subjectName}.`);
  lines.push('TEMARIO REAL (solo puedes usar estos números, ni uno más):');
  for (const unit of input.units.slice(0, 60)) {
    lines.push(`- ${labelOf(unit)} (estado: ${unit.status})`);
  }
  if (input.units.length > 60) {
    lines.push(`- … y ${input.units.length - 60} unidades más (no las uses si no están escritas).`);
  }
  lines.push('');
  lines.push('RESPONDE ÚNICAMENTE CON UN JSON VÁLIDO, sin markdown, sin explicación y sin texto alrededor:');
  lines.push('{"vistos": [4], "enCurso": 5, "sinTemario": false, "resumen": "..."}');
  lines.push('');
  lines.push('REGLAS:');
  lines.push(
    '1. `vistos`: unidades que hoy se han EXPLICADO o avanzado de forma sustancial, aunque quede el final del tema.'
  );
  lines.push(
    '2. `enCurso`: la unidad que se ha EMPEZADO y todavía no se ha terminado. Si ha quedado a medias, va aquí y NO en `vistos`. `null` si no aplica.'
  );
  lines.push(
    '3. `sinTemario`: true solo si dice que hoy no se dio temario nuevo (examen, película, excursión, clase perdida). En ese caso deja `vistos` vacío y `enCurso` en null.'
  );
  lines.push(
    '4. PROHIBIDO INVENTAR: si no menciona una unidad de la lista, no la incluyas. Si no se entiende la frase, devuelve las listas vacías y explícalo en `resumen`.'
  );
  lines.push(
    '5. `resumen`: una sola frase, en segunda persona, con lo que has entendido («Entiendo que hoy habéis empezado la U5 y que la U4 ya está cerrada»).'
  );
  lines.push('');
  lines.push(`FRASE DEL ALUMNO: «${input.answer}»`);
  lines.push('Devuelve solo el JSON.');
  return lines.join('\n');
}

/**
 * Lee la respuesta de la IA. Devuelve `null` si no hay JSON válido y descarta
 * cualquier número que no exista en el temario: la última red contra inventos.
 */
export function parseClassProgressReply(
  raw: string,
  units: ClassUnitRef[]
): ClassProgress | null {
  const text = String(raw ?? '').replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const data = parsed as {
    vistos?: unknown;
    enCurso?: unknown;
    sinTemario?: unknown;
    resumen?: unknown;
  };

  const existing = new Set<number>(
    units.map((unit) => unit.unitNumber).filter((value): value is number => value !== null)
  );

  const vistos = Array.isArray(data.vistos)
    ? data.vistos
        .map((value) => cleanNumber(Number(value)))
        .filter((value): value is number => value !== null && existing.has(value))
    : [];

  const enCursoNumber = cleanNumber(Number(data.enCurso));
  const enCurso = enCursoNumber !== null && existing.has(enCursoNumber) ? enCursoNumber : null;

  const resumen =
    typeof data.resumen === 'string' && data.resumen.trim().length > 0
      ? data.resumen.trim().slice(0, 220)
      : '';

  return {
    vistos: [...new Set(vistos)].sort((a, b) => a - b),
    enCurso,
    sinTemario: data.sinTemario === true,
    resumen,
    fuente: 'ia',
  };
}
