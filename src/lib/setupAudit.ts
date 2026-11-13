import { db } from './db';
import type { SetupAuditArea } from './setup';

/**
 * Auditoría REAL del curso.
 *
 * El alumno pedía «revísame el temario» y el coordinador contestaba de memoria:
 * repetía lo que ya decía el estado del prompt y no comprobaba nada. Aquí están
 * las comprobaciones que el sistema SÍ puede hacer contra la base de datos
 * (unidades duplicadas o sin numerar, exámenes pasados que siguen contando,
 * clases que se pisan, materias sin horario, horas irreales…).
 *
 * Es determinista y no llama a ningún modelo: sirve para que la respuesta del
 * coordinador hable de problemas que existen de verdad, y también para que el
 * respaldo local pueda revisar cuando no hay IA.
 */

export type SetupAuditSeverity = 'alta' | 'media' | 'baja';

export interface SetupAuditFinding {
  area: Exclude<SetupAuditArea, 'todo'>;
  severity: SetupAuditSeverity;
  text: string;
}

export interface SetupAuditReport {
  area: SetupAuditArea;
  findings: SetupAuditFinding[];
  /** Texto compacto, listo para el prompt o para el chat. */
  summary: string;
}

const AREA_LABEL: Record<Exclude<SetupAuditArea, 'todo'>, string> = {
  temario: 'Temario',
  horario: 'Horario',
  examenes: 'Exámenes',
  horas: 'Horas',
};

const DAY_NAMES: Record<number, string> = {
  1: 'lunes',
  2: 'martes',
  3: 'miércoles',
  4: 'jueves',
  5: 'viernes',
};

/** Minutos desde «HH:MM» (0 si no se entiende). */
function minutesOf(value: string): number {
  const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Quita acentos y signos para comparar títulos sin sorpresas. */
function normalize(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Comprueba el curso (o un área concreta) y devuelve los problemas con su
 * gravedad. Nunca lanza por un fallo de base: quien llama prefiere contestar sin
 * auditoría antes que romper el turno.
 */
export async function auditSetup(
  userId: string,
  area: SetupAuditArea = 'todo'
): Promise<SetupAuditReport> {
  const prisma = db(userId);
  const wants = (target: Exclude<SetupAuditArea, 'todo'>): boolean => area === 'todo' || area === target;
  const now = new Date();
  const findings: SetupAuditFinding[] = [];

  const [user, subjects, periods] = await Promise.all([
    prisma.userProfile.findUnique({ where: { id: userId } }),
    prisma.subject.findMany({
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      include: {
        topics: { orderBy: [{ unitNumber: 'asc' }] },
        exams: { orderBy: { examDate: 'asc' } },
        _count: { select: { classPeriods: true } },
      },
    }),
    prisma.classPeriod.findMany({
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
      include: { subject: { select: { name: true } } },
    }),
  ]);

  /* ------------------------------ Horas ------------------------------ */
  if (wants('horas')) {
    if (!user?.weeklyHoursDeclared) {
      findings.push({
        area: 'horas',
        severity: 'alta',
        text: 'no has declarado tus horas reales de estudio: el plan usa un valor de partida, no el tuyo.',
      });
    } else {
      const cap = Number(user.weeklyHoursCap);
      if (!Number.isFinite(cap) || cap <= 0) {
        findings.push({
          area: 'horas',
          severity: 'alta',
          text: 'las horas de estudio que hay apuntadas no son un número válido.',
        });
      } else if (cap > 56) {
        findings.push({
          area: 'horas',
          severity: 'media',
          text: `${cap} h/semana de estudio no es realista: el plan va a quedar imposible de cumplir.`,
        });
      }
    }
  }

  /* ----------------------------- Horario ----------------------------- */
  if (wants('horario')) {
    if (periods.length === 0) {
      findings.push({
        area: 'horario',
        severity: 'alta',
        text: 'no hay ninguna clase en el horario: el plan no sabe qué tiempo tienes libre de verdad.',
      });
    } else if (!user?.timetableComplete) {
      findings.push({
        area: 'horario',
        severity: 'media',
        text: `hay ${periods.length} clases apuntadas pero no has confirmado que el horario esté completo (faltan días por repasar).`,
      });
    }

    // Dos clases que se pisan el mismo día no pueden ser verdad.
    const byDay = new Map<number, typeof periods>();
    for (const period of periods) {
      if (!byDay.has(period.dayOfWeek)) byDay.set(period.dayOfWeek, []);
      byDay.get(period.dayOfWeek)!.push(period);
    }
    for (const [day, list] of byDay) {
      const ordered = [...list].sort((a, b) => minutesOf(a.startTime) - minutesOf(b.startTime));
      for (let index = 1; index < ordered.length; index++) {
        const previous = ordered[index - 1];
        const current = ordered[index];
        if (minutesOf(current.startTime) < minutesOf(previous.endTime)) {
          findings.push({
            area: 'horario',
            severity: 'alta',
            text: `el ${DAY_NAMES[day] ?? day} se pisan dos clases (${previous.subject.name} ${previous.startTime}-${previous.endTime} y ${current.subject.name} ${current.startTime}-${current.endTime}).`,
          });
        }
      }
    }

    for (const subject of subjects) {
      if (!subject.isTracked) continue;
      if (subject._count.classPeriods === 0) {
        findings.push({
          area: 'horario',
          severity: 'baja',
          text: `${subject.name} se estudia en la app pero no tiene ninguna clase en tu horario.`,
        });
      }
    }
  }

  /* ----------------------------- Temario ----------------------------- */
  if (wants('temario')) {
    for (const subject of subjects) {
      if (!subject.isTracked) continue;
      if (subject.topics.length === 0) {
        findings.push({
          area: 'temario',
          severity: 'alta',
          text: `${subject.name} no tiene ninguna unidad: el plan no puede repartir su estudio.`,
        });
        continue;
      }
      if (!subject.syllabusComplete) {
        findings.push({
          area: 'temario',
          severity: 'media',
          // Redacción MUY explícita: un modelo débil leía «tiene 14 unidades pero
          // falta confirmar» como «faltan las 14» y contestaba que no había nada.
          text: `el temario de ${subject.name} YA tiene ${subject.topics.length} unidades anotadas; solo falta que él confirme que no falta ninguna.`,
        });
      }

      const seen = new Map<string, number>();
      for (const topic of subject.topics) {
        const key = normalize(topic.title);
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      const repeated = [...seen.entries()].filter(([, count]) => count > 1);
      if (repeated.length > 0) {
        findings.push({
          area: 'temario',
          severity: 'media',
          text: `en ${subject.name} hay unidades repetidas (${repeated
            .slice(0, 3)
            .map(([title]) => `«${title}»`)
            .join(', ')}): sobran o están mal tituladas.`,
        });
      }

      const numbers = new Map<number, number>();
      let unnumbered = 0;
      for (const topic of subject.topics) {
        if (topic.unitNumber === null) unnumbered++;
        else numbers.set(topic.unitNumber, (numbers.get(topic.unitNumber) ?? 0) + 1);
      }
      if (unnumbered > 0) {
        findings.push({
          area: 'temario',
          severity: 'baja',
          text: `en ${subject.name} hay ${unnumbered} ${unnumbered === 1 ? 'unidad' : 'unidades'} sin número de orden.`,
        });
      }
      const clash = [...numbers.entries()].filter(([, count]) => count > 1);
      if (clash.length > 0) {
        findings.push({
          area: 'temario',
          severity: 'baja',
          text: `en ${subject.name} hay números de unidad repetidos (${clash
            .slice(0, 4)
            .map(([number]) => number)
            .join(', ')}).`,
        });
      }
    }
  }

  /* ----------------------------- Exámenes ---------------------------- */
  if (wants('examenes')) {
    for (const subject of subjects) {
      if (!subject.isTracked) continue;
      const future = subject.exams.filter((exam) => exam.examDate >= now);
      if (future.length === 0) {
        findings.push({
          area: 'examenes',
          severity: 'media',
          text: `${subject.name} no tiene ninguna fecha de examen por delante: sin fecha no hay cuenta atrás ni prioridades.`,
        });
      }

      const past = subject.exams.filter((exam) => exam.examDate < now && !exam.isCompleted);
      for (const exam of past) {
        findings.push({
          area: 'examenes',
          severity: 'alta',
          text: `el examen «${exam.title}» de ${subject.name} ya pasó (${isoDay(new Date(exam.examDate))}) y sigue abierto: o lo marcas como hecho o lo quitamos.`,
        });
      }

      const weight = future.reduce((total, exam) => total + Number(exam.weightPercent ?? 0), 0);
      if (weight > 100) {
        findings.push({
          area: 'examenes',
          severity: 'media',
          text: `los exámenes que quedan de ${subject.name} suman ${Math.round(weight)} % de la nota: los porcentajes no cuadran.`,
        });
      }
    }
  }

  /* ----------------------------- Resumen ----------------------------- */
  const order: Record<SetupAuditSeverity, number> = { alta: 0, media: 1, baja: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const scope = area === 'todo' ? 'todo el curso' : AREA_LABEL[area];
  const lines: string[] = [
    `AUDITORÍA REAL DEL SISTEMA (la acaba de ejecutar la app contra la base de datos; área: ${scope}). No la inventes: esto es lo que hay.`,
  ];

  if (findings.length === 0) {
    lines.push(
      'No he encontrado nada roto en lo que el sistema puede comprobar: horario, temario, exámenes y horas cuadran.'
    );
  } else {
    for (const finding of findings.slice(0, 12)) {
      lines.push(`- [${finding.severity}] ${AREA_LABEL[finding.area]}: ${finding.text}`);
    }
    if (findings.length > 12) lines.push(`- (y ${findings.length - 12} problemas más)`);
  }

  /**
   * El estado en números, también aquí.
   *
   * El prompt del coordinador es largo (estado + protocolo + conocimiento de la
   * app) y, cuando tiene que caber en un modelo con cupo por minuto, se recorta
   * por el medio: justo donde iba la lista de unidades. El modelo contestaba
   * «no hay ninguna unidad» —y hasta se inventaba materias— con el temario lleno.
   * Estos números van pegados a la auditoría, en el trozo que nunca se recorta.
   */
  const tracked = subjects.filter((subject) => subject.isTracked);
  if (tracked.length > 0) {
    lines.push('');
    lines.push('ESTADO EN NÚMEROS (real; si el texto de arriba dice otra cosa, manda esto):');
    for (const subject of tracked) {
      const upcoming = subject.exams.filter((exam) => exam.examDate >= now).length;
      lines.push(
        `- ${subject.name}: ${subject.topics.length} unidades YA anotadas · ${upcoming} ${
          upcoming === 1 ? 'examen con fecha' : 'exámenes con fecha'
        } · ${subject._count.classPeriods} clases/semana`
      );
    }
    if (tracked.length === 0) lines.push('- (ninguna materia que se estudie en la app)');
  }

  return { area, findings, summary: lines.join('\n') };
}
