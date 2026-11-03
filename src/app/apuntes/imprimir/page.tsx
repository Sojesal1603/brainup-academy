import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Download, FileText, GraduationCap, User } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import NoteRenderer from '@/components/apuntes/NoteRenderer';
import PrintButton from './PrintButton';

/**
 * Vista de impresión del cuaderno.
 *
 * Dos modos, desde el mismo sitio:
 *
 *   - `?note=<id>`   → un apunte, listo para imprimir o guardar en PDF.
 *   - `?subject=<id>` → el **dossier completo de una asignatura**: todos sus
 *     apuntes ordenados por unidad, cada uno con su título y su unidad. Es lo
 *     que quieres llevar al instituto la mañana del examen.
 *
 * La página se pinta en el tema oscuro de la app, así que el CSS de `@media
 * print` hace el trabajo sucio: quita el marco de la aplicación (barra lateral,
 * cabecera, navegación), fuerza tinta oscura sobre papel blanco, evita partir
 * tablas y fórmulas por la mitad y deja márgenes de folio. En pantalla se ve
 * igual que el cuaderno; en papel, limpio.
 */

export const dynamic = 'force-dynamic';

const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 15mm 13mm; }

  /* Fuera el marco de la app: en el papel solo va el apunte. */
  aside, nav, header, footer { display: none !important; }
  html, body { background: #fff !important; color: #111 !important; }
  body > div { padding: 0 !important; }
  main { padding: 0 !important; max-width: none !important; width: 100% !important; }

  /* El cuaderno se pinta para pantalla oscura: sobre papel, tinta oscura. */
  .apunte-print, .apunte-print * {
    color: #16181d !important;
    background-image: none !important;
    box-shadow: none !important;
  }

  /* Y los fondos oscuros pasan a blanco, o el texto sería ilegible. */
  .apunte-print [class*="bg-[#0"],
  .apunte-print [class*="bg-slate-8"],
  .apunte-print [class*="bg-slate-9"],
  .apunte-print pre,
  .apunte-print code,
  .apunte-print table,
  .apunte-print details {
    background-color: #fff !important;
  }

  .apunte-print pre,
  .apunte-print code,
  .apunte-print table,
  .apunte-print details,
  .apunte-print th,
  .apunte-print td {
    border-color: #cbd5e1 !important;
  }

  /* Nada de bloques partidos entre dos folios. */
  .apunte-print table,
  .apunte-print pre,
  .apunte-print details,
  .apunte-print li { break-inside: avoid; }
  .apunte-print h3,
  .apunte-print summary { break-after: avoid; }

  .apunte-print { font-size: 11pt; }
  .apunte-print a { text-decoration: underline; }

  /* Un apunte, un folio: en el dossier cada apunte empieza en página nueva,
     para poder arrancar el que toca sin partir el anterior por la mitad. */
  .apunte-page + .apunte-page { break-before: page; }

  /* Las respuestas de Active Recall salen SIEMPRE en papel, estén plegadas o
     no: en el folio no hay nada que pulsar y perder la respuesta es perder
     media sección del apunte. */
  .apunte-print .reveal-answer,
  .apunte-print .reveal-answer > div {
    display: block !important;
  }
}
`;

interface PrintableNote {
  id: string;
  title: string;
  content: string;
  author: string;
  updatedAt: Date;
  agent: { name: string } | null;
}

interface PrintableTopic {
  title: string;
  unitNumber: number | null;
  subject: { id: string; name: string; color: string };
}

/** «U3 · Matrices», o solo el título si la unidad no está numerada. */
function unitLabel(topic: { title: string; unitNumber: number | null }): string {
  return topic.unitNumber ? `U${topic.unitNumber} · ${topic.title}` : topic.title;
}

/** Fecha del apunte en español. */
function formatDate(date: Date): string {
  return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** «Del catedrático X» o «Tus apuntes»: en el papel también se sabe de quién es. */
function authorLabel(note: PrintableNote): string {
  if (note.author !== 'catedratico') return 'Tus apuntes';
  return `Del catedrático${note.agent?.name ? ` ${note.agent.name}` : ''}`;
}

function AuthorBadge({ note }: { note: PrintableNote }) {
  const fromCatedratico = note.author === 'catedratico';
  return (
    <span
      className={
        fromCatedratico
          ? 'inline-flex items-center gap-1.5 rounded-lg border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-violet-200 print:border-slate-400 print:bg-transparent print:text-slate-700'
          : 'inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/60 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-300 print:border-slate-400 print:bg-transparent print:text-slate-700'
      }
    >
      {fromCatedratico ? (
        <GraduationCap className="h-3 w-3 shrink-0" />
      ) : (
        <User className="h-3 w-3 shrink-0" />
      )}
      {authorLabel(note)}
    </span>
  );
}

/** Enlace de descarga en Markdown del apunte. No se imprime. */
function DownloadLink({ noteId, label = 'Descargar .md' }: { noteId: string; label?: string }) {
  return (
    <a
      href={`/api/notes/${noteId}/download`}
      className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-[#111827] px-3.5 py-2.5 text-xs font-semibold text-slate-200 transition-all hover:border-emerald-500/40 hover:text-emerald-300 print:hidden"
    >
      <Download className="h-4 w-4" />
      <span>{label}</span>
    </a>
  );
}

/** Mensaje sencillo para cuando se llega aquí sin decir qué apunte. */
function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="space-y-4">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      <div className="flex items-center gap-2">
        <FileText className="h-5 w-5 text-emerald-400" />
        <h1 className="font-mono text-lg font-black uppercase tracking-tight text-slate-100">
          {title}
        </h1>
      </div>
      <p className="text-sm leading-relaxed text-slate-400">{message}</p>
      <Link
        href="/apuntes"
        className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-400 hover:text-emerald-300"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Volver al cuaderno
      </Link>
    </div>
  );
}

export default async function PrintNotesPage({
  searchParams,
}: {
  searchParams: Promise<{ note?: string; subject?: string }>;
}) {
  const { note: noteId, subject: subjectId } = await searchParams;

  if (!noteId && !subjectId) {
    return (
      <EmptyState
        title="Imprimir apuntes"
        message="Abre esta página desde el cuaderno: elige un apunte y pulsa «Imprimir», o imprime la asignatura entera. Si has llegado aquí por un enlace antiguo, vuelve al cuaderno y elígelo otra vez."
      />
    );
  }

  /* --------------------------- Un solo apunte --------------------------- */
  if (noteId) {
    const note = await prisma.note.findUnique({
      where: { id: noteId },
      include: {
        topic: { include: { subject: true } },
        agent: { select: { name: true } },
      },
    });

    if (!note) notFound();

    const topic: PrintableTopic = {
      title: note.topic.title,
      unitNumber: note.topic.unitNumber,
      subject: {
        id: note.topic.subject.id,
        name: note.topic.subject.name,
        color: note.topic.subject.color,
      },
    };
    const printable: PrintableNote = {
      id: note.id,
      title: note.title,
      content: note.content,
      author: note.author,
      updatedAt: note.updatedAt,
      agent: note.agent,
    };

    return (
      <div className="space-y-6">
        <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Link
            href="/apuntes"
            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-[#111827] px-3.5 py-2.5 text-xs font-semibold text-slate-200 transition-all hover:border-emerald-500/40 hover:text-emerald-300"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Cuaderno</span>
          </Link>
          <PrintButton />
          <DownloadLink noteId={note.id} />
          <Link
            href={`/apuntes/imprimir?subject=${topic.subject.id}`}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-[#111827] px-3.5 py-2.5 text-xs font-semibold text-slate-200 transition-all hover:border-emerald-500/40 hover:text-emerald-300"
          >
            <FileText className="h-4 w-4" />
            <span>Imprimir toda la asignatura</span>
          </Link>
        </div>

        {/* Ojo: NO es <header>, porque el CSS de impresión oculta el marco de la app. */}
        <div className="space-y-2 border-b border-white/10 pb-4 print:border-slate-300">
          <p className="font-mono text-[11px] uppercase tracking-widest text-emerald-400 print:text-slate-600">
            BrainUp Academy · {topic.subject.name}
          </p>
          <h1 className="font-mono text-2xl font-black uppercase tracking-tight text-slate-100 print:text-black">
            {printable.title}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-wider text-emerald-400 print:text-slate-600">
              {unitLabel(topic)}
            </span>
            <AuthorBadge note={printable} />
            <span className="text-[11px] text-slate-500 print:text-slate-600">
              {formatDate(printable.updatedAt)}
            </span>
          </div>
        </div>

        <article className="apunte-print">
          <NoteRenderer content={printable.content} revealAnswers />
        </article>

        <p className="pt-2 text-center font-mono text-[10px] text-slate-600 print:text-slate-700">
          BrainUp Academy · apunte de {topic.subject.name}
        </p>
      </div>
    );
  }

  /* ------------------- Dossier completo de una asignatura ---------------- */
  const subject = await prisma.subject.findUnique({
    where: { id: subjectId },
    include: {
      topics: {
        include: {
          notes: {
            include: { agent: { select: { name: true } } },
          },
        },
      },
    },
  });

  if (!subject) notFound();

  const entries = subject.topics
    .flatMap((topic) =>
      topic.notes.map((note) => ({
        note: {
          id: note.id,
          title: note.title,
          content: note.content,
          author: note.author,
          updatedAt: note.updatedAt,
          agent: note.agent,
        } satisfies PrintableNote,
        topic: { title: topic.title, unitNumber: topic.unitNumber },
      }))
    )
    // Por unidad y, dentro de la unidad, el más reciente al final.
    .sort((a, b) => {
      const unitA = a.topic.unitNumber ?? Number.MAX_SAFE_INTEGER;
      const unitB = b.topic.unitNumber ?? Number.MAX_SAFE_INTEGER;
      if (unitA !== unitB) return unitA - unitB;
      return a.note.updatedAt.getTime() - b.note.updatedAt.getTime();
    });

  if (entries.length === 0) {
    return (
      <EmptyState
        title={subject.name}
        message="Esta asignatura todavía no tiene apuntes en el cuaderno. Cuando escribas uno (o se lo pidas a su catedrático), podrás imprimir aquí el dossier completo."
      />
    );
  }

  const fromCatedratico = entries.filter((entry) => entry.note.author === 'catedratico').length;

  return (
    <div className="space-y-6">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Link
          href="/apuntes"
          className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-[#111827] px-3.5 py-2.5 text-xs font-semibold text-slate-200 transition-all hover:border-emerald-500/40 hover:text-emerald-300"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Cuaderno</span>
        </Link>
        <PrintButton />
      </div>

      {/* Ojo: NO es <header>, porque el CSS de impresión oculta el marco de la app. */}
      <div className="space-y-2 border-b border-white/10 pb-4 print:border-slate-300">
        <p className="font-mono text-[11px] uppercase tracking-widest text-emerald-400 print:text-slate-600">
          BrainUp Academy · Dossier de asignatura
        </p>
        <h1 className="font-mono text-2xl font-black uppercase tracking-tight text-slate-100 print:text-black">
          {subject.name}
        </h1>
        <p className="text-xs text-slate-400 print:text-slate-700">
          {entries.length} {entries.length === 1 ? 'apunte' : 'apuntes'}
          {fromCatedratico > 0
            ? ` · ${fromCatedratico} escritos por ${fromCatedratico === 1 ? 'su catedrático' : 'sus catedráticos'}`
            : ''}
        </p>
      </div>

      <div className="apunte-print space-y-12">
        {entries.map((entry) => (
          <article key={entry.note.id} className="apunte-page space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-2 print:border-slate-300">
              <div className="min-w-0 space-y-1">
                <h2 className="text-lg font-bold leading-snug text-slate-100 print:text-black">
                  {entry.note.title}
                </h2>
                <p className="font-mono text-[11px] uppercase tracking-wider text-emerald-400 print:text-slate-600">
                  {unitLabel(entry.topic)}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <AuthorBadge note={entry.note} />
                <DownloadLink noteId={entry.note.id} label=".md" />
              </div>
            </div>
            <NoteRenderer content={entry.note.content} revealAnswers />
          </article>
        ))}
      </div>

      <p className="pt-2 text-center font-mono text-[10px] text-slate-600 print:text-slate-700">
        BrainUp Academy · {subject.name} · {entries.length}{' '}
        {entries.length === 1 ? 'apunte' : 'apuntes'}
      </p>
    </div>
  );
}
