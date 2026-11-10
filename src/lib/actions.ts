'use server';

import { revalidatePath, updateTag } from 'next/cache';
import { prisma } from './prisma';
import { writeTemarioBackup } from './temarioBackup';
import { regenerateWeeklyPlan } from './planner';
import { regenerateTodayPlan } from './dayPlan';
import { isTopicStatus, StudyMode, TopicStatus } from './types';
import { nextUnit, sortUnits } from './temario';
import {
  buildClassProgressPrompt,
  interpretClassAnswerLocally,
  parseClassProgressReply,
  type ClassUnitRef,
} from './classCheckIn';
import { runAiText } from './aiEngine';
import { isTemarioSource, normalizeTopicTitle, parseTemarioText, TemarioSource } from './temarioImport';

/** Todo lo que depende del temario se refresca con cada cambio de estado. */
function revalidateTemario() {
  // Invalida la lectura compartida de `getTemarioSubjects` en esta misma
  // petición: el alumno ve su cambio al instante, sin esperar 20 s.
  updateTag('temario');
  revalidatePath('/temario');
  revalidatePath('/');
  updateTag('cuartel');
  revalidatePath('/planificador');
  revalidatePath('/horario');
}

/**
 * Alterna el estado de completado de un bloque de estudio.
 */
export async function toggleStudyBlock(blockId: string) {
  const block = await prisma.studyBlock.findUnique({
    where: { id: blockId },
    include: { topic: { include: { subject: true } } },
  });

  if (!block) return { success: false, error: 'Bloque no encontrado' };

  const updated = await prisma.studyBlock.update({
    where: { id: blockId },
    data: {
      isCompleted: !block.isCompleted,
      status: !block.isCompleted ? 'completada' : 'pendiente',
      spentMinutes: !block.isCompleted
        ? Math.max(block.spentMinutes, block.durationMinutes)
        : 0,
    },
  });

  // Si se completa, sumamos las horas estimadas a la asignatura
  if (updated.isCompleted) {
    const hours = block.durationMinutes / 60.0;
    await prisma.subject.update({
      where: { id: block.topic.subjectId },
      data: { totalHoursSpent: { increment: hours } },
    });
    await prisma.topic.update({
      where: { id: block.topicId },
      data: {
        completedHours: { increment: hours },
        lastReviewedAt: new Date(),
      },
    });
  }

  revalidatePath('/');
  updateTag('cuartel');
  revalidatePath('/planificador');
  return { success: true, isCompleted: updated.isCompleted };
}

/* ------------------------------------------------------------------ */
/* Ciclo de vida de una sesión                                         */
/* ------------------------------------------------------------------ */

/** Una sesión empezada: el plan sabe que está en marcha y no la reprograma. */
export async function startSession(blockId: string) {
  if (typeof blockId !== 'string' || blockId.length === 0) {
    return { success: false, error: 'Falta la sesión.' };
  }

  const block = await prisma.studyBlock.findUnique({ where: { id: blockId } });
  if (!block) return { success: false, error: 'Sesión no encontrada' };
  if (block.isCompleted) return { success: true, alreadyDone: true };

  await prisma.studyBlock.update({ where: { id: blockId }, data: { status: 'en_curso' } });
  return { success: true };
}

/**
 * Pausa una sesión guardando los minutos hechos.
 *
 * No se pierde el progreso ni se repite lo ya trabajado: el bloque queda como
 * «parcial» con lo que llevas, y al continuar solo se piden los minutos que
 * faltan.
 */
export async function pauseSession(blockId: string, spentMinutes: number) {
  const block = await prisma.studyBlock.findUnique({ where: { id: blockId } });
  if (!block) return { success: false, error: 'Sesión no encontrada' };
  if (block.isCompleted) return { success: true, alreadyDone: true };

  const spent = Math.max(
    0,
    Math.min(block.durationMinutes, Math.round(Number(spentMinutes) || 0))
  );

  await prisma.studyBlock.update({
    where: { id: blockId },
    data: { status: 'parcial', spentMinutes: spent, isCompleted: false },
  });

  revalidatePath('/');
  updateTag('cuartel');
  revalidatePath('/planificador');
  return { success: true, spentMinutes: spent };
}

/**
 * Marca una sesión como hecha a mano (botón «Hecha»).
 *
 * Suma las horas trabajadas, pero **no toca el dominio**: dar una sesión por
 * completada no es una medición de nivel, y fingir que sí lo es ensuciaría el
 * plan y las estadísticas. El nivel lo mueven el Modo Enfoque y los simulacros.
 */
export async function completeSession(blockId: string) {
  const block = await prisma.studyBlock.findUnique({
    where: { id: blockId },
    include: { topic: true },
  });
  if (!block) return { success: false, error: 'Sesión no encontrada' };
  if (block.isCompleted) return { success: true, alreadyDone: true };

  const spent = Math.max(block.spentMinutes, block.durationMinutes);
  await prisma.studyBlock.update({
    where: { id: blockId },
    data: { isCompleted: true, status: 'completada', spentMinutes: spent },
  });

  const hours = spent / 60;
  await prisma.subject.update({
    where: { id: block.topic.subjectId },
    data: { totalHoursSpent: { increment: hours } },
  });
  await prisma.topic.update({
    where: { id: block.topicId },
    data: { completedHours: { increment: hours }, lastReviewedAt: new Date() },
  });

  revalidatePath('/');
  updateTag('cuartel');
  revalidatePath('/planificador');
  revalidatePath('/enfoque');
  return { success: true };
}

/** Una sesión que no se va a hacer: deja de contar como pendiente. */
export async function abandonSession(blockId: string) {
  const block = await prisma.studyBlock.findUnique({ where: { id: blockId } });
  if (!block) return { success: false, error: 'Sesión no encontrada' };

  await prisma.studyBlock.update({
    where: { id: blockId },
    data: { status: 'abandonada', isCompleted: false },
  });

  revalidatePath('/');
  updateTag('cuartel');
  revalidatePath('/planificador');
  return { success: true };
}

/** Recalcula el plan de hoy con el tiempo que queda ahora mismo. */
export async function recalculateToday() {
  const plan = await regenerateTodayPlan();

  revalidatePath('/');
  updateTag('cuartel');
  revalidatePath('/planificador');

  return {
    success: true,
    sessions: plan.sessions.length,
    availableMinutes: plan.availableMinutes,
    headline: plan.headline,
  };
}

/**
 * Alterna el cumplimiento de un hábito diario.
 */
export async function toggleHabit(habitId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const existingLog = await prisma.habitLog.findFirst({
    where: {
      habitId,
      date: {
        gte: today,
        lt: new Date(today.getTime() + 86400000),
      },
    },
  });

  if (existingLog) {
    // Si ya existía, lo desmarcamos
    await prisma.habitLog.delete({ where: { id: existingLog.id } });
    await prisma.habit.update({
      where: { id: habitId },
      data: { streak: { decrement: 1 } },
    });
  } else {
    // Marcamos como hecho hoy
    await prisma.habitLog.create({
      data: {
        habitId,
        date: today,
        completed: true,
      },
    });
    await prisma.habit.update({
      where: { id: habitId },
      data: { streak: { increment: 1 } },
    });
  }

  revalidatePath('/');
  updateTag('cuartel');
  return { success: true };
}

/**
 * Registra una sesión de estudio completa (desde Modo Enfoque / Pomodoro).
 * Actualiza el dominio del tema y las horas del sistema.
 */
export async function recordStudySession(data: {
  topicId: string;
  minutesSpent: number;
  techniqueUsed: string;
  outcome: 'entendido' | 'con_dudas' | 'fallado';
  notes?: string;
  /** Sesión del plan que se estaba haciendo (para cerrarla sin duplicar horas). */
  blockId?: string;
}) {
  const topic = await prisma.topic.findUnique({
    where: { id: data.topicId },
    include: { subject: true },
  });

  if (!topic) return { success: false, error: 'Tema no encontrado' };

  const prevMastery = topic.masteryLevel;
  let masteryDelta = 0;

  if (data.outcome === 'entendido') {
    masteryDelta = 8;
  } else if (data.outcome === 'con_dudas') {
    masteryDelta = 2;
  } else if (data.outcome === 'fallado') {
    masteryDelta = -8;
  }

  const newMastery = Math.min(100, Math.max(5, prevMastery + masteryDelta));
  const hoursSpent = data.minutesSpent / 60.0;

  // 1. Guardar la sesión
  await prisma.studySession.create({
    data: {
      topicId: data.topicId,
      minutesSpent: data.minutesSpent,
      techniqueUsed: data.techniqueUsed,
      outcome: data.outcome,
      previousMastery: prevMastery,
      newMastery: newMastery,
      notes: data.notes ?? '',
    },
  });

  // 1b. Cerrar la sesión del plan: queda completada y con los minutos reales.
  // Las horas ya se suman aquí abajo con `minutesSpent`, así que cerrar el
  // bloque no vuelve a sumarlas (no se cuenta dos veces el mismo trabajo).
  if (data.blockId) {
    const block = await prisma.studyBlock.findUnique({
      where: { id: data.blockId },
      select: { id: true, topicId: true, isCompleted: true },
    });
    if (block && !block.isCompleted && block.topicId === data.topicId) {
      await prisma.studyBlock.update({
        where: { id: block.id },
        data: {
          isCompleted: true,
          status: 'completada',
          spentMinutes: Math.max(1, Math.round(data.minutesSpent)),
        },
      });
    }
  }

  // 2. Actualizar tema y asignatura
  await prisma.topic.update({
    where: { id: data.topicId },
    data: {
      masteryLevel: newMastery,
      // A partir de aquí el dominio viene de una sesión real de estudio.
      masterySource: 'sesion',
      completedHours: { increment: hoursSpent },
      lastReviewedAt: new Date(),
    },
  });

  await prisma.subject.update({
    where: { id: topic.subjectId },
    data: {
      totalHoursSpent: { increment: hoursSpent },
    },
  });

  // 3. Actualizar racha del usuario
  const user = await prisma.userProfile.findUnique({ where: { id: 'user_default' } });
  if (user) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const lastDate = user.lastStudyDate ? new Date(user.lastStudyDate) : null;
    let newStreak = user.streakCurrent;

    if (!lastDate) {
      newStreak = 1;
    } else {
      lastDate.setHours(0, 0, 0, 0);
      const diffDays = Math.round((today.getTime() - lastDate.getTime()) / 86400000);
      if (diffDays === 1) {
        newStreak += 1;
      } else if (diffDays > 1) {
        newStreak = 1;
      }
    }

    await prisma.userProfile.update({
      where: { id: 'user_default' },
      data: {
        streakCurrent: newStreak,
        streakBest: Math.max(newStreak, user.streakBest),
        lastStudyDate: new Date(),
      },
    });
  }

  revalidatePath('/');
  updateTag('cuartel');
  revalidatePath('/planificador');
  revalidatePath('/enfoque');
  revalidatePath('/estadisticas');
  // La racha vive en la cabecera cacheada.
  updateTag('perfil');

  return { success: true, newMastery };
}

/**
 * Añade una entrada al Banco de Errores Quirúrgico.
 */
export async function createErrorLog(data: {
  subjectId: string;
  topicId: string;
  questionPrompt: string;
  myAnswer: string;
  correctAnswer: string;
  rootCause: string;
  keyLesson: string;
  correctiveAction: string;
}) {
  const error = await prisma.errorLog.create({
    data: {
      subjectId: data.subjectId,
      topicId: data.topicId,
      questionPrompt: data.questionPrompt,
      myAnswer: data.myAnswer,
      correctAnswer: data.correctAnswer,
      rootCause: data.rootCause,
      keyLesson: data.keyLesson,
      correctiveAction: data.correctiveAction,
      reviewCount: 1,
      isMastered: false,
    },
  });

  // Aumentar la prioridad del tema penalizando 3 puntos su dominio.
  // Un error real también es evidencia: queda como medido, no como supuesto.
  await prisma.topic.update({
    where: { id: data.topicId },
    data: {
      masteryLevel: { decrement: 3 },
      masterySource: 'sesion',
    },
  });

  revalidatePath('/');
  updateTag('cuartel');
  revalidatePath('/errores');
  revalidatePath('/planificador');
  return { success: true, errorId: error.id };
}

/**
 * Marca un error como superado/dominado o pendiente.
 */
export async function toggleMasterError(errorId: string) {
  const err = await prisma.errorLog.findUnique({ where: { id: errorId } });
  if (!err) return { success: false };

  const updated = await prisma.errorLog.update({
    where: { id: errorId },
    data: {
      isMastered: !err.isMastered,
      reviewCount: { increment: 1 },
    },
  });

  revalidatePath('/errores');
  revalidatePath('/');
  updateTag('cuartel');
  return { success: true, isMastered: updated.isMastered };
}

/**
 * Crea un nuevo examen o simulacro en el gestor.
 */
export async function createExam(data: {
  subjectId: string;
  title: string;
  examDate: string;
  weightPercent: number;
  examType: string;
  examFormat?: string;
  targetGrade: number;
  notes?: string;
}) {
  await prisma.exam.create({
    data: {
      subjectId: data.subjectId,
      title: data.title,
      examDate: new Date(data.examDate),
      weightPercent: data.weightPercent,
      examType: data.examType,
      examFormat: data.examFormat || 'test',
      targetGrade: data.targetGrade,
      notes: data.notes || '',
    },
  });

  revalidatePath('/');
  updateTag('cuartel');
  revalidatePath('/examenes');
  revalidatePath('/planificador');
  return { success: true };
}

/**
 * Corrige un examen ya apuntado: la fecha, el título, el peso o la nota objetivo.
 *
 * Hace falta porque los exámenes se mueven: el profesor cambia la fecha, el
 * peso no era el que dijo o el título estaba mal escrito. Sin esto, lo único
 * que se podía hacer era crear otro examen y dejar el viejo ahí mintiendo.
 */
export async function updateExam(
  examId: string,
  data: {
    examDate?: string;
    title?: string;
    weightPercent?: number;
    targetGrade?: number;
    notes?: string;
  }
) {
  const existing = await prisma.exam.findUnique({ where: { id: examId } });
  if (!existing) return { success: false, error: 'Ese examen ya no existe.' };

  const next: Record<string, unknown> = {};
  if (data.examDate) {
    const date = new Date(data.examDate);
    if (Number.isNaN(date.getTime())) return { success: false, error: 'La fecha no es válida.' };
    next.examDate = date;
  }
  if (typeof data.title === 'string' && data.title.trim().length > 1) next.title = data.title.trim();
  if (typeof data.weightPercent === 'number' && data.weightPercent > 0 && data.weightPercent <= 100) {
    next.weightPercent = data.weightPercent;
  }
  if (typeof data.targetGrade === 'number' && data.targetGrade >= 0 && data.targetGrade <= 10) {
    next.targetGrade = data.targetGrade;
  }
  if (typeof data.notes === 'string') next.notes = data.notes.slice(0, 600);

  if (Object.keys(next).length === 0) return { success: false, error: 'No has cambiado nada.' };

  await prisma.exam.update({ where: { id: examId }, data: next });

  revalidatePath('/');
  updateTag('cuartel');
  revalidatePath('/examenes');
  revalidatePath('/planificador');
  return { success: true };
}

/**
 * Quita un examen del gestor.
 *
 * Es una de las dos cosas que el alumno no podía hacer por más que insistiera
 * (y el coordinador tampoco: pedía borrarlo y su petición se quedaba sin
 * aplicar). Si el examen tenía simulacros hechos, no se pierden: quedan sin
 * examen asociado, con su nota y sus preguntas.
 */
export async function deleteExam(examId: string) {
  const existing = await prisma.exam.findUnique({ where: { id: examId } });
  if (!existing) return { success: false, error: 'Ese examen ya no existe.' };

  await prisma.exam.delete({ where: { id: examId } });

  revalidatePath('/');
  updateTag('cuartel');
  revalidatePath('/examenes');
  revalidatePath('/planificador');
  return { success: true, title: existing.title };
}

/**
 * Marca un examen como hecho (o lo vuelve a abrir).
 *
 * Un examen pasado que sigue contando como «próximo» ensucia la cuenta atrás y
 * el planificador, que le da urgencia a algo que ya ocurrió.
 */
export async function toggleExamCompleted(examId: string) {
  const existing = await prisma.exam.findUnique({ where: { id: examId } });
  if (!existing) return { success: false, error: 'Ese examen ya no existe.' };

  const updated = await prisma.exam.update({
    where: { id: examId },
    data: { isCompleted: !existing.isCompleted },
  });

  revalidatePath('/');
  updateTag('cuartel');
  revalidatePath('/examenes');
  revalidatePath('/planificador');
  return { success: true, isCompleted: updated.isCompleted };
}

/**
 * Cambia el modo de estudio (Zona de Confort vs Modo Atleta) y recalcula el plan.
 */
export async function switchStudyMode(mode: StudyMode) {
  await regenerateWeeklyPlan(mode);
  updateTag('perfil');
  revalidatePath('/');
  updateTag('cuartel');
  revalidatePath('/planificador');
  return { success: true };
}

/**
 * Fuerza el recálculo dinámico del plan de estudio.
 */
export async function triggerRecalculatePlan() {
  const user = await prisma.userProfile.findUnique({ where: { id: 'user_default' } });
  const mode = (user?.studyMode as StudyMode) || 'athlete';
  await regenerateWeeklyPlan(mode);
  revalidatePath('/');
  updateTag('cuartel');
  revalidatePath('/planificador');
  return { success: true };
}

/**
 * Crea un apunte / página tipo Notion vinculada a un tema.
 */
export async function createNote(data: {
  topicId: string;
  title: string;
  content: string;
  tags?: string;
}) {
  const note = await prisma.note.create({
    data: {
      topicId: data.topicId,
      title: data.title,
      content: data.content,
      tags: data.tags || 'apuntes',
    },
  });

  revalidatePath('/apuntes');
  revalidatePath('/');
  updateTag('cuartel');
  return { success: true, noteId: note.id };
}

/**
 * Actualiza un apunte / página tipo Notion.
 */
export async function updateNote(data: {
  id: string;
  title: string;
  content: string;
  tags?: string;
}) {
  await prisma.note.update({
    where: { id: data.id },
    data: {
      title: data.title,
      content: data.content,
      tags: data.tags,
      updatedAt: new Date(),
    },
  });

  revalidatePath('/apuntes');
  return { success: true };
}

/**
 * Elimina un apunte.
 */
export async function deleteNote(id: string) {
  await prisma.note.delete({ where: { id } });
  revalidatePath('/apuntes');
  return { success: true };
}

/**
 * Crea una nueva asignatura personalizada de Santiago.
 */
export async function createCustomSubject(data: {
  name: string;
  color: string;
  isPhaseGeneral: boolean;
  pauWeight: number;
}) {
  const subject = await prisma.subject.create({
    data: {
      name: data.name,
      color: data.color || '#3b82f6',
      isPhaseGeneral: data.isPhaseGeneral,
      pauWeight: data.pauWeight || 0.2,
      currentGrade: 7.5,
      targetGrade: 9.5,
    },
  });

  // Crear agente catedrático asociado
  await prisma.aiAgent.create({
    data: {
      subjectId: subject.id,
      name: `Catedrático de ${data.name}`,
      specialty: `Dominio curricular y preparación estratégica de ${data.name}`,
      systemPrompt: `Eres el Catedrático especializado en ${data.name} para 1º de Bachillerato. Explicas con rigor, preguntas socráticas y enfoque de preparación pre-PAU.`,
    },
  });

  revalidatePath('/');
  updateTag('cuartel');
  revalidatePath('/planificador');
  revalidatePath('/apuntes');
  return { success: true, subjectId: subject.id };
}

/**
 * Añade un nuevo tema a una asignatura.
 */
export async function createCustomTopic(data: {
  subjectId: string;
  title: string;
  difficulty: number;
}) {
  const topic = await prisma.topic.create({
    data: {
      subjectId: data.subjectId,
      title: data.title,
      difficulty: data.difficulty || 3,
      // Sin medir: no inventamos un dominio de partida.
      masteryLevel: 0,
      masterySource: 'sin_medir',
      estimatedHours: 8.0,
      completedHours: 0.0,
    },
  });

  revalidatePath('/');
  updateTag('cuartel');
  revalidatePath('/planificador');
  revalidatePath('/apuntes');
  return { success: true, topicId: topic.id };
}

/**
 * Cambia el estado de una unidad del temario a mano. Quien manda es lo que
 * pasa en clase, así que aquí se puede marcar cualquier unidad sin más reglas
 * que la fecha en que se explicó.
 */
export async function setTopicStatus(topicId: string, status: TopicStatus) {
  if (!isTopicStatus(status)) return { success: false, error: 'Estado no válido' };

  const topic = await prisma.topic.findUnique({ where: { id: topicId } });
  if (!topic) return { success: false, error: 'Unidad no encontrada' };

  const now = new Date();
  let seenInClassAt: Date | null = now;

  if (status === 'pendiente') {
    seenInClassAt = null;
  } else if (status === 'en_curso') {
    // La fecha de inicio de la unidad no se pisa si ya estaba en curso.
    seenInClassAt = topic.seenInClassAt ?? now;
  }

  await prisma.topic.update({
    where: { id: topicId },
    data: { status, seenInClassAt },
  });

  revalidateTemario();
  return { success: true, status };
}

/**
 * «Hoy en clase hemos visto esta unidad». Es el gesto de un clic desde el
 * Cuartel: marca la unidad como vista, le pone fecha y da por cerradas las
 * unidades anteriores que siguieran en curso.
 */
/**
 * Guarda «cómo lo explicó el profesor» en clase para una unidad.
 *
 * Es la nota que convierte los apuntes del catedrático en los apuntes de SU
 * profesor: la notación que exige, los pasos que pide, dónde hizo hincapié, qué
 * ejemplo puso y con qué convenio corrige. Se escribe con las palabras del
 * alumno —aquí no se interpreta nada— y el redactor de apuntes la recibe como
 * método prioritario. Sin esto, el catedrático escribe un temario genérico
 * impecable que no coincide con lo que le van a preguntar el jueves.
 */
export async function saveClassMethod(topicId: string, method: string) {
  const topic = await prisma.topic.findUnique({ where: { id: topicId }, select: { id: true } });
  if (!topic) return { success: false, error: 'Esa unidad no existe.' };

  const text = String(method ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);

  await prisma.topic.update({
    where: { id: topicId },
    data: { teacherMethod: text.length > 0 ? text : null },
  });

  revalidateTemario();
  return { success: true, saved: text.length > 0 };
}

export async function markTopicSeenInClass(topicId: string) {
  const topic = await prisma.topic.findUnique({
    where: { id: topicId },
    include: { subject: true },
  });
  if (!topic) return { success: false, error: 'Unidad no encontrada' };

  const now = new Date();
  const siblings = await prisma.topic.findMany({
    where: { subjectId: topic.subjectId, status: 'en_curso', id: { not: topicId } },
  });

  const closed = siblings.filter((unit) => (unit.unitNumber ?? 0) < (topic.unitNumber ?? 0));
  for (const unit of closed) {
    await prisma.topic.update({
      where: { id: unit.id },
      data: { status: 'visto', seenInClassAt: unit.seenInClassAt ?? now },
    });
  }

  await prisma.topic.update({
    where: { id: topicId },
    data: { status: 'visto', seenInClassAt: now },
  });

  const remaining = await prisma.topic.findMany({ where: { subjectId: topic.subjectId } });
  const following = nextUnit(
    remaining.map((unit) => ({
      id: unit.id,
      subjectId: unit.subjectId,
      unitNumber: unit.unitNumber,
      title: unit.title,
      term: unit.term,
      status: isTopicStatus(unit.status) ? unit.status : 'pendiente',
      source: unit.source,
      difficulty: unit.difficulty,
      masteryLevel: unit.masteryLevel,
      masterySource: unit.masterySource,
      seenInClassAt: unit.seenInClassAt ? unit.seenInClassAt.toISOString() : null,
    }))
  );

  revalidateTemario();
  return {
    success: true,
    subjectName: topic.subject.name,
    marked: { id: topic.id, unitNumber: topic.unitNumber, title: topic.title },
    closedPrevious: closed.length,
    next: following ? { id: following.id, unitNumber: following.unitNumber, title: following.title } : null,
  };
}

/**
 * «Hoy en clase hemos dado…», contado con sus palabras.
 *
 * Es la puerta conversacional del planificador: el alumno escribe una frase
 * («hemos empezado la U5, pero solo el primer apartado») y el sistema
 *  1. la traduce a unidades REALES de su temario (la IA interpreta; el código
 *     escribe, así que no puede inventarse una unidad que no exista),
 *  2. marca lo visto hoy y deja en curso lo que se ha empezado,
 *  3. rehace las sesiones pendientes de la tarde, donde lo dado hoy pasa a lo
 *     primero con su motivo escrito.
 *
 * Lo completado y lo que está en marcha no se toca: nadie pierde una sesión
 * empezada por contar lo que ha hecho en clase.
 */
export async function registrarAvanceDeClase(subjectId: string, answer: string) {
  const subject = await prisma.subject.findUnique({
    where: { id: subjectId },
    include: { topics: { orderBy: { unitNumber: 'asc' } } },
  });
  if (!subject) return { success: false as const, error: 'Esa asignatura no existe.' };

  const text = String(answer ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
  if (text.length < 2) {
    return { success: false as const, error: 'Cuéntame en una frase por dónde vais en clase.' };
  }

  const units: ClassUnitRef[] = subject.topics.map((topic) => ({
    id: topic.id,
    unitNumber: topic.unitNumber,
    title: topic.title,
    status: topic.status,
  }));

  let progress = interpretClassAnswerLocally(text, units);

  // La IA lee la frase. Si no hay cupo o todas las claves están saturadas, la
  // lectura local ya ha sacado el número o el título y el flujo sigue igual.
  try {
    const result = await runAiText({
      systemInstruction: buildClassProgressPrompt({
        subjectName: subject.name,
        units,
        answer: text,
      }),
      message: text,
      maxTokens: 260,
      budgetMs: 12_000,
      attemptMs: 8_000,
    });
    const parsed = parseClassProgressReply(result.text, units);
    if (parsed && (parsed.vistos.length > 0 || parsed.enCurso !== null || parsed.sinTemario)) {
      progress = parsed;
    }
  } catch (error) {
    console.warn('[plan] la IA no ha podido leer el avance de clase; se usa la lectura local:', error);
  }

  if (progress.vistos.length === 0 && progress.enCurso === null && !progress.sinTemario) {
    const examples = units
      .filter((unit) => unit.status === 'pendiente')
      .slice(0, 3)
      .map((unit) => (unit.unitNumber !== null ? `U${unit.unitNumber}` : `«${unit.title}»`));
    return {
      success: false as const,
      error:
        examples.length > 0
          ? `No he sabido a qué unidad te refieres. Prueba con el número (${examples.join(', ')}) o con el título.`
          : 'No he sabido a qué unidad te refieres. Revisa tu temario y dime el número o el título.',
    };
  }

  const byNumber = new Map<number, ClassUnitRef>();
  for (const unit of units) {
    if (unit.unitNumber !== null) byNumber.set(unit.unitNumber, unit);
  }

  const now = new Date();
  const cambios: string[] = [];
  let touched = 0;

  for (const number of progress.vistos) {
    const unit = byNumber.get(number);
    if (!unit) continue;
    await prisma.topic.update({
      where: { id: unit.id },
      data: { status: 'visto', seenInClassAt: now },
    });
    cambios.push(`U${number} «${unit.title}» → visto hoy`);
    touched += 1;
  }

  const enCursoUnit = progress.enCurso !== null ? byNumber.get(progress.enCurso) ?? null : null;
  const reference = Math.max(0, ...progress.vistos, progress.enCurso ?? 0);

  // Las unidades que seguían «en curso» por detrás de lo que se acaba de contar
  // se cierran: el profesor ya ha pasado a otra cosa y dejarlas abiertas
  // ensuciaría el plan (y la prioridad).
  const stale = units.filter(
    (unit) =>
      unit.status === 'en_curso' &&
      unit.id !== enCursoUnit?.id &&
      !progress.vistos.includes(unit.unitNumber ?? -1) &&
      (unit.unitNumber ?? 0) < reference
  );
  for (const unit of stale) {
    await prisma.topic.update({
      where: { id: unit.id },
      data: { status: 'visto', seenInClassAt: now },
    });
    cambios.push(`U${unit.unitNumber ?? '?'} «${unit.title}» → cerrada al empezar la siguiente`);
  }

  if (enCursoUnit) {
    await prisma.topic.update({
      where: { id: enCursoUnit.id },
      data: { status: 'en_curso' },
    });
    cambios.push(
      `U${enCursoUnit.unitNumber ?? '?'} «${enCursoUnit.title}» → en curso (primero en el plan de hoy)`
    );
  }

  touched += stale.length + (enCursoUnit ? 1 : 0);

  if (progress.sinTemario && touched === 0) {
    revalidateTemario();
    return {
      success: true as const,
      fuente: progress.fuente,
      interpretacion: progress.resumen || 'Hoy no se dio temario nuevo.',
      cambios: ['Sin temario nuevo: el plan del día no cambia.'],
      plan: null,
    };
  }

  // Se rehace la tarde con lo nuevo arriba. `persistDayPlan` borra solo lo
  // pendiente: lo completado y lo que está en marcha se queda como está.
  let planSummary: { headline: string; primera: string | null } | null = null;
  try {
    const plan = await regenerateTodayPlan(now);
    const first = plan.sessions.find((session) => !session.isCompleted) ?? null;
    planSummary = {
      headline: plan.headline,
      primera: first
        ? `${first.subjectName} · ${first.topicTitle} (${first.durationMinutes} min): ${first.reason}`
        : null,
    };
  } catch (error) {
    console.error('[plan] el avance se guardó, pero no se pudo rehacer el plan de hoy:', error);
  }

  revalidateTemario();
  return {
    success: true as const,
    fuente: progress.fuente,
    interpretacion: progress.resumen,
    cambios,
    plan: planSummary,
  };
}

/**
 * Edita una unidad: título, evaluación, dificultad o su número de orden.
 */
export async function updateTopicDetails(data: {
  topicId: string;
  title?: string;
  term?: number | null;
  difficulty?: number;
}) {
  const topic = await prisma.topic.findUnique({ where: { id: data.topicId } });
  if (!topic) return { success: false, error: 'Unidad no encontrada' };

  const title = data.title?.trim();
  if (data.title !== undefined && !title) {
    return { success: false, error: 'El título no puede quedar vacío' };
  }

  await prisma.topic.update({
    where: { id: data.topicId },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(data.term !== undefined ? { term: data.term } : {}),
      ...(data.difficulty !== undefined
        ? { difficulty: Math.min(5, Math.max(1, Math.round(data.difficulty))) }
        : {}),
    },
  });

  revalidateTemario();
  return { success: true };
}

/**
 * Añade una unidad al final del temario de una asignatura (tu índice real,
 * un tema que el profesor añade a última hora…).
 */
export async function addTemarioUnit(data: {
  subjectId: string;
  title: string;
  term?: number | null;
  difficulty?: number;
}) {
  const title = data.title?.trim();
  if (!title) return { success: false, error: 'Escribe un título para la unidad' };

  const siblings = await prisma.topic.findMany({ where: { subjectId: data.subjectId } });
  const lastNumber = sortUnits(siblings).reduce((max, unit) => Math.max(max, unit.unitNumber ?? 0), 0);

  const topic = await prisma.topic.create({
    data: {
      subjectId: data.subjectId,
      title,
      unitNumber: lastNumber + 1,
      term: data.term ?? null,
      difficulty: data.difficulty ?? 3,
      masteryLevel: 0,
      masterySource: 'sin_medir',
      status: 'pendiente',
      source: 'manual',
    },
  });

  revalidateTemario();
  return { success: true, topicId: topic.id };
}

/**
 * Borra una unidad del temario (y, en cascada, sus bloques y errores).
 */
export async function deleteTemarioUnit(topicId: string) {
  const topic = await prisma.topic.findUnique({ where: { id: topicId } });
  if (!topic) return { success: false, error: 'Unidad no encontrada' };

  await prisma.topic.delete({ where: { id: topicId } });
  revalidateTemario();
  return { success: true };
}

/**
 * «Vamos por aquí»: pone la unidad indicada como en curso y da por dadas todas
 * las anteriores. Es el ajuste de una sola vez cuando llegas nuevo al sistema a
 * mitad de curso y no vas a marcar clase por clase lo ya pasado.
 *
 * Las unidades anteriores quedan como vistas SIN fecha de clase (no inventamos
 * cuándo se dieron), así la proyección de fin de temario no se falsea.
 */
export async function setCourseProgressFrom(subjectId: string, topicId: string) {
  const topic = await prisma.topic.findUnique({ where: { id: topicId } });
  if (!topic || topic.subjectId !== subjectId) {
    return { success: false, error: 'Unidad no encontrada en esa asignatura' };
  }

  const siblings = sortUnits(await prisma.topic.findMany({ where: { subjectId } }));
  const position = topic.unitNumber ?? siblings.findIndex((unit) => unit.id === topicId) + 1;
  const now = new Date();
  let closed = 0;

  for (const unit of siblings) {
    const number = unit.unitNumber ?? Number.MAX_SAFE_INTEGER;
    if (number < position && unit.status !== 'visto' && unit.status !== 'repasado') {
      await prisma.topic.update({ where: { id: unit.id }, data: { status: 'visto' } });
      closed++;
    }
  }

  await prisma.topic.update({
    where: { id: topicId },
    data: { status: 'en_curso', seenInClassAt: topic.seenInClassAt ?? now },
  });

  revalidateTemario();
  return { success: true, closed, current: { id: topic.id, title: topic.title, unitNumber: position } };
}

/**
 * Nivel declarado por ti para una unidad (autoevaluación en un clic). Se marca
 * como autoevaluado, no como medido con examen: tú sabes cómo lo llevas, pero la
 * app no lo presenta como una medición objetiva.
 */
export async function setTopicSelfAssessment(topicId: string, level: number | null) {
  const topic = await prisma.topic.findUnique({ where: { id: topicId } });
  if (!topic) return { success: false, error: 'Unidad no encontrada' };

  if (level === null) {
    await prisma.topic.update({
      where: { id: topicId },
      data: { masteryLevel: 0, masterySource: 'sin_medir' },
    });
    revalidateTemario();
    return { success: true, cleared: true };
  }

  const clamped = Math.min(100, Math.max(0, Math.round(level)));
  await prisma.topic.update({
    where: { id: topicId },
    data: { masteryLevel: clamped, masterySource: 'autoevaluacion' },
  });

  revalidateTemario();
  return { success: true, level: clamped };
}

/**
 * Declaras tus notas reales: la media que llevas en cada asignatura y tu
 * objetivo. Hasta que lo hagas no había ninguna nota tuya, solo un valor de
 * fábrica que la app citaba como si fuera tuya.
 */
export async function declareSubjectGrades(data: {
  subjectId: string;
  currentGrade: number;
  targetGrade: number;
}) {
  const subject = await prisma.subject.findUnique({ where: { id: data.subjectId } });
  if (!subject) return { success: false, error: 'Asignatura no encontrada' };

  const current = Math.min(10, Math.max(0, Number(data.currentGrade)));
  const target = Math.min(10, Math.max(0, Number(data.targetGrade)));
  if (!Number.isFinite(current) || !Number.isFinite(target)) {
    return { success: false, error: 'Notas no válidas' };
  }

  await prisma.subject.update({
    where: { id: data.subjectId },
    data: { currentGrade: current, targetGrade: target, gradeSource: 'declarada' },
  });

  revalidateTemario();
  revalidatePath('/estadisticas');
  revalidatePath('/planificador');
  revalidatePath('/ajustes');
  return { success: true };
}

/**
 * Carga TU temario: el índice de tu profesor, el de tu libro o la lista que
 * escribas tú. La app no inventa unidades; lee lo que pegas, respeta el orden,
 * recoge las evaluaciones que anuncies y marca todo como pendiente y sin medir.
 *
 * En modo «sustituir» se guarda antes una copia en data/backups/ y, si esa copia
 * no se puede escribir, no se borra nada.
 */
export async function importTemario(data: {
  subjectId: string;
  text: string;
  source?: string;
  mode?: 'replace' | 'merge';
}) {
  const subject = await prisma.subject.findUnique({ where: { id: data.subjectId } });
  if (!subject) return { success: false as const, error: 'Asignatura no encontrada' };

  const source: TemarioSource = isTemarioSource(data.source) ? data.source : 'manual';
  const mode = data.mode === 'replace' ? 'replace' : 'merge';
  const parsed = parseTemarioText(data.text ?? '');

  if (parsed.units.length === 0) {
    return {
      success: false as const,
      error:
        'No he reconocido ninguna unidad en lo que has pegado. Escribe una unidad por línea (una lista, sin párrafos).',
    };
  }

  let backup: string | null = null;
  if (mode === 'replace') {
    try {
      backup = await writeTemarioBackup(
        subject.id,
        subject.name,
        'Copia previa a sustituir tu temario desde /temario'
      );
    } catch (error) {
      return {
        success: false as const,
        error: `No he podido guardar la copia de seguridad, así que no he borrado nada: ${
          (error as Error).message
        }`,
      };
    }
  }

  const existing = await prisma.topic.findMany({ where: { subjectId: subject.id } });
  const byTitle = new Map(existing.map((topic) => [normalizeTopicTitle(topic.title), topic]));
  let removed = 0;

  if (mode === 'replace') {
    const deleted = await prisma.topic.deleteMany({ where: { subjectId: subject.id } });
    removed = deleted.count;
    byTitle.clear();
  }

  // En modo añadir, las unidades nuevas van detrás de las que ya tenías.
  let cursor = mode === 'replace'
    ? 0
    : existing.reduce((max, topic) => Math.max(max, topic.unitNumber ?? 0), 0);
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const unit of parsed.units) {
    const key = normalizeTopicTitle(unit.title);
    const match = byTitle.get(key);

    if (match) {
      byTitle.delete(key);
      // Ya estaba: solo se completa la evaluación si faltaba.
      if (unit.term !== null && match.term === null) {
        await prisma.topic.update({ where: { id: match.id }, data: { term: unit.term } });
        updated++;
      } else {
        skipped++;
      }
      continue;
    }

    cursor++;
    await prisma.topic.create({
      data: {
        subjectId: subject.id,
        title: unit.title,
        unitNumber: cursor,
        term: unit.term,
        difficulty: unit.difficulty,
        source,
        status: 'pendiente',
        // Sin medir: cargar el temario no es saberlo.
        masteryLevel: 0,
        masterySource: 'sin_medir',
      },
    });
    created++;
  }

  // El plan de la semana se rehace con el temario que acabas de cargar.
  const user = await prisma.userProfile.findUnique({ where: { id: 'user_default' } });
  const plan = await regenerateWeeklyPlan((user?.studyMode as StudyMode) || 'athlete');
  const total = await prisma.topic.count({ where: { subjectId: subject.id } });

  revalidateTemario();
  revalidatePath('/apuntes');
  revalidatePath('/estadisticas');
  revalidatePath('/errores');
  revalidatePath('/ajustes');

  return {
    success: true as const,
    subjectName: subject.name,
    created,
    updated,
    skipped,
    removed,
    backup,
    total,
    blocks: plan.count ?? 0,
    terms: parsed.terms,
    duplicates: parsed.duplicates.length,
    ignored: parsed.ignored.length,
    source,
  };
}

/**
 * Sube o baja una unidad en el orden del temario, renumerando la asignatura.
 */
export async function moveTemarioUnit(topicId: string, direction: 'up' | 'down') {
  const topic = await prisma.topic.findUnique({ where: { id: topicId } });
  if (!topic) return { success: false, error: 'Unidad no encontrada' };

  const siblings = sortUnits(await prisma.topic.findMany({ where: { subjectId: topic.subjectId } }));
  const index = siblings.findIndex((unit) => unit.id === topicId);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= siblings.length) return { success: true, moved: false };

  const reordered = [...siblings];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

  await prisma.$transaction(
    reordered.map((unit, position) =>
      prisma.topic.update({ where: { id: unit.id }, data: { unitNumber: position + 1 } })
    )
  );

  revalidateTemario();
  return { success: true, moved: true };
}

