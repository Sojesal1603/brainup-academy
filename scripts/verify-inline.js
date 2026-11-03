/**
 * Comprobación del motor de formato inline compartido (`src/lib/inlineEmphasis.ts`)
 * contra frases REALES de los apuntes y del chat.
 *
 * Se transpila el módulo de verdad (no una copia): si alguien lo cambia, esto lo
 * nota. Uso: `node scripts/verify-inline.js`
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'inlineEmphasis.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const module_ = { exports: {} };
new Function('exports', 'module', 'require', js)(module_.exports, module_, require);
const { scanInline, stripOrphanMarkers, matchEmphasis } = module_.exports;

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` · ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` · ${detail}` : ''}`);
  }
}

/** Pinta los tokens como etiquetas, para poder leer el resultado de un vistazo. */
function paint(text) {
  return scanInline(text)
    .map((token) => {
      switch (token.type) {
        case 'bold':
          return `<b>${paint(token.value)}</b>`;
        case 'italic':
          return `<i>${paint(token.value)}</i>`;
        case 'code':
          return `<code>${token.value}</code>`;
        case 'math':
          return `<${token.display ? 'mathblock' : 'math'}>${token.value}`;
        case 'link':
          return `<a>${token.value}</a>`;
        default:
          return token.value;
      }
    })
    .join('');
}

function noMarkers(text) {
  return !/[*_]/.test(text.replace(/<\/?[a-z]+>/g, ''));
}

/* ------------------------------------------------------------------ */

console.log('\n1 · La negrita con cursiva dentro (el caso que salía con *** a la vista)');
{
  const input = '| **Paso del *mythos* al *lógos*** | En preguntas sobre el origen. |';
  const html = paint(input);
  check('La negrita abraza la frase entera', html.includes('<b>Paso del <i>mythos</i> al <i>lógos</i></b>'), html);
  check('Y no queda ni un asterisco a la vista', noMarkers(html), html);
}
{
  const input = '**Apertura del *mito* al *lógos*** fue el cambio.';
  const html = paint(input);
  check('Lo mismo suelto en una frase', html.includes('<b>Apertura del <i>mito</i> al <i>lógos</i></b>'), html);
}
{
  const html = paint('**Filosofía** *y* ***fuerte***');
  check('Negrita, cursiva y las dos a la vez', html === '<b>Filosofía</b> <i>y</i> <b><i>fuerte</i></b>', html);
}

console.log('\n2 · Frases reales de los apuntes');
{
  const input =
    '2. **Definir los términos clave**: Si la pregunta menciona un concepto (ej. *phýsis*, *lógos*, *dogma*), empeza definiéndolo.';
  const html = paint(input);
  check('Los términos van en cursiva y la negrita en negrita', html.includes('<b>Definir los términos clave</b>'), html);
  check('Y sale limpia', noMarkers(html), html);
}
{
  const input = '- **Origen**: Surge en Grecia como el paso del *mythos* al *lógos* (explicación racional).';
  const html = paint(input);
  check('Viñeta con negrita y cursivas', html === '- <b>Origen</b>: Surge en Grecia como el paso del <i>mythos</i> al <i>lógos</i> (explicación racional).', html);
}
{
  const input = '**Enunciado de examen:** *Explica brevemente en qué consiste el paso del "mito" al "lógos".*';
  const html = paint(input);
  check('Cursiva que ocupa media línea', html.includes('<i>Explica brevemente') && html.endsWith('</i>'), html);
}

console.log('\n3 · Restos del modelo: fuera, sin llevarse el contenido');
{
  check('Un asterisco huérfano al final no se imprime', paint('Un **resto** raro*') === 'Un <b>resto</b> raro ', paint('Un **resto** raro*'));
  check('Ni una racha suelta en medio', noMarkers(paint('Texto *** y sigue')), paint('Texto *** y sigue'));
  check('Pero un producto matemático se respeta', paint('2*3 = 6') === '2*3 = 6', paint('2*3 = 6'));
  check('Y un nombre con guion bajo también', paint('nombre_fichero.txt') === 'nombre_fichero.txt', paint('nombre_fichero.txt'));
  check(
    'La marca suelta se borra sin comerse la frase',
    stripOrphanMarkers('ya está* ') === 'ya está ',
    JSON.stringify(stripOrphanMarkers('ya está* '))
  );
}

console.log('\n4 · Lo que no debe romperse');
{
  check('Las fórmulas en línea siguen saliendo', paint('Si $x^2 > 0$ entonces') === 'Si <math>x^2 > 0 entonces', paint('Si $x^2 > 0$ entonces'));
  check('Las destacadas también', paint('$$\\frac{a}{b}$$') === '<mathblock>\\frac{a}{b}', paint('$$\\frac{a}{b}$$'));
  check('Y un asterisco DENTRO de una fórmula no abre cursiva', paint('$a*b$') === '<math>a*b', paint('$a*b$'));
  check('El código en línea no se toca', paint('`**no**`') === '<code>**no**</code>', paint('`**no**`'));
  check('Los enlaces siguen siendo enlaces', paint('[PAU](https://x.es)') === '<a>PAU</a>', paint('[PAU](https://x.es)'));
  check('Un texto sin marcas sale idéntico', paint('Una frase normal, sin nada.') === 'Una frase normal, sin nada.', paint('Una frase normal, sin nada.'));
}

console.log('\n5 · El matcher, en el detalle');
{
  check('No engancha énfasis a mitad de palabra', matchEmphasis('**a**', '**') !== null && matchEmphasis('a**b**', '**') === null);
  check('Un abridor seguido de espacio no abre nada', matchEmphasis('* hola *', '*') === null);
  check('Un texto vacío no es énfasis', matchEmphasis('**  **', '**') === null);
  check('Y no se queda mirando donde no hay nada', matchEmphasis('', '**') === null);
}

console.log(`\n${failures === 0 ? 'TODO EN VERDE' : `${failures} FALLO(S)`} · ${checks} comprobaciones\n`);
process.exit(failures === 0 ? 0 : 1);
