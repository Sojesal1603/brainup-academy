/**
 * Lo que BrainUp sabe de sí misma.
 *
 * Dos usos, y los dos importan:
 *
 *   1. **La IA lo recibe en su prompt.** Cuando le preguntas «¿cómo cargo mi
 *      temario?» o «¿por qué no me salen retos?», el catedrático o el coordinador
 *      tienen que contestar con la app delante, no improvisar. Aquí está la app
 *      descrita en texto: cada sección, para qué sirve y cómo se hace lo que se
 *      hace en ella.
 *   2. **Sin IA, esto sigue contestando.** Si todos los modelos están saturados
 *      (pasa: son claves gratuitas), el respaldo local busca la respuesta aquí y
 *      la da igual. Un sistema que no sabe explicarse a sí mismo cuando se queda
 *      sin proveedor no es un sistema, es una ruleta.
 *
 * Módulo puro (sin Prisma ni red).
 */

export interface SystemSection {
  path: string;
  name: string;
  /** Para qué sirve, en una frase. */
  what: string;
  /** Cómo se usa, en pasos cortos. */
  how: string[];
}

export const SYSTEM_SECTIONS: SystemSection[] = [
  {
    path: '/',
    name: 'Cuartel (dashboard)',
    what: 'El parte del día: bloques de estudio asignados, exámenes en cuenta atrás, entregas de Moodle, temas medidos en riesgo, hábitos y el resumen de repasos y retos.',
    how: [
      'Los bloques de hoy se marcan como hechos al terminarlos; eso suma horas y actualiza el nivel de la unidad.',
      'El «Chequeo de clase» apunta qué unidad se ha dado hoy y deja el temario al día.',
      'El bloque «Repaso y Retos» lleva a `/repaso` (qué toca repasar) y a `/retos` (los retos de la semana).',
    ],
  },
  {
    path: '/puesta-a-punto',
    name: 'Puesta a punto',
    what: 'Una entrevista con un coordinador IA para dejar el curso configurado: temario de cada materia, fechas de examen, horas reales de estudio y ritmo.',
    how: [
      'Se contesta una pregunta por turno, en lenguaje normal, sin formatos raros.',
      'Lo que dices se guarda solo: el coordinador lo anota y a la derecha ves qué falta.',
      'Si te equivocas, se lo dices y lo corrige en el momento.',
      'Si la IA no está disponible, el coordinador sigue funcionando en modo local: anota lo que reconoce y te hace la siguiente pregunta.',
    ],
  },
  {
    path: '/temario',
    name: 'Temario',
    what: 'El temario real de cada asignatura: unidades numeradas, evaluación, estado (por dar, en curso, visto, repasado), dificultad y tu nivel por unidad.',
    how: [
      'Pega el índice de tu profesor o de tu libro y la app lo numera y lo guarda.',
      'Marca la unidad que estáis dando («vamos por aquí») y el planificador sube su prioridad.',
      'El selector de nivel por unidad es tu autoevaluación: es una medición, no una promesa.',
    ],
  },
  {
    path: '/planificador',
    name: 'Planificador',
    what: 'Reparte los bloques de estudio de la semana por asignatura y técnica (Active Recall, problemas, flashcards, simulacro, corrección de errores, repaso espaciado SRS).',
    how: [
      'Prioriza por déficit de nivel, errores abiertos, exámenes cerca, entregas de Moodle y, ahora, repasos vencidos.',
      'Se recalcula con un clic cuando cambias notas, temario o ritmo.',
      'Estudia antes las asignaturas que tienes al día siguiente según tu horario real.',
    ],
  },
  {
    path: '/horario',
    name: 'Horario',
    what: 'Tu cuadrícula de clases de la semana (materias, franjas y aulas).',
    how: [
      'Se importa pegando la cuadrícula desde el HTML de tu centro.',
      'Con el horario cargado, el planificador estudia por la tarde lo que tienes al día siguiente.',
    ],
  },
  {
    path: '/repaso',
    name: 'Repaso Espaciado (SRS)',
    what: 'El calendario de repasos de cada unidad y la analítica de retención: qué toca repasar hoy, cuánto se está enfriando cada unidad y qué has recordado de verdad.',
    how: [
      'Cada repaso se valora con cuatro botones (Otra vez, Difícil, Bien, Fácil) y la app reprograma el intervalo sola.',
      'Los repasos vencidos suben en el planificador y en el Cuartel.',
      'La retención estimada es una estimación; la tasa de recuerdo real sale de los repasos que registras.',
    ],
  },
  {
    path: '/retos',
    name: 'Retos Semanales',
    what: 'Metas cortas de la semana construidas con tus datos reales (repasos vencidos, errores abiertos, exámenes con fecha y tus horas declaradas).',
    how: [
      'El botón «Generar los retos de esta semana» los crea; «Actualizar progreso» los vuelve a medir.',
      'El progreso se mide solo con lo que registras en la app: no hay casillas que marcar.',
      'Cada reto conseguido paga XP y el nivel se calcula con esa XP.',
    ],
  },
  {
    path: '/apuntes',
    name: 'Cuaderno Notion',
    what: 'Tu cuaderno de apuntes, organizado por asignatura, con el material que ha subido tu profesor a Moodle.',
    how: [
      'Los apuntes que te escriben los catedráticos IA aparecen marcados como suyos y se pueden descargar en Markdown o imprimir.',
      'El catedrático te pide permiso antes de escribir un apunte: si dices que sí, se redacta y se guarda en la sección de su materia.',
      'Desde el chat puedes abrir el apunte para leerlo, descargarlo o imprimirlo.',
    ],
  },
  {
    path: '/brainup',
    name: 'BrainUp IA (catedráticos)',
    what: 'Un catedrático de IA por asignatura: explica con pistas escalonadas, no da la solución directa, lee tus apuntes y tus adjuntos y anota el nivel que mide.',
    how: [
      'Adjunta capturas, fotos o PDF con el clip (o pégalas con Ctrl+V): los lee de verdad.',
      'El interruptor «Mis apuntes compartidos» le da acceso al cuaderno de esa materia.',
      'Puede proponerte escribir un apunte de la unidad; tú decides.',
    ],
  },
  {
    path: '/examinador',
    name: 'Examinador PAU',
    what: 'Simulacros completos de 4 bloques con cronómetro de 90 minutos y corrección por rúbrica PAU.',
    how: [
      'Se generan sobre tus temas más débiles.',
      'La nota entra en el nivel de cada tema y en las estadísticas.',
    ],
  },
  {
    path: '/errores',
    name: 'Banco de Errores',
    what: 'Cada fallo con su autopsia: enunciado, tu respuesta, la correcta, la causa raíz y la regla preventiva.',
    how: [
      'Registrar un error baja el nivel de esa unidad y sube su prioridad en el plan.',
      'Cuando lo cierras, cuenta como error corregido (y para los retos semanales).',
    ],
  },
  {
    path: '/enfoque',
    name: 'Modo Enfoque',
    what: 'Temporizador Pomodoro o libre (25, 45, 60 o 90 minutos) en pantalla completa, con alarma por Web Audio y calibración del resultado al terminar.',
    how: [
      'Al acabar, di cómo ha ido (Entendido, Con dudas, Fallado) y el nivel de la unidad se ajusta.',
      'Esos minutos son los que cuentan para el reto de horas semanales.',
    ],
  },
  {
    path: '/examenes',
    name: 'Exámenes',
    what: 'Convocatorias con fecha, peso y nota objetivo, y cuenta atrás.',
    how: ['Añade un examen y el planificador y los retos se ajustan solos.'],
  },
  {
    path: '/estadisticas',
    name: 'Estadísticas',
    what: 'Proyección de nota PAU sobre 14 puntos, horas por materia y análisis causal de errores. Solo con datos reales: sin mediciones no hay proyección.',
    how: ['Declara tus notas reales en Ajustes o autoevalúa unidades para que la proyección diga algo.'],
  },
  {
    path: '/ajustes',
    name: 'Ajustes',
    what: 'Notas reales y objetivos por materia, horas semanales, ritmo, conexión con Moodle, estado del motor de IA y exportación de todos tus datos.',
    how: [
      'Moodle: se conecta con usuario y contraseña (la contraseña no se guarda) o con un token de Web Services.',
      'El botón «Comprobar mi Moodle» diagnostica la dirección sin pedir claves.',
      'Desde aquí también se exporta toda la base a JSON.',
    ],
  },
  {
    path: '/mantenimiento',
    name: 'Mantenimiento',
    what: 'El taller del sistema: revisa la salud de la base y del temario, detecta incongruencias (unidades repetidas, numeración rota, datos huérfanos) y las arregla, con un registro de los fallos que le cuentes.',
    how: [
      '«Revisar el sistema» ejecuta las comprobaciones y dice qué encuentra, con su gravedad.',
      'Las reparaciones seguras se aplican en un clic; las que cambian datos te dicen antes qué van a hacer.',
      'Puedes reportar un fallo desde aquí: queda anotado con su contexto para que no se pierda.',
    ],
  },
];

/**
 * Explicaciones sueltas: las preguntas que de verdad se hacen. Se buscan por
 * palabras clave, así que el respaldo local (sin IA) también las encuentra.
 */
export interface SystemFaqEntry {
  id: string;
  /** Palabras que activan esta respuesta (en minúsculas y sin acentos). */
  keywords: string[];
  answer: string;
}

export const SYSTEM_FAQ: SystemFaqEntry[] = [
  {
    id: 'temario-cargar',
    keywords: ['cargar temario', 'meter temario', 'temario', 'indice', 'índice', 'pegar', 'unidades'],
    answer:
      'El temario se carga en /temario: pega el índice de tu profesor o de tu libro y la app lo numera y lo guarda. También puedes dictármelo aquí y lo anoto yo. Si lo cambias, se sustituye con copia de seguridad automática.',
  },
  {
    id: 'notas',
    keywords: ['nota', 'notas', 'media', 'expediente', 'declarar'],
    answer:
      'Tus notas reales se declaran en /ajustes («Mis notas reales») y el objetivo PAU también. A partir de ahí las estadísticas proyectan sobre 14 puntos. Sin notas ni niveles medidos, la proyección se queda sin datos a propósito: no se inventa un 7,5.',
  },
  {
    id: 'ia-clave',
    keywords: ['clave', 'api', 'gemini', 'groq', 'modelo', 'motor', 'cuota', 'saturado', 'no responde', 'error de ia'],
    answer:
      'El motor de IA usa tres proveedores gratuitos, en este orden: GEMINI_API_KEY (aistudio.google.com), GROQ_API_KEY (console.groq.com) y OPENROUTER_API_KEY (openrouter.ai/keys, con sus modelos gratuitos). Basta con tener uno; cada uno que añadas es una red más para cuando los cupos se agotan, y en Gemini y Groq el cupo se cuenta por clave, así que se pueden poner varias (GEMINI_API_KEY_2, GROQ_API_KEY_2…). Si un proveedor se queda sin cupo o falla, el turno pasa solo al siguiente; si están los tres secos, la app lo dice y contesta en modo local en vez de quedarse colgada. También puede usar un modelo en tu propio ordenador (Ollama) como último recurso: se enciende solo si está instalado y los catedráticos lo usan cuando la nube se queda sin cupo.',
  },
  {
    id: 'servidor',
    keywords: ['servidor', 'arrancar', 'encender', 'no carga', 'no se puede acceder', 'err_failed', 'localhost', 'caido', 'caído'],
    answer:
      'La app se levanta con `npm run dev` (o `npm run sirve`, que la mantiene viva y la reinicia si se cae) y se abre en http://localhost:3000. Si el navegador dice «no se puede acceder», el servidor estaba recompilando o se había parado: con `npm run sirve` queda vigilado y se recupera solo.',
  },
  {
    id: 'srs',
    keywords: ['repaso', 'srs', 'espaciado', 'retencion', 'retención', 'olvido', 'intervalo'],
    answer:
      'El repaso espaciado vive en /repaso. Cada repaso que valoras (Otra vez, Difícil, Bien, Fácil) reprograma el intervalo: acertar lo alarga y fallar lo devuelve a un día. Lo vencido sube en el planificador, y la analítica te dice qué recuerdas de verdad por tramo de intervalo.',
  },
  {
    id: 'retos',
    keywords: ['reto', 'retos', 'semanal', 'xp', 'nivel'],
    answer:
      'Los retos semanales están en /retos. Salen de tus datos (repasos vencidos, errores sin cerrar, exámenes con fecha, tus horas declaradas) y su progreso se mide solo con lo que registras. Cada uno conseguido paga XP y el nivel se calcula con esa XP.',
  },
  {
    id: 'apuntes',
    keywords: ['apunte', 'apuntes', 'cuaderno', 'notion', 'descargar', 'imprimir', 'catedratico escribe'],
    answer:
      'Los apuntes viven en /apuntes, cada asignatura en su apartado. Un catedrático IA puede proponerte escribirte uno: te pide permiso en el chat y, si aceptas, lo redacta y lo guarda en la sección de su materia, marcado como suyo. Desde ahí lo abres, lo descargas en Markdown o lo imprimes.',
  },
  {
    id: 'mantenimiento',
    keywords: ['mantenimiento', 'fallo', 'error', 'arreglar', 'roto', 'incongruencia', 'revisar sistema'],
    answer:
      'En /mantenimiento hay un taller que revisa el sistema: integridad de la base, temario duplicado o mal numerado, datos huérfanos y claves que falten. Detecta, explica y repara lo que se puede reparar en un clic. Y si algo te falla, se lo cuentas ahí y queda anotado con su contexto.',
  },
  {
    id: 'moodle',
    keywords: ['moodle', 'tareas', 'entregas', 'centros', 'ical', 'token', 'clave', 'sesion'],
    answer:
      'Moodle se conecta en /ajustes y hay dos puertas. Con tu usuario y contraseña de siempre: primero se le pide a Moodle la clave de Web Services y, si tu centro no lo permite (servicio móvil apagado o claves prohibidas al alumnado), la app entra por la sesión web como el navegador, así que funciona igual. Solo en ese segundo caso guarda tu contraseña, cifrada con la clave de tu equipo, para volver a entrar sola cada día (puedes marcar que no la guarde, y «Desconectar» la borra). Con ella te trae los apuntes que sube tu profesor y tus tareas con su fecha y si ya las has entregado. El botón «Comprobar mi Moodle» diagnostica la dirección sin pedir nada, y el enlace iCal sigue ahí como última alternativa.',
  },
  {
    id: 'privacidad',
    keywords: ['datos', 'privacidad', 'postgresql', 'base de datos', 'copia', 'backup', 'exportar', 'nube'],
    answer:
      'Tus datos viven en una base PostgreSQL privada: ni las notas ni los archivos se comparten salvo las peticiones a la IA que tú mismo lanzas. En /ajustes puedes revisar y exportar tu información.',
  },
];

/** Normaliza para comparar: minúsculas y sin acentos. */
export function normalizeForMatch(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ¿El mensaje parece una pregunta sobre la app? */
export function looksLikeSystemQuestion(message: string): boolean {
  const text = normalizeForMatch(message);
  if (text.length === 0) return false;
  if (/[?¿]/.test(message)) return true;
  return /(como|cómo|donde|dónde|que es|qué es|para que|sirve|funciona|ayuda|no me sale|no funciona|problema|fallo|error)/.test(
    text
  );
}

/**
 * Respuesta local a una pregunta sobre el sistema, o `null` si no hay nada que
 * encaje. Puntúa por palabras clave (cuantas más coincidencias, mejor) para que
 * «¿cómo cargo el temario?» no acabe hablando de Moodle.
 */
export function answerSystemQuestion(message: string): string | null {
  const text = normalizeForMatch(message);
  if (text.length === 0) return null;

  let best: { entry: SystemFaqEntry; score: number } | null = null;

  for (const entry of SYSTEM_FAQ) {
    let score = 0;
    for (const keyword of entry.keywords) {
      const needle = normalizeForMatch(keyword);
      if (needle.length === 0) continue;
      if (text.includes(needle)) {
        // Las palabras clave largas son más específicas: valen más.
        score += needle.includes(' ') ? 4 : needle.length >= 6 ? 3 : 2;
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { entry, score };
  }

  if (!best || best.score < 2) {
    return null;
  }
  return best.entry.answer;
}

/** La app contada para un prompt de IA: secciones + preguntas frecuentes. */
export function buildSystemKnowledgeForAi(): string {
  const lines: string[] = [];

  lines.push('LA APLICACIÓN (esto es lo que existe de verdad; responde con esto, no inventes secciones):');
  for (const section of SYSTEM_SECTIONS) {
    lines.push(`- ${section.path} · ${section.name}: ${section.what}`);
  }

  lines.push('');
  lines.push('CÓMO SE HACE CADA COSA (respuestas ya preparadas, úsalas cuando te pregunten por el sistema):');
  for (const entry of SYSTEM_FAQ) {
    lines.push(`- ${entry.answer}`);
  }

  lines.push('');
  lines.push(
    'Si te preguntan algo del sistema que no está aquí, dilo con claridad y señala dónde mirarlo; no te inventes pantallas ni botones.'
  );

  return lines.join('\n');
}
