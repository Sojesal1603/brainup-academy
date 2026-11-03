import { prisma } from '@/lib/prisma';
import CreateExamModal from '@/components/examenes/CreateExamModal';
import ExamControls from '@/components/examenes/ExamControls';
import {
  GraduationCap,
  Calendar,
  AlertTriangle,
  FileCheck2,
  CheckCircle2,
  Percent,
} from 'lucide-react';
import Link from 'next/link';

/** La fecha del examen en `AAAA-MM-DD` local (la que enseña y edita el gestor). */
function isoDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const dynamic = 'force-dynamic';

export default async function ExamsPage() {
  const subjects = await prisma.subject.findMany({
    select: { id: true, name: true },
    orderBy: { order: 'asc' },
  });

  const exams = await prisma.exam.findMany({
    include: {
      subject: {
        include: {
          // Todas las unidades: el filtro de relevancia se hace en JS para
          // distinguir lo medido de lo que nadie ha medido todavía.
          topics: { orderBy: { unitNumber: 'asc' } },
        },
      },
      pauSessions: true,
    },
    orderBy: { examDate: 'asc' },
  });

  const now = Date.now();

  return (
    <div className="space-y-8">
      {/* Cabecera */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-white/10">
        <div>
          <div className="flex items-center gap-2">
            <GraduationCap className="w-6 h-6 text-amber-400" />
            <h1 className="text-2xl font-black tracking-tight text-slate-100 uppercase font-mono">
              Gestor de Exámenes y PAU
            </h1>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Control de convocatorias, cálculo de urgencia temporal e identificación de temas críticos.
          </p>
        </div>

        <CreateExamModal subjects={subjects} />
      </div>

      {/* Listado de Exámenes */}
      <div className="space-y-4">
        {exams.length === 0 && (
          <div className="rounded-2xl border border-dashed border-slate-800 bg-[#0a0f1d]/50 p-8 text-center">
            <GraduationCap className="mx-auto mb-2 h-8 w-8 text-slate-600" />
            <p className="text-sm font-semibold text-slate-300">Sin exámenes apuntados</p>
            <p className="mx-auto mt-1 max-w-xl text-xs text-slate-500">
              Aquí no se inventa ninguna fecha: las que ves son las que has apuntado tú (o las que
              le has dicho al coordinador en la puesta a punto). Añade los tuyos con el botón de
              arriba o pídeselo al coordinador, que te los pregunta uno a uno.
            </p>
            <Link
              href="/puesta-a-punto"
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold text-slate-950 transition-all hover:bg-emerald-400"
            >
              Decírselo al coordinador
            </Link>
          </div>
        )}

        {exams.map((exam) => {
          const diffMs = new Date(exam.examDate).getTime() - now;
          const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
          const isUrgent = daysLeft <= 7;
          const isWarning = daysLeft > 7 && daysLeft <= 15;

          return (
            <div
              key={exam.id}
              className={`p-5 rounded-2xl border transition-all ${
                isUrgent
                  ? 'bg-[#150e18] border-rose-500/40 shadow-[0_0_20px_rgba(244,63,94,0.08)]'
                  : isWarning
                  ? 'bg-[#16121a] border-amber-500/40'
                  : 'glass-card border-white/10'
              }`}
            >
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                {/* Info Principal */}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="text-xs font-bold px-2 py-0.5 rounded border"
                      style={{
                        backgroundColor: `${exam.subject.color}15`,
                        borderColor: `${exam.subject.color}40`,
                        color: exam.subject.color,
                      }}
                    >
                      {exam.subject.name}
                    </span>

                    {exam.subject.pauWeight > 0 && (
                      <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-mono font-bold border border-emerald-500/20">
                        PAU Ponderación x{exam.subject.pauWeight}
                      </span>
                    )}

                    <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono uppercase">
                      {exam.examType.replace('_', ' ')}
                      {' · '}
                      {exam.examFormat === 'desarrollo'
                        ? 'Desarrollo'
                        : exam.examFormat === 'practico'
                          ? 'Práctico'
                          : 'Test'}
                    </span>
                  </div>

                  <h3 className="text-base font-bold text-slate-100">{exam.title}</h3>

                  {exam.notes && (
                    <p className="text-xs text-slate-400 max-w-2xl">{exam.notes}</p>
                  )}
                </div>

                {/* Métricas e Indicador de Urgencia */}
                <div className="flex flex-wrap items-center gap-4 lg:gap-6 shrink-0 border-t lg:border-t-0 pt-3 lg:pt-0 border-slate-800">
                  {/* Fecha */}
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-slate-500" />
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase font-semibold">
                        Fecha
                      </p>
                      <p className="text-xs font-medium text-slate-200">
                        {new Date(exam.examDate).toLocaleDateString('es-ES', {
                          weekday: 'short',
                          day: 'numeric',
                          month: 'short',
                        })}
                      </p>
                    </div>
                  </div>

                  {/* Peso */}
                  <div className="flex items-center gap-2">
                    <Percent className="w-4 h-4 text-slate-500" />
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase font-semibold">
                        Peso
                      </p>
                      <p className="text-xs font-mono font-medium text-slate-200">
                        {exam.weightPercent}%
                      </p>
                    </div>
                  </div>

                  {/* Nota Objetivo */}
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase font-semibold">
                      Meta
                    </p>
                    <p className="text-xs font-mono font-bold text-emerald-400">
                      {exam.targetGrade.toFixed(1)}/10
                    </p>
                  </div>

                  {/* Cuenta Atrás */}
                  <div className="px-3 py-1.5 rounded-xl bg-[#0a0a0c] border border-slate-800 text-center font-mono">
                    <span
                      className={`text-lg font-black ${
                        isUrgent
                          ? 'text-rose-400'
                          : isWarning
                          ? 'text-amber-400'
                          : 'text-emerald-400'
                      }`}
                    >
                      {daysLeft < 0 ? 'Pasado' : `${daysLeft}d`}
                    </span>
                    <p className="text-[9px] text-slate-500">
                      {daysLeft < 0 ? 'Concluido' : 'restantes'}
                    </p>
                  </div>

                  {/* Acceso a Simulacro / Examinador */}
                  <Link
                    href={`/examinador?subjectId=${exam.subjectId}&examId=${exam.id}`}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition-all border border-slate-700 hover:scale-105"
                  >
                    <FileCheck2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Lanzar Simulacro</span>
                  </Link>

                  {/* Corregir: mover la fecha, darlo por hecho o quitarlo */}
                  <ExamControls
                    examId={exam.id}
                    examDate={isoDay(new Date(exam.examDate))}
                    isCompleted={exam.isCompleted}
                  />
                </div>
              </div>

              {/* Temas Críticos de esta materia que debes vigilar */}
              <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 text-slate-400">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                  <span className="text-[11px] font-semibold text-slate-300">
                    Puntos de atención en {exam.subject.name}:
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {[...exam.subject.topics]
                    .sort(
                      (a, b) =>
                        // Primero lo medido (y cuanto más flojo, antes); lo que
                        // nadie ha medido no es un punto débil, es una incógnita.
                        (a.masterySource === 'sin_medir' ? 1 : 0) -
                          (b.masterySource === 'sin_medir' ? 1 : 0) ||
                        a.masteryLevel - b.masteryLevel
                    )
                    .slice(0, 3)
                    .map((t) => (
                      <span
                        key={t.id}
                        className="px-2 py-0.5 rounded bg-[#0a0a0c] border border-slate-800 text-[11px] text-slate-300 flex items-center gap-1.5"
                      >
                        <span className="truncate max-w-[150px]">{t.title}</span>
                        <span
                          className={`font-mono font-bold ${
                            t.masterySource === 'sin_medir'
                              ? 'text-slate-500'
                              : t.masteryLevel < 50
                                ? 'text-rose-400'
                                : 'text-emerald-400'
                          }`}
                        >
                          {t.masterySource === 'sin_medir' ? 'sin medir' : `${t.masteryLevel}%`}
                        </span>
                      </span>
                    ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
