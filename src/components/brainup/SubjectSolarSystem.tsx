import Link from 'next/link';
import type { CSSProperties } from 'react';

export interface SolarSubject {
  id: string;
  agentName: string;
  subjectName: string;
  color: string;
  href: string;
  examDays: number | null;
}

/** Iniciales de la materia: «Matemáticas II» → «MII». */
function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '·';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words
    .slice(0, 3)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
}

function Planet({ subject, size }: { subject: SolarSubject; size: 'lg' | 'sm' }) {
  const urgent = subject.examDays !== null && subject.examDays <= 14;
  return (
    <Link
      href={subject.href}
      style={{ '--glow': subject.color } as CSSProperties}
      className="group flex flex-col items-center text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 rounded-2xl"
    >
      <span
        className={`relative flex shrink-0 items-center justify-center rounded-full border-2 font-mono font-black tracking-tight transition-transform duration-300 group-hover:scale-110 ${
          size === 'lg' ? 'h-16 w-16 text-sm' : 'h-14 w-14 text-xs'
        }`}
        style={{
          background: `radial-gradient(circle at 32% 26%, ${subject.color}55, #0a0a0c 76%)`,
          borderColor: `${subject.color}99`,
          boxShadow: `0 0 24px ${subject.color}44, inset 0 0 14px ${subject.color}22`,
          color: subject.color,
        }}
        aria-hidden="true"
      >
        <span
          className="pointer-events-none absolute -inset-1 rounded-full opacity-0 blur-md transition-opacity duration-300 group-hover:opacity-70"
          style={{ backgroundColor: `${subject.color}44` }}
        />
        <span className="relative">{initials(subject.subjectName)}</span>
        {urgent && (
          <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.9)]" />
        )}
      </span>
      <span className="mt-2 max-w-[7.5rem] text-[11px] font-semibold leading-tight text-slate-300 group-hover:text-slate-100">
        {subject.subjectName}
      </span>
      <span className="text-[10px] text-slate-500">
        {subject.examDays === null
          ? 'sin examen'
          : subject.examDays === 0
            ? 'examen hoy'
            : `examen en ${subject.examDays} d`}
      </span>
    </Link>
  );
}

/**
 * El Sistema Solar de Asignaturas: cada materia es un planeta con su color y su
 * tutor. En escritorio y tablet se dibuja la órbita completa; en móvil, la misma
 * información en una fila táctil que se desliza (nada de planetas de 20 px).
 */
export default function SubjectSolarSystem({ subjects }: { subjects: SolarSubject[] }) {
  if (subjects.length === 0) return null;

  return (
    <section
      aria-labelledby="sistema-solar"
      className="glass-card relative overflow-hidden p-5 sm:p-7"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2
            id="sistema-solar"
            className="text-sm font-bold uppercase tracking-wider text-slate-100"
          >
            Sistema Solar de Asignaturas
          </h2>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Cada mundo es una materia con su catedrático. El punto rojo avisa de un examen en menos
            de dos semanas.
          </p>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
          {subjects.length} {subjects.length === 1 ? 'mundo' : 'mundos'}
        </span>
      </div>

      {/* Órbita de escritorio y tablet */}
      <div className="relative mx-auto mt-4 hidden h-[400px] max-w-[700px] md:block">
        <div
          aria-hidden="true"
          className="absolute inset-x-10 inset-y-6 rounded-[50%] border border-white/[0.05]"
        />
        <div
          aria-hidden="true"
          className="absolute inset-x-24 inset-y-16 rounded-[50%] border border-white/[0.04]"
        />

        {/* El sol: el curso, no una materia. */}
        <div className="absolute left-1/2 top-1/2 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full border border-emerald-400/40 bg-emerald-500/10 text-emerald-300 shadow-[0_0_45px_rgba(16,185,129,0.25)]">
          <span className="font-mono text-[10px] font-bold uppercase tracking-widest">Curso</span>
          <span className="text-[9px] text-emerald-400/80">PAU</span>
        </div>

        {subjects.map((subject, index) => {
          // Reparto sobre una elipse: dos anillos alternos para que no se
          // amontonen los planetas cuando hay muchas materias.
          const angle = (index / subjects.length) * Math.PI * 2 - Math.PI / 2;
          const ring = index % 2 === 0 ? 1 : 0.72;
          const left = 50 + Math.cos(angle) * 44 * ring;
          const top = 50 + Math.sin(angle) * 38 * ring;

          return (
            <div
              key={subject.id}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${left}%`, top: `${top}%` }}
            >
              <Planet subject={subject} size="lg" />
            </div>
          );
        })}
      </div>

      {/* Fila táctil para móvil */}
      <div className="mt-4 flex snap-x gap-3 overflow-x-auto pb-2 md:hidden">
        {subjects.map((subject) => (
          <div key={subject.id} className="w-[7.5rem] shrink-0 snap-start">
            <Planet subject={subject} size="sm" />
          </div>
        ))}
      </div>
    </section>
  );
}
