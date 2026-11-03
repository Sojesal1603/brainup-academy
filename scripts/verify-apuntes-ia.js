/**
 * Verificación de los apuntes que escriben los catedráticos IA.
 *
 * Parte **offline** (siempre, sin gastar API): compila `src/lib/apuntesIa.ts`,
 * que es puro, y comprueba lo que decide si el trato con el alumno se respeta:
 *
 *   1. La **propuesta** `[[apunte:U4=Título]]` se extrae del texto visible en
 *      cualquiera de sus formas, y no se traga un mensaje sin título.
 *   2. La limpieza de etiquetas **no rompe el Markdown** (la indentación de las
 *      listas anidadas se conserva: es estructura, no decoración).
 *   3. El **título** se separa del cuerpo, y sin `# ` no se pierde contenido.
 *   4. El **contexto del cuaderno** lleva lo medido, los exámenes, los apuntes
 *      que ya tiene y el material del profesor; y cuando no hay medición lo dice
 *      en lugar de suponer un nivel.
 *   5. **El apunte va limpio.** `sanitizeNoteContent` no deja entrar vallas de
 *      código, HTML, etiquetas internas ni delimitadores que el cuaderno no
 *      pinta, y `noteQualityReport` mide lo que de verdad importa: cuerpo,
 *      apartados por punto y secciones imprescindibles.
 *
 * Parte **viva** (`--live`, consume API y requiere `npm run dev`): el permiso es
 * un contrato de verdad (sin confirmar → 403; sin unidad → 400; unidad de otra
 * asignatura → 404), la redacción deja un apunte en el cuaderno con su autor y
 * su formato, la descarga `.md` sale con sus cabeceras y la vista de impresión
 * responde. Al terminar borra el apunte de prueba.
 *
 * Uso:
 *   node scripts/verify-apuntes-ia.js           → solo lo offline (gratis)
 *   node scripts/verify-apuntes-ia.js --live    → además, el camino completo real
 */
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, '.tmp-verify-apuntes');
/** La app en vivo. Se puede apuntar a otro puerto con `BRAINUP_APP_URL`. */
const APP = process.env.BRAINUP_APP_URL || 'http://localhost:3000';
const LIVE = process.argv.includes('--live');

fs.rmSync(outDir, { recursive: true, force: true });

execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    path.join('src', 'lib', 'apuntesIa.ts'),
    path.join('src', 'lib', 'noteUnitMatch.ts'),
    '--outDir',
    '.tmp-verify-apuntes',
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck',
  ],
  { cwd: projectRoot, stdio: 'inherit' }
);

const apuntes = require(path.join(outDir, 'apuntesIa.js'));
const unidades = require(path.join(outDir, 'noteUnitMatch.js'));

let failures = 0;
const warnings = [];

function check(label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}${detail ? ` · ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` · ${detail}` : ''}`);
  }
}

function warn(text) {
  warnings.push(text);
  console.log(`  ! ${text}`);
}

/* ------------------------------------------------------------------ */
/* 1-4: puro, sin red                                                 */
/* ------------------------------------------------------------------ */

function offline() {
  console.log('1) La propuesta de apunte: el catedrático pide permiso');
  const atEnd = apuntes.parseNoteProposal('Te vendría bien tenerlo por escrito. ¿Te escribo unos apuntes? [[apunte:U4=Límites y continuidad]]');
  check('etiqueta al final: se extrae y desaparece del texto', atEnd.proposal && atEnd.proposal.unitNumber === 4 && atEnd.proposal.title === 'Límites y continuidad', JSON.stringify(atEnd.proposal));
  check('el texto visible queda limpio', !atEnd.text.includes('[['), JSON.stringify(atEnd.text.slice(-40)));
  check('y conserva la pregunta al alumno', /¿Te escribo unos apuntes\?/.test(atEnd.text));

  const withoutU = apuntes.parseNoteProposal('¿Te los preparo? [[apunte:7=Derivadas]]');
  check('acepta el número de unidad sin la U', withoutU.proposal && withoutU.proposal.unitNumber === 7);

  const inMiddle = apuntes.parseNoteProposal('Puedo escribirte [[apunte:U2=Matrices]] si quieres, tú decides.');
  check('también si la cuela en medio de la frase', inMiddle.proposal && inMiddle.proposal.title === 'Matrices', JSON.stringify(inMiddle.proposal));
  check('y la quita del texto de en medio', !inMiddle.text.includes('[[') && /tú decides/.test(inMiddle.text), JSON.stringify(inMiddle.text));

  const none = apuntes.parseNoteProposal('Sigamos con el ejercicio 3.');
  check('sin etiqueta no hay propuesta', none.proposal === null && none.text === 'Sigamos con el ejercicio 3.');

  const empty = apuntes.parseNoteProposal('¿Te los escribo? [[apunte:U4=   ]]');
  check('una propuesta sin título no vale', empty.proposal === null);

  console.log('\n2) La limpieza de etiquetas no rompe el Markdown');
  const nested = ['- Paso 1', '  - subpaso a', '\t- subpaso b', '- Paso 2'].join('\n');
  check(
    'conserva la indentación de las listas anidadas',
    apuntes.stripHiddenTags(nested) === nested,
    JSON.stringify(apuntes.stripHiddenTags(nested))
  );
  const withTags = 'Toma la pista. [[nivel:U4=55]]\n\n  - sigue aquí\n[[etapa:pista_1]]';
  const cleaned = apuntes.stripHiddenTags(withTags);
  check('quita las tres etiquetas', !/\[\[/.test(cleaned), JSON.stringify(cleaned));
  check('y no toca la lista indentada', cleaned.includes('\n  - sigue aquí'));
  check(
    'colapsa espacios dobles solo dentro de la línea',
    apuntes.stripHiddenTags('Deja   sitio   aquí') === 'Deja sitio aquí'
  );

  console.log('\n3) El título se separa del cuerpo (una sola vez en el cuaderno)');
  const withH1 = apuntes.splitNoteTitle('# Derivadas\n\n> Qué es.\n\n## Lo que tienes que saber\n- algo', 'respaldo');
  check('el título sale del `# `', withH1.title === 'Derivadas', withH1.title);
  check('y el cuerpo empieza después del título', !withH1.content.startsWith('# Derivadas') && withH1.content.startsWith('> Qué es.'), JSON.stringify(withH1.content.slice(0, 30)));

  const styled = apuntes.splitNoteTitle('# **Límites** y `continuidad`\n\ncuerpo', 'respaldo');
  check('limpia negritas y código del título', styled.title === 'Límites y continuidad', styled.title);

  const noH1 = apuntes.splitNoteTitle('> Empieza directo\n\nsin título', 'Límites');
  check('sin `# ` usa el título propuesto', noH1.title === 'Límites');
  check('y no se pierde ni un párrafo del cuerpo', noH1.content.startsWith('> Empieza directo'), JSON.stringify(noH1.content.slice(0, 24)));

  const emptyH1 = apuntes.splitNoteTitle('#   \n\nsolo cuerpo', 'Límites');
  check('un `# ` vacío cae al título propuesto', emptyH1.title === 'Límites' && emptyH1.content.includes('solo cuerpo'));

  console.log('\n4) El contexto del cuaderno: qué sabe antes de escribir');
  const rich = apuntes.buildNotebookContext({
    studentName: 'Santiago',
    subjectName: 'Matemáticas I',
    unit: { title: 'Límites', unitNumber: 4, status: 'en_curso' },
    syllabus: [
      { unitNumber: 1, title: 'Números reales', status: 'visto' },
      { unitNumber: 4, title: 'Límites', status: 'en_curso' },
    ],
    measuredTopics: [{ title: 'Derivadas', unitNumber: 3, masteryLevel: 38, source: 'simulacro' }],
    upcomingExams: [{ title: 'Examen de límites', examType: 'parcial', days: 6 }],
    existingNotes: [
      { title: 'Resumen de derivadas', unitNumber: 3, author: 'alumno' },
      { title: 'Apunte mío de límites', unitNumber: 4, author: 'catedratico' },
    ],
    existingNoteExcerpts: [{ title: 'Resumen de derivadas', excerpt: 'regla de la cadena' }],
    teacherMaterials: [{ name: 'Ejercicios 4.pdf', sectionName: 'Tema 4' }],
    focus: 'se me atragantan los límites laterales',
  }).join('\n');

  check('dice la unidad y su estado en clase', /U4 «Límites»/.test(rich) && /en_curso/.test(rich));
  check('marca su unidad floja medida, con el porcentaje', /«Derivadas» \(U3\) 38%/.test(rich), 'Derivadas 38%');
  check(
    'pone los exámenes con su tipo y los días que quedan',
    /Examen de límites \(parcial\) en 6 días/.test(rich),
    (rich.split('\n').find((line) => line.startsWith('Exámenes a la vista')) ?? '').slice(0, 80)
  );
  check('lista los apuntes que YA tiene, marcando los del catedrático', /«Resumen de derivadas» \(U3\)/.test(rich) && /«Apunte mío de límites» \(U4\) \[tuyo\]/.test(rich));
  check('le dice que no duplique', /NO repitas su contenido/.test(rich));
  check('cita el material del profesor sin inventarlo', /Ejercicios 4\.pdf/.test(rich) && /NO inventes su contenido/.test(rich));
  check('incluye el enfoque que ha pedido el alumno', /límites laterales/.test(rich));

  const emptyContext = apuntes.buildNotebookContext({
    studentName: 'Santiago',
    subjectName: 'Física',
    unit: null,
    syllabus: [],
    measuredTopics: [],
    upcomingExams: [],
    existingNotes: [],
    existingNoteExcerpts: [],
    teacherMaterials: [],
    focus: null,
  }).join('\n');
  check(
    'sin mediciones NO le supone un nivel: se lo prohíbe',
    /No hay ninguna medición real/.test(emptyContext) && /no supongas/.test(emptyContext)
  );
  check(
    'y avisa de que sería su primer apunte de la asignatura',
    /no tiene ningún apunte/.test(emptyContext)
  );

  /*
   * CÓMO LO EXPLICÓ EL PROFESOR.
   *
   * Es el dato que ata el apunte al aula: sin él, el catedrático escribe un
   * temario genérico (correcto) que no tiene por qué parecerse a la notación ni
   * a los pasos que exige el profesor que le corrige. Tiene que llegar al
   * redactor con prioridad explícita, y no llegar cuando no hay nada anotado.
   */
  const conMetodo = apuntes
    .buildNotebookContext({
      studentName: 'Santiago',
      subjectName: 'Matemáticas I',
      unit: { title: 'Trigonometría', unitNumber: 3, status: 'visto' },
      syllabus: [],
      measuredTopics: [],
      upcomingExams: [],
      existingNotes: [],
      existingNoteExcerpts: [],
      teacherMaterials: [],
      teacherMethodology: 'Exige la fórmula antes de sustituir y vectores con flecha.',
      focus: null,
    })
    .join('\n');
  check(
    'el método del profesor entra en el prompt con prioridad',
    /METODOLOGÍA DEL PROFESOR DE CLASE/.test(conMetodo) &&
      /prioridad absoluta/i.test(conMetodo) &&
      /vectores con flecha/.test(conMetodo)
  );
  check(
    'y sin nada anotado no se lo inventa ni lo menciona',
    !/METODOLOGÍA DEL PROFESOR/.test(emptyContext)
  );

  /*
   * Los apartados se piden por su TÍTULO, no por el icono: el prompt se decora
   * con emojis a propósito (es la estética del cuaderno Notion), así que exigir
   * la cadena exacta «## Fórmulas y reglas» ataba la prueba a una decoración y
   * fallaba en cuanto se mejoraba la estética. Lo que no puede faltar es el
   * apartado.
   */
  check(
    'el prompt de redacción exige la estructura completa',
    // Sin anclar al principio de línea: en el prompt los apartados van
    // numerados dentro de una lista («5. `## ⚡ Fórmulas…`»), y lo que importa es
    // que el apartado esté exigido, no dónde se escriba la instrucción.
    /## .*Fórmulas/.test(apuntes.NOTE_WRITER_INSTRUCTIONS) &&
      /## .*Errores que te van a costar puntos/.test(apuntes.NOTE_WRITER_INSTRUCTIONS) &&
      /## .*Compruébalo tú/.test(apuntes.NOTE_WRITER_INSTRUCTIONS)
  );
  check(
    'exige LaTeX y exactitud (nada inventado)',
    /LaTeX/.test(apuntes.NOTE_WRITER_INSTRUCTIONS) &&
      /EXACTO/i.test(apuntes.NOTE_WRITER_INSTRUCTIONS)
  );
  // El contrato cambió: el apunte ya no lleva HTML ni vallas, y el cuerpo va
  // desarrollado punto por punto (un `### ` por cada punto del tema).
  check(
    'y exige el desarrollo punto por punto',
    /## .*Desarrollo de la unidad/.test(apuntes.NOTE_WRITER_INSTRUCTIONS) &&
      /### /.test(apuntes.NOTE_WRITER_INSTRUCTIONS) &&
      // El margen concreto puede ajustarse; lo que tiene que haber es un margen
      // de palabras POR PUNTO (si desaparece, el apunte vuelve a ser un resumen).
      /entre \d+ y \d+ palabras por punto/i.test(apuntes.NOTE_WRITER_INSTRUCTIONS)
  );
  check(
    'prohíbe el código dentro del apunte (vallas y HTML)',
    /PROHIBIDO Y ELIMINADO/.test(apuntes.NOTE_WRITER_INSTRUCTIONS) &&
      /vallas/.test(apuntes.NOTE_WRITER_INSTRUCTIONS) &&
      /etiquetas HTML/.test(apuntes.NOTE_WRITER_INSTRUCTIONS)
  );
  // Ojo: el prompt SÍ nombra `<details>`… para prohibirlo. Lo que no puede es
  // pedirlo: la frase que pedía el desplegable tenía que desaparecer.
  check(
    'y ya no le pide desplegables `<details>` en el apunte',
    !/<details><summary>/.test(apuntes.NOTE_WRITER_INSTRUCTIONS) &&
      !/Respuesta<\/summary>/.test(apuntes.NOTE_WRITER_INSTRUCTIONS) &&
      /etiquetas HTML/.test(apuntes.NOTE_WRITER_INSTRUCTIONS)
  );
  check(
    'las respuestas de Active Recall van como `**Respuesta:**`',
    /\*\*Respuesta:\*\*/.test(apuntes.NOTE_WRITER_INSTRUCTIONS)
  );

  // El segundo intento: cuando el primero sale sin estructura, se le dice qué
  // faltaba. El primero va limpio, sin corrección que le confunda.
  const writerInput = {
    studentName: 'Santiago',
    subjectName: 'Matemáticas I',
    unit: { title: 'Límites', unitNumber: 4, status: 'en_curso' },
    syllabus: [],
    measuredTopics: [],
    upcomingExams: [],
    existingNotes: [],
    existingNoteExcerpts: [],
    teacherMaterials: [],
    focus: null,
    proposedTitle: 'Límites',
  };
  const firstTry = apuntes.buildNoteWriterUserMessage(writerInput);
  const secondTry = apuntes.buildNoteWriterUserMessage(writerInput, 'faltaba esto: «Ejemplo resuelto»');
  check('el primer intento va sin corrección', !firstTry.includes('CORRECCIÓN'));
  check(
    'el segundo intento dice qué faltaba, y lo dice al final',
    secondTry.includes('CORRECCIÓN DEL INTENTO ANTERIOR') &&
      secondTry.includes('«Ejemplo resuelto»') &&
      secondTry.indexOf('CORRECCIÓN') > secondTry.indexOf('Escribe los apuntes')
  );
  check(
    'y los dos piden el apunte entero con su estructura',
    firstTry.includes('# Título') && secondTry.includes('## Desarrollo de la unidad')
  );
}

/* ------------------------------------------------------------------ */
/* 5: el apunte limpio (offline)                                      */
/* ------------------------------------------------------------------ */

/** ¿Queda alguna etiqueta HTML en el texto? (La guarda del `<` evita falsos positivos con «x < y».) */
function tieneHtml(text) {
  return /<\/?[a-zA-Z][^<>]*>/.test(String(text ?? ''));
}

/**
 * Explicación larga y de verdad. Hace falta porque la puerta de calidad pide
 * >= 900 palabras: un fixture corto no probaría nada, solo fallaría la puerta.
 */
const EXPLICACION = [
  'La continuidad de una función en un punto exige tres condiciones que se cumplen a la vez: que el valor de la función exista en ese punto, que exista el límite cuando la variable se acerca a él por cualquier camino y que ese límite coincida con el valor.',
  'Cuando alguna de las tres falla, la función tiene una discontinuidad, y el tipo de discontinuidad dice mucho de lo que se puede hacer con ella: una discontinuidad evitable se arregla redefiniendo el valor en ese punto, una de salto se queda como está y una asintótica marca una recta que la curva no llega a tocar nunca.',
  'Para trabajar con continuidad conviene dibujar antes de calcular, porque el esbozo avisa de dónde está el problema y evita perder el tiempo operando con una expresión que ya se ve que tiene un agujero.',
].join(' ');

const APLICACION = [
  'En la práctica se estudian los límites laterales por separado: si los dos coinciden, el límite existe y basta compararlo con el valor de la función; si no coinciden, la discontinuidad es de salto y su tamaño es la diferencia entre ambos.',
  'Ese par de números se escribe siempre en la respuesta, porque el corrector los busca y un resultado sin ellos se queda a medias aunque el dibujo esté perfecto.',
].join(' ');

/** Un punto del tema, desarrollado como lo pide el prompt: definición, por qué y aplicación. */
function puntoDesarrollo(numero, titulo, matiz) {
  return [`### ${numero}. ${titulo}`, '', matiz, '', EXPLICACION, '', APLICACION, ''].join('\n');
}

/** Apunte completo de mentira, tan largo como uno de verdad. */
const APUNTE_COMPLETO = [
  '> La continuidad y sus discontinuidades: qué son, cómo se detectan y cómo se clasifican antes de entrar en el examen.',
  '',
  '## Lo que tienes que saber',
  '',
  '- **Continuidad**: hay continuidad cuando el límite existe, la función está definida en el punto y los dos valores coinciden.',
  '- **Discontinuidad evitable**: el límite existe pero no coincide con el valor de la función, o el valor no existe.',
  '',
  '## Desarrollo de la unidad',
  '',
  puntoDesarrollo(1, 'Continuidad en un punto', 'Es la definición madre: sin ella no se entiende ninguna de las otras.'),
  puntoDesarrollo(2, 'Límites laterales', 'Permiten decidir si el límite existe sin depender del dibujo.'),
  puntoDesarrollo(3, 'Discontinuidad evitable', 'El caso que se arregla redefiniendo un solo valor.'),
  puntoDesarrollo(4, 'Discontinuidad de salto', 'El caso en el que los laterales no coinciden y el salto se mide.'),
  puntoDesarrollo(5, 'Asíntotas verticales', 'Donde la función se escapa y la continuidad se rompe sin remedio.'),
  puntoDesarrollo(6, 'Continuidad en un intervalo', 'El resultado que permite aplicar los teoremas clásicos en un examen.'),
  '## Fórmulas y reglas',
  '',
  '| Fórmula | Cuándo se usa |',
  '| :--- | :--- |',
  '| $\\lim_{x\\to a} f(x) = f(a)$ | continuidad en el punto $a$ |',
  '',
  '## Cómo se hace (método)',
  '',
  '1. Comprueba si la función está definida en el punto.',
  '2. Calcula los dos límites laterales.',
  '3. Compara y clasifica la discontinuidad.',
  '',
  '## Ejemplo resuelto',
  '',
  'Se pide estudiar la continuidad de una función definida a trozos con un salto en el punto dos. Se calcula el límite por la izquierda, se calcula por la derecha, se comparan los dos con el valor y se concluye que la discontinuidad es de salto finito de tamaño uno.',
  '',
  '## Errores que te van a costar puntos',
  '',
  '- Confundir el límite con el valor de la función en el punto.',
  '- Olvidar uno de los dos laterales y dar por hecho el resultado.',
  '',
  '## Compruébalo tú',
  '',
  '1. ¿Qué tres condiciones pide la continuidad en un punto?',
  '',
  '**Respuesta:** Que el límite exista, que el valor esté definido en el punto y que los dos coincidan.',
].join('\n');

/* ------------------------------------------------------------------ */
/* 6: de qué unidad son los apuntes                                   */
/* ------------------------------------------------------------------ */

/**
 * Temario real de Física y Química, recortado a las unidades que importan aquí.
 * Es el caso que reportó el alumno: pidió apuntes de química orgánica y la vista
 * previa le enseñó los de trabajo mecánico.
 */
const TEMARIO_FQ = [
  { id: 'u4', unitNumber: 4, title: 'Formulación y nomenclatura inorgánica' },
  { id: 'u9', unitNumber: 9, title: 'Química orgánica: grupos funcionales y formulación' },
  { id: 'u10', unitNumber: 10, title: 'Isomería y series homólogas' },
  { id: 'u16', unitNumber: 16, title: 'Trabajo, energía y potencia: conservación' },
];

function offlineUnidad() {
  console.log('\n6) La unidad de los apuntes: el título corrige al número equivocado');

  check(
    'las palabras de relleno y los números no cuentan',
    JSON.stringify(unidades.significantTokens('Unidad 9 · Química orgánica')) === JSON.stringify(['quimica', 'organica']),
    JSON.stringify(unidades.significantTokens('Unidad 9 · Química orgánica'))
  );

  // EL CASO REPORTADO: propuesta U16 (la unidad que da en clase), título de química orgánica.
  const organica = unidades.resolveNoteUnit(TEMARIO_FQ, {
    unitNumber: 16,
    title: 'Química del carbono: formulación y nomenclatura',
  });
  check(
    'le piden orgánica, la propuesta dice U16 y se escriben los de la U9',
    organica.unit && organica.unit.id === 'u9' && organica.corrected === true,
    organica.unit ? `U${organica.unit.unitNumber} · ${organica.unit.title}` : 'sin unidad'
  );
  check('y queda dicho de qué unidad se ha corregido', organica.numbered && organica.numbered.id === 'u16');

  const exacto = unidades.resolveNoteUnit(TEMARIO_FQ, {
    unitNumber: 16,
    title: 'Química orgánica: grupos funcionales y formulación',
  });
  check(
    'con el título exacto de la unidad también acierta',
    exacto.unit && exacto.unit.id === 'u9' && exacto.corrected === true
  );

  const correcto = unidades.resolveNoteUnit(TEMARIO_FQ, {
    unitNumber: 16,
    title: 'Trabajo, energía y potencia',
  });
  check(
    'si el número ya es el bueno, no se toca',
    correcto.unit && correcto.unit.id === 'u16' && correcto.corrected === false,
    correcto.unit ? `U${correcto.unit.unitNumber}` : 'sin unidad'
  );

  const generico = unidades.resolveNoteUnit(TEMARIO_FQ, {
    unitNumber: 16,
    title: 'Apuntes completos de la unidad',
  });
  check(
    'un título genérico no mueve la unidad (no se adivina)',
    generico.unit && generico.unit.id === 'u16' && generico.corrected === false,
    generico.unit ? `U${generico.unit.unitNumber}` : 'sin unidad'
  );

  const ambiguo = unidades.resolveNoteUnit(TEMARIO_FQ, { unitNumber: 16, title: 'Formulación' });
  check(
    'si el título empata entre dos unidades, se queda la del número',
    ambiguo.unit && ambiguo.unit.id === 'u16' && ambiguo.corrected === false,
    ambiguo.unit ? `U${ambiguo.unit.unitNumber}` : 'sin unidad'
  );

  const sinNumero = unidades.resolveNoteUnit(TEMARIO_FQ, { unitNumber: 99, title: 'Isomería y series homólogas' });
  check(
    'si el número no existe, el título sí encuentra la unidad',
    sinNumero.unit && sinNumero.unit.id === 'u10' && sinNumero.corrected === true,
    sinNumero.unit ? `U${sinNumero.unit.unitNumber}` : 'sin unidad'
  );

  const otraMateria = unidades.resolveNoteUnit(TEMARIO_FQ, {
    unitNumber: 16,
    title: 'La Celestina y el teatro medieval',
  });
  check(
    'un título de otra asignatura no la busca: nunca se inventa una unidad',
    otraMateria.unit && otraMateria.unit.id === 'u16' && otraMateria.corrected === false
  );
  check(
    'sin temario no hay unidad que dar',
    unidades.resolveNoteUnit([], { unitNumber: 9, title: 'Química orgánica' }).unit === null
  );
}

function offlineLimpieza() {
  console.log('\n5) El apunte limpio: ni un resto de código dentro');

  // --- Vallas de código: una fórmula vuelve como fórmula, el texto como texto ---
  const vallaMath = ['## Fórmulas', '', '```latex', '\\frac{a}{b} = c', '```'].join('\n');
  const mathOut = apuntes.sanitizeNoteContent(vallaMath);
  check(
    'una valla con LaTeX vuelve como fórmula de verdad',
    mathOut.includes('$$\\frac{a}{b} = c$$'),
    JSON.stringify(mathOut)
  );
  check('y la valla desaparece', !mathOut.includes('```'), JSON.stringify(mathOut));

  const vallaTexto = [
    '## Cómo se hace',
    '',
    '```text',
    'Primero se dibuja el diagrama y después se aplica la regla del cociente.',
    '```',
  ].join('\n');
  const proseOut = apuntes.sanitizeNoteContent(vallaTexto);
  check(
    'una valla con texto NO se lleva por delante el contenido',
    proseOut.includes('Primero se dibuja el diagrama y después se aplica la regla del cociente.') &&
      !proseOut.includes('```'),
    JSON.stringify(proseOut)
  );
  check('y el resto del apunte sigue en su sitio', proseOut.startsWith('## Cómo se hace'));

  // --- Desplegables viejos: la forma que el cuaderno pinta, sin HTML ---
  const legacy = [
    '1. ¿Qué pide la continuidad?',
    '',
    '<details><summary>Respuesta</summary>Que el límite y el valor coincidan.</details>',
  ].join('\n');
  const legacyOut = apuntes.sanitizeNoteContent(legacy);
  check(
    'un desplegable viejo pasa a la forma limpia',
    legacyOut.includes('**Respuesta:** Que el límite y el valor coincidan.'),
    JSON.stringify(legacyOut)
  );
  check('y no sobrevive ni una etiqueta HTML', !tieneHtml(legacyOut), JSON.stringify(legacyOut));

  const legacyLabel = apuntes.sanitizeNoteContent(
    '<details><summary>Solución</summary>Se igualan los laterales.</details>'
  );
  check(
    'con otra etiqueta se respeta el nombre que puso el modelo',
    legacyLabel.includes('**Solución:** Se igualan los laterales.'),
    JSON.stringify(legacyLabel)
  );

  // --- Delimitadores que el cuaderno no pinta ---
  const delims = apuntes.sanitizeNoteContent('En línea \\(x^2\\) y destacada \\[y = mx + n\\].');
  check(
    'los delimitadores `\\( \\)` y `\\[ \\]` se convierten a `$` y `$$`',
    delims.includes('$x^2$') && delims.includes('$$y = mx + n$$'),
    JSON.stringify(delims)
  );

  // --- Etiquetas internas del sistema ---
  const tags = apuntes.sanitizeNoteContent(
    'Toma la pista. [[etapa:pista_1]]\n\n[[nivel:U4=55]]\n\n[[apunte:U4=Límites y continuidad]]\n\nContenido de verdad.'
  );
  check('ninguna etiqueta interna llega al apunte guardado', !tags.includes('[['), JSON.stringify(tags));

  // --- Escapes literales: el «\n» de dos caracteres y la LaTeX que NO hay que tocar ---
  const escaped = apuntes.sanitizeNoteContent(
    'Primer párrafo.\\n\\n## Lo que tienes que saber\\n\\n- Una idea con \\nabla f y otra con \\nu.'
  );
  check(
    'los «\\n» de dos caracteres vuelven a ser saltos de línea',
    // El filtro tiene que ser preciso: `\n` suelto no puede quedar, pero `\nu` y
    // `\nabla` también contienen una «n» detrás de una barra y están bien así.
    escaped.includes('\n\n## Lo que tienes que saber') && !/\\n(?![a-zA-Z])/.test(escaped),
    JSON.stringify(escaped.slice(0, 60))
  );
  check(
    'y los comandos de LaTeX \\nabla o \\nu NO se destrozan',
    escaped.includes('\\nabla f') && escaped.includes('\\nu'),
    JSON.stringify(escaped)
  );

  // --- Fórmulas, dólares equilibrados y tablas ---
  const mixed = [
    '## Fórmulas',
    '',
    '```latex',
    '\\frac{a}{b} = \\sqrt{c}',
    '```',
    '',
    'En línea \\(x^2\\) y una tabla:',
    '',
    '| Fórmula | Uso |',
    '| :--- | :--- |',
    '| $\\lim_{x\\to 0} f(x)$ | siempre |',
  ].join('\n');
  const mixedOut = apuntes.sanitizeNoteContent(mixed);
  const dollars = (mixedOut.match(/\$/g) ?? []).length;
  check(
    'la fórmula sobrevive con sus llaves y sus comandos',
    mixedOut.includes('\\frac{a}{b} = \\sqrt{c}') && mixedOut.includes('\\lim_{x\\to 0} f(x)'),
    JSON.stringify(mixedOut)
  );
  check('y los delimitadores quedan equilibrados', dollars % 2 === 0 && dollars >= 6, `${dollars} símbolos $`);
  check(
    'la tabla se queda como tabla',
    mixedOut.includes('| Fórmula | Uso |') && mixedOut.includes('| :--- | :--- |')
  );

  // --- Aire: nada que se vea raro al imprimir ---
  const messy = ['---', '', '# Título   ', '', '', '', '## Sección', '', '', 'Texto con espacios al final   ', '', '', '---'].join('\n');
  const tidy = apuntes.sanitizeNoteContent(messy);
  check(
    'sin espacios al final de línea',
    tidy.split('\n').every((line) => line === line.replace(/[ \t]+$/, '')),
    JSON.stringify(tidy)
  );
  check('sin tres saltos de línea seguidos', !tidy.includes('\n\n\n'));
  check(
    'sin separadores sueltos al principio ni al final',
    !tidy.startsWith('---') && !tidy.endsWith('---'),
    JSON.stringify(tidy)
  );
  check(
    'y el contenido sigue ahí',
    tidy.includes('# Título') && tidy.includes('## Sección') && tidy.includes('Texto con espacios al final')
  );

  // --- Limpiar dos veces no puede cambiar nada ---
  const nasty = [vallaMath, '', legacy, '', delims, '', escaped, '', mixed, '', messy].join('\n\n');
  const once = apuntes.sanitizeNoteContent(nasty);
  const twice = apuntes.sanitizeNoteContent(once);
  check('limpiar dos veces da el mismo apunte', once === twice, `${once.length} vs ${twice.length} caracteres`);

  // --- Un apunte que ya está bien sale intacto (byte a byte) ---
  const bienFormado = [
    '> Resumen de la unidad.',
    '',
    '## Lo que tienes que saber',
    '',
    '- **Definición**: una función $f$ es continua en $x_0$ si $\\lim_{x\\to x_0} f(x) = f(x_0)$.',
    '',
    '## Desarrollo de la unidad',
    '',
    '### 1. Continuidad',
    '',
    'Explicación con una fórmula en línea $a^2 + b^2 = c^2$ y nada más.',
    '',
    '## Compruébalo tú',
    '',
    '1. ¿Qué significa que una función sea continua en un punto?',
    '',
    '**Respuesta:** Que el límite coincida con el valor de la función en ese punto.',
    '',
    '| Fórmula | Cuándo se usa |',
    '| :--- | :--- |',
    '| $f(x)$ | siempre |',
  ].join('\n');
  check(
    'un apunte que ya está bien sale intacto, byte a byte',
    apuntes.sanitizeNoteContent(bienFormado) === bienFormado,
    JSON.stringify(apuntes.sanitizeNoteContent(bienFormado).slice(0, 60))
  );

  // --- La puerta de calidad ---
  const quality = apuntes.noteQualityReport(APUNTE_COMPLETO);
  check(
    'un apunte completo pasa la puerta de calidad',
    quality.ok === true,
    `${quality.words} palabras · ${quality.sections.length} secciones · ${quality.developedPoints} apartados${
      quality.missing.length > 0 ? ` · falta: ${quality.missing.join(', ')}` : ''
    }`
  );
  check(
    'y lo mide de verdad: cuerpo, apartados y secciones',
    quality.words >= 900 && quality.developedPoints >= 6 && quality.sections.length >= 6
  );
  check('un apunte completo no tiene nada que reprocharle', quality.structureMissing.length === 0, quality.structureMissing.join(', '));

  // El caso que sí hay que atrapar: un apunte con CUERPO (no es un esquema de
  // cuatro líneas) pero sin los puntos desarrollados. Es el resumen que se
  // guarda demasiado a menudo y no es lo que se le ha pedido al catedrático.
  // Un párrafo largo de verdad (el mismo texto dos veces, que aquí es relleno
  // honesto: lo que se comprueba es la ESTRUCTURA, no la prosa).
  const parrafo = `${EXPLICACION} ${APLICACION}`;
  const sinDesarrollo = [
    '> Resumen de la unidad.',
    '',
    '## Lo que tienes que saber',
    '',
    parrafo,
    '',
    parrafo,
    '',
    '## Fórmulas y reglas',
    '',
    '| Fórmula | Cuándo se usa |',
    '| :--- | :--- |',
    '| $f(x)$ | siempre |',
    '',
    '## Cómo se hace (método)',
    '',
    parrafo,
    '',
    parrafo,
    '',
    '## Ejemplo resuelto',
    '',
    parrafo,
    '',
    parrafo,
    '',
    '## Errores que te van a costar puntos',
    '',
    parrafo,
    '',
    '## Compruébalo tú',
    '',
    '1. ¿Qué se mira primero?',
    '',
    '**Respuesta:** que el límite y el valor coincidan.',
  ].join('\n');
  const resumen = apuntes.noteQualityReport(sinDesarrollo);
  check(
    'un resumen con cuerpo pero sin el desarrollo punto por punto NO pasa la puerta',
    resumen.ok === false && resumen.words >= 900,
    `${resumen.words} palabras · ${resumen.developedPoints} apartados · falta: ${resumen.missing.join(', ')}`
  );
  check(
    'y lo que le falta se llama por su nombre, sin confundirlo con la extensión',
    resumen.structureMissing.length === 2 &&
      resumen.structureMissing.some((item) => /Desarrollo de la unidad/.test(item)) &&
      resumen.structureMissing.some((item) => /apartado por apartado/.test(item)) &&
      !resumen.structureMissing.some((item) => /más contenido/.test(item)),
    resumen.structureMissing.join(' · ')
  );

  // Y con los apartados puestos pero pocos (dos), sigue faltando lo mismo: el
  // umbral es 3, no «alguno».
  const dosApartados = APUNTE_COMPLETO.replace(/^### 3\..*\n/m, '').replace(/^### 4\..*\n/m, '').replace(/^### 5\..*\n/m, '').replace(/^### 6\..*\n/m, '');
  const flojos = apuntes.noteQualityReport(dosApartados);
  check(
    'con menos de tres apartados tampoco',
    flojos.structureMissing.some((item) => /apartado por apartado/.test(item)),
    `${flojos.developedPoints} apartados`
  );
  check(
    'y el aviso del taller tiene nombre propio',
    /^\[auto\]/.test(apuntes.NOTE_INCOMPLETE_ISSUE_TITLE) && /apunte/i.test(apuntes.NOTE_INCOMPLETE_ISSUE_TITLE),
    apuntes.NOTE_INCOMPLETE_ISSUE_TITLE
  );

  const esquema = [
    '## Lo que tienes que saber',
    '- cuatro cosas sueltas',
    '',
    '## Desarrollo de la unidad',
    '### 1. Algo',
    '',
    '## Ejemplo resuelto',
    '- un ejercicio enunciado y sin resolver',
    '',
    '## Compruébalo tú',
    '1. ¿Y esto?',
  ].join('\n');
  const esquemaQuality = apuntes.noteQualityReport(esquema);
  check(
    'un esquema con los títulos pero sin cuerpo NO pasa',
    esquemaQuality.ok === false && esquemaQuality.missing.some((item) => /más contenido/.test(item)),
    `${esquemaQuality.words} palabras · falta: ${esquemaQuality.missing.join(', ')}`
  );
  check(
    'y dice exactamente qué le falta',
    esquemaQuality.missing.some((item) => /apartado por apartado/.test(item)),
    esquemaQuality.missing.join(' · ')
  );
}

/* ------------------------------------------------------------------ */
/* 6-8: vivo, contra la app                                           */
/* ------------------------------------------------------------------ */

async function live() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  const agent = await prisma.aiAgent.findFirst({ include: { subject: true } });
  if (!agent) {
    warn('No hay ningún catedrático IA en la base: la parte viva se omite.');
    await prisma.$disconnect();
    return;
  }

  const topic = await prisma.topic.findFirst({
    where: { subjectId: agent.subjectId, unitNumber: { not: null } },
    orderBy: { unitNumber: 'asc' },
  });
  const otherTopic = await prisma.topic.findFirst({
    where: { subjectId: { not: agent.subjectId } },
  });

  const post = async (body) => {
    const res = await fetch(`${APP}/api/tutor/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };

  let createdNoteId = null;

  try {
    console.log('\n6) El permiso es un contrato, no un adorno');
    const noPermission = await post({ agentId: agent.id, unitNumber: topic?.unitNumber ?? 1, title: 'Prueba' });
    check('sin el «sí» del alumno no se escribe nada', noPermission.status === 403, `HTTP ${noPermission.status}`);
    check('y se explica por qué', /permiso/i.test(noPermission.data?.error ?? ''), noPermission.data?.error);

    const noUnit = await post({ agentId: agent.id, confirmed: true });
    check('sin unidad no sabe de qué escribir', noUnit.status === 400, `HTTP ${noUnit.status}`);

    if (otherTopic) {
      const foreign = await post({ agentId: agent.id, confirmed: true, topicId: otherTopic.id, title: 'Prueba' });
      check(
        'un catedrático no escribe de una asignatura que no es suya',
        foreign.status === 404,
        `HTTP ${foreign.status}`
      );
    } else {
      warn('No hay otra asignatura con unidades: el rechazo por asignatura ajena se omite.');
    }

    const unknownAgent = await post({ agentId: 'no-existe', confirmed: true, unitNumber: 1, title: 'Prueba' });
    check('un catedrático que no existe no redacta nada', unknownAgent.status === 404, `HTTP ${unknownAgent.status}`);

    console.log(`\n7) La redacción real (${agent.subject.name} · U${topic?.unitNumber ?? '?'} «${topic?.title ?? ''}»)`);
    if (!topic) {
      warn('La asignatura no tiene unidades numeradas: la redacción real se omite.');
      return;
    }

    const before = await prisma.note.count();
    const written = await post({
      agentId: agent.id,
      unitNumber: topic.unitNumber,
      title: topic.title,
      confirmed: true,
      focus: 'los errores típicos de examen',
    });

    check('redacta y guarda el apunte', written.status === 200 && written.data?.ok === true, `HTTP ${written.status} ${written.data?.error ?? ''}`);
    createdNoteId = written.data?.note?.id ?? null;

    const note = createdNoteId ? await prisma.note.findUnique({ where: { id: createdNoteId } }) : null;
    check('el apunte está en la base', Boolean(note));
    check('queda marcado como escrito por el catedrático', note?.author === 'catedratico', note?.author);
    check('y con su agente, para saber de quién es', note?.agentId === agent.id);

    if (note) {
      check(
        'cuelga de la unidad correcta de SU asignatura',
        note.topicId === topic.id,
        `${note.topicId === topic.id ? 'unidad correcta' : 'unidad equivocada'}`
      );
      check('no repite el título dentro del contenido', !/^#\s/.test(note.content.trim()), JSON.stringify(note.content.trim().slice(0, 40)));
      check('el título no viene vacío', note.title.trim().length > 0, note.title);
      check('el cuerpo tiene secciones de verdad', (note.content.match(/^##\s/gm) ?? []).length >= 4, `${(note.content.match(/^##\s/gm) ?? []).length} secciones`);
      check('incluye fórmulas en LaTeX para KaTeX', /\$[^$]+\$/.test(note.content));
      // El apunte guardado no puede llevar ni una etiqueta HTML ni una valla: eso
      // lo garantiza el limpiador, así que aquí sí se falla si aparece.
      check('sin una sola etiqueta HTML guardada dentro', !tieneHtml(note.content), JSON.stringify((note.content.match(/<\/?[a-zA-Z][^<>]*>/) ?? [''])[0]));
      check('y sin vallas de código', !note.content.includes('```'));
      // Estas dos son estilo del modelo, no garantía de la casa: se avisa.
      if (!note.content.includes('**Respuesta:**')) {
        warn('El apunte no trae las respuestas de Active Recall en la forma pedida (`**Respuesta:** `): el modelo ha vuelto a su formato de siempre.');
      }
      const apartados = (note.content.match(/^###\s/gm) ?? []).length;
      if (apartados < 3) {
        warn(`El apunte no desarrolla los puntos apartado por apartado (${apartados} apartados \`### \`): ha salido más esquema que apunte.`);
      }
      check(
        'la API dice cómo de largo ha salido el apunte',
        typeof written.data?.quality?.words === 'number' && written.data.quality.words > 0,
        JSON.stringify(written.data?.quality)
      );
      check(
        'y si le falta estructura, lo dice en vez de callarse',
        Array.isArray(written.data?.quality?.structureMissing),
        JSON.stringify(written.data?.quality?.structureMissing ?? null)
      );

      // El trato completo: si el apunte se guarda cojo (con cuerpo pero sin los
      // puntos desarrollados), tiene que quedar anotado en el taller para poder
      // reescribirlo; y si sale entero, no se ensucia el taller con avisos.
      if (createdNoteId) {
        const aviso = await prisma.systemIssue.findFirst({
          where: {
            title: apuntes.NOTE_INCOMPLETE_ISSUE_TITLE,
            status: { not: 'resuelto' },
            contextJson: { contains: createdNoteId },
          },
        });
        const cojo = (written.data?.quality?.structureMissing ?? []).length > 0;
        if (cojo) {
          check('un apunte sin el desarrollo punto por punto queda anotado en el taller', aviso !== null, aviso ? `${aviso.status} · ${(aviso.detail ?? '').slice(0, 80)}` : 'sin aviso');
        } else {
          check('un apunte entero no deja avisos en el taller', aviso === null);
        }
      }
      check('es un apunte completo, no un párrafo', note.content.length > 1200, `${note.content.length} caracteres`);
      if (!/## *Ejemplo resuelto/.test(note.content)) {
        warn('El apunte no trae la sección «Ejemplo resuelto»: el modelo se la ha saltado (la estructura se pide, pero no siempre se cumple).');
      }
    }
    check('no ha dejado apuntes duplicados de más', (await prisma.note.count()) >= before + 1);

    console.log('\n8) Sacarlo del cuaderno: descarga e impresión');
    if (!createdNoteId) {
      warn('Sin apunte escrito no se puede comprobar la descarga.');
      return;
    }

    const dl = await fetch(`${APP}/api/notes/${createdNoteId}/download`);
    const md = await dl.text();
    check('la descarga responde 200', dl.status === 200, `HTTP ${dl.status}`);
    check('con tipo Markdown', (dl.headers.get('content-type') ?? '').includes('text/markdown'), dl.headers.get('content-type'));
    check(
      'y como descarga con su nombre de archivo',
      (dl.headers.get('content-disposition') ?? '').includes('attachment') && (dl.headers.get('content-disposition') ?? '').includes('.md'),
      dl.headers.get('content-disposition')
    );
    check('el .md lleva el título como encabezado', md.trimStart().startsWith('# '), JSON.stringify(md.trimStart().slice(0, 40)));
    check('con su bloque de datos (asignatura y autor)', md.includes(agent.subject.name) && /Del catedrático|catedrático/i.test(md));
    check('y el contenido del apunte entero', md.includes(note.content.trim().slice(0, 60)));
    check('el .md descargable tampoco lleva HTML ni vallas', !tieneHtml(md) && !md.includes('```'));

    const missing = await fetch(`${APP}/api/notes/no-existe/download`);
    check('un apunte que no existe da 404', missing.status === 404, `HTTP ${missing.status}`);

    const printOne = await fetch(`${APP}/apuntes/imprimir?note=${createdNoteId}`);
    const htmlOne = await printOne.text();
    check('la vista de impresión de un apunte responde 200', printOne.status === 200, `HTTP ${printOne.status}`);
    check('con el título del apunte en pantalla', htmlOne.includes(note.title.slice(0, 20)));
    check('y las reglas de impresión que quitan el marco de la app', /@media print/.test(htmlOne) && /aside, nav, header/.test(htmlOne));

    const printSubject = await fetch(`${APP}/apuntes/imprimir?subject=${agent.subjectId}`);
    check('el dossier de la asignatura responde 200', printSubject.status === 200, `HTTP ${printSubject.status}`);
  } finally {
    if (createdNoteId) {
      await prisma.note.delete({ where: { id: createdNoteId } }).catch(() => {});
      // Y su aviso del taller, si lo hubo: una prueba no deja basura en el taller.
      await prisma.systemIssue
        .deleteMany({ where: { title: apuntes.NOTE_INCOMPLETE_ISSUE_TITLE, contextJson: { contains: createdNoteId } } })
        .catch(() => {});
      console.log(`\nLimpieza: apunte de prueba borrado · apuntes en la base ahora: ${await prisma.note.count()}`);
    } else {
      console.log(`\nLimpieza: no se creó ningún apunte · apuntes en la base: ${await prisma.note.count()}`);
    }
    await prisma.$disconnect();
  }
}

async function main() {
  offline();
  offlineLimpieza();
  offlineUnidad();
  if (LIVE) {
    await live();
  } else {
    console.log('\n(Parte viva omitida: usa `npm run verify:apuntes-ia -- --live` con el servidor levantado.)');
  }

  if (failures > 0) console.log(`\n${failures} COMPROBACIONES FALLIDAS`);
  else if (warnings.length > 0) console.log(`\nTODO EN VERDE con ${warnings.length} aviso(s)`);
  else console.log('\nTODO EN VERDE');

  fs.rmSync(outDir, { recursive: true, force: true });
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('FALLO INESPERADO:', error);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exitCode = 1;
});
