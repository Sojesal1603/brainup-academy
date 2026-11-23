/**
 * Contrato anti-alucinación: ¿la cita que devuelve el modelo está de verdad en
 * el trozo que dice?
 *
 * Esto es código puro y determinista a propósito. No llama a ningún modelo, no
 * toca la base y se puede probar sin red: si una cita no se puede comprobar
 * aquí, no se publica como verificada.
 *
 * Qué se tolera (porque el modelo copia de un PDF, no de un teclado):
 *   · espacios raros, saltos de línea y guiones de corte;
 *   · acentos y mayúsculas distintos (NFD, se quitan diacríticos);
 *   · comillas tipográficas y guiones largos;
 *   · una cita partida con «…» o «...»: cada fragmento debe aparecer, en orden.
 *
 * Qué NO se tolera: cambiar una cifra, una unidad o una palabra de contenido.
 */

/** Longitud mínima de una cita para que signifique algo. */
export const MIN_QUOTE_CHARS = 12;

/** Quita diacríticos y unifica comillas, guiones y espacios. */
export function normalizeCitationText(input: string): string {
  return String(input ?? '')
    .normalize('NFKC')
    .replace(/\u00ad/g, '')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Trozos de una cita con elipsis: todos deben aparecer, en este orden. */
export function quoteFragments(quote: string): string[] {
  return normalizeCitationText(quote)
    .split(/\s*(?:\.{2,}|…)\s*/)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0);
}

/**
 * ¿La cita aparece en el texto del trozo?
 *
 * Con elipsis se exige que los fragmentos aparezcan en orden, no que estén
 * pegados: es exactamente lo que hace una persona al citar «lo importante…
 * y lo siguiente».
 */
export function quoteMatchesChunk(quote: string, chunkText: string): boolean {
  const fragments = quoteFragments(quote);
  if (fragments.length === 0) return false;
  if (fragments.join('').length < MIN_QUOTE_CHARS) return false;

  const haystack = normalizeCitationText(chunkText);
  if (haystack.length === 0) return false;

  let cursor = 0;
  for (const fragment of fragments) {
    const found = haystack.indexOf(fragment, cursor);
    if (found === -1) return false;
    cursor = found + fragment.length;
  }
  return true;
}

export interface CitationChunk {
  id: string;
  userId: string;
  text: string;
}

export type CitationVerdict = 'VERIFIED' | 'UNVERIFIED' | 'ERROR';

export interface CitationCheck {
  status: CitationVerdict;
  /** Motivo corto para el registro y para el reintento. Nunca se enseña crudo. */
  reason: string | null;
}

/**
 * Valida una cita contra los trozos **permitidos** de esta petición.
 *
 * El `allowed` es la lista que se le mandó al modelo (no «toda la base»): así un
 * `chunkId` inventado o de otra cuenta no puede colarse ni aunque exista.
 */
export function checkCitation(params: {
  userId: string;
  chunkId: string | null | undefined;
  quote: string | null | undefined;
  allowed: ReadonlyMap<string, CitationChunk>;
}): CitationCheck {
  const chunkId = (params.chunkId ?? '').trim();
  const quote = (params.quote ?? '').trim();

  if (!chunkId) {
    return { status: 'ERROR', reason: 'El bloque afirma algo sin indicar de qué trozo sale.' };
  }
  if (quote.length < MIN_QUOTE_CHARS) {
    return { status: 'ERROR', reason: 'La cita es demasiado corta para comprobarse.' };
  }

  const chunk = params.allowed.get(chunkId);
  if (!chunk) {
    return {
      status: 'ERROR',
      reason: 'El trozo citado no estaba entre las fuentes de esta generación.',
    };
  }
  if (chunk.userId !== params.userId) {
    // No se distingue «no existe» de «es de otra cuenta»: ambos son el mismo
    // error y el mensaje no debe confirmar que el id existe.
    return { status: 'ERROR', reason: 'El trozo citado no está disponible para esta cuenta.' };
  }

  if (!quoteMatchesChunk(quote, chunk.text)) {
    return {
      status: 'UNVERIFIED',
      reason: 'La cita no aparece literalmente en el trozo: no se publica como verificada.',
    };
  }

  return { status: 'VERIFIED', reason: null };
}

/**
 * Política graduada: un fallo se puede reintentar **una** vez con el motivo
 * delante. Después de eso, el bloque se guarda como UNVERIFIED/ERROR (nunca
 * VERIFIED) y la sección queda para revisión.
 */
export function citationRetryInstruction(check: CitationCheck): string | null {
  if (check.status === 'VERIFIED') return null;
  return [
    'La cita del bloque anterior NO ha pasado la comprobación:',
    `- ${check.reason ?? 'no coincide con el texto del trozo.'}`,
    'Vuelve a redactar SOLO ese bloque. Copia una frase exacta del trozo indicado,',
    'sin cambiar cifras ni palabras, o elimina la afirmación si no está en la fuente.',
    'Devuelve el mismo JSON, con la cita corregida.',
  ].join('\n');
}

/**
 * Cobertura de un apunte: apartados no omitidos que tienen al menos una cita
 * VERIFIED. Es el número del anillo («12/12 apartados con cita en tu
 * documento»), no una estimación.
 */
export function citationCoverage(
  sections: ReadonlyArray<{
    status: string;
    blocks: ReadonlyArray<{ quoteStatus: string }>;
  }>
): { withCitation: number; total: number; ratio: number } {
  const counted = sections.filter((section) => section.status !== 'SKIPPED');
  const withCitation = counted.filter((section) =>
    section.blocks.some((block) => block.quoteStatus === 'VERIFIED')
  ).length;
  return {
    withCitation,
    total: counted.length,
    ratio: counted.length === 0 ? 0 : withCitation / counted.length,
  };
}
