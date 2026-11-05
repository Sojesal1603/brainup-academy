import nextDynamic from 'next/dynamic';
import { BookOpenCheck, CalendarClock, Layers } from 'lucide-react';
import { BoardSkeleton, PanelSkeleton } from '@/components/ui/Skeletons';
import { getTemarioSubjects } from '@/lib/temario';

// Tablero e importador solo se descargan si se entra al temario, y cada uno
// con su propio esqueleto: el resumen de arriba ya se lee mientras llegan.
const TemarioBoard = nextDynamic(() => import('@/components/temario/TemarioBoard'), {
  loading: () => <BoardSkeleton />,
});
const TemarioImporter = nextDynamic(() => import('@/components/temario/TemarioImporter'), {
  loading: () => <PanelSkeleton lines={2} />,
});

export const dynamic = 'force-dynamic';

export default async function TemarioPage() {
  const subjects = await getTemarioSubjects();

  const totals = subjects.reduce(
    (acc, subject) => ({
      units: acc.units + subject.units.length,
      seen: acc.seen + subject.stats.seen,
      enCurso: acc.enCurso + subject.stats.counts.en_curso,
      pendientes: acc.pendientes + subject.stats.counts.pendiente,
    }),
    { units: 0, seen: 0, enCurso: 0, pendientes: 0 }
  );

  const sinTemario = subjects.filter((subject) => subject.units.length === 0);
  const progressPct = totals.units === 0 ? 0 : Math.round((totals.seen / totals.units) * 100);

  return (
    <div className="space-y-6">
      {/* Cabecera */}
      <div className="flex flex-col gap-3 border-b border-white/10 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <BookOpenCheck className="h-6 w-6 text-emerald-400" />
            <h1 className="font-mono text-2xl font-black uppercase tracking-tight text-slate-100">
              Temario y avance de clase
            </h1>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Tu índice real de cada asignatura: qué llevas visto, qué se está dando ahora y cuándo
            terminarás al ritmo actual. Lo que marques aquí manda en el planificador.
          </p>
        </div>

        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-[#0c1322] px-3 py-2">
          <Layers className="h-4 w-4 text-emerald-400" />
          <div>
            <div className="font-mono text-lg font-bold text-slate-100">
              {totals.seen}/{totals.units}
            </div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500">
              unidades dadas · {progressPct}%
            </div>
          </div>
        </div>
      </div>

      {/* Resumen global */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Unidades totales" value={totals.units} tone="slate" />
        <StatCard label="Dadas en clase" value={totals.seen} tone="sky" />
        <StatCard label="En curso ahora" value={totals.enCurso} tone="amber" />
        <StatCard label="Por dar" value={totals.pendientes} tone="emerald" />
      </div>

      {/* Cómo se mantiene actualizado */}
      <div className="rounded-2xl border border-white/10 bg-[#0c1322] p-4">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-emerald-400" />
          <h2 className="text-sm font-bold text-slate-100">Cómo se mantiene al día</h2>
        </div>
        <ul className="mt-2 space-y-1.5 text-xs text-slate-400">
          <li>
            <span className="text-slate-200">1. El temario lo pones tú:</span> pegas el índice de tu
            profesor o el de tu libro en «Cargar tu temario» (aquí debajo) y la app lo respeta: lo
            lee, lo numera y guarda de dónde ha salido cada unidad.
          </li>
          <li>
            <span className="text-slate-200">2. Cada tarde, en el Cuartel:</span> te pregunto qué has
            visto hoy en cada clase que has tenido. Con ese clic la unidad pasa a «vista», queda
            fechada y el planificador prioriza su repaso.
          </li>
          <li>
            <span className="text-slate-200">3. Aquí mismo:</span> corriges cualquier desfase (una
            unidad que el profesor adelanta, un cambio de orden) en un par de clics.
          </li>
        </ul>
        <p className="mt-2 text-[11px] text-slate-500">
          No hay temario de fábrica ni niveles de partida: lo que aparece en esta pantalla es lo que
          has cargado tú. Si algún día sustituyes un índice, la copia anterior queda guardada en{' '}
          <code className="text-slate-400">data/backups/</code>.
        </p>
      </div>

      <TemarioImporter
        subjects={subjects.map((subject) => ({
          id: subject.id,
          name: subject.name,
          unitCount: subject.units.length,
        }))}
        defaultOpen={totals.units === 0}
      />

      {sinTemario.length > 0 && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs text-amber-200">
          <span className="font-semibold">Sin temario cargado:</span>{' '}
          {sinTemario.map((subject) => subject.name).join(', ')}. Pega el índice real de esas
          materias en «Cargar tu temario» o añade las unidades una a una; si alguna no tiene
          temario de examen, puedes dejarla vacía sin problema.
        </div>
      )}

      <TemarioBoard subjects={subjects} />
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'slate' | 'sky' | 'amber' | 'emerald';
}) {
  const tones: Record<string, string> = {
    slate: 'text-slate-200',
    sky: 'text-sky-300',
    amber: 'text-amber-300',
    emerald: 'text-emerald-300',
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-[#0c1322] p-3">
      <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className={`mt-1 font-mono text-xl font-bold ${tones[tone]}`}>{value}</div>
    </div>
  );
}
