/**
 * La memoria entre días de la IA.
 *
 * El problema que resuelve: cada IA del sistema (cada catedrático con su materia,
 * el coordinador de la puesta a punto y el vigilante de mantenimiento) guardaba su
 * conversación en SQLite, pero **cada mañana empezaba de cero**. Volvía a preguntar
 * lo que ya sabía, se le olvidaba lo acordado y repetía caminos ya andados.
 *
 * Cómo funciona:
 *
 *   1. Al terminar el día (o al cerrar una conversación), se escribe **un recuerdo
 *      por ámbito y día**: dos o tres frases de lo hablado más los datos concretos
 *      (unidades, fechas, acuerdos, lo que quedó pendiente).
 *   2. Al empezar un turno, la IA recibe esos recuerdos de los últimos días como un
 *      bloque corto dentro de su prompt: «esto ya lo sabes, no lo vuelvas a
 *      preguntar».
 *
 * Dos decisiones que importan:
 *
 *   - **Las reglas escriben siempre, el modelo solo pule.** El recuerdo se fabrica
 *     con reglas (sin gastar ni un token) y eso quiere decir que existe aunque la
 *     IA esté saturada; si hay modelo disponible, se le pide que lo redacte mejor y
 *     se guarda esa versión. Nunca se depende de la IA para tener memoria.
 *   - **Presupuesto de caracteres.** La memoria entra en el prompt, así que va
 *     acotada (ver `MEMORY_MAX_CHARS`): recuerda mejor, no más. Un bloque eterno
 *     haría las respuestas más lentas, que es justo lo que se está arreglando.
 *
 * El formateo y la lectura de la conversación son **puros** (se pueden probar sin
 * base de datos); lo único que toca Prisma es guardar y leer.
 */

import { prisma } from './prisma';
import { currentUserId } from './tenant';

/** Ámbitos que no son un catedrático. */
export const MEMORY_SCOPE_COORDINATOR = 'coordinador';
export const MEMORY_SCOPE_MAINTENANCE = 'mantenimiento';

/**
 * Cuántos días atrás se recuerdan.
 *
 * Eran 7; ahora son 30. El bloque sigue acotado por `MEMORY_MAX_CHARS` (si no
 * cabe, se cae primero el día más viejo), así que ampliar la ventana no infla el
 * prompt: solo permite que una unidad que se estudió hace tres semanas siga
 * presente en lugar de desaparecer de golpe.
 */
export const MEMORY_DAYS = 30;
/** Presupuesto del bloque de memoria dentro del prompt (caracteres). */
export const MEMORY_MAX_CHARS = 1400;
/** Tope de datos concretos por día. */
export const MEMORY_MAX_FACTS = 4;

export interface MemoryFact {
  label: string;
  value: string;
}

export interface DayMemory {
  day: string;
  summary: string;
  facts: MemoryFact[];
  writtenBy: string;
}

/* ------------------------------------------------------------------ */
/* El bloque que recibe la IA (puro)                                  */
/* ------------------------------------------------------------------ */

/** El día del alumno (hora local), como clave estable de la memoria. */
export function dayKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** «2026-10-14» → «14/10», que es como se lee de un vistazo. */
function shortDay(day: string): string {
  const [, month, dayOfMonth] = day.split('-');
  return month && dayOfMonth ? `${dayOfMonth}/${month}` : day;
}

/**
 * El bloque de memoria, listo para meter en un prompt.
 *
 * Se escribe **de lo más reciente a lo más antiguo** (para que el modelo se quede
 * con lo último si algún día hay que recortar) y se respeta el presupuesto: si no
 * cabe todo, se cae primero el día más viejo. Devuelve cadena vacía si no hay nada
 * que recordar, y entonces el prompt no lleva ni el encabezado.
 */
export function buildMemoryBlock(memories: DayMemory[], maxChars: number = MEMORY_MAX_CHARS): string {
  const usable = memories
    .filter((memory) => (memory.summary ?? '').trim().length > 0)
    .sort((a, b) => (a.day < b.day ? 1 : -1));

  if (usable.length === 0) return '';

  const header =
    'LO QUE YA SABES DE LOS DÍAS ANTERIORES (lo tienes ya apuntado: no lo vuelvas a preguntar, úsalo):';
  const lines: string[] = [];
  const used: string[] = [];
  let total = header.length;

  for (const memory of usable) {
    const facts = memory.facts
      .filter((fact) => fact.label.trim().length > 0 && fact.value.trim().length > 0)
      .slice(0, MEMORY_MAX_FACTS)
      .map((fact) => `${fact.label}: ${fact.value}`)
      .join(' · ');

    const line = `· ${shortDay(memory.day)} — ${memory.summary.trim().slice(0, 420)}${
      facts.length > 0 ? ` [${facts.slice(0, 320)}]` : ''
    }`;

    if (total + line.length + 1 > maxChars && used.length > 0) break;
    used.push(line);
    total += line.length + 1;
  }

  if (used.length === 0) return '';
  lines.push(...used);
  return [header, ...lines].join('\n');
}

/* ------------------------------------------------------------------ */
/* Leer una conversación y sacar el recuerdo (puro)                    */
/* ------------------------------------------------------------------ */

const MONTHS =
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre';

const DATE_RE = new RegExp(`\\b(\\d{1,2}\\s+de\\s+(?:${MONTHS}))\\b`, 'i');
const UNIT_RE = /unidad\s+(?:n[º°]?\s*)?(\d{1,2})\b/i;
const QUOTED_RE = /«([^»]{3,80})»/g;
const PENDING_RE = /\b(queda|quedó|quedaba|lo dejamos|lo dejamos en|pendiente de|para mañana|la próxima vez|te lo apunto)\b/i;
const DECISION_RE = /\b(acordamos|hemos quedado|de acuerdo|lo apunto|he anotado|he guardado|guardado en|añadido a)\b/i;
const NOTES_RE = /\b(apunte|apuntes|resumen|esquema)\b/i;
const DOUBT_RE = /\b(no lo s[eé]|no estoy segur[oa]|duda|no me queda claro)\b/i;

function clean(text: string, max = 200): string {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function uniquePush(list: string[], value: string): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) return;
  if (!list.some((item) => item.toLowerCase() === trimmed.toLowerCase())) list.push(trimmed);
}

/**
 * El recuerdo de una conversación, sacado con reglas.
 *
 * No es un resumen literario: es lo que hace falta para no repetirse. Las tres
 * cosas que se buscan son las que de verdad se pierden entre días: **de qué se
 * habló**, **qué se acordó** y **qué quedó pendiente**, más los datos concretos
 * que se pueden citar tal cual (una fecha, una unidad, un apunte).
 */
export function digestConversation(
  messages: Array<{ role: string; content: string }>,
  options: { maxAsks?: number } = {}
): { summary: string; facts: MemoryFact[] } {
  const maxAsks = options.maxAsks ?? 3;
  const facts: MemoryFact[] = [];

  const userMessages = messages.filter((message) => message.role === 'user');
  const assistantMessages = messages.filter((message) => message.role !== 'user');
  const asked: string[] = [];
  const decided: string[] = [];
  const pending: string[] = [];
  const doubts: string[] = [];

  for (const message of userMessages) {
    const text = clean(message.content, 140);
    if (text.length > 0) uniquePush(asked, text);
  }

  for (const message of assistantMessages) {
    const text = clean(message.content, 300);
    if (text.length === 0) continue;
    if (DECISION_RE.test(text)) uniquePush(decided, text);
    if (PENDING_RE.test(text)) uniquePush(pending, text);
    if (DOUBT_RE.test(text)) uniquePush(doubts, text);
  }

  // Datos concretos, de todo lo hablado: lo que se puede citar sin equivocarse.
  const whole = messages.map((message) => String(message.content ?? '')).join('\n');

  const dates = [...new Set([...whole.matchAll(new RegExp(DATE_RE.source, 'gi'))].map((m) => m[1]))];
  if (dates.length > 0) facts.push({ label: 'fechas', value: dates.slice(0, 2).join(', ') });

  const units = [...new Set([...whole.matchAll(new RegExp(UNIT_RE.source, 'gi'))].map((m) => m[1]))];
  if (units.length > 0) facts.push({ label: 'unidades', value: units.slice(0, 3).join(', ') });

  const quoted = [...new Set([...whole.matchAll(QUOTED_RE)].map((m) => clean(m[1], 60)))].filter(
    (title) => title.length >= 6
  );
  if (quoted.length > 0) facts.push({ label: 'temas citados', value: quoted.slice(0, 3).join(' · ') });

  const noteMentions = assistantMessages
    .map((message) => clean(message.content, 260))
    .filter((text) => NOTES_RE.test(text));
  if (noteMentions.length > 0) {
    facts.push({ label: 'apuntes', value: `se habló de apuntes en ${noteMentions.length} respuesta(s)` });
  }

  const parts: string[] = [];
  if (asked.length > 0) {
    parts.push(`Se habló de: ${asked.slice(-maxAsks).join(' / ')}`);
  }
  if (decided.length > 0) {
    parts.push(`Se acordó: ${decided[decided.length - 1].slice(0, 180)}`);
  }
  if (pending.length > 0) {
    parts.push(`Quedó pendiente: ${pending[pending.length - 1].slice(0, 180)}`);
  }
  if (doubts.length > 0) {
    parts.push(`No le quedó claro: ${doubts[doubts.length - 1].slice(0, 140)}`);
  }

  const summary =
    parts.length > 0
      ? parts.join('. ').slice(0, 600)
      : `Conversación de ${messages.length} mensaje(s) sin acuerdos que anotar.`;

  return { summary, facts: facts.slice(0, MEMORY_MAX_FACTS) };
}

/* ------------------------------------------------------------------ */
/* Guardar y leer (Prisma)                                            */
/* ------------------------------------------------------------------ */

interface MemoryRowLike {
  day: string;
  summary: string;
  factsJson: string | null;
  writtenBy: string;
}

function parseFacts(json: string | null): MemoryFact[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as Array<{ label?: unknown; value?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((fact) => typeof fact?.label === 'string' && typeof fact?.value === 'string')
      .map((fact) => ({ label: String(fact.label), value: String(fact.value) }));
  } catch {
    return [];
  }
}

function toDayMemory(row: MemoryRowLike): DayMemory {
  return { day: row.day, summary: row.summary, facts: parseFacts(row.factsJson), writtenBy: row.writtenBy };
}

/** Guarda (o actualiza) el recuerdo de un ámbito en un día. */
export async function saveDayMemory(input: {
  scope: string;
  day?: string;
  summary: string;
  facts?: MemoryFact[];
  writtenBy?: 'reglas' | 'ia';
}): Promise<void> {
  const scope = String(input.scope ?? '').trim();
  const summary = String(input.summary ?? '').trim();
  if (scope.length === 0 || summary.length === 0) return;

  const day = input.day ?? dayKey();
  const factsJson = JSON.stringify((input.facts ?? []).slice(0, MEMORY_MAX_FACTS));
  const writtenBy = input.writtenBy ?? 'reglas';
  const userId = currentUserId();

  await prisma.agentMemory.upsert({
    where: { userId_scope_day: { userId, scope, day } },
    create: { userId, scope, day, summary: summary.slice(0, 1000), factsJson, writtenBy },
    update: { summary: summary.slice(0, 1000), factsJson, writtenBy },
  });
}

/** Los recuerdos de los últimos días de un ámbito, del más reciente al más viejo. */
export async function loadRecentMemories(scope: string, days: number = MEMORY_DAYS): Promise<DayMemory[]> {
  const from = new Date();
  from.setDate(from.getDate() - Math.max(0, days));

  const rows = await prisma.agentMemory.findMany({
    where: { userId: currentUserId(), scope, createdAt: { gte: from } },
    orderBy: { createdAt: 'desc' },
    take: days + 1,
    select: { day: true, summary: true, factsJson: true, writtenBy: true },
  });

  return rows.map(toDayMemory);
}

/** El bloque de memoria listo para el prompt (cadena vacía si no hay nada). */
export async function loadMemoryBlock(scope: string, days: number = MEMORY_DAYS): Promise<string> {
  try {
    return buildMemoryBlock(await loadRecentMemories(scope, days));
  } catch {
    // Sin memoria se responde igual: es un extra, no un requisito.
    return '';
  }
}

/**
 * Escribe el recuerdo del día a partir de una conversación.
 *
 * Es lo que se llama al cerrar un turno (fuera de la respuesta del alumno, para no
 * añadir espera): lee los mensajes, los resume con reglas y lo guarda. Si se le
 * pasa `polishWithAi`, además se le pide al modelo una redacción mejor; si falla
 * —o si no hay clave— se queda la de las reglas, que ya está guardada.
 */
export async function rememberConversation(input: {
  scope: string;
  conversationId: string;
  /** Redacción mejor a cargo del modelo. Se usa **una vez al día por ámbito**. */
  polish?: (raw: string) => Promise<string | null>;
}): Promise<{ summary: string; facts: MemoryFact[]; polished: boolean } | null> {
  const scope = String(input.scope ?? '').trim();
  if (scope.length === 0) return null;

  const messages = await prisma.aiMessage.findMany({
    where: { conversationId: input.conversationId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  });

  // Una conversación de un solo saludo no es memoria: es ruido.
  if (messages.length < 3) return null;

  const { summary, facts } = digestConversation(messages);
  await saveDayMemory({ scope, summary, facts, writtenBy: 'reglas' });

  // El pulido cuesta una llamada de IA. Se pide **una vez al día y ámbito**, no en
  // cada turno: la memoria no puede competir por la cuota con lo que el alumno
  // está preguntando ahora mismo (ver el tope de tiempo del motor).
  if (input.polish && !(await isPolishedToday(scope))) {
    try {
      const polished = await input.polish(summary);
      if (polished && polished.trim().length > 0) {
        await saveDayMemory({ scope, summary: polished.trim(), facts, writtenBy: 'ia' });
        return { summary: polished.trim(), facts, polished: true };
      }
    } catch {
      // El pulido es un lujo: el recuerdo de las reglas ya está guardado.
    }
  }

  return { summary, facts, polished: false };
}

/** ¿El recuerdo de hoy de este ámbito ya lo redactó el modelo? */
export async function isPolishedToday(scope: string, day: string = dayKey()): Promise<boolean> {
  try {
    const row = await prisma.agentMemory.findUnique({
      where: { userId_scope_day: { userId: currentUserId(), scope, day } },
      select: { writtenBy: true },
    });
    return row?.writtenBy === 'ia';
  } catch {
    // Sin poder comprobarlo se prefiere no gastar cuota: las reglas ya escriben.
    return true;
  }
}
