/**
 * Instrucciones que convierten al tutor en profesor de Dibujo Técnico sin
 * dejarle inventar SVG. El modelo elige una construcción exacta y pasa datos;
 * el motor calcula los puntos y el renderizador pinta la figura.
 *
 * Desde el fallo de producción del Catedrático de Dibujo Técnico, la valla ya
 * no es una sugerencia: si el alumno pide un trazado, una construcción o una
 * imagen paso a paso, el prompt de ese turno añade un requisito explícito y el
 * contrato incluye dos ejemplos válidos (construcción y primitivas).
 */
import { CONSTRUCTION_KINDS } from '../geometry/types';

const FENCE = '```';

/**
 * Palabras que convierten una petición normal en una petición visual. Se
 * normalizan sin acentos y en minúsculas para no depender de cómo escriba el
 * alumno («mediatriz» / «MEDIATRIZ» / «mediátriz»).
 */
const EXPLICIT_VISUAL_TERMS =
  /\b(dibuj\w*|imagen(?:es)?|figura(?:s)?|esquema(?:s)?|ilustraci[oó]n(?:es)?|l[aá]mina(?:s)?|visual(?:es)?|gr[aá]fic[oa]s?)\b/;
const GEOMETRY_TERMS =
  /\b(mediatriz|bisectriz|perpendicular(?:es)?|paralel(?:a|as|o|os)|tangente(?:s)?|circunferencia(?:s)?|comp[aá]s|arco(?:s)?|traslaci[oó]n(?:es)?|rotaci[oó]n(?:es)?|giro(?:s)?|abatimiento(?:s)?|di[eé]drico|perspectiva(?:s)?|homotecia(?:s)?|simetr[ií]a(?:s)?|pol[ií]gono(?:s)?|trazado(?:s)?|construcci[oó]n geom[eé]trica|intersecci[oó]n(?:es)?|acotaci[oó]n(?:es)?)\b/;
const TECHNICAL_SUBJECT =
  /\b(dibujo t[eé]cnico|geometr[ií]a|pl[aá]stica|tecnolog[ií]a|ingenier[ií]a|arquitectura|descriptiva)\b/;
const TECHNICAL_PLATE_TERMS =
  /\b(alzado|planta|perfil|secci[oó]n|corte|escala|desarrollo|proyecci[oó]n(?:es)?)\b/;

function normalize(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ¿Este turno exige una valla `visual`? No intenta adivinar el tema: solo
 * detecta peticiones explícitas de dibujo/imagen o vocabulario de trazado.
 * Una explicación normal «paso a paso» de álgebra no activa la obligación.
 */
export function needsVisualSpec(text: string, subjectName = ''): boolean {
  const value = normalize(text);
  if (!value) return false;
  if (EXPLICIT_VISUAL_TERMS.test(value)) return true;
  if (GEOMETRY_TERMS.test(value)) return true;
  if (TECHNICAL_SUBJECT.test(normalize(subjectName)) && TECHNICAL_PLATE_TERMS.test(value)) {
    return true;
  }
  return false;
}

export const VISUAL_PROMPT = [
  'FIGURAS Y DIBUJO TÉCNICO:',
  `Cuando la respuesta gane claridad con una figura —y SIEMPRE que el alumno pida un trazado, una construcción geométrica, una imagen, un dibujo o pasos visuales— incluye UNA valla ${FENCE}visual. La valla puede ir antes o después de la explicación textual.`,
  `Dentro de la valla va SOLO un JSON válido, sin comentarios, sin comas finales, sin texto alrededor y sin ${FENCE}json. No inventes coordenadas de resultado ni escribas SVG, HTML o canvas.`,
  'Para dibujo técnico usa siempre "construction" cuando la construcción exista en la lista: el motor calcula los puntos exactos. Si la construcción pedida no está en la lista (por ejemplo, una traslación con arcos de compás), usa "primitives" para dibujar los puntos y arcos de trabajo, y explica que son datos de la figura, no resultados inventados.',
  `Construcciones disponibles: ${CONSTRUCTION_KINDS.join(', ')}.`,
  '',
  'Contrato exacto (elige UNA sola forma, nunca las dos):',
  `{"version":1,"kind":"technical","title":"...","construction":{"kind":"...", ...}}`,
  `o`,
  `{"version":1,"kind":"diagram","title":"...","primitives":[{"type":"...","id":"...", ...}]}`,
  'Campos obligatorios: version:1, kind, title y exactamente construction o primitives. Los ids son únicos y los pasos solo referencian ids existentes. Máximo 160 primitivas.',
  '',
  'Ejemplo válido de construcción:',
  `${FENCE}visual`,
  '{"version":1,"kind":"technical","title":"Mediatriz del segmento AB","construction":{"kind":"perpendicular_bisector","a":[0,0],"b":[100,0]}}',
  FENCE,
  '',
  'Ejemplo válido de esquema con primitivas:',
  `${FENCE}visual`,
  '{"version":1,"kind":"diagram","title":"Segmento AB y su punto medio","primitives":[{"type":"point","id":"a","at":[0,0],"label":"A","role":"given"},{"type":"point","id":"b","at":[100,0],"label":"B","role":"given"},{"type":"segment","id":"ab","from":[0,0],"to":[100,0],"style":"accent"},{"type":"point","id":"m","at":[50,0],"label":"M","role":"result"},{"type":"label","id":"l","at":[50,36],"text":"Paso 1: mide AB y marca M en 50"}]}',
  FENCE,
  '',
  'Para un esquema libre (no técnico) puedes usar "primitives" con coordenadas explícitas. Tipos: point (at), segment (from, to), circle (center, radius), arc (center, radius, startAngle, endAngle), polygon (points), label (at, text), dimension (from, to, offset, label) y angle (vertex, from, to, radius, label). Estilos: solid, dashed, muted, accent.',
  'Reglas: coordenadas numéricas en un sistema cartesiano con Y hacia arriba; "title" obligatorio; ids únicos; los pasos solo referencian ids existentes. Máximo 160 primitivas.',
  'La figura acompaña a la explicación, no la sustituye. Si el alumno pide el trazado, explica el orden de los pasos y deja que los valide en la tarjeta. No muestres el JSON como código ni hables de especificaciones, motores o modelos.',
  `Antes de cerrar la respuesta, comprueba que la valla ${FENCE}visual está completa, que el JSON parsea y que no has escrito SVG ni HTML.`,
].join('\n');

/**
 * Bloque que se añade al prompt SOLO cuando `needsVisualSpec` detecta una
 * petición de trazado/imagen. Va después del contrato general para que el
 * modelo no lo interprete como una opción decorativa.
 */
export const VISUAL_REQUIRED_PROMPT = [
  VISUAL_PROMPT,
  '',
  'REQUISITO VISUAL DE ESTE TURNO (prioridad sobre el resto de instrucciones de formato):',
  'El alumno ha pedido explícitamente un trazado, una construcción geométrica o una imagen/paso a paso visual. ESTE TURNO NO PUEDES RESPONDER SOLO CON TEXTO.',
  `Incluye al menos una valla ${FENCE}visual válida antes o después de la explicación. No la dejes vacía, no uses ${FENCE}json y no sustituyas la figura por una descripción verbal.`,
  'Si la construcción exacta no está en la lista, usa "primitives" con los puntos, segmentos y arcos de trabajo. El JSON debe validar el esquema de Zod; si dudas, copia la forma de uno de los dos ejemplos de arriba.',
  'La explicación textual puede ser breve, pero la valla es obligatoria: sin ella el alumno pierde la imagen interactiva que ha pedido.',
].join('\n');

/** Bloque para el redactor de apuntes de materias tecnológicas. */
export const NOTE_VISUAL_PROMPT = [
  'TRAZADOS Y ESQUEMAS TÉCNICOS:',
  `Cuando un apartado gane claridad con un trazado, incluye un bloque ${FENCE}visual con una "construction" exacta. El cuaderno lo renderiza como figura interactiva; no es un bloque de código visible.`,
  'No escribas SVG ni HTML. Usa solo las construcciones del contrato y no inventes coordenadas de resultados.',
  VISUAL_PROMPT,
].join('\n');
