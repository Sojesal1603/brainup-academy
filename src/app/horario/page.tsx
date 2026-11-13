import { currentTenant } from '@/lib/tenantContext';
import { getCurrentUnitBySubject } from '@/lib/temario';
import { CalendarClock, Clock, MapPin, School } from 'lucide-react';

export const dynamic = 'force-dynamic';

const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];

function toMinutes(hhmm: string): number {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
}

function nextSchoolDayIndex(date: Date): number {
  const day = date.getDay(); // 0=Domingo ... 6=Sábado
  for (let offset = 1; offset <= 7; offset++) {
    const candidate = (day + offset) % 7;
    if (candidate >= 1 && candidate <= 5) return candidate;
  }
  return 1;
}

export default async function SchedulePage() {
  const { user, tenant: prisma } = await currentTenant();
  const periods = await prisma.classPeriod.findMany({
    include: { subject: { select: { name: true, color: true } } },
    orderBy: [{ dayOfWeek: 'asc' }, { period: 'asc' }],
  });

  // Temario: en qué unidad va cada asignatura, para leer el horario con contexto.
  const temarioBySubject = await getCurrentUnitBySubject(user.id);
  const unitLabel = (subjectId: string): string | null => {
    const entry = temarioBySubject.get(subjectId);
    const unit = entry?.current ?? entry?.next ?? null;
    if (!unit) return null;
    return `${unit.unitNumber ? `U${unit.unitNumber} · ` : ''}${unit.title}`;
  };

  // Franjas horarias únicas (1ª..6ª hora)
  const timeSlots = new Map<number, { start: string; end: string }>();
  for (const p of periods) {
    if (!timeSlots.has(p.period)) {
      timeSlots.set(p.period, { start: p.startTime, end: p.endTime });
    }
  }
  const sortedSlots = [...timeSlots.entries()].sort((a, b) => a[0] - b[0]);

  // Acceso rápido día-hora -> clase
  const grid = new Map<string, (typeof periods)[number]>();
  for (const p of periods) {
    grid.set(`${p.dayOfWeek}-${p.period}`, p);
  }

  // Estado temporal
  const now = new Date();
  const jsDay = now.getDay();
  const isSchoolDay = jsDay >= 1 && jsDay <= 5;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const todayClasses = periods.filter((p) => p.dayOfWeek === jsDay);
  const currentClass = todayClasses.find(
    (p) => nowMinutes >= toMinutes(p.startTime) && nowMinutes < toMinutes(p.endTime)
  );
  const nextToday = todayClasses.find((p) => toMinutes(p.startTime) > nowMinutes);

  const nextDay = nextSchoolDayIndex(now);
  const nextDayClasses = periods.filter((p) => p.dayOfWeek === nextDay);

  // Carga semanal por asignatura (minutos lectivos)
  const weeklyLoad = new Map<string, { color: string; minutes: number; unit: string | null }>();
  for (const p of periods) {
    const duration = toMinutes(p.endTime) - toMinutes(p.startTime);
    const entry = weeklyLoad.get(p.subject.name);
    if (entry) {
      entry.minutes += duration;
    } else {
      weeklyLoad.set(p.subject.name, {
        color: p.subject.color,
        minutes: duration,
        unit: unitLabel(p.subjectId),
      });
    }
  }
  const weeklyRanking = [...weeklyLoad.entries()].sort(
    (a, b) => b[1].minutes - a[1].minutes
  );
  const maxWeeklyMinutes = weeklyRanking[0]?.[1].minutes ?? 1;

  return (
    <div className="space-y-8">
      {/* Cabecera */}
      <div className="pb-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <CalendarClock className="w-6 h-6 text-emerald-400" />
          <h1 className="text-2xl font-black tracking-tight text-slate-100 uppercase font-mono">
            Horario Escolar
          </h1>
        </div>
        <p className="text-xs text-slate-400 mt-1">
          Tu cuadrícula lectiva real de Lunes a Viernes. El planificador prioriza las asignaturas
          que tienes al día siguiente.
        </p>
      </div>

      {/* Tarjetas de estado */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Ahora */}
        <div className="p-5 rounded-2xl glass-card space-y-2">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-emerald-400 font-mono">
            <Clock className="w-3.5 h-3.5" />
            Ahora {currentClass && <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
          </div>
          {currentClass ? (
            <>
              <p className="text-sm font-bold text-slate-100">{currentClass.subject.name}</p>
              <p className="text-[11px] text-slate-400 font-mono">
                {currentClass.startTime}–{currentClass.endTime}
                {currentClass.classroom ? ` · ${currentClass.classroom}` : ''}
              </p>
              {unitLabel(currentClass.subjectId) && (
                <p className="text-[11px] text-emerald-300/90">
                  Unidad en curso: {unitLabel(currentClass.subjectId)}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-sm font-bold text-slate-300">
                {isSchoolDay
                  ? nextToday
                    ? 'Sin clase en este momento'
                    : 'Clases terminadas por hoy'
                  : 'Fin de semana'}
              </p>
              {isSchoolDay && nextToday && (
                <p className="text-[11px] text-slate-400 font-mono">
                  Siguiente: {nextToday.subject.name} a las {nextToday.startTime}
                  {nextToday.classroom ? ` · ${nextToday.classroom}` : ''}
                </p>
              )}
            </>
          )}
        </div>

        {/* Hoy */}
        <div className="p-5 rounded-2xl glass-card space-y-2">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-blue-400 font-mono">
            <School className="w-3.5 h-3.5" />
            {isSchoolDay ? `Hoy · ${DAY_NAMES[jsDay - 1]}` : 'Hoy'}
          </div>
          {isSchoolDay ? (
            todayClasses.length > 0 ? (
              <>
                <p className="text-sm font-bold text-slate-100">
                  {todayClasses.length} {todayClasses.length === 1 ? 'clase' : 'clases'}
                  <span className="text-slate-400 font-normal">
                    {' '}
                    · {todayClasses[0].startTime}–{todayClasses[todayClasses.length - 1].endTime}
                  </span>
                </p>
                <p className="text-[11px] text-slate-400">
                  Terminas con {todayClasses[todayClasses.length - 1].subject.name}.
                </p>
              </>
            ) : (
              <p className="text-sm font-bold text-slate-300">Sin clases programadas</p>
            )
          ) : (
            <p className="text-sm font-bold text-slate-300">Hoy no hay clases 🎉</p>
          )}
        </div>

        {/* Próximo día lectivo */}
        <div className="p-5 rounded-2xl glass-card space-y-2">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-violet-400 font-mono">
            <MapPin className="w-3.5 h-3.5" />
            Próximo día lectivo · {DAY_NAMES[nextDay - 1]}
          </div>
          {nextDayClasses.length > 0 ? (
            <>
              <p className="text-sm font-bold text-slate-100">
                Empiezas con {nextDayClasses[0].subject.name}
                <span className="text-slate-400 font-normal font-mono"> a las {nextDayClasses[0].startTime}</span>
              </p>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                {nextDayClasses
                  .slice(0, 4)
                  .map((c) => c.subject.name)
                  .join(' · ')}
                {nextDayClasses.length > 4 ? ` · +${nextDayClasses.length - 4}` : ''}
              </p>
            </>
          ) : (
            <p className="text-sm font-bold text-slate-300">Día sin clases programadas</p>
          )}
        </div>
      </div>

      {/* Cuadrícula semanal */}
      <div className="rounded-2xl bg-[#0b101c] border border-white/10 p-5 sm:p-6 space-y-4">
        <h2 className="text-xs font-black uppercase tracking-widest text-slate-300 font-mono">
          Cuadrícula semanal
        </h2>

        {sortedSlots.length === 0 ? (
          <p className="text-xs text-slate-500 italic">
            No hay horario registrado. Añade franjas lectivas para verlas aquí.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-separate border-spacing-1.5">
              <thead>
                <tr>
                  <th className="w-24 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500 pl-1">
                    Hora
                  </th>
                  {DAY_NAMES.map((name, idx) => {
                    const dayNumber = idx + 1;
                    const isToday = isSchoolDay && jsDay === dayNumber;
                    return (
                      <th
                        key={name}
                        className={`rounded-lg px-3 py-2 text-center text-[11px] font-bold uppercase tracking-wider ${
                          isToday
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
                            : 'text-slate-400'
                        }`}
                      >
                        {name}
                        {isToday && (
                          <span className="ml-1.5 text-[9px] font-mono bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded">
                            HOY
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sortedSlots.map(([periodNumber, slot]) => (
                  <tr key={periodNumber}>
                    <td className="pl-1 pr-2 align-middle">
                      <p className="text-[11px] font-bold text-slate-300 font-mono">{periodNumber}ª</p>
                      <p className="text-[9px] text-slate-500 font-mono">
                        {slot.start}
                        <br />
                        {slot.end}
                      </p>
                    </td>
                    {DAY_NAMES.map((_, idx) => {
                      const dayNumber = idx + 1;
                      const entry = grid.get(`${dayNumber}-${periodNumber}`);
                      const isToday = isSchoolDay && jsDay === dayNumber;

                      if (!entry) {
                        return (
                          <td key={`${dayNumber}-${periodNumber}`} className="align-top">
                            <div
                              className={`h-full min-h-[52px] rounded-lg border border-dashed ${
                                isToday ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-slate-800/70'
                              }`}
                            />
                          </td>
                        );
                      }

                      return (
                        <td key={`${dayNumber}-${periodNumber}`} className="align-top">
                          <div
                            className={`rounded-lg border px-3 py-2 space-y-0.5 h-full min-h-[52px] ${
                              isToday ? 'ring-1 ring-emerald-500/30' : ''
                            }`}
                            style={{
                              backgroundColor: `${entry.subject.color}14`,
                              borderColor: `${entry.subject.color}55`,
                            }}
                          >
                            <p
                              className="text-[11px] font-bold leading-snug"
                              style={{ color: entry.subject.color }}
                            >
                              {entry.subject.name}
                            </p>
                            {unitLabel(entry.subjectId) && (
                              <p
                                className="text-[9px] leading-snug"
                                style={{ color: `${entry.subject.color}cc` }}
                                title="Unidad del temario en la que va esta asignatura"
                              >
                                {unitLabel(entry.subjectId)}
                              </p>
                            )}
                            {entry.classroom && (
                              <p className="text-[9px] text-slate-400 font-mono">{entry.classroom}</p>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Carga semanal por asignatura */}
      {weeklyRanking.length > 0 && (
        <div className="rounded-2xl bg-[#0b101c] border border-white/10 p-5 sm:p-6 space-y-4">
          <h2 className="text-xs font-black uppercase tracking-widest text-slate-300 font-mono">
            Carga lectiva semanal
          </h2>
          <div className="space-y-3">
            {weeklyRanking.map(([name, data]) => (
              <div key={name} className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold text-slate-200">{name}</span>
                  <span className="text-[10px] font-mono text-slate-400">
                    {(data.minutes / 60).toFixed(1)} h/semana
                  </span>
                </div>
                {data.unit && (
                  <p className="text-[10px] text-slate-500 truncate">En curso: {data.unit}</p>
                )}
                <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(5, (data.minutes / maxWeeklyMinutes) * 100)}%`,
                      backgroundColor: data.color,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
