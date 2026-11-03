/**
 * BrainUp Academy - Integración y Flujos Oficiales con Google NotebookLM
 *
 * Cada asignatura cuenta con su cuaderno de NotebookLM como motor de razonamiento
 * sobre fuentes oficiales (temario, diapositivas, grabaciones, boletines y exámenes).
 *
 * Este módulo provee:
 * 1. Catálogo de los 11 flujos de estudio estructurados.
 * 2. Generador de prompts quirúrgicos basados en fuentes y metodología del profesor.
 * 3. Sanitizador de respuestas de NotebookLM con citas hacia el cuaderno Notion.
 */

export interface NotebookLmFlow {
  id: string;
  name: string;
  description: string;
  category: 'comprension' | 'practica' | 'evaluacion' | 'repaso';
  icon: string;
  generatePrompt: (params: {
    subjectName: string;
    topicTitle: string;
    unitNumber: number | null;
    teacherMethod?: string | null;
  }) => string;
}

export const NOTEBOOKLM_FLOWS: NotebookLmFlow[] = [
  {
    id: 'esquema_fiel',
    name: '1. Esquema Jerárquico del Tema',
    description: 'Estructura lógica exhaustiva basada exclusivamente en las fuentes, con citación de páginas.',
    category: 'comprension',
    icon: 'ListTree',
    generatePrompt: ({ subjectName, topicTitle, unitNumber }) =>
      `Actúa como el examinador jefe y profesor titular de ${subjectName}.
Analiza EXCLUSIVAMENTE las fuentes cargadas correspondientes a la unidad ${unitNumber ? `U${unitNumber}: ` : ''}«${topicTitle}».

Genera un ESQUEMA JERÁRQUICO COMPLETO del tema siguiendo estas reglas estrictas:
1. Divide el contenido en Secciones Principales, Subsecciones y Puntos Clave.
2. Cada concepto fundamental DEBE incluir su cita exacta entre corchetes con el documento y la página o diapositiva donde aparece (ejemplo: [Apuntes Tema, Pág. 12] o [Diapositiva 8]).
3. Incluye las fórmulas clave en notación LaTeX ($...$).
4. Si un concepto NO está en las fuentes cargadas, NO lo inventes ni lo deduzcas: ignóralo por completo.`,
  },
  {
    id: 'resumen_fiel',
    name: '2. Resumen Fiel con Criterio de Profesor',
    description: 'Resumen riguroso adaptado a la notación, pasos obligatorios y advertencias de tu profesor.',
    category: 'comprension',
    icon: 'BookOpen',
    generatePrompt: ({ subjectName, topicTitle, unitNumber, teacherMethod }) =>
      `Actúa como catedrático de ${subjectName}. Redacta un RESUMEN TEÓRICO FIEL Y EXHAUSTIVO de la unidad ${unitNumber ? `U${unitNumber}: ` : ''}«${topicTitle}».

REGLAS NO NEGOCIABLES:
1. Fidelidad absoluta a las fuentes: define los conceptos usando el vocabulario exacto de los apuntes y libros cargados.
2. Criterio del profesor: ${teacherMethod ? `Aplica rigurosamente su metodología: «${teacherMethod}».` : 'Prioriza las advertencias, notación y desarrollos destacados en las notas.'}
3. Cita las fuentes relevantes en cada apartado con [Doc, Pág. X].
4. Estructura con encabezados limpios, listas ordenadas y destacados de:
   > 📌 DEFINICIÓN OFICIAL
   > ⚡ FÓRMULAS INDISPENSABLES
   > ⚠️ ERRORES TÍPICOS / MOTIVOS DE PENALIZACIÓN EN EXAMEN`,
  },
  {
    id: 'glosario_quirurgico',
    name: '3. Glosario Técnico de Términos Clave',
    description: 'Definiciones canónicas de los conceptos indispensables para obtener la máxima nota teórica.',
    category: 'comprension',
    icon: 'Binary',
    generatePrompt: ({ subjectName, topicTitle, unitNumber }) =>
      `Extrae de las fuentes cargadas un GLOSARIO TÉCNICO de los 15 conceptos indispensables de ${unitNumber ? `U${unitNumber}: ` : ''}«${topicTitle}» en ${subjectName}.

Formato obligatorio por cada término:
- **Término técnico**: Definición canónica exacta según las fuentes.
  - *Contexto de aplicación*: Dónde y cómo se utiliza.
  - *Referencia*: [Documento, Página/Diapositiva exacta].`,
  },
  {
    id: 'explicacion_profesor',
    name: '4. Explicación al Estilo del Profesor',
    description: 'Desarrollo conceptual paso a paso utilizando las explicaciones y metáforas de clase.',
    category: 'comprension',
    icon: 'GraduationCap',
    generatePrompt: ({ subjectName, topicTitle, teacherMethod }) =>
      `Explica los puntos más complejos del tema «${topicTitle}» tal y como los explicaría el profesor en clase de ${subjectName}.
${teacherMethod ? `Metodología exigida en el aula: «${teacherMethod}».` : ''}

Requisitos:
- Usa explicaciones directas, intuitivas pero formalmente rigurosas.
- Detalla el paso a paso algebraico o conceptual sin saltarte deducciones.
- Si en las fuentes hay notas al margen o ejemplos puestos en pizarra, utilízalos explícitamente citando la fuente.`,
  },
  {
    id: 'preguntas_socraticas',
    name: '5. Batería de Preguntas Socráticas',
    description: 'Preguntas desafiantes para poner a prueba tu comprensión real sin mirar los apuntes.',
    category: 'practica',
    icon: 'HelpCircle',
    generatePrompt: ({ subjectName, topicTitle }) =>
      `Genera una batería de 8 PREGUNTAS SOCRÁTICAS de alto nivel sobre «${topicTitle}» de ${subjectName}.
Las preguntas deben:
- Exigir razonar la causa de un fenómeno, la justificación de una fórmula o las consecuencias de variar una condición.
- NO ser preguntas de memoria simple ("¿qué es...?"), sino de aplicación y deducción ("¿por qué ocurre...", "¿qué pasaría si...").
- Añade al final de cada pregunta una pista oculta basada en las fuentes [Pista: Ref. Doc, Pág. X].`,
  },
  {
    id: 'flashcards_recall',
    name: '6. Flashcards de Active Recall',
    description: 'Tarjetas de memoria activa (Pregunta / Respuesta inequívoca) listas para memorizar.',
    category: 'practica',
    icon: 'Layers',
    generatePrompt: ({ subjectName, topicTitle }) =>
      `Crea 12 TARJETAS DE ACTIVE RECALL (Flashcards) basadas EXCLUSIVAMENTE en las fuentes de «${topicTitle}» (${subjectName}).

Formato exacto:
---
**FRONT (Pregunta)**: [Pregunta directa y concisa]
**BACK (Respuesta)**: [Respuesta precisa, sin rodeos, con fórmula si aplica]
*Fuente*: [Pág. X / Diapositiva Y]
---`,
  },
  {
    id: 'quiz_autoevaluacion',
    name: '7. Quiz de Autoevaluación Cronometrado',
    description: 'Test de 6 preguntas con justificación rigurosa de respuestas correctas y distractoras.',
    category: 'evaluacion',
    icon: 'CheckSquare',
    generatePrompt: ({ subjectName, topicTitle }) =>
      `Diseña un QUIZ DE AUTOEVALUACIÓN de 6 preguntas de opción múltiple (4 opciones: A, B, C, D) sobre «${topicTitle}» en ${subjectName}.
- 3 preguntas teóricas de concepto.
- 3 preguntas de cálculo o aplicación práctica.
- Al final, incluye las Soluciones Explicadas justificando por qué la opción correcta es la verdadera según las fuentes y por qué cada una de las otras 3 es falsa, citando la página o documento.`,
  },
  {
    id: 'casos_practicos',
    name: '8. Casos Prácticos y Problemas Resueltos',
    description: 'Resolución metódica de ejercicios tipo examen con el desarrollo formal que exige el profesor.',
    category: 'practica',
    icon: 'Cpu',
    generatePrompt: ({ subjectName, topicTitle, teacherMethod }) =>
      `Selecciona o formula 3 PROBLEMAS TÍPICOS de examen del tema «${topicTitle}» en ${subjectName}.
${teacherMethod ? `Aplica estrictamente el criterio de corrección: «${teacherMethod}».` : ''}

Por cada problema:
1. **Enunciado completo** con datos y unidades correctas.
2. **Planteamiento teórico**: Principios físicos/matemáticos aplicados.
3. **Desarrollo algebraico paso a paso** en LaTeX ($...$ y $$...$$).
4. **Resultado numérico final** con sus unidades y análisis de coherencia física/lógica.
5. **Criterio de corrección**: Dónde se suelen perder puntos en este ejercicio según las fuentes.`,
  },
  {
    id: 'simulacro_examen',
    name: '9. Simulacro de Examen Oficial',
    description: 'Examen de prueba con estructura, duración y baremo de puntuación exactos.',
    category: 'evaluacion',
    icon: 'FileSpreadsheet',
    generatePrompt: ({ subjectName, topicTitle, unitNumber }) =>
      `Genera un SIMULACRO DE EXAMEN REAL de 1 hora de duración para ${subjectName}, correspondiente a ${unitNumber ? `U${unitNumber}: ` : ''}«${topicTitle}».
Estructura:
- 1 Pregunta teórica de definición y deducción (2.5 puntos).
- 2 Problemas numéricos o de desarrollo completo (3.5 puntos cada uno).
- 1 Pregunta trampa / cuestión conceptual corta (0.5 puntos).
Incluye al final la RÚBRICA Y BAREMO DETALLADO de puntuación citando las fuentes.`,
  },
  {
    id: 'deteccion_lagunas',
    name: '10. Detección de Lagunas y Errores Trampa',
    description: 'Diagnóstico de los puntos ciegos donde la mayoría de estudiantes suspenden o pierden nota.',
    category: 'evaluacion',
    icon: 'AlertTriangle',
    generatePrompt: ({ subjectName, topicTitle }) =>
      `Analiza las fuentes cargadas de «${topicTitle}» (${subjectName}).
Identifica los 5 PUNTOS CRÍTICOS O TRAMPAS CONCEPTUALES donde los alumnos suelen confundirse o cometer errores de bulto.
Por cada punto crítico:
- ¿Cuál es la confusión habitual?
- ¿Cuál es la regla correcta según los apuntes del profesor?
- Mini-ejemplo de contraste (Bien vs. Mal).
- Referencia: [Doc, Pág. X].`,
  },
  {
    id: 'plan_repaso',
    name: '11. Plan de Repaso Espaciado',
    description: 'Calendario de consolidación de 4 repasos estratégicos antes del examen.',
    category: 'repaso',
    icon: 'CalendarClock',
    generatePrompt: ({ subjectName, topicTitle }) =>
      `Diseña un PLAN DE REPASO ESTRATÉGICO para consolidar el tema «${topicTitle}» en ${subjectName} en 4 etapas:
- **Repaso 1 (Día +1)**: Qué 3 conceptos y fórmulas revisar en 15 minutos.
- **Repaso 2 (Día +3)**: Qué 2 ejercicios clave resolver sin mirar.
- **Repaso 3 (Día +7)**: Test activo de recuperación y vocabulario técnico.
- **Repaso 4 (Pre-Examen)**: Simulacro relámpago de los puntos críticos identificados en las fuentes.`,
  },
];

/**
 * Convierte citas estándar de NotebookLM en badges visuales compatibles con el visor de Notion.
 */
export function formatNotebookLmContent(rawText: string): string {
  if (!rawText) return '';

  return rawText
    // Reemplaza citas [Pág. X] o [p. X] o [Diapositiva Y] con badges destacados
    .replace(/\[(?:doc(?:umento)?\s*[^,\]]*,?\s*)?(?:p[áa]g(?:ina)?\.?\s*(\d+(?:-\d+)?)|diapositiva\s*(\d+)|minuto\s*([\d:]+))\]/gi, (match) => {
      return ` \`📌 ${match.slice(1, -1)}\` `;
    })
    // Limpia llamadas a fuentes numéricas tipo [1], [2] convirtiéndolas en insignias discretas
    .replace(/\[(\d+)\]/g, ' `[$1]` ');
}
