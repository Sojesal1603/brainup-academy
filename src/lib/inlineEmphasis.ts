/**
 * Formato inline de un texto escrito por la IA: negrita, cursiva, código,
 * enlaces y fórmulas.
 *
 * Vive aquí, en un módulo aparte, porque lo usan DOS pantallas que antes tenían
 * cada una su propia versión: el cuaderno de apuntes (`NoteRenderer`) y el chat
 * del tutor (`MarkdownMessage`). Tenían el mismo fallo —en
 * `**Apertura del *mito* al *lógos***` los asteriscos salían a la vista— y
 * arreglarlo dos veces, cada uno a su manera, es garantizar que vuelvan a
 * separarse con el siguiente cambio. Una sola regla, un solo sitio.
 *
 * Módulo puro: sin React, sin red y sin estado, para poder comprobarlo aislado.
 */

export type InlineTokenType = 'text' | 'code' | 'bold' | 'italic' | 'link' | 'math';

export interface InlineToken {
  type: InlineTokenType;
  value: string;
  /** Solo en los enlaces. */
  href?: string;
  /** Solo en las fórmulas: `true` para las destacadas (`$$…$$`). */
  display?: boolean;
}

/** ¿Es un carácter de palabra? (`a*b*c` no es una cursiva; `**nota**` sí). */
function isWordChar(char: string | undefined): boolean {
  return Boolean(char) && /[\p{L}\p{N}]/u.test(char as string);
}

/**
 * Basura de formato: las marcas de énfasis que han quedado sin pareja.
 *
 * Un `**` o un `***` suelto es un resto del modelo, no contenido: en un apunte
 * que se estudia no puede imprimirse. Se quitan; lo que había entre medias se
 * queda (nunca se pierde una letra por una marca mal puesta).
 *
 * Una marca de UNA sola letra también es un resto cuando no está entre dos
 * caracteres de palabra: `...y ya*` pierde el asterisco, pero `2*3` y
 * `nombre_fichero` se quedan como están.
 */
export function stripOrphanMarkers(text: string): string {
  if (!/[*_]/.test(text)) return text;

  const out = text
    .replace(/\*{2,}/g, ' ')
    .replace(/_{2,}/g, ' ')
    .replace(/[*_]/g, (marker, offset: number, whole: string) =>
      isWordChar(whole[offset - 1]) && isWordChar(whole[offset + 1]) ? marker : ' '
    );

  return out.replace(/[ \t]{2,}/g, ' ');
}

/** ¿El texto de dentro vale como énfasis? (no vacío ni solo espacios). */
function innerIsUsable(inner: string): boolean {
  return inner.trim().length > 0;
}

/**
 * Busca el cierre de una marca de énfasis contando las RACHAS de asteriscos.
 *
 * El caso que obliga a esto es real y sale mucho: `**Apertura del *mito* al
 * *lógos***`. Una expresión regular de negrita (`\*\*[^*]+\*\*`) no puede
 * pintarlo —el contenido lleva asteriscos dentro— y el alumno acababa viendo
 * `***` en mitad del apunte. Aquí se busca la racha que cierra: para la negrita,
 * una racha par (y si solo hay una impar al final, se toma su parte final, que es
 * justo el cierre de la cursiva que va dentro).
 */
export function matchEmphasis(
  rest: string,
  marker: '**' | '*' | '__'
): { inner: string; length: number } | null {
  // La marca tiene que empezar AQUÍ. Sin esta comprobación, el matcher enganchaba
  // énfasis en mitad de una palabra (se comía letras y cerraba donde no tocaba).
  if (!rest.startsWith(marker)) return null;

  const width = marker.length;
  const char = marker[0];
  const afterOpen = rest.slice(width);
  if (afterOpen.length === 0) return null;
  // Un abridor no puede ir seguido de espacio: eso no abre nada.
  if (/^\s/.test(afterOpen)) return null;

  let fallback: number | null = null;

  for (let i = 0; i < afterOpen.length; i++) {
    if (afterOpen[i] !== char) continue;

    let run = 0;
    while (afterOpen[i + run] === char) run += 1;

    if (run >= width) {
      const closesHere = width === 2 ? run % 2 === 0 : run % 2 === 1;
      if (closesHere) {
        const closeAt = i + run - width;
        const inner = afterOpen.slice(0, closeAt);
        if (innerIsUsable(inner)) return { inner, length: width + closeAt + width };
      }
      if (fallback === null && i > 0) fallback = i + run - width;
    }

    i += run - 1;
  }

  if (fallback !== null) {
    const inner = afterOpen.slice(0, fallback);
    if (innerIsUsable(inner)) return { inner, length: width + fallback + width };
  }

  return null;
}

/**
 * Trocea un texto en sus piezas de formato. El orden importa: el código y las
 * fórmulas van ANTES que las marcas (dentro de una fórmula o de un `código`, un
 * asterisco es un producto, no una negrita).
 *
 * El texto que no es marca sale ya limpio de restos (`stripOrphanMarkers`), así
 * que quien pinte los tokens no tiene que acordarse de limpiar nada.
 */
export function scanInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let plain = '';
  let index = 0;

  const flush = () => {
    if (plain.length === 0) return;
    const clean = stripOrphanMarkers(plain);
    if (clean.length > 0) tokens.push({ type: 'text', value: clean });
    plain = '';
  };

  while (index < text.length) {
    const rest = text.slice(index);

    // Código en línea
    const code = rest.match(/^`([^`\n]+)`/);
    if (code) {
      flush();
      tokens.push({ type: 'code', value: code[1] });
      index += code[0].length;
      continue;
    }

    // Fórmula destacada en la misma línea
    const displayMath = rest.match(/^\$\$([^$]+)\$\$/);
    if (displayMath) {
      flush();
      tokens.push({ type: 'math', value: displayMath[1], display: true });
      index += displayMath[0].length;
      continue;
    }

    // Fórmula en línea
    const math = rest.match(/^\$([^$\n]+)\$/);
    if (math) {
      flush();
      tokens.push({ type: 'math', value: math[1], display: false });
      index += math[0].length;
      continue;
    }

    // Enlace
    const link = rest.match(/^\[([^\]\n]+)\]\(([^)\s]+)\)/);
    if (link) {
      flush();
      tokens.push({ type: 'link', value: link[1], href: link[2] });
      index += link[0].length;
      continue;
    }

    // Negrita (`**` o `__`) y cursiva, con anidamiento de verdad.
    const bold = matchEmphasis(rest, '**') ?? matchEmphasis(rest, '__');
    if (bold) {
      flush();
      tokens.push({ type: 'bold', value: bold.inner });
      index += bold.length;
      continue;
    }

    const italic = matchEmphasis(rest, '*');
    if (italic) {
      flush();
      tokens.push({ type: 'italic', value: italic.inner });
      index += italic.length;
      continue;
    }

    plain += text[index];
    index += 1;
  }

  flush();
  return tokens;
}
