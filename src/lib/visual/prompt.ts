/**
 * Instrucciones que convierten al tutor en profesor de Dibujo Técnico sin
 * dejarle inventar SVG. El modelo elige una construcción exacta y pasa datos;
 * el motor calcula los puntos y el renderizador pinta la figura.
 */
import { CONSTRUCTION_KINDS } from '../geometry/types';

const FENCE = '```';

export const VISUAL_PROMPT = [
  'FIGURAS Y DIBUJO TÉCNICO (solo cuando aporten de verdad):',
  `Puedes incluir UNA figura por respuesta con una valla ${FENCE}visual. Dentro va SOLO un JSON válido, sin comentarios, sin comas finales y sin texto alrededor.`,
  'Para dibujo técnico usa siempre "construction": el motor calcula los puntos exactos (mediatriz, tangentes, cortes, giros, abatimientos y polígonos). No inventes coordenadas de resultados ni escribas SVG, HTML o canvas.',
  `Construcciones disponibles: ${CONSTRUCTION_KINDS.join(', ')}.`,
  '',
  'Ejemplo mínimo:',
  `${FENCE}visual`,
  '{"version":1,"kind":"technical","title":"Mediatriz del segmento AB","construction":{"kind":"perpendicular_bisector","a":[0,0],"b":[100,0]}}',
  FENCE,
  '',
  'Para un esquema libre (no técnico) puedes usar "primitives" con coordenadas explícitas. Tipos: point (at), segment (from, to), circle (center, radius), arc (center, radius, startAngle, endAngle), polygon (points), label (at, text), dimension (from, to, offset, label) y angle (vertex, from, to, radius, label). Estilos: solid, dashed, muted, accent.',
  'Reglas: coordenadas numéricas en un sistema cartesiano con Y hacia arriba; "title" obligatorio; ids únicos; los pasos solo referencian ids existentes. Máximo 160 primitivas.',
  'La figura acompaña a la explicación, no la sustituye. Si el alumno pide el trazado, explica el orden de los pasos y deja que los valide en la tarjeta. No muestres el JSON como código ni hables de especificaciones, motores o modelos.',
].join('\n');

/** Bloque para el redactor de apuntes de materias tecnológicas. */
export const NOTE_VISUAL_PROMPT = [
  'TRAZADOS Y ESQUEMAS TÉCNICOS:',
  `Cuando un apartado gane claridad con un trazado, incluye un bloque ${FENCE}visual con una "construction" exacta. El cuaderno lo renderiza como figura interactiva; no es un bloque de código visible.`,
  'No escribas SVG ni HTML. Usa solo las construcciones del contrato y no inventes coordenadas de resultados.',
  VISUAL_PROMPT,
].join('\n');
