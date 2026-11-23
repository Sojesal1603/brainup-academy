/**
 * `Note.content` como **proyección de solo lectura** del árbol modular.
 *
 * Todo lo que ya existe en la app (visor, descarga, búsqueda, exportación) lee
 * `Note.content`. Para no romperlo, el árbol no lo sustituye: lo genera. Esta
 * función es la única que decide cómo se escribe, y por eso es determinista:
 * con las mismas secciones y bloques produce exactamente el mismo Markdown.
 *
 * Reglas:
 *   · los apartados SKIPPED no se proyectan (el alumno los omitió);
 *   · los bloques se ordenan por `order`, nunca por fecha de creación;
 *   · un bloque FORMULA sin delimitadores se envuelve en `$$…$$`;
 *   · las variantes cuelgan de su bloque con un encabezado, no se pierden.
 *
 * Módulo puro: `verify:lienzo` compara dos proyecciones y exige igualdad byte a
 * byte, sin base de datos.
 */

export interface ProjectionBlock {
  id: string;
  parentId: string | null;
  order: number;
  type: string;
  content: string;
  quoteStatus?: string;
}

export interface ProjectionSection {
  id: string;
  title: string;
  purpose?: string | null;
  order: number;
  status: string;
  pageFrom?: number | null;
  pageTo?: number | null;
  blocks: readonly ProjectionBlock[];
}

export interface ProjectionNote {
  title: string;
  sections: readonly ProjectionSection[];
}

const TYPE_HEADINGS: Record<string, string> = {
  TEXT: 'Ampliación',
  FORMULA: 'Fórmula',
  DEFINITION: 'Definición',
  EXAMPLE: 'Ejemplo',
  EVIDENCE: 'Cita',
  QUESTION: 'Pregunta',
};

/** Limpia un contenido sin reinterpretarlo: sigue siendo Markdown/KaTeX. */
function cleanContent(content: string): string {
  return String(content ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

/** Título sin almohadillas: evita `## ## Título` si el modelo ya las puso. */
function cleanHeading(title: string): string {
  return String(title ?? '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/\s*#+\s*$/, '')
    .trim();
}

function formulaBlock(content: string): string {
  if (content.includes('$$') || /^\s*\$\$/.test(content)) return content;
  return `$$\n${content}\n$$`;
}

function renderBlock(block: ProjectionBlock, depth: number): string {
  const heading = TYPE_HEADINGS[block.type] ?? 'Ampliación';
  const content = cleanContent(block.content);

  if (!content) return '';

  const body =
    block.type === 'FORMULA'
      ? formulaBlock(content)
      : block.type === 'EVIDENCE'
        ? content
            .split('\n')
            .map((line) => (line.trim().length > 0 ? `> ${line}` : '>'))
            .join('\n')
        : content;

  if (depth === 0) return body;
  const hashes = depth === 1 ? '###' : '####';
  return `${hashes} ${heading}\n\n${body}`;
}

function renderTree(blocks: readonly ProjectionBlock[]): string {
  const byParent = new Map<string | null, ProjectionBlock[]>();
  for (const block of blocks) {
    const list = byParent.get(block.parentId) ?? [];
    list.push(block);
    byParent.set(block.parentId, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order);

  const walk = (parentId: string | null, depth: number): string[] => {
    const children = byParent.get(parentId) ?? [];
    return children.flatMap((block) => {
      const own = renderBlock(block, depth);
      const nested = walk(block.id, depth + 1);
      return own ? [own, ...nested] : nested;
    });
  };

  return walk(null, 0).join('\n\n');
}

/**
 * Proyección completa. El resultado siempre termina en un único `\n` y nunca
 * tiene tres saltos de línea seguidos (los visores existentes lo agradecen).
 */
export function projectNoteMarkdown(note: ProjectionNote): string {
  const lines: string[] = [];
  const title = cleanHeading(note.title);
  if (title) lines.push(`# ${title}`);

  const sections = note.sections
    .filter((section) => section.status !== 'SKIPPED')
    .slice()
    .sort((a, b) => a.order - b.order);

  for (const section of sections) {
    const heading = cleanHeading(section.title);
    if (heading) lines.push(`## ${heading}`);

    const purpose = String(section.purpose ?? '').trim();
    if (purpose) lines.push(`*${purpose}*`);

    const body = renderTree(section.blocks);
    if (body) lines.push(body);
  }

  const markdown = lines
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return markdown.length > 0 ? `${markdown}\n` : '';
}

/**
 * Huella barata de la proyección para detectar desincronizaciones sin comparar
 * megabytes en cada lectura. No es criptográfica: es un checksum de contenido.
 */
export function projectionFingerprint(markdown: string): string {
  let hash = 2166136261;
  const text = String(markdown ?? '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
