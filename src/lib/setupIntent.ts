import type { SetupAuditArea } from './setup';

/**
 * Qué está pidiendo el alumno en su mensaje.
 *
 * El coordinador obedecía solo a medias: si decía «revísame el temario» o
 * «deshaz eso», dependía de que el modelo se acordara de emitir la etiqueta. Con
 * esto, la app lo detecta por su cuenta y actúa ELLA (audita o deshace) antes de
 * hablar con el modelo, que luego cuenta lo que ha pasado. Obedecer al alumno no
 * puede depender del humor de un proveedor.
 *
 * Módulo puro: sin base de datos y sin red.
 */

/** Verbos que piden una revisión de verdad. */
const REVIEW_VERB =
  /\b(revis\w*|comprueb\w*|comprob\w*|verific\w*|audit\w*|inspeccion\w*|supervis\w*|repasa\w*|cheque\w*)\b/i;

/** Preguntas que también son una revisión («¿qué me falta?», «¿está todo bien?»). */
const REVIEW_QUESTION =
  /(est[aá] todo bien|qu[eé] (me )?falta|qu[eé] falta|lo tengo todo|est[aá] bien montado|qu[eé] queda por montar|est[aá] completo)/i;

/** Negaciones: «no lo deshagas», «no vuelvas atrás». */
const UNDO_NEGATED = /\bno\s+(lo\s+|me\s+lo\s+)?(desha\w*|revier\w*|restaur\w*|vuelvas?\s+atr[aá]s)/i;

/** «deshazlo», «vuelve atrás», «restaura», «lo has liado». */
const UNDO_VERB =
  /\b(desha\w*|deshace\w*|reviert\w*|revier\w*|restaur\w*|vuelve\s+atr[aá]s|volver\s+atr[aá]s|lo\s+has\s+liado|lo\s+has\s+hecho\s+mal|te\s+has\s+equivocado|est[aá]\s+mal\s+montado)/i;

/**
 * Las horas de estudio que acaba de decir, si lo ha dicho sin ambigüedad.
 *
 * «3 horas al día entre semana» es un dato, no una sugerencia: si el modelo no
 * emite `[[horas:…]]`, la app lo apunta igual. Obedecer no puede depender de que
 * el proveedor se acuerde de la etiqueta.
 *
 * Devuelve horas SEMANALES: por semana tal cual; por día, ×5 (semana lectiva) o
 * ×7 si nombra el fin de semana.
 */
export function hoursFromMessage(message: string): number | null {
  const text = String(message ?? '');
  if (text.trim().length === 0) return null;

  const weekly = text.match(
    /(\d{1,2}(?:[.,]\d)?)\s*(?:h\b|horas?)\s*(?:a\s+la|por|semanales?|cada)\s*semana/i
  );
  if (weekly) return clampHours(Number(weekly[1].replace(',', '.')));

  const daily = text.match(
    /(\d{1,2}(?:[.,]\d)?)\s*(?:h\b|horas?)\s*(?:al?\s+d[ií]a|diarias?|cada\s+d[ií]a)/i
  );
  if (daily) {
    const value = Number(daily[1].replace(',', '.'));
    const weekend = /fin\s+de\s+semana|s[aá]bados?|domingos?|todos\s+los\s+d[ií]as/i.test(text);
    return clampHours(value * (weekend ? 7 : 5));
  }

  return null;
}

/** Una cifra semanal razonable (1–80 h), o null. */
function clampHours(value: number): number | null {
  const weekly = Math.round(value * 10) / 10;
  return Number.isFinite(weekly) && weekly >= 1 && weekly <= 80 ? weekly : null;
}

/** ¿Pide volver atrás? */
export function wantsUndo(message: string): boolean {
  const text = String(message ?? '');
  if (text.trim().length === 0) return false;
  if (UNDO_NEGATED.test(text)) return false;
  return UNDO_VERB.test(text);
}

/**
 * ¿Pide revisar algo? Devuelve el área (o 'todo') y `null` si no lo pide.
 *
 * Se exige un verbo de revisión o una pregunta del tipo «¿qué me falta?»: así
 * «repasa la unidad 3 conmigo» no dispara una auditoría del curso entero.
 */
export function reviewArea(message: string): SetupAuditArea | null {
  const text = String(message ?? '');
  if (text.trim().length === 0) return null;
  if (!REVIEW_VERB.test(text) && !REVIEW_QUESTION.test(text)) return null;

  if (/temario|unidad(es)?|tema(s)?\b/i.test(text)) return 'temario';
  if (/horario|clases?\b/i.test(text)) return 'horario';
  if (/examen(es)?|fechas?\b/i.test(text)) return 'examenes';
  if (/horas?\b/i.test(text)) return 'horas';
  return 'todo';
}
