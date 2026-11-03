'use client';

import { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

/** Colapsa dobles backslashes por si el texto viene escapado de más. */
function normalizeTex(tex: string): string {
  return tex.replace(/\\\\/g, '\\');
}

/**
 * Renderiza texto con matemáticas inline `$...$` mediante KaTeX.
 * Si una fórmula no compila, se muestra en crudo sin romper la interfaz.
 */
export default function MathText({ text, className }: { text: string; className?: string }) {
  const parts = useMemo(() => {
    const output: Array<{ type: 'text' | 'math'; value: string }> = [];
    // La IA a veces escribe display math ($$...$$): lo tratamos como inline.
    const normalized = text.replace(/\$\$/g, '$');
    const regex = /\$([^$]+)\$/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(normalized)) !== null) {
      if (match.index > lastIndex) {
        output.push({ type: 'text', value: normalized.slice(lastIndex, match.index) });
      }
      output.push({ type: 'math', value: match[1] });
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < normalized.length) {
      output.push({ type: 'text', value: normalized.slice(lastIndex) });
    }

    return output;
  }, [text]);

  return (
    <span className={className}>
      {parts.map((part, index) =>
        part.type === 'math' ? (
          <span
            key={index}
            className="inline-block align-middle text-slate-100"
            dangerouslySetInnerHTML={{
              __html: katex.renderToString(normalizeTex(part.value), {
                throwOnError: false,
                strict: false,
              }),
            }}
          />
        ) : (
          <span key={index} className="whitespace-pre-wrap">
            {part.value}
          </span>
        )
      )}
    </span>
  );
}
