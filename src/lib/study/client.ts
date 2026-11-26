/**
 * Cliente HTTP del lienzo modular.
 *
 * Es la única puerta por la que el navegador habla con `/api/notes/[id]/...` y
 * `/api/study/...`. Los tipos se declaran aquí (no se importan de `notes.ts`)
 * porque ese módulo toca Prisma y no puede viajar al bundle del cliente; aun
 * así reproducen exactamente lo que devuelve `serializeNoteTree`.
 *
 * Todas las funciones lanzan `StudyClientError` con el mensaje que ya viene
 * redactado del servidor. La interfaz no inventa excusas propias.
 */

export type StudySectionStatus = 'PENDING' | 'COMPLETED' | 'SKIPPED';
export type StudyQuoteStatus = 'VERIFIED' | 'UNVERIFIED' | 'ERROR' | 'NONE';
export type StudyBlockType =
  | 'TEXT'
  | 'FORMULA'
  | 'DEFINITION'
  | 'EXAMPLE'
  | 'EVIDENCE'
  | 'QUESTION';
export type StudyVariantKind = 'simpler' | 'example' | 'deeper';
export type StudyJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface StudyCoverage {
  withCitation: number;
  total: number;
  ratio: number;
}

export interface StudyCanvasBlock {
  id: string;
  parentId: string | null;
  order: number;
  type: StudyBlockType;
  content: string;
  isAiGenerated: boolean;
  isEdited: boolean;
  chunkId: string | null;
  quote: string | null;
  quoteStatus: StudyQuoteStatus;
}

export interface StudyCanvasSection {
  id: string;
  title: string;
  purpose: string;
  order: number;
  status: StudySectionStatus;
  pageFrom: number | null;
  pageTo: number | null;
  /** Cobertura inicial de fuentes del esquema (0-1), no la de citas. */
  coverage: number | null;
  blocks: StudyCanvasBlock[];
}

export interface StudyNoteTree {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
  topic: {
    id: string;
    title: string;
    unitNumber: number | null;
    subjectName: string;
  };
  agentName: string | null;
  coverage: StudyCoverage;
  sections: StudyCanvasSection[];
}

export interface StudySectionGeneration {
  kept: number;
  added: number;
  discarded: number;
  verified: number;
  unverified: number;
  errors: number;
  status: 'COMPLETED' | 'PENDING';
  blocks: Array<{
    id: string;
    type: string;
    content: string;
    quoteStatus: string;
    citationReason: string | null;
  }>;
  markdown: string;
}

export interface StudyOutlineResult {
  created: boolean;
  fallback?: boolean;
  warning?: string | null;
  model?: string | null;
  message?: string;
  note: StudyNoteTree | null;
}

export interface StudySectionExpansion {
  ok: true;
  warning: string | null;
  model: string | null;
  generation: StudySectionGeneration;
}

export interface StudyVariantResult {
  ok: true;
  block: {
    id: string;
    parentId: string;
    depth: number;
    label: string;
    content: string;
    quoteStatus: string;
  };
  markdown: string;
}

export interface StudyJob {
  id: string;
  noteId: string | null;
  status: StudyJobStatus;
  step: number;
  totalSteps: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StudyJobSnapshot {
  job: StudyJob;
  sections: Array<{ id: string; title: string; status: StudySectionStatus }>;
}

export interface StudyJobStart {
  jobId: string;
  totalSteps?: number;
  resumed?: boolean;
}

export interface StudyTickResult {
  job?: {
    id: string;
    status: StudyJobStatus;
    step: number;
    totalSteps: number;
  };
  section?: { id: string; title: string; status: StudySectionStatus };
  warning?: string | null;
  finished?: boolean;
}

/** Error de la API con el estado HTTP que lo provocó. */
export class StudyClientError extends Error {
  readonly status: number;
  readonly retry: boolean;

  constructor(message: string, status: number, retry = false) {
    super(message);
    this.name = 'StudyClientError';
    this.status = status;
    this.retry = retry;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: 'no-store',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const payload = await readJson(response);

  if (!response.ok) {
    const body = asRecord(payload);
    const message =
      typeof body.error === 'string' && body.error.trim()
        ? body.error
        : 'No se ha podido completar la operación con el lienzo.';
    throw new StudyClientError(message, response.status, body.retry === true);
  }

  // Única conversión del módulo: el contrato lo fija el servidor y aquí se
  // declara. Si una ruta cambia de forma, el error salta al usar el campo.
  return payload as T;
}

function noteUrl(noteId: string, suffix = ''): string {
  return `/api/notes/${encodeURIComponent(noteId)}${suffix}`;
}

/** Árbol actual del apunte (esquema, bloques y cobertura). */
export async function loadOutline(noteId: string): Promise<StudyNoteTree> {
  const payload = await request<{ note: StudyNoteTree }>(noteUrl(noteId, '/outline'));
  return payload.note;
}

/**
 * Pide el esquema. Si el apunte ya tiene apartados no se regenera: el servidor
 * devuelve el que existe y `created: false`.
 */
export async function createOutline(noteId: string): Promise<StudyOutlineResult> {
  return request<StudyOutlineResult>(noteUrl(noteId, '/outline'), { method: 'POST' });
}

/** Desarrolla un apartado concreto. */
export async function expandSection(
  noteId: string,
  sectionId: string
): Promise<StudySectionExpansion> {
  return request<StudySectionExpansion>(
    noteUrl(noteId, `/sections/${encodeURIComponent(sectionId)}/expand`),
    { method: 'POST' }
  );
}

/** Guarda el contenido editado de un bloque (pone `isEdited` en el servidor). */
export async function updateBlock(
  noteId: string,
  blockId: string,
  content: string
): Promise<{ ok: true; markdown: string }> {
  return request<{ ok: true; markdown: string }>(
    noteUrl(noteId, `/blocks/${encodeURIComponent(blockId)}`),
    { method: 'PATCH', body: JSON.stringify({ content }) }
  );
}

/** Cuelga una variante («más sencillo», «un ejemplo», «más profundo»). */
export async function addVariant(
  noteId: string,
  blockId: string,
  kind: StudyVariantKind
): Promise<StudyVariantResult> {
  return request<StudyVariantResult>(
    noteUrl(noteId, `/blocks/${encodeURIComponent(blockId)}/variants`),
    { method: 'POST', body: JSON.stringify({ kind }) }
  );
}

/** Reordena los apartados según el array de ids. */
export async function reorderSections(
  noteId: string,
  sectionIds: string[]
): Promise<{ ok: true; markdown: string }> {
  return request<{ ok: true; markdown: string }>(noteUrl(noteId, '/outline'), {
    method: 'PATCH',
    body: JSON.stringify({ sectionIds }),
  });
}

/** Marca un apartado como omitido o lo recupera. */
export async function setSectionSkipped(
  noteId: string,
  sectionId: string,
  skipped: boolean
): Promise<{ ok: true; markdown: string }> {
  return request<{ ok: true; markdown: string }>(noteUrl(noteId, '/outline'), {
    method: 'PATCH',
    body: JSON.stringify({ sectionId, status: skipped ? 'SKIPPED' : 'PENDING' }),
  });
}

/** Crea (o reanuda) el trabajo de desarrollar el tema entero. */
export async function startExpandAll(noteId: string): Promise<StudyJobStart> {
  return request<StudyJobStart>(noteUrl(noteId, '/expand-all'), { method: 'POST' });
}

/** Estado del trabajo: pasos hechos, total y estado de cada apartado. */
export async function getJob(jobId: string): Promise<StudyJobSnapshot> {
  return request<StudyJobSnapshot>(`/api/study/jobs/${encodeURIComponent(jobId)}`);
}

/** Avanza un paso. Un 409 con `retry` significa «otro tick va por delante». */
export async function tickJob(jobId: string): Promise<StudyTickResult> {
  return request<StudyTickResult>(`/api/study/jobs/${encodeURIComponent(jobId)}/tick`, {
    method: 'POST',
  });
}
