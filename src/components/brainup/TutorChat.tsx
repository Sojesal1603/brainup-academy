'use client';

import NeuralLoader from '@/components/ui/NeuralLoader';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  Download,
  Eye,
  FileText,
  GraduationCap,
  ImageIcon,
  Loader2,
  NotebookPen,
  PanelRight,
  Paperclip,
  Printer,
  Ruler,
  RotateCcw,
  Send,
  ShieldQuestion,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import MarkdownMessage from './MarkdownMessage';
import NoteSplitPanel, {
  type EngineOption,
  type NoteVariant,
  type PanelMode,
  type SplitNote,
} from './NoteSplitPanel';
import type { NoteProposal } from '@/lib/apuntesIa';
import {
  ALLOWED_ATTACHMENT_HINT,
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENT_BYTES,
  MAX_TUTOR_ATTACHMENTS,
  MIME_BY_EXTENSION,
  extensionOf,
  formatBytes,
  isAllowedMime,
  isImageMime,
} from '@/lib/attachmentLimits';

/**
 * Cuánto se espera una respuesta antes de darla por perdida.
 *
 * El servidor ya se corta solo a los 30 s de IA y contesta con el respaldo
 * local, así que este tope solo cubre el caso de que la conexión se quede
 * colgada (red, servidor reiniciándose). Sin él, el spinner giraba para siempre
 * y el alumno no sabía si esperar o recargar.
 */
const CHAT_TIMEOUT_MS = 150_000;
/** Redactar un apunte es la llamada más cara del sistema: más margen. */
const NOTES_TIMEOUT_MS = 240_000;

/** Un error HTTP con su estado, para poder decidir si merece la pena reintentar. */
class HttpStatusError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** Qué se le cuenta al alumno según lo que haya contestado el servidor. */
function describeHttpStatus(status: number): string {
  if (status === 401) return 'Tu sesión ha caducado. Recarga la página y vuelve a entrar.';
  if (status === 403) return 'Esa acción no está permitida ahora mismo.';
  if (status === 404) return 'No se ha encontrado el catedrático o la conversación. Recarga la página.';
  if (status === 413) return 'La petición es demasiado grande: quita algún adjunto o acorta el mensaje.';
  if (status === 429) {
    return 'Ahora mismo no queda cupo de IA (los motores gratuitos se han agotado). Espera un minuto y vuelve a intentarlo: tu mensaje no se ha perdido.';
  }
  if (status === 502) {
    return 'El motor de IA no ha contestado a tiempo. Suele ser saturación momentánea: vuelve a intentarlo en unos segundos.';
  }
  if (status === 503) {
    return 'El servidor no está disponible un momento (puede estar arrancando). Vuelve a intentarlo en unos segundos.';
  }
  if (status === 504) return 'El servidor ha tardado demasiado en contestar. Vuelve a intentarlo.';
  if (status >= 500) {
    return `El servidor ha fallado al responder (error ${status}). Tu mensaje no se ha perdido: vuelve a intentarlo.`;
  }
  return `La petición no ha salido bien (error ${status}). Vuelve a intentarlo.`;
}

/** ¿El fallo es de red (fetch ni siquiera llegó a responder)? */
function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TypeError') return true;
  return /failed to fetch|networkerror|network error|load failed|fetch failed|network request failed/i.test(
    error.message
  );
}

/** Mensaje en castellano para el alumno, en vez del «Failed to fetch» crudo. */
function describeFetchError(error: unknown): string {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'La espera se ha cortado porque el catedrático ha tardado demasiado. No se ha perdido nada: vuelve a intentarlo.';
  }
  if (isNetworkFailure(error)) {
    return 'Se ha cortado la conexión con el servidor (puede haberse reiniciado o haber fallado la red). Tu mensaje sigue aquí: pulsa «Reintentar».';
  }
  const message = error instanceof Error ? error.message.trim() : '';
  return message.length > 0 ? message : 'Error inesperado del tutor.';
}

/** Solo se ofrece reintentar cuando el fallo puede irse con otra tentativa. */
function canRetry(error: unknown): boolean {
  if (error instanceof HttpStatusError) return error.status === 429 || error.status >= 500;
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return true;
  }
  return isNetworkFailure(error);
}

type TutorStage =
  | 'diagnostico'
  | 'pista_1'
  | 'pista_2'
  | 'verificacion'
  | 'resolucion'
  | 'explicacion_directa';

/** Adjunto ya enviado (vive en el historial guardado en tu SQLite). */
export interface AttachmentRef {
  name: string;
  mimeType: string;
  sizeBytes?: number;
}

/** Apunte que el catedrático está leyendo, para poder enseñarlo en el chat. */
export interface SharedNoteRef {
  id: string;
  title: string;
  topicLabel: string | null;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  stage?: TutorStage | null;
  attachments?: AttachmentRef[];
  /** Apunte que el catedrático ofrece escribirle, a la espera de tu permiso. */
  noteProposal?: NoteProposal | null;
}

/** Apunte ya redactado, para poder abrirlo, descargarlo o imprimirlo. */
export interface WrittenNoteRef {
  id: string;
  title: string;
  unitNumber: number | null;
  unitTitle: string;
  subjectId: string;
}

/** Un apunte ya redactado que espera tu visto bueno (vista previa). */
interface NoteDraftPreview {
  token: string;
  title: string;
  content: string;
  unitNumber: number | null;
  unitTitle: string;
  /** El título ha corregido el número que proponía el catedrático. */
  unitCorrected?: boolean;
  /** La unidad que él dijo, cuando no era la de verdad. */
  requestedUnitNumber?: number | null;
  subjectName: string;
  agentName: string;
  words: number;
  developedPoints: number;
  structureMissing: string[];
  model: string;
  /** Motor que la ha escrito (para marcar su pestaña en la comparativa). */
  provider: string;
}

/** Documento abierto en la vista dividida (borrador o apunte ya guardado). */
interface PanelNote extends SplitNote {
  /** Mensaje del chat al que pertenece: es lo que permite guardarlo. */
  messageId: string;
  /** Una entrada por motor: la misma unidad escrita por cada IA disponible. */
  variants: NoteVariant[];
  /** Motor cuya versión se está leyendo ahora. */
  activeEngine: string;
}

/** Estado de cada propuesta de apunte, por mensaje. */
interface NoteJob {
  status: 'writing' | 'preview' | 'saving' | 'done' | 'error' | 'dismissed';
  error?: string;
  updated?: boolean;
  note?: WrittenNoteRef;
  /** Lo redactado, tal y como se va a guardar (lo que se enseña en la vista previa). */
  draft?: NoteDraftPreview;
}

/**
 * Adjunto recién soltado: se sube a disco **según se elige** y espera ahí a
 * viajar en el próximo mensaje. Del archivo solo viaja después su id.
 */
interface PendingAttachment extends AttachmentRef {
  /** Clave local, para poder seguirlo mientras sube. */
  key: string;
  /** Id de la copia en el servidor; `null` mientras sube. */
  uploadId: string | null;
  /** 0-100 mientras sube; `null` cuando ya está arriba. */
  progress: number | null;
  /** Cómo se ha podido leer: `texto`, `imagen`, `sin_texto`. */
  mode: string | null;
  pages: number;
  chars: number;
  /** Avisos honestos del servidor (páginas escaneadas, texto cortado…). */
  notes: string[];
  /** Miniatura de las imágenes (blob local); `null` en los documentos. */
  previewUrl: string | null;
}

/** Lo que el servidor contesta cuando ya tiene el archivo en el disco. */
interface UploadedDoc {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  mode: string;
  pages: number;
  chars: number;
  notes: string[];
}

interface TutorAgent {
  id: string;
  name: string;
  specialty: string;
  subject: { name: string; color: string };
}

/** Contexto real del alumno para el saludo de apertura del catedrático. */
export interface TutorOpeningContext {
  /** Unidad con nivel MEDIDO más bajo (null si no hay ninguna medición). */
  weakTopicLabel: string | null;
  /** Unidades de la materia que nadie ha medido: sin esto no se puede juzgar nada. */
  unmeasuredCount: number;
  nextExamLabel: string | null;
  examDays: number | null;
  pendingErrors: number;
}

interface TutorChatProps {
  agent: TutorAgent;
  model: string;
  initialConversationId: string | null;
  initialMessages: ChatMessage[];
  opening: TutorOpeningContext;
  /** Cuántos apuntes tiene de esta materia, para el interruptor de compartir. */
  notes: { total: number; titles: string[] };
  /** Motores que pueden escribir ahora mismo: alimentan la comparativa. */
  engines: EngineOption[];
}

/** Ficha de un adjunto: miniatura si es imagen, icono si es PDF, y su nombre. */
function AttachmentChipView({ attachment }: { attachment: AttachmentRef }) {
  const isImage = isImageMime(attachment.mimeType);
  return (
    <span className="flex max-w-[240px] items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-200">
      {isImage ? (
        <ImageIcon className="h-3 w-3 shrink-0" />
      ) : (
        <FileText className="h-3 w-3 shrink-0" />
      )}
      <span className="truncate" title={attachment.name}>
        {attachment.name}
      </span>
      {typeof attachment.sizeBytes === 'number' && attachment.sizeBytes > 0 && (
        <span className="shrink-0 font-mono opacity-70">{formatBytes(attachment.sizeBytes)}</span>
      )}
    </span>
  );
}

/** El tipo que se manda al servidor: el que dice el navegador o, si no dice nada
 * útil (`.md`, `.tex` y compañía llegan como vacío), el de la extensión. */
function resolveUploadMime(file: File): string {
  const declared = String(file.type ?? '').trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && isAllowedMime(declared)) return declared;
  return MIME_BY_EXTENSION[extensionOf(file.name)] ?? declared;
}

/**
 * Sube un archivo por su propia puerta (`PUT /api/tutor/attachments`).
 *
 * Aquí está justo lo que quitó el tope de 6 MB: el archivo **no** se convierte a
 * base64 ni entra en el JSON del chat —eso obligaba a tenerlo entero en la
 * memoria del navegador y del servidor—, se manda en crudo y el servidor lo
 * escribe en disco mientras llega. El progreso se lee del propio
 * `XMLHttpRequest`, que es lo único que sabe cuánto lleva enviado.
 *
 * Se valida aquí lo mismo que validará el servidor: un archivo que iba a ser
 * rechazado no gasta ni un byte de subida.
 */
function uploadAttachment(
  file: File,
  onProgress: (percent: number) => void
): Promise<{ ok: true; value: UploadedDoc } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const mimeType = resolveUploadMime(file);

    if (!isAllowedMime(mimeType)) {
      resolve({
        ok: false,
        error: `No sé leer «${file.name}» (${file.type || 'tipo desconocido'}). ${ALLOWED_ATTACHMENT_HINT}`,
      });
      return;
    }
    if (file.size === 0) {
      resolve({ ok: false, error: `«${file.name}» está vacío.` });
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      resolve({
        ok: false,
        error: `«${file.name}» pesa ${formatBytes(file.size)} y el tope por archivo es ${formatBytes(
          MAX_ATTACHMENT_BYTES
        )}. Divídelo (por ejemplo, por temas) y sube cada parte.`,
      });
      return;
    }

    const request = new XMLHttpRequest();
    request.open('PUT', '/api/tutor/attachments');
    request.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    request.setRequestHeader('x-file-type', mimeType);
    request.setRequestHeader('x-file-size', String(file.size));

    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    };

    request.onerror = () =>
      resolve({ ok: false, error: `No se ha podido subir «${file.name}»: se ha cortado la conexión.` });
    request.onabort = () => resolve({ ok: false, error: `La subida de «${file.name}» se ha cancelado.` });

    request.onload = () => {
      let payload: { upload?: UploadedDoc; error?: string } | null = null;
      try {
        payload = JSON.parse(request.responseText) as { upload?: UploadedDoc; error?: string };
      } catch {
        payload = null;
      }

      if (request.status >= 200 && request.status < 300 && payload?.upload) {
        onProgress(100);
        resolve({ ok: true, value: payload.upload });
        return;
      }

      resolve({
        ok: false,
        error:
          payload?.error ||
          (request.status === 0
            ? `No se ha podido subir «${file.name}»: el servidor no ha respondido.`
            : `No se ha podido subir «${file.name}» (error ${request.status}).`),
      });
    };

    request.send(file);
  });
}

/**
 * Borra del servidor la copia de un archivo que ya no se va a enviar. Es cortesía
 * con el disco del alumno, no una condición: si falla, el archivo se queda ahí
 * sin hacer daño a nadie.
 */
function discardUpload(uploadId: string | null): void {
  if (!uploadId) return;
  void fetch(`/api/tutor/attachments?id=${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(
    () => {}
  );
}

/** Qué se ha podido leer de un archivo ya subido, en dos palabras. */
function readLabel(attachment: PendingAttachment): string {
  if (attachment.mode === 'imagen') return 'imagen';
  if (attachment.mode === 'sin_texto') return 'sin texto';
  if (attachment.mode === 'texto') {
    if (attachment.pages > 0) return `${attachment.pages} pág.`;
    return `${Math.round((attachment.chars ?? 0) / 1000)} mil car.`;
  }
  return '';
}

const STAGE_ORDER: TutorStage[] = [
  'diagnostico',
  'pista_1',
  'pista_2',
  'verificacion',
  'resolucion',
];

const STAGE_META: Record<TutorStage, { label: string; className: string }> = {
  diagnostico: {
    label: 'Diagnóstico',
    className: 'bg-amber-500/10 text-amber-300 border-amber-500/40',
  },
  pista_1: {
    label: 'Pista 1',
    className: 'bg-sky-500/10 text-sky-300 border-sky-500/40',
  },
  pista_2: {
    label: 'Pista 2',
    className: 'bg-cyan-500/10 text-cyan-200 border-cyan-500/40',
  },
  verificacion: {
    label: 'Verificación',
    className: 'bg-violet-500/10 text-violet-300 border-violet-500/40',
  },
  resolucion: {
    label: 'Resolución',
    className: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/40',
  },
  explicacion_directa: {
    label: 'Explicación Directa',
    className: 'bg-teal-500/10 text-teal-300 border-teal-500/40',
  },
};

/** Saludo de apertura: lo redacta la app con tus datos reales, sin gastar IA. */
function buildOpeningMessage(agent: TutorAgent, opening: TutorOpeningContext): string {
  const lines: string[] = [
    `Soy **${agent.name}**.`,
    `Mi trabajo aquí: ${agent.specialty}.`,
    'Mi método es socrático por defecto para retarte a razonar, pero si me pides una explicación directa o un resumen sin preguntas, te lo explico al momento.',
  ];

  const situation: string[] = [];
  if (opening.weakTopicLabel) {
    situation.push(
      `Unidad con nivel medido más bajo: **${opening.weakTopicLabel}** (medida de verdad, no supuesta).`
    );
  } else if (opening.unmeasuredCount > 0) {
    situation.push(
      `Todavía **no hay ninguna medición real de tu nivel** en esta materia (${opening.unmeasuredCount} unidades sin medir). No te voy a decir que algo se te da mal porque no lo sé: hoy toca medirlo.`
    );
  }
  if (opening.nextExamLabel) {
    situation.push(
      `Próximo examen: **${opening.nextExamLabel}**${
        opening.examDays !== null
          ? opening.examDays <= 0
            ? ' (es hoy)'
            : opening.examDays === 1
              ? ' (mañana)'
              : ` (en ${opening.examDays} días)`
          : ''
      }.`
    );
  }
  if (opening.pendingErrors > 0) {
    situation.push(
      `Arrastras ${opening.pendingErrors} ${
        opening.pendingErrors === 1 ? 'error sin dominar' : 'errores sin dominar'
      } en el banco.`
    );
  }

  if (situation.length > 0) {
    lines.push('Esto es lo que veo en tu expediente:');
    lines.push(situation.map((item) => `- ${item}`).join('\n'));
  }

  lines.push('¿Por dónde empezamos? Elige abajo o lánzame directamente tu duda.');

  return lines.join('\n\n');
}

/**
 * La tarjeta de la propuesta: el catedrático pide permiso y el alumno decide.
 *
 * Mientras no diga que sí, aquí no se escribe nada. Si acepta, se muestra dónde
 * ha quedado el apunte y cómo descargarlo o imprimirlo.
 */
function NoteOfferCard({
  proposal,
  job,
  agentName,
  onOpen,
  onPreview,
  onSave,
  onDismiss,
}: {
  proposal: NoteProposal;
  job: NoteJob | undefined;
  agentName: string;
  /** Abrirlo en la vista dividida para leerlo con calma. */
  onOpen: () => void;
  /** Redactar (o volver a redactar) y enseñarlo sin guardarlo. */
  onPreview: () => void;
  /** Guardar el apunte que se acaba de leer, tal cual. */
  onSave: () => void;
  onDismiss: () => void;
}) {
  if (job?.status === 'dismissed') return null;

  const unitLabel = proposal.unitNumber ? ` de la unidad ${proposal.unitNumber}` : '';
  const draft = job?.draft;
  const busy = job?.status === 'writing' || job?.status === 'saving';

  return (
    <div className="space-y-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 py-3">
      <p className="flex items-start gap-2 text-[11px] leading-relaxed text-stone-300">
        <NotebookPen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-300/80" />
        <span>
          {agentName} te ofrece <strong>unos apuntes suyos</strong>
          {unitLabel}: <strong>«{proposal.title}»</strong>. Los escribiría en tu cuaderno, en la
          sección de su asignatura, listos para imprimir.
        </span>
      </p>

      {job?.status === 'writing' && (
        <p className="flex items-center gap-2 pl-6 text-[11px] text-violet-200">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Redactando tus apuntes… puede tardar un poco: los está escribiendo enteros.
        </p>
      )}

      {/*
        * LA VISTA PREVIA.
        *
        * El apunte ya está escrito y se lee aquí tal y como va a quedar en el
        * cuaderno (mismo motor de pintado que el cuaderno, mismas cajas y mismas
        * fórmulas). Todavía no se ha guardado nada: hasta que no diga «guardar»,
        * no entra. Si no le convence, pide otra versión sin ensuciar nada.
        */}
      {draft && (job?.status === 'preview' || job?.status === 'saving') && (
        <div className="space-y-2 pl-6">
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-violet-200">
            <span className="rounded bg-violet-500/20 px-1.5 py-0.5 font-bold uppercase tracking-wider">
              Vista previa
            </span>
            <span className="font-semibold text-slate-200">«{draft.title}»</span>
            <span className="font-mono text-slate-400">
              {draft.words} palabras · {draft.developedPoints} apartados
            </span>
            <span className="text-slate-500">Todavía no está en tu cuaderno</span>
          </div>

          {/*
           * De qué unidad son. Va aquí, con la vista previa, porque es la forma
           * de darse cuenta a la primera de si son los apuntes del tema que ha
           * pedido: antes solo se veía el título del apunte, y un apunte de otra
           * unidad pasaba por bueno hasta guardarlo.
           */}
          <p className="text-[11px] leading-relaxed text-violet-200">
            {draft.unitNumber ? `Unidad ${draft.unitNumber} · ` : ''}
            <span className="font-semibold text-slate-200">{draft.unitTitle}</span>
            <span className="text-slate-500"> · {draft.subjectName}</span>
          </p>
          {draft.unitCorrected && (
            <p className="text-[10px] leading-relaxed text-amber-200">
              La propuesta apuntaba a la unidad {draft.requestedUnitNumber ?? '?'}, pero el tema era
              este: los apuntes son de la unidad {draft.unitNumber ?? '?'}. Si no es lo que querías,
              dímelo y los escribo de otra.
            </p>
          )}

          {draft.structureMissing.length > 0 && (
            <p className="flex items-start gap-2 text-[11px] leading-relaxed text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span>
                Le falta {draft.structureMissing.join(', ')}. Si lo guardas así, se queda con su aviso
                en el taller — pídele otra versión si lo quieres completo.
              </span>
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              onClick={onOpen}
              title="Leerlo en la vista dividida, sin salir del chat"
              className="flex items-center gap-1.5 rounded-lg bg-stone-200 px-2.5 py-1.5 text-[10px] font-semibold text-stone-900 transition-colors hover:bg-white"
            >
              <PanelRight className="h-3 w-3" />
              Abrir documento
            </button>
            <button
              onClick={onSave}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[10px] font-semibold text-stone-200 transition-colors hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {job?.status === 'saving' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              {job?.status === 'saving' ? 'Guardando…' : 'Guardar'}
            </button>
            <button
              onClick={onPreview}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#111827] px-2.5 py-1.5 text-[10px] font-semibold text-slate-200 transition-colors hover:border-violet-500/40 hover:text-violet-200 disabled:opacity-50"
            >
              <RotateCcw className="h-3 w-3" />
              Otra versión
            </button>
            <button
              onClick={onDismiss}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] font-semibold text-slate-400 transition-colors hover:text-slate-200 disabled:opacity-50"
            >
              <X className="h-3 w-3" />
              Descartar
            </button>
          </div>
        </div>
      )}

      {job?.status === 'error' && (
        <p className="flex items-start gap-2 pl-6 text-[11px] leading-relaxed text-rose-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />
          <span>
            {job.error}{' '}
            <button onClick={onPreview} className="font-semibold underline hover:text-rose-100">
              Reintentar
            </button>
          </span>
        </p>
      )}

      {job?.status === 'done' && job.note && (
        <div className="space-y-2 pl-6">
          <p className="flex items-start gap-2 text-[11px] leading-relaxed text-emerald-200">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <span>
              {job.updated ? 'Apunte actualizado' : 'Apunte escrito'}:{' '}
              <strong>«{job.note.title}»</strong>
              {job.note.unitNumber ? ` (U${job.note.unitNumber} · ${job.note.unitTitle})` : ''}. Ya está en
              tu cuaderno.
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/apuntes"
              className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[10px] font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/20"
            >
              <BookOpen className="h-3 w-3" />
              Ver en el cuaderno
            </Link>
            <a
              href={`/api/notes/${job.note.id}/download`}
              className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#111827] px-2.5 py-1.5 text-[10px] font-semibold text-slate-200 transition-colors hover:border-emerald-500/40 hover:text-emerald-300"
            >
              <Download className="h-3 w-3" />
              Descargar .md
            </a>
            <a
              href={`/apuntes/imprimir?note=${job.note.id}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#111827] px-2.5 py-1.5 text-[10px] font-semibold text-slate-200 transition-colors hover:border-emerald-500/40 hover:text-emerald-300"
            >
              <Printer className="h-3 w-3" />
              Imprimir
            </a>
          </div>
        </div>
      )}

      {(!job || job.status === 'writing' || job.status === 'error') && (
        <div className="flex flex-wrap gap-2 pl-6">
          <button
            onClick={onPreview}
            disabled={job?.status === 'writing'}
            className="flex items-center gap-1.5 rounded-lg bg-violet-500 px-2.5 py-1.5 text-[10px] font-bold text-slate-950 transition-colors hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {job?.status === 'writing' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            {job?.status === 'writing' ? 'Escribiendo…' : 'Sí, enséñamelos antes'}
          </button>
          <button
            onClick={onDismiss}
            disabled={job?.status === 'writing'}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#111827] px-2.5 py-1.5 text-[10px] font-semibold text-slate-300 transition-colors hover:border-slate-500 disabled:opacity-50"
          >
            <X className="h-3 w-3" />
            Ahora no
          </button>
        </div>
      )}
    </div>
  );
}

export default function TutorChat({
  agent,
  model,
  initialConversationId,
  initialMessages,
  opening,
  notes,
  engines,
}: TutorChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [activeModel, setActiveModel] = useState(model);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Turno que falló por red o por el servidor: se puede reenviar tal cual. */
  const [failedTurn, setFailedTurn] = useState<{
    text: string;
    attachments: PendingAttachment[];
  } | null>(null);
  const [measurement, setMeasurement] = useState<
    { unitNumber: number; title: string; mastery: number } | null
  >(null);
  // Archivos listos para enviar (capturas, fotos, PDF) y ajustes del turno.
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentWarning, setAttachmentWarning] = useState<string | null>(null);
  // Compartir los apuntes es la opción cómoda: se puede apagar en cualquier momento.
  const [shareNotes, setShareNotes] = useState(true);
  const [sharedNotes, setSharedNotes] = useState<SharedNoteRef[]>([]);
  // Propuestas de apunte: pendientes, en redacción, escritas o rechazadas.
  const [noteJobs, setNoteJobs] = useState<Record<string, NoteJob>>({});
  // Vista dividida: el documento que se lee al lado del chat.
  const [panel, setPanel] = useState<PanelNote | null>(null);
  const [panelSaving, setPanelSaving] = useState(false);
  /** Chat a todo el ancho, texto Markdown o folio PDF digital. */
  const [panelMode, setPanelMode] = useState<PanelMode>('chat');

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** ¿El alumno está al final del hilo? Si no, no se le mueve la vista. */
  const nearBottomRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  /** Adjuntos que el alumno ha quitado mientras subían (hay que borrarlos del servidor). */
  const removedRef = useRef<Set<string>>(new Set());

  /** ¿Hay algún archivo subiendo todavía? (entonces no se puede enviar el turno) */
  const uploading = pending.some((attachment) => attachment.progress !== null);

  // Autoscroll inteligente: baja solo si ya estabas abajo. Si estás releyendo
  // un mensaje de hace diez turnos, una respuesta nueva no te arranca la vista.
  useEffect(() => {
    if (!nearBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isSending]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    nearBottomRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 140;
  };

  const send = async (rawText?: string, retryAttachments?: PendingAttachment[]) => {
    const text = (rawText ?? input).trim();
    // Al reintentar, el turno viaja con los adjuntos que ya tenía: no se pierden.
    const outgoing = retryAttachments ?? pending;
    if ((!text && outgoing.length === 0) || isSending) return;
    if (uploading) {
      setAttachmentError('Espera a que terminen de subir los archivos: en cuanto estén, se envía el mensaje.');
      return;
    }

    setError(null);
    setAttachmentError(null);
    setAttachmentWarning(null);
    setFailedTurn(null);

    const optimisticId = `local-user-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: optimisticId,
        role: 'user',
        content: text,
        attachments: outgoing.map(({ name, mimeType, sizeBytes }) => ({ name, mimeType, sizeBytes })),
      },
    ]);
    setInput('');
    setPending([]);
    setIsSending(true);

    try {
      const res = await fetch('/api/tutor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: timeoutSignal(CHAT_TIMEOUT_MS),
        body: JSON.stringify({
          agentId: agent.id,
          conversationId,
          message: text,
          shareNotes,
          // De cada archivo viaja solo su id: los bytes ya están en el disco del
          // servidor, que es donde se le saca el texto al documento. Esto es lo
          // que permite subir un tema de 200 MB sin que quepa en un JSON.
          uploadIds: outgoing
            .map((attachment) => attachment.uploadId)
            .filter((id): id is string => Boolean(id)),
        }),
      });

      const data = (await res.json().catch(() => null)) as
        | {
            conversationId?: string;
            model?: string;
            measured?: { unitNumber: number; title: string; mastery: number } | null;
            attachmentsReadable?: boolean;
            /** Archivos que el modelo de este turno no ha podido leer. */
            unreadable?: string[];
            /** Qué se ha podido leer de cada documento subido. */
            documents?: Array<{
              name: string;
              pages: number;
              chars: number;
              mode: string;
              notes: string[];
            }>;
            /** Archivos que ni se han podido mirar (por tamaño). */
            notRead?: string[];
            sharedNotes?: SharedNoteRef[];
            noteProposal?: NoteProposal | null;
            reply?: { id: string; content: string; stage: TutorStage | null };
            error?: string;
          }
        | null;

      // El servidor siempre contesta JSON: si el estado no es 2xx, se usa su
      // mensaje (ya viene en castellano) o el que corresponda al código.
      if (!res.ok) {
        throw new HttpStatusError(data?.error || describeHttpStatus(res.status), res.status);
      }
      if (!data?.reply) {
        throw new Error(
          data?.error || 'El catedrático ha contestado en blanco. Vuelve a intentarlo.'
        );
      }

      setFailedTurn(null);

      if (data.conversationId) setConversationId(data.conversationId);
      if (data.model) setActiveModel(data.model);
      if (data.measured) {
        setMeasurement(data.measured);
        // El radar lateral (servidor) muestra el nivel medido: se refresca.
        router.refresh();
      }

      // Qué se ha podido leer de verdad de cada archivo: se dice, en vez de
      // dejar creer que el catedrático ha leído algo que no ha podido leer.
      const notices: string[] = [];

      if (outgoing.length > 0 && data.attachmentsReadable === false) {
        const names = (data.unreadable ?? []).filter(Boolean);
        notices.push(
          `El modelo que ha respondido ahora no puede mirar imágenes ni escaneos${names.length > 0 ? `: de ${names.map((name) => `«${name}»`).join(', ')} solo ha visto el nombre` : ''}. El texto de los documentos sí se ha leído. Pídeselo otra vez cuando haya un modelo con visión disponible, o pégale el texto a mano.`
        );
      }

      for (const doc of data.documents ?? []) {
        if (doc.mode === 'imagen') {
          notices.push(`«${doc.name}»: es una imagen, el catedrático la mira directamente`);
          continue;
        }
        if (doc.mode === 'sin_texto') {
          notices.push(`«${doc.name}»: no tiene texto que leer${doc.notes.length > 0 ? ` (${doc.notes.join('; ')})` : ''}`);
          continue;
        }
        notices.push(
          `«${doc.name}»: leído${doc.pages > 0 ? ` (${doc.pages} páginas)` : ''} · ${doc.chars.toLocaleString(
            'es-ES'
          )} caracteres${doc.notes.length > 0 ? ` · ${doc.notes.join('; ')}` : ''}`
        );
      }

      if ((data.notRead ?? []).length > 0) {
        notices.push(
          `No he podido mirar ${(data.notRead ?? []).join(', ')}: demasiado grande para una sola petición. Su texto sí se ha leído (arriba); si es un escaneo, súbelo por partes o como capturas.`
        );
      }

      setAttachmentWarning(notices.length > 0 ? notices.join(' — ') : null);

      setSharedNotes(Array.isArray(data.sharedNotes) ? data.sharedNotes : []);

      setMessages((prev) => [
        ...prev,
        {
          id: data.reply!.id,
          role: 'assistant',
          content: data.reply!.content,
          stage: data.reply!.stage,
          noteProposal: data.noteProposal ?? null,
        },
      ]);
    } catch (err) {
      // Se retira el mensaje optimista y se devuelven el texto y los adjuntos
      // al cuadro de escritura: nada se pierde por un fallo de la IA.
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      setInput(text);
      setPending(outgoing);
      setFailedTurn(canRetry(err) ? { text, attachments: outgoing } : null);
      setError(describeFetchError(err));
    } finally {
      setIsSending(false);
    }
  };

  /** Reenvía el turno que se quedó sin respuesta, con su texto y sus adjuntos. */
  const retrySend = () => {
    if (!failedTurn || isSending) return;
    void send(failedTurn.text, failedTurn.attachments);
  };

  /**
   * El alumno acepta la propuesta: el catedrático **redacta** el apunte, pero
   * todavía NO lo guarda. Lo que sale de aquí se le enseña tal y como va a
   * quedar y es él quien decide: guardarlo, pedir otra versión o dejarlo.
   *
   * Ese paso intermedio es la diferencia entre un cuaderno que se lee y uno que
   * se llena: redactar un apunte es la llamada más cara del sistema, así que
   * escribir primero y preguntar después acaba guardando apuntes que no
   * convencen. Y como el borrador se queda en el servidor, darle a «guardar» no
   * vuelve a gastar cupo: se guarda exactamente lo que ha leído.
   */
  const requestNotePreview = async (message: ChatMessage) => {
    const proposal = message.noteProposal;
    if (!proposal) return;

    setNoteJobs((prev) => ({ ...prev, [message.id]: { status: 'writing' } }));

    try {
      const res = await fetch('/api/tutor/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: timeoutSignal(NOTES_TIMEOUT_MS),
        body: JSON.stringify({
          agentId: agent.id,
          conversationId,
          unitNumber: proposal.unitNumber,
          title: proposal.title,
          confirmed: true,
          // Redactar y devolvérnoslo, sin escribir nada en el cuaderno todavía.
          preview: true,
        }),
      });

      const data = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            draftToken?: string;
            draft?: {
              title: string;
              content: string;
              unitNumber: number | null;
              unitTitle: string;
              unitCorrected?: boolean;
              requestedUnitNumber?: number | null;
              subjectName: string;
              subjectColor?: string;
              agentName: string;
            };
            quality?: { words: number; developedPoints: number; structureMissing?: string[] };
            model?: string;
            provider?: string;
            error?: string;
          }
        | null;

      if (!res.ok) {
        throw new HttpStatusError(data?.error || describeHttpStatus(res.status), res.status);
      }
      if (!data?.ok || !data.draftToken || !data.draft) {
        throw new Error(data?.error || 'No se han podido redactar los apuntes.');
      }

      // Copiado antes del setState: dentro de la función de actualización el
      // estrechamiento de tipos del `if` de arriba ya no vale.
      const draft = data.draft;
      const token = data.draftToken;

      setNoteJobs((prev) => ({
        ...prev,
        [message.id]: {
          status: 'preview',
          draft: {
            token,
            title: draft.title,
            content: draft.content,
            unitNumber: draft.unitNumber,
            unitTitle: draft.unitTitle,
            unitCorrected: draft.unitCorrected === true,
            requestedUnitNumber: draft.requestedUnitNumber ?? null,
            subjectName: draft.subjectName,
            agentName: draft.agentName,
            words: data.quality?.words ?? 0,
            developedPoints: data.quality?.developedPoints ?? 0,
            structureMissing: data.quality?.structureMissing ?? [],
            model: data.model ?? '',
            provider: data.provider ?? '',
          },
        },
      }));

      // Acaba de entregar el documento: se abre en la vista dividida, que es
      // donde se lee, se compara con otros motores y se guarda sin salir del
      // chat. La versión recién escrita entra como primera pestaña.
      const engineId = data.provider ?? '';
      setPanel({
        messageId: message.id,
        title: draft.title,
        unitLabel: draft.unitNumber
          ? `Unidad ${draft.unitNumber} · ${draft.unitTitle}`
          : draft.unitTitle,
        unitNumber: draft.unitNumber,
        subjectName: draft.subjectName,
        authorLabel: `Del catedrático ${draft.agentName}`,
        content: draft.content,
        words: data.quality?.words ?? 0,
        isDraft: true,
        activeEngine: engineId,
        variants: [
          {
            engine: engineId,
            label: engines.find((engine) => engine.id === engineId)?.name ?? 'Motor',
            model: data.model ?? '',
            status: 'ready',
            token,
            title: draft.title,
            content: draft.content,
            words: data.quality?.words ?? 0,
          },
        ],
      });
      setPanelMode('markdown');
    } catch (err) {
      setNoteJobs((prev) => ({
        ...prev,
        [message.id]: {
          status: 'error',
          error: describeFetchError(err),
        },
      }));
    }
  };

  /**
   * «Me convence»: el apunte entra en el cuaderno tal y como se acaba de leer.
   * No se vuelve a llamar a la IA (el borrador viaja por su vale), así que no
   * cuesta ni una petición más.
   */
  const saveNoteDraft = async (message: ChatMessage) => {
    const draft = noteJobs[message.id]?.draft;
    if (!draft) return;

    setNoteJobs((prev) => ({ ...prev, [message.id]: { status: 'saving', draft } }));

    try {
      const res = await fetch('/api/tutor/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: timeoutSignal(NOTES_TIMEOUT_MS),
        body: JSON.stringify({
          agentId: agent.id,
          conversationId,
          confirmed: true,
          draftToken: draft.token,
        }),
      });

      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; updated?: boolean; note?: WrittenNoteRef; error?: string }
        | null;

      if (!res.ok) {
        throw new HttpStatusError(data?.error || describeHttpStatus(res.status), res.status);
      }
      if (!data?.ok || !data.note) {
        throw new Error(data?.error || 'No se ha podido guardar el apunte.');
      }

      const savedNote = data.note;
      setNoteJobs((prev) => ({
        ...prev,
        [message.id]: { status: 'done', note: savedNote, updated: Boolean(data.updated) },
      }));
      // Si se guarda desde la vista dividida, el panel sigue abierto pero deja
      // de ser un borrador: aparecen las salidas (.md, cuaderno).
      setPanel((prev) =>
        prev && prev.messageId === message.id
          ? {
              ...prev,
              isDraft: false,
              noteId: savedNote.id,
              updatedLabel: new Date().toLocaleDateString('es-ES', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              }),
            }
          : prev
      );
      // El cuaderno ya tiene el apunte nuevo: el radar lateral se refresca.
      router.refresh();
    } catch (err) {
      setNoteJobs((prev) => ({
        ...prev,
        [message.id]: {
          status: 'error',
          error: describeFetchError(err),
        },
      }));
    }
  };

  const dismissNote = (messageId: string) => {
    setNoteJobs((prev) => ({ ...prev, [messageId]: { status: 'dismissed' } }));
  };

  /**
   * Acepta archivos del selector o pegados con Ctrl+V (capturas de pantalla).
   *
   * Se suben **en cuanto se eligen**, uno detrás de otro y con su barra de
   * progreso: cuando el alumno pulsa Enviar, el archivo ya está en el disco del
   * servidor y el turno no espera por él. Si algo falla, la ficha desaparece y
   * se dice por qué.
   */
  const addFiles = async (files: File[]) => {
    if (files.length === 0 || isSending || uploading) return;
    setAttachmentError(null);
    setAttachmentWarning(null);

    const room = MAX_TUTOR_ATTACHMENTS - pending.length;
    if (room <= 0) {
      setAttachmentError(
        `Ya tienes ${MAX_TUTOR_ATTACHMENTS} archivos listos para enviar. Quita uno para añadir otro.`
      );
      return;
    }

    if (files.length > room) {
      setAttachmentError(`Puedes adjuntar como mucho ${MAX_TUTOR_ATTACHMENTS} archivos por mensaje.`);
    }

    for (const file of files.slice(0, room)) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const previewUrl = isImageMime(file.type) ? URL.createObjectURL(file) : null;

      // La ficha aparece en el acto, con su barra: subir un tema de 90 MB tarda y
      // hay que poder ver que está subiendo.
      setPending((prev) =>
        [
          ...prev,
          {
            key,
            uploadId: null,
            progress: 0,
            mode: null,
            pages: 0,
            chars: 0,
            notes: [],
            name: file.name,
            mimeType: resolveUploadMime(file),
            sizeBytes: file.size,
            previewUrl,
          },
        ].slice(0, MAX_TUTOR_ATTACHMENTS)
      );

      const result = await uploadAttachment(file, (percent) => {
        setPending((prev) =>
          prev.map((attachment) =>
            attachment.key === key ? { ...attachment, progress: percent } : attachment
          )
        );
      });

      // Lo ha quitado el alumno mientras subía: se borra del servidor y no entra.
      if (removedRef.current.has(key)) {
        if (result.ok) discardUpload(result.value.id);
        continue;
      }

      if (!result.ok) {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPending((prev) => prev.filter((attachment) => attachment.key !== key));
        setAttachmentError(result.error);
        continue;
      }

      const doc = result.value;
      setPending((prev) =>
        prev.map((attachment) =>
          attachment.key === key
            ? {
                ...attachment,
                uploadId: doc.id,
                progress: null,
                mode: doc.mode,
                pages: doc.pages,
                chars: doc.chars,
                notes: doc.notes,
                mimeType: doc.mimeType,
                sizeBytes: doc.sizeBytes,
              }
            : attachment
        )
      );
    }
  };

  const removePending = (index: number) => {
    const target = pending[index];
    if (!target) return;
    removedRef.current.add(target.key);
    if (target.previewUrl) URL.revokeObjectURL(target.previewUrl);
    discardUpload(target.uploadId);
    setPending((prev) => prev.filter((_, position) => position !== index));
  };

  const startNewConversation = () => {
    // Lo que estaba listo para enviar ya no se va a enviar: se borra también del
    // disco del servidor, que si no se queda ahí ocupando sitio.
    for (const attachment of pending) {
      removedRef.current.add(attachment.key);
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      discardUpload(attachment.uploadId);
    }
    setMessages([]);
    setConversationId(null);
    setError(null);
    setInput('');
    setPending([]);
    setAttachmentError(null);
    setAttachmentWarning(null);
    setSharedNotes([]);
    setPanel(null);
    setPanelMode('chat');
  };

  /** Vuelve al chat sin perder el documento: queda listo para reabrirlo. */
  const closePanel = () => setPanelMode('chat');

  /** Abre en el panel el borrador que ya está escrito para ese mensaje. */
  const openDraftPanel = (message: ChatMessage) => {
    const draft = noteJobs[message.id]?.draft;
    if (!draft) return;
    setPanel({
      messageId: message.id,
      title: draft.title,
      unitLabel: draft.unitNumber
        ? `Unidad ${draft.unitNumber} · ${draft.unitTitle}`
        : draft.unitTitle,
      unitNumber: draft.unitNumber ?? null,
      subjectName: draft.subjectName,
      authorLabel: `Del catedrático ${draft.agentName}`,
      content: draft.content,
      words: draft.words,
      isDraft: true,
      activeEngine: draft.provider || 'original',
      variants: draft.token
        ? [
            {
              engine: draft.provider || 'original',
              label:
                engines.find((engine) => engine.id === draft.provider)?.name ??
                'Versión del catedrático',
              model: draft.model,
              status: 'ready',
              token: draft.token,
              title: draft.title,
              content: draft.content,
              words: draft.words,
            },
          ]
        : [],
    });
    setPanelMode('markdown');
  };

  /** Trae del servidor un apunte ya guardado y lo abre al lado del chat. */
  const openSavedNotePanel = async (message: ChatMessage) => {
    const note = noteJobs[message.id]?.note;
    if (!note) return;
    setError(null);
    try {
      const res = await fetch(`/api/notes/${note.id}`, {
        signal: timeoutSignal(NOTES_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => null)) as
        | {
            note?: {
              id: string;
              title: string;
              content: string;
              unitNumber: number | null;
              unitTitle: string;
              subjectName: string;
              updatedAt: string;
            };
            error?: string;
          }
        | null;
      if (!res.ok) {
        throw new HttpStatusError(data?.error || describeHttpStatus(res.status), res.status);
      }
      if (!data?.note) throw new Error(data?.error || 'No se ha podido abrir el apunte.');
      const opened = data.note;
      setPanel({
        messageId: message.id,
        title: opened.title,
        unitLabel: opened.unitNumber
          ? `Unidad ${opened.unitNumber} · ${opened.unitTitle}`
          : opened.unitTitle,
        subjectName: opened.subjectName,
        authorLabel: `Del catedrático ${agent.name}`,
        content: opened.content,
        noteId: opened.id,
        updatedLabel: new Date(opened.updatedAt).toLocaleDateString('es-ES', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        }),
        isDraft: false,
        unitNumber: opened.unitNumber,
        activeEngine: '',
        variants: [],
      });
      setPanelMode('markdown');
    } catch (err) {
      setError(describeFetchError(err));
    }
  };

  /**
   * «Guardar esta versión»: entra en el cuaderno exactamente la versión que el
   * alumno está leyendo, no la primera que se escribió. Se reutiliza su vale de
   * borrador, así que no se vuelve a gastar una llamada de IA.
   */
  const savePanelNote = async () => {
    if (!panel) return;
    const variant =
      panel.variants.find(
        (item) => item.status === 'ready' && item.token && item.engine === panel.activeEngine
      ) ?? panel.variants.find((item) => item.status === 'ready' && item.token);
    if (!variant?.token) return;

    setPanelSaving(true);
    try {
      const res = await fetch('/api/tutor/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: agent.id,
          conversationId,
          confirmed: true,
          draftToken: variant.token,
        }),
      });

      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; updated?: boolean; note?: WrittenNoteRef; error?: string }
        | null;

      if (!res.ok) {
        throw new HttpStatusError(data?.error || describeHttpStatus(res.status), res.status);
      }
      if (!data?.ok || !data.note) {
        throw new Error(data?.error || 'No se ha podido guardar el apunte.');
      }

      const saved = data.note;
      setNoteJobs((prev) => ({
        ...prev,
        [panel.messageId]: { status: 'done', note: saved, updated: Boolean(data.updated) },
      }));
      setPanel((prev) =>
        prev
          ? {
              ...prev,
              isDraft: false,
              noteId: saved.id,
              updatedLabel: new Date().toLocaleDateString('es-ES', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              }),
            }
          : prev
      );
      router.refresh();
    } catch (err) {
      setError(describeFetchError(err));
    } finally {
      setPanelSaving(false);
    }
  };

  /** Lee otra versión ya escrita, sin volver a pedirla. */
  const selectVariant = (engine: string) =>
    setPanel((prev) => (prev ? { ...prev, activeEngine: engine } : prev));

  /**
   * Pide la MISMA unidad al motor elegido y guarda su versión como una pestaña
   * más. No toca el cuaderno: ahí solo entra lo que el alumno fija al guardar.
   */
  const generateVariant = async (engineId: string) => {
    if (!panel) return;
    const message = messages.find((item) => item.id === panel.messageId);
    const proposal = message?.noteProposal;
    const label = engines.find((engine) => engine.id === engineId)?.name ?? engineId;
    const current = panel.variants.find((variant) => variant.engine === panel.activeEngine);

    setPanel((prev) =>
      prev
        ? {
            ...prev,
            variants: [
              ...prev.variants.filter((variant) => variant.engine !== engineId),
              { engine: engineId, label, model: '', status: 'pending' },
            ],
          }
        : prev
    );

    try {
      const res = await fetch('/api/tutor/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: timeoutSignal(NOTES_TIMEOUT_MS),
        body: JSON.stringify({
          agentId: agent.id,
          conversationId,
          unitNumber: proposal?.unitNumber ?? panel.unitNumber ?? null,
          title: proposal?.title ?? current?.title ?? panel.title,
          confirmed: true,
          preview: true,
          // El motor de ESTA pestaña, no el que elija la cadena por su cuenta.
          provider: engineId,
        }),
      });

      const data = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            draftToken?: string;
            draft?: { title: string; content: string };
            quality?: { words: number };
            model?: string;
            error?: string;
          }
        | null;

      if (!res.ok) {
        throw new HttpStatusError(data?.error || describeHttpStatus(res.status), res.status);
      }
      if (!data?.ok || !data.draftToken || !data.draft) {
        throw new Error(data?.error || 'Ese motor no ha podido escribir su versión.');
      }

      const draft = data.draft;
      const variant: NoteVariant = {
        engine: engineId,
        label,
        model: data.model ?? '',
        status: 'ready',
        token: data.draftToken,
        title: draft.title,
        content: draft.content,
        words: data.quality?.words ?? 0,
      };

      setPanel((prev) =>
        prev
          ? {
              ...prev,
              variants: [...prev.variants.filter((item) => item.engine !== engineId), variant],
              activeEngine: engineId,
            }
          : prev
      );
    } catch (err) {
      setPanel((prev) =>
        prev
          ? {
              ...prev,
              variants: [
                ...prev.variants.filter((item) => item.engine !== engineId),
                {
                  engine: engineId,
                  label,
                  model: '',
                  status: 'error',
                  error: describeFetchError(err),
                },
              ],
            }
          : prev
      );
    }
  };

  const hasMessages = messages.length > 0;

  /** Proveedor que está respondiendo, para el rótulo de la barra. */
  const providerName = /groq/i.test(activeModel)
    ? 'Groq'
    : /openrouter/i.test(activeModel)
      ? 'OpenRouter'
      : /ollama|local/i.test(activeModel)
        ? 'Local'
        : 'Gemini';

  const openingMessage = useMemo(() => buildOpeningMessage(agent, opening), [agent, opening]);

  /** Sugerencias de un clic: se envían solas y son autosuficientes para la IA. */
  const starters = useMemo(() => {
    const list: Array<{ label: string; text: string }> = [];

    if (opening.weakTopicLabel) {
      list.push({
        label: `Repaso de «${opening.weakTopicLabel}»`,
        text: `Vamos con mi unidad medida más floja: «${opening.weakTopicLabel}». Pregúntame lo mínimo para localizar exactamente dónde se me rompe la base.`,
      });
    } else {
      list.push({
        label: 'Mídeme el nivel',
        text: `Todavía no has medido mi nivel en ${agent.subject.name}. Hazme un diagnóstico rápido de la unidad que estoy dando: 3 o 4 preguntas cortas, y cuando compruebes dónde estoy, anótalo con la etiqueta [[nivel:U<numero>=<0-100>]] para que quede como nivel medido.`,
      });
    }

    if (opening.nextExamLabel) {
      list.push({
        label: 'Plan de repaso para hoy',
        text: `Tengo el examen «${opening.nextExamLabel}» a la vista. Propónme un plan de repaso concreto para hoy y empieza a examinarme del primer punto.`,
      });
    }

    list.push({
      label: 'Tengo un ejercicio',
      text: 'Te paso un ejercicio. Dame solo la primera pista, sin resolverlo.',
    });

    return list;
  }, [agent.subject.name, opening.nextExamLabel, opening.weakTopicLabel]);

  /** Última etapa alcanzada: alimenta la barra de progreso socrática. */
  const currentStage = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const stage = messages[index].stage;
      if (stage) return stage;
    }
    return null;
  }, [messages]);

  /** La versión que se está leyendo manda sobre el cuerpo del documento. */
  const activeVariant = panel
    ? panel.variants.find(
        (variant) => variant.engine === panel.activeEngine && variant.status === 'ready'
      )
    : undefined;
  const panelNote: SplitNote | null = panel
    ? {
        ...panel,
        title: activeVariant?.title ?? panel.title,
        content: activeVariant?.content ?? panel.content,
        words: activeVariant?.words ?? panel.words,
      }
    : null;

  return (
    <>
      <div
        className="chat-shell flex min-h-0 flex-1 flex-col overflow-hidden bg-[#0a0a0b]"
      >
      {/* Barra de herramientas: el estado del catedrático, sin ruido. */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em]"
            style={{
              backgroundColor: `${agent.subject.color}12`,
              borderColor: `${agent.subject.color}33`,
              color: agent.subject.color,
            }}
          >
            {agent.subject.name}
          </span>
          <span className="hidden items-center gap-1.5 truncate text-[11px] text-stone-500 sm:inline-flex">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400/80" />
            {providerName}
            {' · '}
            {activeModel.startsWith('auto') ? 'mejor modelo' : activeModel}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {panel && panelMode === 'chat' && (
            <button
              onClick={() => setPanelMode('markdown')}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] font-medium text-stone-300 transition-colors hover:border-white/20 hover:text-stone-100"
              title="Abrir el documento al lado del chat"
            >
              <PanelRight className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Documento</span>
            </button>
          )}
          {panelMode !== 'chat' && (
            <button
              onClick={closePanel}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] font-medium text-stone-300 transition-colors hover:border-white/20 hover:text-stone-100"
              title="Volver al chat a pantalla completa"
            >
              <PanelRight className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Cerrar documento</span>
            </button>
          )}
          <button
            onClick={startNewConversation}
            disabled={isSending}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-stone-400 transition-colors hover:bg-white/[0.05] hover:text-stone-100 disabled:opacity-40"
            title="Empezar una consulta nueva (se creará otra conversación)"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Nueva consulta</span>
          </button>
        </div>
      </div>

      {/* Medición real anotada por el catedrático */}
      {measurement && (
        <div className="flex shrink-0 items-start gap-2 border-b border-white/[0.05] px-4 py-2 text-[11px] text-stone-400">
          <Ruler className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400/80" />
          <span>
            Nivel registrado por el catedrático: <strong>U{measurement.unitNumber}</strong>{' '}
            «{measurement.title}» → <strong>{measurement.mastery}%</strong>. Ya cuenta como medido en
            el planificador, el temario y las estadísticas.
          </span>
        </div>
      )}

      {/* Apuntes que el catedrático está leyendo en este momento */}
      {sharedNotes.length > 0 && (
        <div className="flex shrink-0 items-start gap-2 border-b border-white/[0.05] px-4 py-2 text-[11px] text-stone-400">
          <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400/70" />
          <span>
            El catedrático está leyendo {sharedNotes.length}{' '}
            {sharedNotes.length === 1 ? 'apunte' : 'apuntes'} tuyos:{' '}
            {sharedNotes.map((note, index) => (
              <span key={note.id}>
                <strong>«{note.title}»</strong>
                {note.topicLabel ? ` (${note.topicLabel})` : ''}
                {index < sharedNotes.length - 1 ? ', ' : '.'}
              </span>
            ))}
          </span>
        </div>
      )}

      {/* Progreso socrático: una línea de pasos, sin neones. */}
      {hasMessages && (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-white/[0.05] px-4 py-2">
          {STAGE_ORDER.map((stage, index) => {
            const activeIndex = currentStage ? STAGE_ORDER.indexOf(currentStage) : -1;
            const isDone = activeIndex > -1 && index < activeIndex;
            const isActive = stage === currentStage;

            return (
              <div key={stage} className="flex shrink-0 items-center gap-1.5">
                <span
                  className={clsx(
                    'flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] transition-colors',
                    isActive
                      ? 'bg-white/[0.07] text-stone-100'
                      : isDone
                        ? 'text-stone-400'
                        : 'text-stone-600'
                  )}
                >
                  {isDone && <Check className="h-2.5 w-2.5" />}
                  {STAGE_META[stage].label}
                </span>
                {index < STAGE_ORDER.length - 1 && (
                  <span
                    className={clsx('h-px w-2.5', isDone ? 'bg-stone-600' : 'bg-white/[0.07]')}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Lista de mensajes: ocupa el alto disponible y se desplaza dentro. */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6"
      >
        <div className="mx-auto w-full max-w-3xl space-y-8">
        {/* Apertura proactiva del catedrático (sin gastar API) */}
        {!hasMessages && (
          <div className="chat-message flex gap-3">
            <div
              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.03]"
              style={{ color: agent.subject.color }}
            >
              <GraduationCap className="h-3.5 w-3.5" />
            </div>

            <div className="min-w-0 flex-1 space-y-4">
              <div className="space-y-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-stone-500">
                  Primer contacto
                </p>
                <div className="text-[15px] leading-7 text-stone-200/90">
                  <MarkdownMessage content={openingMessage} />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2">
                {starters.map((starter) => (
                  <button
                    key={starter.label}
                    onClick={() => send(starter.text)}
                    disabled={isSending}
                    className="group flex items-center justify-between gap-3 rounded-lg border border-white/[0.07] px-3.5 py-2.5 text-left text-[12.5px] text-stone-300 transition-colors hover:border-white/20 hover:bg-white/[0.03] disabled:opacity-50"
                  >
                    <span className="font-semibold text-slate-200">{starter.label}</span>
                    <span className="flex items-center gap-1.5 text-[10px] text-slate-500 group-hover:text-emerald-400">
                      <span className="hidden sm:inline">Enviar</span>
                      <ArrowRight className="w-3 h-3" />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {messages.map((message) => {
          const isUser = message.role === 'user';
          const stageMeta = message.stage ? STAGE_META[message.stage] : null;

          if (isUser) {
            return (
              <div key={message.id} className="chat-message flex justify-end">
                <div className="max-w-[88%] space-y-1.5 sm:max-w-[75%]">
                  {message.attachments && message.attachments.length > 0 && (
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {message.attachments.map((attachment, index) => (
                        <AttachmentChipView
                          key={`${message.id}-adjunto-${index}`}
                          attachment={attachment}
                        />
                      ))}
                    </div>
                  )}
                  {message.content.trim().length > 0 && (
                    <div className="rounded-2xl rounded-br-md border border-white/[0.07] bg-white/[0.05] px-4 py-2.5">
                      <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-stone-100">
                        {message.content}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            );
          }

          return (
            <div key={message.id} className="chat-message flex gap-3">
              <div
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.03]"
                style={{ color: agent.subject.color }}
              >
                <GraduationCap className="h-3.5 w-3.5" />
              </div>

              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-medium text-stone-300">{agent.name}</span>
                  {stageMeta && (
                    <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-stone-400">
                      {stageMeta.label}
                    </span>
                  )}
                  {noteJobs[message.id]?.draft && (
                    <button
                      onClick={() => openDraftPanel(message)}
                      title="Leerlo en la vista dividida, sin salir del chat"
                      className="flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-medium text-stone-300 transition-colors hover:border-white/25 hover:text-white"
                    >
                      <PanelRight className="h-3 w-3" />
                      Vista previa
                    </button>
                  )}
                  {noteJobs[message.id]?.note && (
                    <button
                      onClick={() => void openSavedNotePanel(message)}
                      title="Abrir el apunte guardado al lado del chat"
                      className="flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-medium text-stone-300 transition-colors hover:border-white/25 hover:text-white"
                    >
                      <FileText className="h-3 w-3" />
                      Abrir documento
                    </button>
                  )}
                </div>

                <div className="text-[15px] leading-7 text-stone-200/90">
                  <MarkdownMessage content={message.content} />
                </div>

                {/* El catedrático te ofrece unos apuntes: tú decides. */}
                {message.noteProposal && (
                  <NoteOfferCard
                    proposal={message.noteProposal}
                    job={noteJobs[message.id]}
                    agentName={agent.name}
                    onOpen={() => openDraftPanel(message)}
                    onPreview={() => requestNotePreview(message)}
                    onSave={() => saveNoteDraft(message)}
                    onDismiss={() => dismissNote(message.id)}
                  />
                )}
              </div>
            </div>
          );
        })}

        {isSending && (
          <div className="flex gap-3">
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center border shrink-0 mt-0.5"
              style={{
                backgroundColor: `${agent.subject.color}15`,
                borderColor: `${agent.subject.color}40`,
                color: agent.subject.color,
              }}
            >
              <GraduationCap className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1 max-w-md">
              <NeuralLoader
                compact
                title="El catedrático está pensando"
                messages={[
                  'Analizando tu respuesta y tus errores abiertos...',
                  'Cruzando apuntes con el temario oficial...',
                  'Sintetizando estructura socrática...',
                  'Comprobando que todo sale de tus fuentes...',
                ]}
              />
            </div>
          </div>
        )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-4 sm:mx-6 mb-3 flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-rose-200">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-xs leading-relaxed">{error}</p>
            {failedTurn && (
              <button
                onClick={retrySend}
                disabled={isSending}
                className="flex items-center gap-1.5 rounded-lg border border-rose-400/40 bg-rose-500/10 px-2.5 py-1 text-[10px] font-semibold text-rose-100 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className="h-3 w-3" />
                {isSending ? 'Reintentando…' : 'Reintentar el envío'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Compartir apuntes: lo que el catedrático puede leer de tu cuaderno */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-white/[0.06] px-4 pt-2.5 sm:px-6">
        <button
          onClick={() => setShareNotes((prev) => !prev)}
          className={clsx(
            'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold transition-colors',
            shareNotes
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border-slate-700 bg-slate-800/60 text-slate-400'
          )}
          title={
            notes.total === 0
              ? 'Todavía no has escrito apuntes de esta materia'
              : notes.titles.length > 0
                ? `Le dará acceso a tus apuntes: ${notes.titles.join(', ')}${notes.total > notes.titles.length ? '…' : ''}`
                : 'Le dará acceso a tus apuntes de esta materia'
          }
        >
          <BookOpen className="h-3 w-3" />
          {shareNotes ? 'Mis apuntes compartidos' : 'Mis apuntes ocultos'}
          <span className="font-mono opacity-70">({notes.total})</span>
        </button>

        {shareNotes && notes.total === 0 && (
          <span className="text-[10px] text-slate-500">
            Todavía no has escrito apuntes de esta materia: el catedrático no tiene nada tuyo que leer.
          </span>
        )}
      </div>

      {/* Cuadro de escritura, pegado al borde inferior */}
      <div className="shrink-0 bg-[#0b0b0d] px-4 pb-3 pt-1 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
        {/* Archivos listos para enviar */}
        {pending.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pending.map((attachment, index) => {
              const isUploading = attachment.progress !== null;
              const unreadable = attachment.mode === 'sin_texto';
              const label = isUploading ? `subiendo ${attachment.progress}%` : readLabel(attachment);
              return (
                <span
                  key={attachment.key}
                  className={clsx(
                    'flex flex-col gap-1 rounded-lg border py-1 pl-2 pr-1 text-[10px] font-semibold',
                    unreadable
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  )}
                  title={attachment.notes.length > 0 ? attachment.notes.join(' · ') : attachment.name}
                >
                  <span className="flex items-center gap-2">
                    {attachment.previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={attachment.previewUrl}
                        alt={attachment.name}
                        className="h-8 w-8 rounded object-cover"
                      />
                    ) : (
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="max-w-[160px] truncate">{attachment.name}</span>
                    <span className="font-mono opacity-70">
                      {formatBytes(attachment.sizeBytes ?? 0)}
                    </span>
                    {label.length > 0 && <span className="font-mono opacity-80">{label}</span>}
                    <button
                      onClick={() => removePending(index)}
                      className="rounded p-0.5 hover:bg-emerald-500/20 hover:text-emerald-100"
                      title="Quitar este archivo"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>

                  {isUploading && (
                    <span className="block h-1 w-full overflow-hidden rounded-full bg-slate-800">
                      <span
                        className="block h-full rounded-full bg-emerald-400 transition-all"
                        style={{ width: `${attachment.progress ?? 0}%` }}
                      />
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        )}

        <div className="flex items-end gap-2.5">
          <input
            ref={fileInputRef}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            hidden
            onChange={(event) => {
              void addFiles(Array.from(event.target.files ?? []));
              // Se limpia para poder volver a elegir el mismo archivo.
              event.target.value = '';
            }}
          />

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isSending || uploading || pending.length >= MAX_TUTOR_ATTACHMENTS}
            className="flex shrink-0 items-center gap-1.5 rounded-xl border border-slate-700 bg-[#111827] px-3 py-2.5 text-xs font-semibold text-slate-300 transition-all hover:border-emerald-500/40 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
            title={`Adjuntar una captura, una foto o un PDF (${ALLOWED_ATTACHMENT_HINT})`}
          >
            <Paperclip className="w-4 h-4" />
          </button>

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            onPaste={(e) => {
              // Pegar una captura (Ctrl+V) la adjunta directamente.
              const files = Array.from(e.clipboardData?.files ?? []).filter(
                (file) => file.type.length > 0
              );
              if (files.length === 0) return;
              e.preventDefault();
              void addFiles(files);
            }}
            rows={2}
            maxLength={4000}
            placeholder="Escribe tu duda, pega el enunciado o suelta aquí una captura…"
            className="flex-1 resize-none bg-[#070b14] border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500/70 focus:ring-1 focus:ring-emerald-500/30 transition-colors placeholder:text-slate-600"
          />

          <button
            onClick={() => send()}
            disabled={isSending || uploading || (input.trim().length === 0 && pending.length === 0)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            title={uploading ? 'Espera a que terminen de subir los archivos' : 'Enviar el mensaje'}
          >
            {isSending || uploading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            <span className="hidden sm:inline">Enviar</span>
          </button>
        </div>

        {attachmentError && (
          <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-rose-300">
            <AlertTriangle className="mt-0.5 w-3 h-3 shrink-0" />
            {attachmentError}
          </p>
        )}

        {attachmentWarning && (
          <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-amber-300">
            <Eye className="mt-0.5 w-3 h-3 shrink-0" />
            {attachmentWarning}
          </p>
        )}

          <p className="mt-2 flex items-center gap-1.5 text-[10px] text-stone-600">
            <ShieldQuestion className="h-3 w-3 shrink-0" />
            Enter para enviar · Shift+Enter salto de línea · Ctrl+V pega una captura ·{' '}
            {ALLOWED_ATTACHMENT_HINT}
          </p>
        </div>
      </div>
      </div>

      {panelMode !== 'chat' && (
        <NoteSplitPanel
          note={panelNote}
          mode={panelMode}
          onMode={setPanelMode}
          onClose={closePanel}
          onSave={
            panelNote?.isDraft && panel?.variants.some((variant) => variant.token)
              ? savePanelNote
              : undefined
          }
          saving={panelSaving}
          variants={panel?.variants ?? []}
          engines={engines}
          activeEngine={panel?.activeEngine ?? ''}
          onSelectEngine={selectVariant}
          onGenerate={generateVariant}
        />
      )}
    </>
  );
}
