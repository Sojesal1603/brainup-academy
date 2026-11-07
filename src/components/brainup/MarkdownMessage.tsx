'use client';

import { useMemo, useState, type ReactNode } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { Check, Copy } from 'lucide-react';
import { scanInline } from '@/lib/inlineEmphasis';

/**
 * Renderizador de mensajes del Tutor IA: Markdown ligero + fórmulas LaTeX.
 *
 * Los modelos devuelven Markdown (listas, negritas, títulos, citas) y LaTeX
 * entre `$...$` o `$$...$$`. Sin esto, el alumno veía los asteriscos y las
 * barras invertidas en crudo.
 *
 * Filosofía: nada de dependencias nuevas, se reutiliza KaTeX (ya presente para
 * los apuntes y el examinador) y, si una fórmula no compila, se muestra tal cual
 * en lugar de romper la conversación.
 */

/** Colapsa dobles backslashes por si el contenido viene escapado de más. */
function normalizeTex(tex: string): string {
  return tex.replace(/\\\\/g, '\\').trim();
}

function KatexInline({ tex, display }: { tex: string; display: boolean }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(normalizeTex(tex), {
        displayMode: display,
        throwOnError: false,
        strict: false,
        output: 'html',
      });
    } catch {
      return null;
    }
  }, [tex, display]);

  if (!html) {
    return (
      <code className="px-1 py-0.5 rounded bg-slate-800 text-emerald-300 text-[12px] font-mono">
        {tex}
      </code>
    );
  }

  if (display) {
    return (
      <span
        className="block my-2 overflow-x-auto overflow-y-hidden text-slate-100"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <span
      className="inline-block align-middle text-slate-100"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Formato inline                                                      */
/* ------------------------------------------------------------------ */

/**
 * Inline recurrente: las negritas pueden contener cursivas, código y fórmulas.
 *
 * Quien trocea el texto es `scanInline` (`@/lib/inlineEmphasis`), el mismo motor
 * que pinta el cuaderno de apuntes. Antes había aquí una expresión regular
 * propia, y con `**Apertura del *mito* al *lógos***` cerraba la negrita en el
 * sitio equivocado y dejaba un asterisco a la vista del alumno.
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return scanInline(text).map((token, index) => {
    const key = `${keyPrefix}-i${index}`;

    switch (token.type) {
      case 'code':
        return (
          <code
            key={key}
            className="px-1.5 py-0.5 rounded bg-slate-800/80 border border-slate-700 text-emerald-300 text-[12px] font-mono"
          >
            {token.value}
          </code>
        );
      case 'bold':
        return (
          <strong key={key} className="font-bold text-slate-100">
            {renderInline(token.value, key)}
          </strong>
        );
      case 'italic':
        return (
          <em key={key} className="italic text-slate-200">
            {renderInline(token.value, key)}
          </em>
        );
      case 'link':
        return (
          <a
            key={key}
            href={token.href}
            target="_blank"
            rel="noreferrer"
            className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2"
          >
            {token.value}
          </a>
        );
      case 'math':
        return <KatexInline key={key} tex={token.value} display={token.display === true} />;
      default:
        return <span key={key}>{token.value}</span>;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Bloques                                                             */
/* ------------------------------------------------------------------ */

/**
 * Normaliza las variantes de LaTeX que sueltan los modelos:
 * \( ... \) → $ ... $ y \[ ... \] → $$ ... $$.
 */
function normalizeDelimiters(input: string): string {
  return input
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => `$$${body}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${body}$`);
}

/**
 * Bloque de código con su botón de copia. El texto se copia tal cual, sin el
 * rótulo del lenguaje ni adornos: es lo que se pega en el editor.
 */
function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Navegador sin permiso de portapapeles (http fuera de localhost):
      // el botón no hace nada raro, simplemente no copia.
    }
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-white/10 bg-[#08080a]">
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-stone-500">
          {language || 'código'}
        </span>
        <button
          type="button"
          onClick={copy}
          title="Copiar el bloque de código"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-stone-400 transition-colors hover:bg-white/[0.06] hover:text-stone-200"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <pre className="overflow-x-auto px-3.5 py-3">
        <code className="whitespace-pre font-mono text-[12.5px] leading-6 text-stone-200/90">
          {code}
        </code>
      </pre>
    </div>
  );
}

/** ¿La línea es el separador de una tabla Markdown (`|---|:--:|`)? */
function isTableSeparator(line: string): boolean {
  return /^\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?$/.test(line.trim());
}

/** Trocea una fila `| a | b |` en celdas. */
function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

const HEADING_SIZES: Record<number, string> = {
  1: 'text-sm font-black uppercase tracking-wide text-slate-100',
  2: 'text-[13px] font-bold text-slate-100',
  3: 'text-[13px] font-bold text-slate-100',
  4: 'text-xs font-bold text-slate-200',
  5: 'text-xs font-semibold text-slate-300',
  6: 'text-xs font-semibold text-slate-300',
};

export default function MarkdownMessage({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const blocks = useMemo(() => {
    const text = normalizeDelimiters(content.replace(/\r\n/g, '\n'));
    const lines = text.split('\n');
    const output: ReactNode[] = [];

    let paragraph: string[] = [];
    let index = 0;

    const flushParagraph = () => {
      if (paragraph.length === 0) return;
      const joined = paragraph.join('\n');
      output.push(
        <p key={`p-${output.length}`} className="whitespace-pre-wrap leading-relaxed">
          {renderInline(joined, `p-${output.length}`)}
        </p>
      );
      paragraph = [];
    };

    while (index < lines.length) {
      const line = lines[index];
      const trimmed = line.trim();

      // Bloque de código ``` ```
      if (trimmed.startsWith('```')) {
        flushParagraph();
        const language = trimmed.slice(3).trim();
        const codeLines: string[] = [];
        index += 1;
        while (index < lines.length && !lines[index].trim().startsWith('```')) {
          codeLines.push(lines[index]);
          index += 1;
        }
        index += 1; // salta el cierre
        output.push(
          <CodeBlock key={`code-${output.length}`} code={codeLines.join('\n')} language={language} />
        );
        continue;
      }

      // Tablas: cabecera, separador y filas. Las usa el catedrático para
      // comparar autores, tiempos verbales o pasos de un método.
      if (trimmed.startsWith('|') && isTableSeparator(lines[index + 1] ?? '')) {
        flushParagraph();
        const header = parseTableRow(trimmed);
        index += 2;
        const rows: string[][] = [];
        while (index < lines.length && lines[index].trim().startsWith('|')) {
          rows.push(parseTableRow(lines[index].trim()));
          index += 1;
        }
        output.push(
          <div
            key={`table-${output.length}`}
            className="my-2 overflow-x-auto rounded-lg border border-white/10"
          >
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="bg-white/[0.04]">
                  {header.map((cell, cellIndex) => (
                    <th
                      key={cellIndex}
                      className="border-b border-white/10 px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-stone-400"
                    >
                      {renderInline(cell, `th-${output.length}-${cellIndex}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr
                    key={rowIndex}
                    className="border-b border-white/[0.05] last:border-0 odd:bg-white/[0.015]"
                  >
                    {row.map((cell, cellIndex) => (
                      <td
                        key={cellIndex}
                        className="px-3 py-2 align-top leading-6 text-stone-200"
                      >
                        {renderInline(cell, `td-${output.length}-${rowIndex}-${cellIndex}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }

      // Fórmula en bloque: $$...$$ (en la misma línea o repartida en varias)
      if (trimmed.startsWith('$$')) {
        flushParagraph();
        const first = trimmed.slice(2);

        // Caso habitual: $$ ... $$ en una sola línea.
        if (first.length >= 2 && first.endsWith('$$')) {
          output.push(
            <KatexInline key={`math-${output.length}`} tex={first.slice(0, -2)} display />
          );
          index += 1;
          continue;
        }

        // Caso multilínea: se busca el cierre con un límite razonable para que
        // una fórmula sin cerrar no se coma el resto del mensaje.
        const mathLines: string[] = [first];
        let cursor = index + 1;
        let closed = false;

        while (cursor < lines.length && cursor - index <= 8) {
          const current = lines[cursor].trim();
          cursor += 1;
          if (current.endsWith('$$')) {
            mathLines.push(current.slice(0, -2));
            closed = true;
            break;
          }
          mathLines.push(current);
        }

        if (closed) {
          output.push(
            <KatexInline key={`math-${output.length}`} tex={mathLines.join(' ')} display />
          );
          index = cursor;
          continue;
        }

        // Sin cierre: se deja como texto para no perder contenido.
        paragraph.push(line);
        index += 1;
        continue;
      }

      // Separador horizontal
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        flushParagraph();
        output.push(<hr key={`hr-${output.length}`} className="my-2 border-slate-700/60" />);
        index += 1;
        continue;
      }

      // Títulos # ## ###
      const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        const level = heading[1].length;
        output.push(
          <p key={`h-${output.length}`} className={`mt-1 ${HEADING_SIZES[level]}`}>
            {renderInline(heading[2], `h-${output.length}`)}
          </p>
        );
        index += 1;
        continue;
      }

      // Listas con viñetas
      if (/^([-*+])\s+/.test(trimmed)) {
        flushParagraph();
        const items: string[] = [];
        while (index < lines.length && /^([-*+])\s+/.test(lines[index].trim())) {
          items.push(lines[index].trim().replace(/^([-*+])\s+/, ''));
          index += 1;
        }
        output.push(
          <ul key={`ul-${output.length}`} className="space-y-1 pl-1">
            {items.map((item, itemIndex) => (
              <li key={itemIndex} className="flex gap-2">
                <span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-emerald-400/80 shrink-0" />
                <span className="flex-1 whitespace-pre-wrap">
                  {renderInline(item, `ul-${output.length}-${itemIndex}`)}
                </span>
              </li>
            ))}
          </ul>
        );
        continue;
      }

      // Listas numeradas
      if (/^\d+[.)]\s+/.test(trimmed)) {
        flushParagraph();
        const items: string[] = [];
        while (index < lines.length && /^\d+[.)]\s+/.test(lines[index].trim())) {
          items.push(lines[index].trim().replace(/^\d+[.)]\s+/, ''));
          index += 1;
        }
        output.push(
          <ol key={`ol-${output.length}`} className="space-y-1 pl-1">
            {items.map((item, itemIndex) => (
              <li key={itemIndex} className="flex gap-2">
                <span className="mt-px w-4 shrink-0 text-right text-[11px] font-mono font-bold text-emerald-400">
                  {itemIndex + 1}.
                </span>
                <span className="flex-1 whitespace-pre-wrap">
                  {renderInline(item, `ol-${output.length}-${itemIndex}`)}
                </span>
              </li>
            ))}
          </ol>
        );
        continue;
      }

      // Citas: el catedrático las usa para el error típico o la regla clave
      if (trimmed.startsWith('>')) {
        flushParagraph();
        const quoted: string[] = [];
        while (index < lines.length && lines[index].trim().startsWith('>')) {
          quoted.push(lines[index].trim().replace(/^>\s?/, ''));
          index += 1;
        }
        output.push(
          <blockquote
            key={`quote-${output.length}`}
            className="border-l-2 border-emerald-500/50 bg-emerald-500/5 rounded-r-lg px-3 py-2 text-[12.5px] text-emerald-100/90"
          >
            {renderInline(quoted.join('\n'), `quote-${output.length}`)}
          </blockquote>
        );
        continue;
      }

      if (trimmed.length === 0) {
        flushParagraph();
        index += 1;
        continue;
      }

      paragraph.push(line);
      index += 1;
    }

    flushParagraph();
    return output;
  }, [content]);

  if (blocks.length === 0) return null;

  return <div className={`space-y-2.5 text-[13px] ${className ?? ''}`}>{blocks}</div>;
}
