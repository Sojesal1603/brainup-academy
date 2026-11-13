/**
 * BrainUp Moodle — Sincronización por enlace iCal / Webcal.
 *
 * Todas las plataformas Moodle (Moodle Centros, EducaMadrid, Aules…) ofrecen
 * en el Calendario el botón «Exportar calendario → URL de suscripción».
 * Este módulo descarga ese enlace, extrae las entregas y exámenes y los
 * guarda como MoodleTask en la base local, sin duplicados (upsert por UID).
 */

import { db } from './db';

export interface MoodleEvent {
  uid: string;
  summary: string;
  description?: string;
  start: Date;
  url?: string;
  course?: string;
}

export interface MoodleSyncStats {
  total: number;
  created: number;
  updated: number;
  skipped: number;
}

/* ------------------------------------------------------------------ */
/* Parser iCal mínimo (RFC 5545, lo que Moodle realmente emite)        */
/* ------------------------------------------------------------------ */

function unfoldLines(raw: string): string[] {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function unescapeICalText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseICalDate(value: string): Date | null {
  const trimmed = value.trim();

  // Fecha sin hora: 20261014
  if (/^\d{8}$/.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    const month = Number(trimmed.slice(4, 6));
    const day = Number(trimmed.slice(6, 8));
    return new Date(year, month - 1, day, 23, 59, 0);
  }

  // Fecha con hora: 20261014T120000 o 20261014T120000Z
  const match = trimmed.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!match) return null;

  const [, y, mo, d, h, mi, s, z] = match;
  if (z) {
    return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  }
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

export function parseICalEvents(ics: string): MoodleEvent[] {
  const lines = unfoldLines(ics);
  const events: MoodleEvent[] = [];
  let current: Map<string, { value: string; params: string }> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === 'BEGIN:VEVENT') {
      current = new Map();
      continue;
    }

    if (trimmed === 'END:VEVENT') {
      if (current) {
        const dtStart = current.get('DTSTART');
        const summary = current.get('SUMMARY');

        if (dtStart && summary) {
          const start = parseICalDate(dtStart.value);
          if (start) {
            const description = current.get('DESCRIPTION');
            const url = current.get('URL');
            const categories = current.get('CATEGORIES');
            const uid = current.get('UID');

            events.push({
              uid:
                uid?.value.trim() ||
                `moodle-${start.getTime()}-${summary.value.slice(0, 40)}`,
              summary: unescapeICalText(summary.value).trim(),
              description: description ? unescapeICalText(description.value).trim() : undefined,
              start,
              url: url?.value.trim() || undefined,
              course: categories ? unescapeICalText(categories.value).trim() : undefined,
            });
          }
        }
      }
      current = null;
      continue;
    }

    if (!current) continue;

    const colon = line.indexOf(':');
    if (colon <= 0) continue;

    const left = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const semi = left.indexOf(';');
    const name = (semi >= 0 ? left.slice(0, semi) : left).toUpperCase();
    const params = semi >= 0 ? left.slice(semi + 1) : '';

    if (!current.has(name)) current.set(name, { value, params });
  }

  return events;
}

/* ------------------------------------------------------------------ */
/* Sincronización                                                      */
/* ------------------------------------------------------------------ */

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export async function syncMoodleFeed(userId: string, feedUrl: string): Promise<MoodleSyncStats> {
  const prisma = db(userId);
  let parsed: URL;
  try {
    parsed = new URL(feedUrl);
  } catch {
    throw new Error('El enlace no es válido. Debe empezar por http:// o https://');
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('El enlace debe empezar por http:// o https://');
  }

  let response: Response;
  try {
    response = await fetch(feedUrl, {
      headers: { 'User-Agent': 'BrainUpAcademy/1.0 (sincronizador iCal local)' },
      signal: AbortSignal.timeout(25_000),
      redirect: 'follow',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `No se pudo descargar el calendario de Moodle (${detail}). Comprueba el enlace y tu conexión.`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Moodle respondió con HTTP ${response.status}. Comprueba que el enlace de suscripción sigue activo.`
    );
  }

  const text = await response.text();
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new Error(
      'El enlace no devuelve un calendario iCal válido. Asegúrate de copiar la «URL de suscripción» del Calendario de Moodle.'
    );
  }

  const events = parseICalEvents(text);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const from = new Date(todayStart.getTime() - 86400000); // incluye lo de ayer (por si acaso)
  const horizon = new Date(todayStart.getTime() + 120 * 86400000);

  const relevant = events.filter((event) => event.start >= from && event.start <= horizon);

  const subjects = await prisma.subject.findMany({
    where: { userId },
    select: { id: true, name: true },
  });

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const event of relevant) {
    if (!event.uid) {
      skipped++;
      continue;
    }

    // Intento de asignar la tarea a una asignatura conocida por nombre.
    let subjectId: string | null = null;
    if (event.course) {
      const course = normalize(event.course);
      const match = subjects.find(
        (s) => course.includes(normalize(s.name)) || normalize(s.name).includes(course)
      );
      subjectId = match?.id ?? null;
    }

    const data = {
      title: event.summary || 'Tarea de Moodle',
      description: event.description ?? null,
      courseName: event.course || 'Moodle',
      subjectId,
      dueDate: event.start,
      moodleUrl: event.url ?? null,
    };

    const existing = await prisma.moodleTask.findFirst({
      where: { userId, externalId: event.uid },
    });

    if (existing) {
      await prisma.moodleTask.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.moodleTask.create({ data: { userId, externalId: event.uid, ...data } });
      created++;
    }
  }

  return { total: events.length, created, updated, skipped };
}
