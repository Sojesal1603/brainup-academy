import type { CSSProperties } from 'react';
import { currentTenant } from '@/lib/tenantContext';
import { agentSlug } from '@/lib/agentSlug';
import {
  Sparkles,
  Brain,
  GraduationCap,
  ArrowRight,
  ShieldAlert,
  Sigma,
  Landmark,
  Languages,
  Atom,
  FlaskConical,
  Dna,
  TrendingUp,
  BookOpen,
  Scale,
  Globe,
  Music,
  Palette,
  Cpu,
} from 'lucide-react';
import clsx from 'clsx';
import Link from 'next/link';
import SubjectSolarSystem from '@/components/brainup/SubjectSolarSystem';

export const dynamic = 'force-dynamic';

/**
 * Avatar propio de cada materia: dos catedráticos solo comparten icono si son la
 * misma asignatura. Se busca por palabra clave del nombre (el temario se importa
 * con el nombre del profesor, así que no hay una lista cerrada) y, si no encaja
 * ninguna, queda el birrete genérico.
 */
function subjectIcon(name: string) {
  const n = name.toLowerCase();
  if (/matem|álgebr|algebr|cálculo|calculo/.test(n)) return Sigma;
  if (/físic|fisica/.test(n)) return Atom;
  if (/químic|quimic/.test(n)) return FlaskConical;
  if (/biolog/.test(n)) return Dna;
  if (/filosof|ética|etica/.test(n)) return Scale;
  if (/historia/.test(n)) return Landmark;
  if (/inglés|ingles|idioma/.test(n)) return Languages;
  if (/lengua|literat|comentario/.test(n)) return BookOpen;
  if (/econom|empresa/.test(n)) return TrendingUp;
  if (/geograf/.test(n)) return Globe;
  if (/músic|music/.test(n)) return Music;
  if (/arte|dibujo|plástic|plastic/.test(n)) return Palette;
  if (/tic|tecnolog|informát|informat/.test(n)) return Cpu;
  return GraduationCap;
}

/**
 * Hub de catedráticos: una tarjeta de cristal por materia, con el avatar teñido
 * del color de la asignatura y un badge que dice en qué punto está el temario
 * («En curso», «Examen en 4 d»…). El badge no es decorativo: sale del estado
 * real de las unidades y de la fecha del próximo examen.
 */
export default async function BrainUpHubPage() {
  const { tenant: prisma } = await currentTenant();
  const agents = await prisma.aiAgent.findMany({
    include: {
      subject: {
        include: {
          errorLogs: { where: { isMastered: false } },
          // Solo lo justo para el badge: estado de las unidades y próximo examen.
          topics: { select: { status: true }, take: 200 },
          exams: {
            where: { isCompleted: false, examDate: { gte: new Date() } },
            orderBy: { examDate: 'asc' },
            take: 1,
            select: { title: true, examDate: true },
          },
        },
      },
    },
    orderBy: { subject: { order: 'asc' } },
  });

  const now = Date.now();

  return (
    <div className="space-y-8">
      {/* Cabecera */}
      <div className="pb-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Sparkles className="w-6 h-6 text-emerald-400" />
          <h1 className="text-2xl font-black tracking-tight text-slate-100 uppercase font-mono">
            BrainUp: Tutores & Catedráticos IA
          </h1>
        </div>
        <p className="text-xs text-slate-400 mt-1">
          Especialistas de élite por materia. Método socrático riguroso: diagnóstico previo, pistas
          escalonadas y rúbrica oficial PAU.
        </p>
      </div>

      {/* Tarjeta de Regla de Oro Socrática */}
      <div className="card-glass fade-up flex items-start gap-4 rounded-2xl p-5 border-emerald-500/25">
        <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
          <Brain className="w-5 h-5" />
        </div>
        <div className="space-y-1">
          <h3 className="text-sm font-bold text-slate-100">Protocolo de Tutoría BrainUp</h3>
          <p className="text-xs text-slate-300 leading-relaxed">
            Nuestros tutores <strong>no resuelven el ejercicio por ti</strong>. Primero te harán
            preguntas de diagnóstico para detectar tu fallo conceptual, te darán una pista
            estratégica y solo te permitirán avanzar cuando justifiques tu razonamiento.
          </p>
        </div>
      </div>

      {/* Sistema solar de materias: la vista de mundos antes del listado. */}
      <SubjectSolarSystem
        subjects={agents.map((agent) => ({
          id: agent.id,
          agentName: agent.name,
          subjectName: agent.subject.name,
          color: agent.subject.color,
          href: `/brainup/${agentSlug(agent.subject.name)}`,
          examDays: agent.subject.exams[0]
            ? Math.max(
                0,
                Math.round((agent.subject.exams[0].examDate.getTime() - now) / 86400000)
              )
            : null,
        }))}
      />

      {/* Grid de Catedráticos por Asignatura */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {agents.map((agent) => {
          const unmasteredErrors = agent.subject.errorLogs.length;
          const color = agent.subject.color;
          const nextExam = agent.subject.exams[0] ?? null;
          const examDays = nextExam
            ? Math.max(0, Math.round((nextExam.examDate.getTime() - now) / 86400000))
            : null;
          const inCourse = agent.subject.topics.some((topic) => topic.status === 'en_curso');
          const AvatarIcon = subjectIcon(agent.subject.name);

          // Badge superior: primero el examen cercano (es lo que cambia el plan),
          // después lo que se está dando en clase y, si no, el temario al día.
          const badge =
            examDays !== null && examDays <= 14
              ? {
                  label: examDays === 0 ? 'Examen hoy' : `Examen en ${examDays} d`,
                  className: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
                }
              : inCourse
                ? {
                    label: 'En curso',
                    className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
                  }
                : {
                    label: 'Temario al día',
                    className: 'border-slate-600/60 bg-slate-700/30 text-slate-300',
                  };

          return (
            <article
              key={agent.id}
              // El hover ilumina con el color EXACTO de la materia: la tarjeta
              // publica ese color como `--glow` y el CSS hace el resto.
              style={{ '--glow': color } as CSSProperties}
              className="glass-card glow-subject fade-up hover-lift flex flex-col justify-between gap-4 p-5"
            >
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  {/* Avatar con halo del color de la materia */}
                  <div className="relative shrink-0">
                    <span
                      className="absolute -inset-1 rounded-2xl opacity-60 blur-md"
                      style={{ backgroundColor: `${color}44` }}
                      aria-hidden
                    />
                    <div
                      className="relative flex h-12 w-12 items-center justify-center rounded-2xl border-2"
                      style={{
                        background: `radial-gradient(circle at 30% 20%, ${color}33, #0a0a0c 78%)`,
                        borderColor: `${color}80`,
                        boxShadow: `0 0 18px ${color}40, inset 0 0 12px ${color}22`,
                        color,
                      }}
                    >
                      <AvatarIcon className="h-6 w-6" />
                    </div>
                  </div>

                  <span
                    className={clsx(
                      'shrink-0 rounded-full border px-2.5 py-0.5 text-[9px] font-bold font-mono uppercase tracking-wider',
                      badge.className
                    )}
                  >
                    {badge.label}
                  </span>
                </div>

                <div>
                  <h3 className="text-base font-bold text-slate-100">{agent.name}</h3>
                  <p className="mt-1 text-xs text-slate-400 line-clamp-2">{agent.specialty}</p>
                  <span
                    className="mt-2 inline-block rounded border px-2 py-0.5 text-[10px] font-bold"
                    style={{
                      backgroundColor: `${color}15`,
                      borderColor: `${color}40`,
                      color,
                    }}
                  >
                    {agent.subject.name}
                  </span>
                </div>

                {unmasteredErrors > 0 && (
                  <div className="flex items-center gap-2 p-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs">
                    <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
                    <span>{unmasteredErrors} errores pendientes en el banco</span>
                  </div>
                )}
              </div>

              <div className="pt-3 border-t border-white/10">
                <Link
                  href={`/brainup/${agentSlug(agent.subject.name)}`}
                  className="group flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-3 py-2.5 text-xs font-bold text-white shadow-lg shadow-purple-950/40 transition-all hover:from-blue-500 hover:to-purple-500 hover:shadow-purple-600/30 hover:scale-[1.02]"
                >
                  <span>Consultar Catedrático</span>
                  <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
