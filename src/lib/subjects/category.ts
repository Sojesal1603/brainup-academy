/**
 * Categoría didáctica de una materia (Paso 14, B7).
 *
 * Es un módulo puro: sin Prisma, sin red y sin IA. Traduce el nombre de una
 * asignatura a una de las siete categorías aprobadas y devuelve la capa de
 * prompt que cambia el método del catedrático. La categoría guardada en
 * `Subject.category` manda; si es null (perfiles anteriores), se infiere.
 */

export const SUBJECT_CATEGORIES = [
  'PROBLEMAS',
  'LABORATORIO',
  'COMENTARIO',
  'IDIOMA',
  'EXPOSICION',
  'TECNICA',
  'GENERAL',
] as const;

export type SubjectCategory = (typeof SUBJECT_CATEGORIES)[number];

export interface SubjectCategoryMeta {
  label: string;
  short: string;
  description: string;
  /** Color estable para chips y tarjetas (no sustituye al color de la materia). */
  color: string;
  /** Herramientas del panel, en el orden en que conviene ofrecerlas. */
  tools: readonly string[];
}

export const SUBJECT_CATEGORY_META: Record<SubjectCategory, SubjectCategoryMeta> = {
  PROBLEMAS: {
    label: 'Resolución de problemas',
    short: 'Problemas',
    description: 'Método visible, datos, unidades y comprobación del resultado.',
    color: '#3b82f6',
    tools: ['problemas', 'test', 'guia', 'flashcards', 'mapa'],
  },
  LABORATORIO: {
    label: 'Ciencias de laboratorio',
    short: 'Laboratorio',
    description: 'Hipótesis, variables, medidas, error y conclusión.',
    color: '#10b981',
    tools: ['laboratorio', 'guia', 'test', 'flashcards', 'mapa'],
  },
  COMENTARIO: {
    label: 'Comentario de texto',
    short: 'Comentario',
    description: 'Lectura guiada, estructura, rasgos y valoración con pruebas del texto.',
    color: '#f59e0b',
    tools: ['comentario', 'guia', 'test', 'mapa', 'flashcards'],
  },
  IDIOMA: {
    label: 'Idiomas',
    short: 'Idioma',
    description: 'Producción en el idioma, corrección por tipo de error y conversación.',
    color: '#8b5cf6',
    tools: ['idioma', 'flashcards', 'test', 'guia', 'mapa'],
  },
  EXPOSICION: {
    label: 'Exposición y expresión',
    short: 'Exposición',
    description: 'Guion, argumentación, tiempo y ensayo con preguntas previsibles.',
    color: '#ec4899',
    tools: ['guia', 'mapa', 'flashcards', 'test'],
  },
  TECNICA: {
    label: 'Técnica y programación',
    short: 'Técnica',
    description: 'Diseño, implementación y prueba, sin ejecutar código en el servidor.',
    color: '#06b6d4',
    tools: ['problemas', 'guia', 'test', 'mapa', 'flashcards'],
  },
  GENERAL: {
    label: 'General',
    short: 'General',
    description: 'Sin método especializado: se mantienen las herramientas de siempre.',
    color: '#64748b',
    tools: ['flashcards', 'test', 'mapa', 'guia'],
  },
};

/** ¿El valor guardado es una categoría válida? */
export function isSubjectCategory(value: unknown): value is SubjectCategory {
  return (
    typeof value === 'string' && (SUBJECT_CATEGORIES as readonly string[]).includes(value)
  );
}

export function normalizeSubjectCategory(value: unknown): SubjectCategory | null {
  return isSubjectCategory(value) ? value : null;
}

/**
 * Inferencia determinista por nombre. Si no hay una coincidencia clara, GENERAL:
 * nunca se inventa una didáctica que el nombre no justifica.
 *
 * El orden importa. «Tecnología e Ingeniería» es TECNICA antes de caer en
 * PROBLEMAS por «ingeniería»; «Historia del Arte» es COMENTARIO antes de caer
 * en EXPOSICION por «arte».
 */
export function inferSubjectCategory(name: string | null | undefined): SubjectCategory {
  const value = String(name ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  if (!value) return 'GENERAL';

  if (
    /inglés|ingles|francés|frances|alemán|aleman|italiano|portugués|portugues|idioma|lengua extranjera|latín|latin|griego|chino|japonés|japones|ruso/.test(
      value
    )
  ) {
    return 'IDIOMA';
  }

  if (
    /biolog|geolog|ciencias? (de la )?tierra|anatom|bioquím|bioquim|fisiolog|microbiolog|ambiental|laboratorio|experimental/.test(
      value
    )
  ) {
    return 'LABORATORIO';
  }

  if (
    /historia del arte|lengua|literat|historia|filosof|derecho|humanidades|clásic|clasic|comentario de texto/.test(
      value
    )
  ) {
    return 'COMENTARIO';
  }

  if (
    /tecnolog|informátic|informatic|programaci|computaci|dibujo técnico|dibujo tecnico|electrónic|electronica|robótic|robotica|redes|sistemas operativos|base de datos/.test(
      value
    )
  ) {
    return 'TECNICA';
  }

  if (
    /matem|álgebr|algebr|cálculo|calculo|físic|fisica|químic|quimic|estadíst|estadist|econom|contabilid|finanz|ingenier|mecánic|mecanic|electrotecnia|termodinámic|termodinamica|resistencia de materiales/.test(
      value
    )
  ) {
    return 'PROBLEMAS';
  }

  if (
    /música|musica|arte|plástic|plastic|escénic|escenic|oratoria|teatro|danza|expresión corporal|expresion corporal/.test(
      value
    )
  ) {
    return 'EXPOSICION';
  }

  return 'GENERAL';
}

/** La categoría efectiva: la guardada manda; null cae a la inferencia. */
export function subjectCategoryOf(subject: {
  name: string;
  category?: string | null;
}): SubjectCategory {
  return normalizeSubjectCategory(subject.category) ?? inferSubjectCategory(subject.name);
}

/**
 * Capa de prompt que cambia el MÉTODO de la materia, no la etapa.
 *
 * GENERAL devuelve una lista vacía: una materia sin categoría conserva
 * exactamente el prompt que ya tenía (paridad verificada).
 */
export function buildCategoryLayer(category: SubjectCategory): string[] {
  switch (category) {
    case 'PROBLEMAS':
      return [
        'MÉTODO DE LA MATERIA (resolución de problemas): no empieces por la fórmula. Identifica datos, incógnita, unidades y condiciones; propón un plan y justifica cada paso. No des el resultado sin el desarrollo, y ciérralo con una comprobación (unidades, orden de magnitud o sustitución inversa). Si un cálculo es verificable, comprueba el resultado antes de afirmarlo.',
      ];
    case 'LABORATORIO':
      return [
        'MÉTODO DE LA MATERIA (ciencias de laboratorio): separa observación de inferencia. Trabaja con hipótesis, variable independiente, dependiente y controladas, procedimiento reproducible, tabla de datos con unidades y análisis de error. No inventes medidas ni resultados: si faltan datos, dilo y pide el cuaderno. Concluye solo lo que los datos permiten.',
      ];
    case 'COMENTARIO':
      return [
        'MÉTODO DE LA MATERIA (comentario de texto): localiza el texto, su contexto y su intención; describe la estructura y los rasgos lingüísticos o literarios con ejemplos citados entre comillas. No parafrasees ni atribuyas ideas que no estén en el texto. Cierra con una valoración razonada, no con una opinión suelta.',
      ];
    case 'IDIOMA':
      return [
        'MÉTODO DE LA MATERIA (idioma): las explicaciones y el metalenguaje van en español; los ejemplos, la práctica y las producciones, en el idioma de la materia. Corrige clasificando el error (gramática, léxico, ortografía, registro) y ofrece una versión correcta. En conversación, mantén el papel y no cambies al español salvo para explicar una regla.',
      ];
    case 'EXPOSICION':
      return [
        'MÉTODO DE LA MATERIA (exposición): exige tesis clara, guion con apertura, desarrollo y cierre, y una línea de tiempo realista. Ensaya con preguntas previsibles y corrige muletillas, estructura y claridad. No escribas el discurso entero si el alumno solo necesita el esqueleto: primero el plan, luego la redacción.',
      ];
    case 'TECNICA':
      return [
        'MÉTODO DE LA MATERIA (técnica y programación): separa comprensión del problema, diseño, implementación y prueba. El código se entrega en bloques con explicación y casos de prueba; no se ejecuta en el servidor. Si el alumno pide ejecutar, aclara que aquí solo se revisa el código y se razona el resultado.',
      ];
    default:
      return [];
  }
}

/**
 * ¿Esta categoría puede usar una herramienta? Las herramientas base siguen
 * disponibles en todas: la categoría ordena, no encierra.
 */
export function categorySupportsTool(category: SubjectCategory, tool: string): boolean {
  return SUBJECT_CATEGORY_META[category].tools.includes(tool);
}
