import { currentTenant } from '@/lib/tenantContext';
import { scanSystem } from '@/lib/maintenanceActions';
import { loadMaintenanceInput } from '@/lib/maintenanceData';
import { SEVERITY_META, type MaintenanceSeverity } from '@/lib/maintenance';
import nextDynamic from 'next/dynamic';
import type { IssueRow } from '@/components/mantenimiento/IssuesList';
import { PanelSkeleton } from '@/components/ui/Skeletons';

// Los paneles interactivos del taller son la mitad del peso de la página; el
// diagnóstico ya se lee del servidor antes de que lleguen.
const FixesPanel = nextDynamic(() => import('@/components/mantenimiento/FixesPanel'), {
  loading: () => <PanelSkeleton lines={3} />,
});
const ReportIssueForm = nextDynamic(() => import('@/components/mantenimiento/ReportIssueForm'), {
  loading: () => <PanelSkeleton lines={2} />,
});
const IssueTriageButton = nextDynamic(() => import('@/components/mantenimiento/IssueTriageButton'), {
  loading: () => <PanelSkeleton lines={1} />,
});
const IssuesList = nextDynamic(() => import('@/components/mantenimiento/IssuesList'), {
  loading: () => <PanelSkeleton lines={3} />,
});
const SyllabusAudit = nextDynamic(() => import('@/components/mantenimiento/SyllabusAudit'), {
  loading: () => <PanelSkeleton lines={2} />,
});
import {
  AlertOctagon,
  AlertTriangle,
  Bot,
  Info,
  RefreshCw,
  Stethoscope,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

/**
 * Taller de mantenimiento.
 *
 * Mira dentro del sistema, dice en castellano qué no cuadra y ofrece los
 * arreglos. Nada se toca a escondidas: los arreglos se enseñan antes de
 * aplicarlos y lo único que se aplica solo (el botón «arreglar todo lo seguro»,
 * o el vigilante en segundo plano) es lo que no pierde información.
 */

const SEVERITY_ICON: Record<MaintenanceSeverity, typeof AlertOctagon> = {
  critico: AlertOctagon,
  aviso: AlertTriangle,
  info: Info,
};

export default async function MaintenancePage() {
  const { user, tenant: prisma } = await currentTenant();
  const [scan, input, issues, subjects] = await Promise.all([
    scanSystem(),
    loadMaintenanceInput(user.id),
    prisma.systemIssue.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 40,
    }),
    prisma.subject.findMany({
      select: { id: true, name: true, _count: { select: { topics: true } } },
      orderBy: { order: 'asc' },
    }),
  ]);

  const findings = scan.findings;
  const summary = scan.summary;
  const severities: MaintenanceSeverity[] = ['critico', 'aviso', 'info'];

  const issueRows: IssueRow[] = issues.map((issue) => ({
    id: issue.id,
    title: issue.title,
    detail: issue.detail,
    source: issue.source,
    status: issue.status,
    resolution: issue.resolution,
    createdAtLabel: issue.createdAt.toLocaleString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }),
  }));

  const openIssues = issueRows.filter((issue) => issue.status !== 'resuelto').length;
  // Los que ha reportado el alumno y aún nadie ha mirado: son los que atiende la
  // IA (aquí con el botón, y sola en cada ronda del vigilante).
  const pendingReports = issueRows.filter(
    (issue) => issue.source === 'alumno' && issue.status === 'abierto'
  ).length;
  const ai = input.ai;
  const aiConfigured = ai.gemini || ai.groq;

  return (
    <div className="space-y-8">
      {/* Cabecera */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-4 border-b border-white/10">
        <div>
          <div className="flex items-center gap-2">
            <Wrench className="w-6 h-6 text-emerald-400" />
            <h1 className="text-2xl font-black tracking-tight text-slate-100 uppercase font-mono">
              Taller de Mantenimiento
            </h1>
          </div>
          <p className="text-xs text-slate-400 mt-1 max-w-3xl leading-relaxed">
            Aquí se revisa el sistema por dentro: unidades repetidas, numeración rota, calendarios de
            repaso imposibles, niveles que nadie ha medido, exámenes que ya pasaron. Cada cosa se
            explica —qué pasa, cuántos casos, un ejemplo— y cada arreglo dice exactamente qué va a
            cambiar antes de aplicarlo. Nada se borra a escondidas: lo que toca datos con valor solo
            se propone.
          </p>
          <p className="text-xs text-slate-400 mt-1 max-w-3xl leading-relaxed">
            Si algo falla, anótalo abajo y queda registrado. El vigilante{' '}
            <span className="font-mono text-slate-300">npm run vigilante</span> pasa estas mismas
            comprobaciones cada pocos minutos por su cuenta y aplica solo lo que es seguro.
          </p>
        </div>

        <Link
          href="/mantenimiento"
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition-all shrink-0"
        >
          <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
          <span>Volver a revisar</span>
        </Link>
      </div>

      {!scan.success && (
        <div className="p-4 rounded-2xl bg-rose-500/5 border border-rose-500/30">
          <p className="text-xs font-bold text-rose-300">No se ha podido completar la revisión</p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {scan.error ?? 'Revisa la consola del servidor.'} Última pasada intentada:{' '}
            {new Date(scan.scannedAt).toLocaleTimeString('es-ES')}.
          </p>
        </div>
      )}

      {/* Resumen de la pasada */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-[#140c17] border border-rose-900/40">
          <p className="text-[10px] font-semibold uppercase text-rose-400">Críticos</p>
          <p className="text-2xl font-black text-rose-400 font-mono mt-0.5">{summary.critico}</p>
        </div>
        <div className="p-4 rounded-xl bg-[#141004] border border-amber-900/40">
          <p className="text-[10px] font-semibold uppercase text-amber-400">Avisos</p>
          <p className="text-2xl font-black text-amber-400 font-mono mt-0.5">{summary.aviso}</p>
        </div>
        <div className="glass-card p-4 rounded-2xl">
          <p className="text-[10px] font-semibold uppercase text-sky-400">Información</p>
          <p className="text-2xl font-black text-sky-400 font-mono mt-0.5">{summary.info}</p>
        </div>
        <div className="p-4 rounded-xl glass-card border border-emerald-900/40">
          <p className="text-[10px] font-semibold uppercase text-emerald-400">
            Con arreglo automático
          </p>
          <p className="text-2xl font-black text-emerald-400 font-mono mt-0.5">{summary.fixable}</p>
        </div>
      </div>

      <p className="text-[11px] text-slate-500 font-mono">
        Pasada de {new Date(scan.scannedAt).toLocaleString('es-ES')} · {summary.total} hallazgo(s) ·{' '}
        {openIssues} fallo(s) anotado(s) sin resolver
      </p>

      {/* Hallazgos */}
      <div className="space-y-5">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200 flex items-center gap-2">
          <Stethoscope className="w-4 h-4 text-emerald-400" />
          <span>Lo que no cuadra</span>
          <span className="text-xs text-slate-500 font-mono">({findings.length})</span>
        </h2>

        {findings.length === 0 ? (
          <div className="p-6 rounded-2xl bg-emerald-500/5 border border-emerald-500/30 space-y-1">
            <p className="text-xs font-bold text-emerald-300">
              Todo en orden: ninguna comprobación ha encontrado nada
            </p>
            <p className="text-[11px] text-slate-400 leading-relaxed max-w-2xl">
              El temario, los calendarios de repaso, los niveles, los hábitos y los retos están
              coherentes. Si más adelante algo se descuadra, aparecerá aquí solo.
            </p>
          </div>
        ) : (
          severities.map((severity) => {
            const group = findings.filter((finding) => finding.severity === severity);
            if (group.length === 0) return null;
            const meta = SEVERITY_META[severity];
            const Icon = SEVERITY_ICON[severity];

            return (
              <div key={severity} className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${meta.dotColor}`} />
                  <span className="text-[11px] font-mono uppercase tracking-widest text-slate-400">
                    {meta.label}
                  </span>
                  <span className="text-[11px] font-mono text-slate-600">{group.length}</span>
                </div>

                {group.map((finding) => (
                  <div
                    key={finding.id}
                    className="p-4 rounded-2xl glass-card space-y-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border ${meta.badgeColor}`}
                      >
                        {meta.label}
                      </span>
                      <Icon className="w-3.5 h-3.5 text-slate-400" />
                      <span className="text-xs font-bold text-slate-100">{finding.title}</span>
                      <span className="text-[11px] font-mono text-slate-500">
                        {finding.count} caso(s)
                      </span>
                      {finding.fixable && (
                        <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
                          arreglable
                        </span>
                      )}
                    </div>

                    <p className="text-[11px] text-slate-400 leading-relaxed">{finding.detail}</p>

                    {finding.samples.length > 0 && (
                      <ul className="space-y-0.5 pt-1">
                        {finding.samples.map((sample, index) => (
                          <li key={index} className="text-[11px] font-mono text-slate-500">
                            · {sample}
                          </li>
                        ))}
                      </ul>
                    )}

                    {finding.fixLabel && (
                      <p className="text-[11px] text-emerald-300/90">
                        Arreglo propuesto: {finding.fixLabel}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>

      {/* Arreglos */}
      <FixesPanel
        fixes={scan.fixes.map((fix) => ({
          id: fix.id,
          label: fix.label,
          description: fix.description,
          count: fix.count,
          safe: fix.safe,
        }))}
        clean={summary.total === 0}
        findings={summary.total}
      />

      {/* Motor de IA y vigilante */}
      <div className="p-5 rounded-2xl glass-card space-y-3">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-emerald-400" />
          <p className="text-xs font-bold uppercase tracking-wider text-slate-200">
            Motor de IA y vigilante
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
          <span
            className={`px-2 py-0.5 rounded border ${
              ai.gemini
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : 'bg-slate-500/10 text-slate-400 border-slate-500/30'
            }`}
          >
            Gemini {ai.gemini ? '✓' : '✗'}
          </span>
          <span
            className={`px-2 py-0.5 rounded border ${
              ai.groq
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : 'bg-slate-500/10 text-slate-400 border-slate-500/30'
            }`}
          >
            Groq {ai.groq ? '✓' : '✗'}
          </span>
          <span className="px-2 py-0.5 rounded border bg-sky-500/10 text-sky-400 border-sky-500/30">
            {ai.availableModels} modelo(s) libres
          </span>
          {ai.coolingDown > 0 && (
            <span className="px-2 py-0.5 rounded border bg-amber-500/10 text-amber-400 border-amber-500/30">
              {ai.coolingDown} en enfriamiento
            </span>
          )}
        </div>

        <p className="text-[11px] text-slate-400 leading-relaxed max-w-3xl">
          El motor salta solo los modelos que están en enfriamiento (cupo agotado o error) y sigue
          con el siguiente; si ninguno está libre, la app responde en modo local en vez de caerse.
          Con Gemini y Groq configurados a la vez es muy difícil quedarse sin catedrático.
        </p>
        <p className="text-[11px] text-slate-400 leading-relaxed max-w-3xl">
          El vigilante es el que trabaja sin que se lo pidas: comprueba que la app responde (endpoint{' '}
          <span className="font-mono text-slate-300">/api/salud</span>), pasa estas comprobaciones
          contra la base, aplica los arreglos seguros, deja anotado lo que no puede arreglar y
          reinicia el servidor si se ha caído. Se lanza con{' '}
          <span className="font-mono text-slate-300">npm run vigilante</span> y deja su diario en{' '}
          <span className="font-mono text-slate-300">data/logs/vigilante.log</span>.
        </p>
      </div>

      {/* Auditoría de IA del temario */}
      <SyllabusAudit
        subjects={subjects.map((subject) => ({
          id: subject.id,
          name: subject.name,
          units: subject._count.topics,
        }))}
        aiConfigured={aiConfigured}
      />

      {/* Reportar y revisar fallos */}
      <div className="space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200 flex items-center gap-2">
          <AlertOctagon className="w-4 h-4 text-rose-400" />
          <span>Fallos anotados</span>
          <span className="text-xs text-slate-500 font-mono">({issueRows.length})</span>
        </h2>

        <ReportIssueForm pathname="/mantenimiento" />
        <IssueTriageButton pending={pendingReports} aiConfigured={aiConfigured} />
        <IssuesList issues={issueRows} />
      </div>
    </div>
  );
}
