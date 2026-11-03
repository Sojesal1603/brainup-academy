import { prisma } from '@/lib/prisma';
import {
  BarChart3,
  TrendingUp,
  Clock,
  PieChart,
  Target,
  AlertTriangle,
  Award,
} from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function StatsPage() {
  const user = await prisma.userProfile.findUnique({
    where: { id: 'user_default' },
  });

  const subjects = await prisma.subject.findMany({
    include: {
      topics: true,
      errorLogs: true,
    },
    orderBy: { order: 'asc' },
  });

  const sessions = await prisma.studySession.findMany({
    orderBy: { startedAt: 'asc' },
  });

  // 1. Horas por asignatura
  const totalHours = subjects.reduce((acc, s) => acc + s.totalHoursSpent, 0);

  // 2. Errores agrupados por causa
  const allErrors = await prisma.errorLog.findMany();
  const errorsByCause: Record<string, number> = {
    concepto: 0,
    calculo: 0,
    lectura_enunciado: 0,
    tiempo: 0,
    bloqueo: 0,
  };

  allErrors.forEach((e) => {
    if (errorsByCause[e.rootCause] !== undefined) {
      errorsByCause[e.rootCause]++;
    }
  });

  // 3. Estimación Oficial de Nota PAU sobre 14.0
  // La estimación se construye SOLO con datos reales:
  //   · la nota que has declarado en esa asignatura, o, si no la has declarado,
  //   · el nivel medio de las unidades que sí tienen nivel medido.
  // Si no hay ninguna de las dos cosas, la asignatura queda «sin datos» y la
  // proyección se muestra como provisional en vez de inventarse un 7,5.
  const estimatedSubjectGrades = subjects.map((sub) => {
    const measuredTopics = sub.topics.filter((topic) => topic.masterySource !== 'sin_medir');
    const declaredGrade = sub.gradeSource !== 'sin_medir' ? sub.currentGrade : null;

    const avgMastery =
      measuredTopics.length > 0
        ? measuredTopics.reduce((acc, topic) => acc + topic.masteryLevel, 0) / measuredTopics.length
        : null;

    const estimatedGrade =
      declaredGrade ?? (avgMastery === null ? null : Math.min(10, Math.max(0, (avgMastery / 100) * 10)));

    return {
      ...sub,
      measuredCount: measuredTopics.length,
      unmeasuredCount: sub.topics.length - measuredTopics.length,
      declaredGrade,
      estimatedGrade: estimatedGrade === null ? null : Math.round(estimatedGrade * 100) / 100,
    };
  });

  // Materias generales (fase obligatoria) con dato disponible
  const generalSubjects = estimatedSubjectGrades.filter(
    (s) => s.isPhaseGeneral && s.estimatedGrade !== null
  );
  const generalSubjectsTotal = estimatedSubjectGrades.filter((s) => s.isPhaseGeneral).length;
  const generalAvg =
    generalSubjects.length > 0
      ? generalSubjects.reduce((acc, s) => acc + (s.estimatedGrade as number), 0) / generalSubjects.length
      : null;

  // Expediente de Bachillerato: la media de las notas que has declarado; si no
  // hay ninguna, se mantiene el supuesto 8.5 pero se declara como supuesto.
  const declaredGrades = estimatedSubjectGrades
    .map((s) => s.declaredGrade)
    .filter((grade): grade is number => grade !== null);
  const bachExpediente =
    declaredGrades.length > 0
      ? Math.round((declaredGrades.reduce((acc, g) => acc + g, 0) / declaredGrades.length) * 100) / 100
      : 8.5;
  const bachExpedienteIsAssumed = declaredGrades.length === 0;

  const cau = generalAvg === null ? null : bachExpediente * 0.6 + generalAvg * 0.4; // Sobre 10

  // Materias específicas (fase voluntaria de subida de nota, ponderan 0.2)
  const specificSubjects = estimatedSubjectGrades
    .filter((s) => s.pauWeight > 0 && s.estimatedGrade !== null)
    .sort((a, b) => (b.estimatedGrade as number) - (a.estimatedGrade as number));

  const best1 = specificSubjects[0]?.estimatedGrade ?? 0;
  const best2 = specificSubjects[1]?.estimatedGrade ?? 0;
  const admissionPauBonus = best1 * 0.2 + best2 * 0.2; // Máximo 4.0 puntos

  const predictedFinalPauGrade =
    cau === null ? null : Math.min(14.0, Math.round((cau + admissionPauBonus) * 100) / 100);

  // Cobertura del cálculo: cuántas materias de fase general tienen dato real.
  const coverage = {
    withData: generalSubjects.length,
    total: generalSubjectsTotal,
    measuredUnits: estimatedSubjectGrades.reduce((acc, s) => acc + s.measuredCount, 0),
    totalUnits: estimatedSubjectGrades.reduce(
      (acc, s) => acc + s.measuredCount + s.unmeasuredCount,
      0
    ),
    declaredSubjects: declaredGrades.length,
    assumedExpediente: bachExpedienteIsAssumed,
  };

  return (
    <div className="space-y-8">
      {/* Cabecera */}
      <div className="pb-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-6 h-6 text-emerald-400" />
          <h1 className="text-2xl font-black tracking-tight text-slate-100 uppercase font-mono">
            Estadísticas & Simulador Predictivo PAU
          </h1>
        </div>
        <p className="text-xs text-slate-400 mt-1">
          Proyección sobre 14 puntos calculada <strong className="text-slate-300">solo con datos
          reales</strong>: tus notas declaradas, el nivel medido de cada unidad y los simulacros
          corregidos. Sin datos no hay proyección.
        </p>
      </div>

      {/* Tarjeta de Estimación Predictiva PAU (Base 14) */}
      <div className="p-6 rounded-3xl bg-gradient-to-br from-[#0c1626] via-[#131825] to-[#070d18] border border-emerald-500/40 shadow-2xl relative overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 relative z-10">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Award className="w-5 h-5 text-emerald-400" />
              <span className="text-xs font-mono font-bold uppercase tracking-widest text-emerald-400">
                Proyección Oficial Selectividad / PAU
              </span>
            </div>
            <h2 className="text-xl font-black text-slate-100">
              Nota Predictiva Actual
            </h2>
            <p className="text-xs text-slate-400 max-w-lg leading-relaxed">
              Cálculo ponderado oficial: 60% Expediente Bachillerato (
              {bachExpediente.toFixed(2)}
              {coverage.assumedExpediente ? ', supuesto: declara tus notas para afinarlo' : ', media de tus notas declaradas'}) + 40% Fase
              General ({generalAvg === null ? 'sin datos' : generalAvg.toFixed(2)}) + Fase Específica (las
              dos mejores ponderaciones de 0.2).
            </p>
            <p className="text-[11px] text-slate-500">
              Materias de fase general con dato real: {coverage.withData}/{coverage.total} ·
              unidades con nivel medido: {coverage.measuredUnits}/{coverage.totalUnits} ·
              notas declaradas: {coverage.declaredSubjects}
            </p>
          </div>

          <div className="flex items-center gap-6 shrink-0 bg-[#060a13]/80 p-4 rounded-2xl border border-slate-800">
            <div className="text-center font-mono">
              {predictedFinalPauGrade === null ? (
                <>
                  <span className="text-4xl sm:text-5xl font-black text-slate-500">—</span>
                  <p className="text-[10px] text-slate-500 uppercase mt-1">sin datos aún</p>
                </>
              ) : (
                <>
                  <span className="text-4xl sm:text-5xl font-black text-emerald-400 drop-shadow-[0_0_20px_rgba(16,185,129,0.3)]">
                    {predictedFinalPauGrade.toFixed(2)}
                  </span>
                  <p className="text-[10px] text-slate-500 uppercase mt-1">sobre 14.000</p>
                </>
              )}
            </div>

            <div className="h-12 w-[1px] bg-slate-800" />

            <div className="space-y-1 text-xs">
              <p className="text-slate-400">
                Nota Objetivo:{' '}
                <strong className="text-slate-200 font-mono">
                  {user?.targetGradePau.toFixed(2)}
                </strong>
              </p>
              {predictedFinalPauGrade === null ? (
                <p className="font-semibold text-slate-400">
                  Declara tus notas en Ajustes o autoevalúa unidades en el Temario para calcularla.
                </p>
              ) : (
                <p
                  className={`font-semibold font-mono ${
                    predictedFinalPauGrade >= (user?.targetGradePau || 13.5)
                      ? 'text-emerald-400'
                      : 'text-amber-400'
                  }`}
                >
                  {predictedFinalPauGrade >= (user?.targetGradePau || 13.5)
                    ? '✓ Por encima de la meta'
                    : `Déficit: ${(Number(user?.targetGradePau) - predictedFinalPauGrade).toFixed(2)} pts`}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Grid: Horas por Asignatura & Diagnóstico de Errores */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Horas Invertidas por Materia */}
        <div className="p-6 rounded-2xl glass-card space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200 flex items-center gap-2">
              <Clock className="w-4 h-4 text-blue-400" />
              <span>Horas Dedicadas por Materia</span>
            </h3>
            <span className="text-xs text-slate-400 font-mono">
              Total: {totalHours.toFixed(1)}h
            </span>
          </div>

          <div className="space-y-3">
            {subjects.map((sub) => {
              const pct = totalHours ? (sub.totalHoursSpent / totalHours) * 100 : 0;
              return (
                <div key={sub.id} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="font-semibold text-slate-200">{sub.name}</span>
                    <span className="font-mono text-slate-400">
                      {sub.totalHoursSpent.toFixed(1)}h ({pct.toFixed(0)}%)
                    </span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: sub.color,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Anatomía de Errores por Causa Raíz */}
        <div className="p-6 rounded-2xl glass-card space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200 flex items-center gap-2">
              <PieChart className="w-4 h-4 text-rose-400" />
              <span>Análisis Causal de Errores</span>
            </h3>
            <span className="text-xs text-slate-400 font-mono">
              {allErrors.length} errores
            </span>
          </div>

          <p className="text-xs text-slate-400">
            Descubre dónde pierdes puntos: ¿lagunas teóricas o despistes de cálculo?
          </p>

          <div className="space-y-3 pt-2">
            {[
              { key: 'concepto', label: 'Fallo Conceptual', color: '#f43f5e' },
              { key: 'calculo', label: 'Error de Cálculo / Signos', color: '#f59e0b' },
              { key: 'lectura_enunciado', label: 'Comprensión de Enunciado', color: '#3b82f6' },
              { key: 'tiempo', label: 'Falta de Tiempo', color: '#fb923c' },
              { key: 'bloqueo', label: 'Bloqueo / Ansiedad', color: '#a855f7' },
            ].map((c) => {
              const count = errorsByCause[c.key] || 0;
              const pct = allErrors.length ? (count / allErrors.length) * 100 : 0;
              return (
                <div key={c.key} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="font-semibold text-slate-200">{c.label}</span>
                    <span className="font-mono text-slate-400">
                      {count} ({pct.toFixed(0)}%)
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: c.color,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
