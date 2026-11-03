'use client';

import { useMemo, useState, type ReactNode } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronRight,
  FileText,
  Lightbulb,
  Pin,
  Quote,
  Search,
} from 'lucide-react';
import clsx from 'clsx';
import { sanitizeNoteContent } from '@/lib/apuntesIa';
import { scanInline } from '@/lib/inlineEmphasis';

/* ------------------------------------------------------------------ */
/* Matemáticas (KaTeX)                                                 */
/* ------------------------------------------------------------------ */

/** Colapsa dobles backslashes por si el contenido viene escapado de más. */
function normalizeTex(tex: string): string {
  return tex.replace(/\\\\/g, '\\');
}

function KatexMath({ tex, display = false }: { tex: string; display?: boolean }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(normalizeTex(tex), {
        displayMode: display,
        throwOnError: false,
        strict: false,
      });
    } catch {
      return null;
    }
  }, [tex, display]);

  if (!html) {
    return (
      <code className="px-1 py-0.5 rounded bg-slate-800 text-emerald-300 text-xs font-mono">
        {tex}
      </code>
    );
  }

  if (display) {
    return (
      <span
        className="block my-2 overflow-x-auto text-slate-100"
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
/* Delimitadores de LaTeX                                             */
/* ------------------------------------------------------------------ */

/**
 * Los modelos sueltan el LaTeX de tres maneras distintas. El limpiador de
 * apuntes (`sanitizeNoteContent`) ya deja los del sistema, pero un apunte viejo
 * guardado antes de esa limpieza puede traer `\( … \)` o `\[ … \]`, que el
 * cuaderno pintaría en crudo al alumno. Se normaliza también aquí: pintar bien
 * un apunte viejo no puede depender de que se vuelva a guardar.
 */
function normalizeDelimiters(text: string): string {
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => `\n\n$$${body.trim()}$$\n\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${body.trim()}$`);
}

/* ------------------------------------------------------------------ */
/* Formato inline (negrita, cursiva, código, enlaces y $...$ )         */
/* ------------------------------------------------------------------ */

/**
 * Formato inline de un apunte: negrita, cursiva, código, enlaces y fórmulas,
 * con anidamiento de verdad (`**negrita con *cursiva* dentro**`) y sin dejar
 * marcas huérfanas a la vista.
 *
 * Quien trocea el texto es `scanInline` (`@/lib/inlineEmphasis`), que es el mismo
 * motor que usa el chat del tutor: así el apunte y el chat no pueden pintar la
 * misma frase de dos maneras distintas. Aquí solo se le pone el traje del
 * cuaderno.
 */
function renderInline(text: string, prefix = 'i'): ReactNode[] {
  return scanInline(text).map((token, index) => {
    const key = `${prefix}-${index}`;

    switch (token.type) {
      case 'code':
        return (
          <code
            key={key}
            className="px-1.5 py-0.5 rounded bg-slate-800/90 border border-slate-700 text-emerald-300 text-[0.85em] font-mono"
          >
            {token.value}
          </code>
        );
      case 'math':
        return <KatexMath key={key} tex={token.value} display={token.display} />;
      case 'link':
        return (
          <a
            key={key}
            href={token.href}
            target="_blank"
            rel="noreferrer"
            className="text-emerald-400 underline decoration-emerald-400/40 hover:text-emerald-300"
          >
            {token.value}
          </a>
        );
      case 'bold':
        return (
          <strong key={key} className="font-bold text-slate-100">
            {renderInline(token.value, key)}
          </strong>
        );
      case 'italic':
        return (
          <em key={key} className="italic text-slate-300">
            {renderInline(token.value, key)}
          </em>
        );
      default:
        return token.value;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Callouts temáticos                                                  */
/* ------------------------------------------------------------------ */

interface CalloutMeta {
  icon: typeof Lightbulb;
  iconClass: string;
  containerClass: string;
}

const CALLOUT_META: CalloutMeta[] = [
  {
    icon: Lightbulb,
    iconClass: 'text-amber-400',
    containerClass: 'border-amber-500/35 bg-amber-500/10',
  },
  {
    icon: AlertTriangle,
    iconClass: 'text-rose-400',
    containerClass: 'border-rose-500/35 bg-rose-500/10',
  },
  {
    icon: CheckCircle2,
    iconClass: 'text-emerald-400',
    containerClass: 'border-emerald-500/35 bg-emerald-500/10',
  },
  {
    icon: Brain,
    iconClass: 'text-violet-400',
    containerClass: 'border-violet-500/35 bg-violet-500/10',
  },
  {
    icon: Pin,
    iconClass: 'text-sky-400',
    containerClass: 'border-sky-500/35 bg-sky-500/10',
  },
  {
    icon: Search,
    iconClass: 'text-cyan-400',
    containerClass: 'border-cyan-500/35 bg-cyan-500/10',
  },
  {
    icon: FileText,
    iconClass: 'text-slate-400',
    containerClass: 'border-slate-600/50 bg-slate-700/15',
  },
  {
    icon: Quote,
    iconClass: 'text-slate-400',
    containerClass: 'border-slate-700 bg-slate-800/30',
  },
];

const CALLOUT_RULES: Array<{ test: RegExp; index: number }> = [
  { test: /^\s*(💡|🔆|🟡|TRUCO)/iu, index: 0 },
  { test: /^\s*(⚠️?|❗|🛑|ERROR|CUIDADO|OJO)/iu, index: 1 },
  { test: /^\s*(✅|☑️|🎉|SOLUCIÓN|SOLUCION)/iu, index: 2 },
  { test: /^\s*(🧠|🤔|ACTIVE RECALL|AUTOEVALUACIÓN)/iu, index: 3 },
  { test: /^\s*(📌|📍|DEFINICIÓN|DEFINICION|CLAVE)/iu, index: 4 },
  { test: /^\s*(🔍|🔎|LUPA|PISTA|INVESTIGA)/iu, index: 5 },
  { test: /^\s*(📝|🗒️|NOTA|RESUMEN)/iu, index: 6 },
];

function detectCallout(text: string): CalloutMeta {
  // Normaliza prefijos markdown (negritas, cursivas, flechas) para detectar palabras clave
  const normalized = text.replace(/^[\s*_>#\-▶►▸]+/, '');
  for (const rule of CALLOUT_RULES) {
    if (rule.test.test(text) || rule.test.test(normalized)) {
      return CALLOUT_META[rule.index];
    }
  }
  return CALLOUT_META[CALLOUT_META.length - 1]; // neutral
}

function stripLeadingEmoji(text: string): string {
  return text.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D]+\s*/u, '');
}

/* ------------------------------------------------------------------ */
/* Parser de bloques                                                   */
/* ------------------------------------------------------------------ */

/** Una entrada de lista, con sus sub-entradas (el anidamiento es estructura). */
interface ListItem {
  text: string;
  /** `true`/`false` si era una casilla `- [ ]`, `null` si es una viñeta normal. */
  done: boolean | null;
  /** La entrada estaba numerada (`1. `) en vez de ser una viñeta. */
  ordered: boolean;
  children: ListItem[];
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'details'; summary: string; lines: string[] }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'math'; tex: string }
  /** Respuesta de Active Recall, plegada para poder intentarlo antes de leerla. */
  | { kind: 'reveal'; label: string; text: string }
  | { kind: 'hr' };

/** Una línea de lista ya leída: sangría (nivel), marca y texto. */
interface ParsedListLine {
  indent: number;
  ordered: boolean;
  text: string;
  done: boolean | null;
}

/**
 * Lee una línea de lista. La sangría es la que dice el nivel: dos espacios por
 * nivel, como en Markdown, y las casillas `- [ ]` son entradas normales con
 * estado.
 */
function parseListLine(line: string): ParsedListLine | null {
  const match = line.match(/^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/);
  if (!match) return null;

  const task = match[3].match(/^\[([ xX])\]\s+(.*)$/);

  return {
    indent: match[1].replace(/\t/g, '  ').length,
    ordered: /\d/.test(match[2]),
    text: task ? task[2] : match[3],
    done: task ? task[1].toLowerCase() === 'x' : null,
  };
}

/**
 * Convierte las líneas de una lista en un árbol por sangría. Un apunte de
 * cátedra usa sub-viñetas para matizar un concepto, y aplanarlas convertía una
 * jerarquía en una lista interminable del mismo nivel.
 */
function buildListTree(lines: ParsedListLine[]): ListItem[] {
  const roots: ListItem[] = [];
  const stack: Array<{ indent: number; node: ListItem }> = [];

  for (const line of lines) {
    const node: ListItem = {
      text: line.text,
      done: line.done,
      ordered: line.ordered,
      children: [],
    };

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (line.indent > top.indent) break;
      stack.pop();
    }

    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].node.children.push(node);

    stack.push({ indent: line.indent, node });
  }

  return roots;
}

function isTableSeparator(line: string): boolean {
  return /^\|(\s*:?-{2,}:?\s*\|)+$/.test(line.trim());
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseBlocks(content: string): Block[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Línea vacía
    if (!trimmed) {
      i++;
      continue;
    }

    // Bloque de código
    const fence = trimmed.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // cierre
      blocks.push({ kind: 'code', lang, code: codeLines.join('\n') });
      continue;
    }

    // Toggle Active Recall <details> ... </details>
    if (trimmed.toLowerCase().startsWith('<details')) {
      const inner: string[] = [];
      i++;
      while (
        i < lines.length &&
        !lines[i].trim().toLowerCase().startsWith('</details')
      ) {
        inner.push(lines[i]);
        i++;
      }
      i++; // cierre
      let summary = 'Detalle';
      const summaryIndex = inner.findIndex((l) => /<summary>/i.test(l));
      if (summaryIndex >= 0) {
        const source = inner[summaryIndex];
        summary = source
          .replace(/<summary>/i, '')
          .replace(/<\/summary>/i, '')
          .replace(/^[▶►▸\s]+/, '')
          .trim();
        inner.splice(summaryIndex, 1);
      }
      blocks.push({ kind: 'details', summary, lines: inner });
      continue;
    }

    // Tablas
    if (trimmed.startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      const rows = tableLines
        .filter((l) => !isTableSeparator(l))
        .map(parseTableRow);
      if (rows.length > 0) blocks.push({ kind: 'table', rows });
      continue;
    }

    // Regla horizontal
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    // Encabezados
    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    // Fórmula en bloque $$...$$
    if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) {
      blocks.push({ kind: 'math', tex: trimmed.slice(2, -2) });
      i++;
      continue;
    }

    // Cita / callout
    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ kind: 'quote', lines: quoteLines });
      continue;
    }

    // Listas: viñetas, numeradas y casillas `- [ ]`, con su anidamiento real
    // por sangría. Antes se aplanaban todas y el apunte perdía la jerarquía.
    if (parseListLine(line)) {
      const parsed: ParsedListLine[] = [];
      while (i < lines.length) {
        const item = parseListLine(lines[i]);
        if (!item) break;
        parsed.push(item);
        i++;
      }
      blocks.push({ kind: 'list', items: buildListTree(parsed) });
      continue;
    }

    // Respuesta de Active Recall: se pliega para poder intentarlo antes de
    // leerla. Los apuntes nuevos no traen HTML: la respuesta viene como
    // `**Respuesta:** …` en el párrafo siguiente a la pregunta.
    const reveal = trimmed.match(
      /^(?:\*\*|__)?\s*(respuesta|soluci[oó]n)\s*(?:\*\*|__)?\s*[:—–-]\s*(.*)$/i
    );
    if (reveal) {
      const label = /^soluci/i.test(reveal[1]) ? 'Solución' : 'Respuesta';
      const answer: string[] = [reveal[2].trim()];
      i++;
      while (i < lines.length && lines[i].trim().length > 0) {
        answer.push(lines[i].trim());
        i++;
      }
      blocks.push({ kind: 'reveal', label, text: answer.join('\n').trim() });
      continue;
    }

    // Párrafo (agrupa líneas consecutivas normales)
    const paragraphLines: string[] = [];
    while (i < lines.length) {
      const current = lines[i].trim();
      if (
        !current ||
        current.startsWith('#') ||
        current.startsWith('|') ||
        current.startsWith('>') ||
        current.startsWith('```') ||
        current.toLowerCase().startsWith('<details') ||
        parseListLine(current) !== null ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(current)
      ) {
        break;
      }
      paragraphLines.push(current);
      i++;
    }
    if (paragraphLines.length > 0) {
      blocks.push({ kind: 'paragraph', lines: paragraphLines });
    } else {
      i++; // Salvaguarda anti-bucle infinito
    }
  }

  return blocks;
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

/**
 * Respuesta de Active Recall.
 *
 * En pantalla arranca plegada: la gracia es intentar responder antes de leerla.
 * El contenido se pinta SIEMPRE en el DOM y se oculta con CSS, así que al
 * imprimir no se pierde nunca, aunque el alumno la haya cerrado. En la vista de
 * impresión (`revealAnswers`) sale abierta desde el principio, porque en papel
 * no hay nada que pulsar.
 */
function AnswerReveal({
  label,
  text,
  revealAnswers,
}: {
  label: string;
  text: string;
  revealAnswers: boolean;
}) {
  const [open, setOpen] = useState(revealAnswers);

  return (
    <div className="reveal-answer rounded-xl border border-violet-500/30 bg-violet-500/5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left print:hidden"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-violet-500/30 bg-violet-500/15">
          <ChevronRight
            className={clsx(
              'h-3.5 w-3.5 text-violet-300 transition-transform',
              open && 'rotate-90'
            )}
          />
        </span>
        <span className="text-xs font-semibold text-violet-200">{label}</span>
        <span className="ml-auto text-[10px] font-mono uppercase tracking-wider text-violet-300/70">
          {open ? 'ocultar' : 'ver respuesta'}
        </span>
      </button>
      <div
        className={clsx(
          'px-3.5 pb-3.5 pt-0.5 print:block',
          !open && 'hidden'
        )}
      >
        <p className="border-t border-dashed border-violet-500/20 pt-2.5 text-sm leading-7 text-violet-50/90">
          {renderInline(text, 'reveal')}
        </p>
      </div>
    </div>
  );
}

/**
 * Lista con sub-entradas. El nivel 0 conserva el estilo de siempre (punto
 * esmeralda o número en caja) y los niveles de dentro van más pequeños y más
 * apagados, que es como se lee una jerarquía en un apunte.
 */
function ListBlock({ items, depth = 0 }: { items: ListItem[]; depth?: number }) {
  const ordered = items.length > 0 && items[0].ordered;
  const Tag = ordered ? 'ol' : 'ul';

  return (
    <Tag className={clsx('pl-1', depth === 0 ? 'space-y-1.5' : 'mt-1.5 space-y-1')}>
      {items.map((item, idx) => (
        <li key={idx} className="flex items-start gap-2.5">
          {item.done !== null ? (
            <span
              className={clsx(
                'mt-1 w-4 h-4 rounded border flex items-center justify-center shrink-0',
                item.done
                  ? 'bg-emerald-500/90 border-emerald-400 text-slate-950'
                  : 'border-slate-600 bg-transparent'
              )}
            >
              {item.done && <CheckCircle2 className="w-3 h-3" />}
            </span>
          ) : ordered ? (
            <span
              className={clsx(
                'flex items-center justify-center shrink-0 font-mono font-bold',
                depth === 0
                  ? 'mt-0.5 w-5 h-5 rounded-md bg-slate-800 border border-slate-700 text-[10px] text-emerald-300'
                  : 'mt-[6px] w-4 text-[10px] text-slate-400'
              )}
            >
              {idx + 1}
            </span>
          ) : (
            <span
              className={clsx(
                'rounded-full shrink-0',
                depth === 0
                  ? 'mt-[9px] w-1.5 h-1.5 bg-emerald-400/80'
                  : 'mt-[11px] w-1 h-1 bg-slate-500'
              )}
            />
          )}

          <div className="min-w-0 flex-1">
            <span
              className={clsx(
                'leading-7',
                depth === 0 ? 'text-sm' : 'text-[13px] leading-6',
                item.done ? 'text-slate-500 line-through' : depth === 0 ? 'text-slate-200/90' : 'text-slate-300/80'
              )}
            >
              {renderInline(item.text, `li-${depth}-${idx}`)}
            </span>
            {item.children.length > 0 && <ListBlock items={item.children} depth={depth + 1} />}
          </div>
        </li>
      ))}
    </Tag>
  );
}

function renderLines(lines: string[], prefix: string): ReactNode {
  return (
    <div className="space-y-2">
      {lines
        .filter((l) => l.trim())
        .map((line, idx) => (
          <p key={`${prefix}-${idx}`} className="text-sm leading-7 text-slate-200/90">
            {renderInline(line, `${prefix}-${idx}`)}
          </p>
        ))}
    </div>
  );
}

function renderBlock(block: Block, index: number, revealAnswers: boolean): ReactNode {
  const key = `block-${index}`;

  switch (block.kind) {
    case 'heading': {
      const sizes: Record<number, string> = {
        1: 'text-2xl font-black text-slate-50 mt-2',
        2: 'text-lg font-bold text-slate-100 mt-5',
        // `### ` es el apartado de cada punto del tema en los apuntes nuevos: se
        // le da un filo esmeralda para que se vea dónde empieza cada punto.
        3: 'mt-5 border-l-2 border-emerald-500/40 pl-2.5 text-[15px] font-bold text-slate-100',
        4: 'text-sm font-bold uppercase tracking-wide text-slate-300 mt-3',
      };
      return (
        <h3 key={key} className={clsx(sizes[block.level] ?? sizes[3], 'leading-snug')}>
          {renderInline(block.text, key)}
        </h3>
      );
    }

    case 'paragraph':
      return (
        <div key={key}>
          {renderLines(block.lines, key)}
        </div>
      );

    case 'list':
      return <ListBlock key={key} items={block.items} />;

    case 'reveal':
      return (
        <AnswerReveal key={key} label={block.label} text={block.text} revealAnswers={revealAnswers} />
      );

    case 'quote': {
      const firstLine = block.lines[0] ?? '';
      const meta = detectCallout(firstLine);
      const Icon = meta.icon;
      const cleanedLines = block.lines.map((line, idx) =>
        idx === 0 ? stripLeadingEmoji(line) : line
      );

      return (
        <div
          key={key}
          className={clsx(
            'flex items-start gap-3 rounded-xl border px-4 py-3',
            meta.containerClass
          )}
        >
          <Icon className={clsx('w-4 h-4 mt-1 shrink-0', meta.iconClass)} />
          <div className="min-w-0 flex-1 space-y-1">
            {cleanedLines
              .filter((l) => l.trim())
              .map((line, idx) => {
                const t = line.trim();
                if (t.startsWith('$$') && t.endsWith('$$') && t.length > 4) {
                  return <KatexMath key={`${key}-${idx}`} tex={t.slice(2, -2)} display />;
                }
                return (
                  <p key={`${key}-${idx}`} className="text-sm leading-7 text-slate-100/95">
                    {renderInline(line, `${key}-${idx}`)}
                  </p>
                );
              })}
          </div>
        </div>
      );
    }

    case 'table': {
      const [header, ...body] = block.rows;
      return (
        <div key={key} className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-slate-800/70">
                {header.map((cell, idx) => (
                  <th
                    key={`${key}-h-${idx}`}
                    className="px-3.5 py-2.5 text-left font-bold uppercase tracking-wider text-[10px] text-slate-300 border-b border-slate-700"
                  >
                    {renderInline(cell, `${key}-h-${idx}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, rIdx) => (
                <tr key={`${key}-r-${rIdx}`} className="even:bg-slate-900/40">
                  {row.map((cell, cIdx) => (
                    <td
                      key={`${key}-r-${rIdx}-${cIdx}`}
                      className="px-3.5 py-2.5 text-slate-200/90 border-b border-slate-800/70 align-top"
                    >
                      {renderInline(cell, `${key}-r-${rIdx}-${cIdx}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case 'details':
      return (
        <details
          key={key}
          className="group rounded-xl border border-slate-800 bg-[#080d17] px-4 py-3 open:bg-[#0a1120] transition-colors"
        >
          <summary className="flex items-center gap-2.5 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
            <span className="w-5 h-5 rounded-md bg-violet-500/15 border border-violet-500/30 flex items-center justify-center shrink-0">
              <ChevronRight className="w-3.5 h-3.5 text-violet-300 transition-transform group-open:rotate-90" />
            </span>
            <span className="text-sm font-semibold text-slate-100">
              {renderInline(block.summary, `${key}-summary`)}
            </span>
            <span className="ml-auto text-[10px] font-mono uppercase tracking-wider text-violet-300/70 hidden sm:inline">
              Active Recall
            </span>
          </summary>
          <div className="pt-3 mt-1 border-t border-dashed border-slate-800/70 space-y-2">
            {parseBlocks(block.lines.join('\n')).map((inner, innerIdx) =>
              renderBlock(inner, 1000 + innerIdx, revealAnswers)
            )}
          </div>
        </details>
      );

    case 'code':
      return (
        <pre
          key={key}
          className="rounded-xl border border-slate-800 bg-[#05080f] px-4 py-3.5 overflow-x-auto"
        >
          <code className="text-xs font-mono leading-6 text-emerald-200/90 whitespace-pre">
            {block.code}
          </code>
        </pre>
      );

    case 'math':
      return (
        <div
          key={key}
          className="rounded-xl border border-slate-800 bg-[#080d17] px-4 py-3 text-center"
        >
          <KatexMath tex={block.tex} display />
        </div>
      );

    case 'hr':
      return <hr key={key} className="border-slate-800 my-2" />;

    default:
      return null;
  }
}

export default function NoteRenderer({
  content,
  revealAnswers = false,
}: {
  content: string;
  /** En papel no hay nada que pulsar: las respuestas salen a la vista. */
  revealAnswers?: boolean;
}) {
  // Todo apunte pasa por el limpiador antes de pintarse: fuera vallas de código,
  // HTML y etiquetas internas. Así los apuntes guardados antes de que existiera
  // esa limpieza se ven igual de limpios, sin tocar nada de la base.
  const blocks = useMemo(
    () => parseBlocks(normalizeDelimiters(sanitizeNoteContent(content))),
    [content]
  );

  if (blocks.length === 0) {
    return (
      <p className="text-sm italic text-slate-500">
        Esta página aún no tiene contenido. Pulsa «Editar» para empezar a escribir.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {blocks.map((block, idx) => renderBlock(block, idx, revealAnswers))}
    </div>
  );
}
