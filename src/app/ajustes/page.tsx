import nextDynamic from 'next/dynamic';
import { prisma } from '@/lib/prisma';
import { ensureUserProfile } from '@/lib/userProfile';
import { getMoodleStatus } from '@/lib/moodleWsSync';
import { readMoodleHealth } from '@/lib/moodleSelfHeal';
import AccesoMovil from '@/components/ajustes/AccesoMovil';
import { PanelSkeleton } from '@/components/ui/Skeletons';
import { readAuthConfig } from '@/lib/authGate';

// Ajustes es un panel de paneles: cada uno baja cuando se va a ver, no todos
// de golpe al abrir la sección.
const MoodleWsConnector = nextDynamic(() => import('@/components/ajustes/MoodleWsConnector'), {
  loading: () => <PanelSkeleton lines={4} />,
});
const MoodleConnector = nextDynamic(() => import('@/components/ajustes/MoodleConnector'), {
  loading: () => <PanelSkeleton lines={2} />,
});
const AiEngineCard = nextDynamic(() => import('@/components/ajustes/AiEngineCard'), {
  loading: () => <PanelSkeleton lines={3} />,
});
const GradesPanel = nextDynamic(() => import('@/components/ajustes/GradesPanel'), {
  loading: () => <PanelSkeleton lines={4} />,
});
import {
  Settings,
  Download,
  Database,
  Plug,
  Shield,
  Layers,
  Cpu,
  CheckCircle,
  GraduationCap,
  LogOut,
} from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  // Memoizado por petición: el Header del layout ya ha pedido este perfil.
  const user = await ensureUserProfile();
  // Solo hay sesión que cerrar si la puerta está puesta en el entorno.
  const authOn = Boolean(readAuthConfig());

  const [moodleStatus, moodleHealth] = await Promise.all([getMoodleStatus(), readMoodleHealth()]);

  const notionConfigured = Boolean(process.env.NOTION_API_KEY);
  const notebookLmConfigured = Boolean(process.env.NOTEBOOKLM_MCP_PORT);

  // Estado real de cada asignatura: nota declarada (o no) y cuántas unidades
  // tienen el nivel medido, que es lo único que se puede usar para juzgar.
  const subjects = await prisma.subject.findMany({
    include: { _count: { select: { topics: true } } },
    orderBy: [{ order: 'asc' }, { name: 'asc' }],
  });
  const measuredBySubject = await prisma.topic.groupBy({
    by: ['subjectId'],
    where: { masterySource: { not: 'sin_medir' } },
    _count: true,
  });
  const measuredMap = new Map(measuredBySubject.map((row) => [row.subjectId, row._count]));

  return (
    <div className="space-y-8">
      {/* Cabecera */}
      <div className="pb-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Settings className="w-6 h-6 text-slate-300" />
          <h1 className="text-2xl font-black tracking-tight text-slate-100 uppercase font-mono">
            Ajustes & Portabilidad de Datos
          </h1>
        </div>
        <p className="text-xs text-slate-400 mt-1">
          Control de privacidad, exportación de copias de seguridad y estado de conectores externos.
        </p>
      </div>

      {/* Sesión del dispositivo: aquí se cierra la puerta, no solo en la cabecera */}
      {authOn ? (
        <div className="p-6 rounded-2xl glass-card space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 shrink-0 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-300">
                <Shield className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-100">Sesión de este dispositivo</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  La sesión está abierta con la contraseña del entorno y dura 30 días. Al cerrarla
                  se borra la cookie firmada de este navegador y volverás al formulario de acceso;
                  los datos no se tocan.
                </p>
              </div>
            </div>

            <form action="/api/auth/logout" method="post" className="shrink-0">
              <button
                type="submit"
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-xs font-bold text-rose-200 transition-colors hover:bg-rose-500/20"
              >
                <LogOut className="w-4 h-4" />
                <span>Cerrar sesión</span>
              </button>
            </form>
          </div>
        </div>
      ) : null}

      {/* Mis notas reales: la base de toda la analítica y de los catedráticos */}
      <GradesPanel
        subjects={subjects.map((subject) => ({
          id: subject.id,
          name: subject.name,
          color: subject.color,
          currentGrade: subject.currentGrade,
          targetGrade: subject.targetGrade,
          gradeSource: subject.gradeSource,
          measuredUnits: measuredMap.get(subject.id) ?? 0,
          totalUnits: subject._count.topics,
        }))}
      />

      {/* Motor de IA: selección automática del mejor modelo gratuito */}
      <AiEngineCard />

      {/* La dirección para abrirlo desde el móvil (cambia con la red) */}
      <AccesoMovil />

      {/* Tarjeta de Exportación de Datos */}
      <div className="p-6 rounded-2xl glass-card space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-100">
                Copia de Seguridad Universal (JSON)
              </h3>
              <p className="text-xs text-slate-400">
                Descarga todos tus temas, notas, sesiones, errores y exámenes en un archivo local.
              </p>
            </div>
          </div>

          <a
            href="/api/export"
            download
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition-all shadow-md hover:scale-105"
          >
            <Download className="w-4 h-4 stroke-[3]" />
            <span>Exportar Todo</span>
          </a>
        </div>
      </div>

      {/* Moodle: apuntes y tareas de verdad, con token de Web Services */}
      <div className="p-6 rounded-2xl glass-card space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-500/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
            <GraduationCap className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100">
              Moodle: apuntes y tareas
            </h3>
            <p className="text-xs text-slate-400">
              BrainUp entra en tus cursos: indexa los apuntes que sube tu profesor (en «Cuaderno Notion») y lee tus
              tareas con la fecha de entrega y si ya las has entregado. Lo más rápido es tu usuario y tu contraseña
              de siempre, y funciona aunque tu centro no te deje crear la clave de Web Services: la app entra por la
              sesión web como el navegador. Se sincroniza solo cuando tú quieras.
            </p>
          </div>
        </div>

        <MoodleWsConnector
          status={moodleStatus}
          lastSyncIso={user?.lastMoodleSync ? user.lastMoodleSync.toISOString() : null}
          health={moodleHealth}
        />

        <details className="rounded-xl border border-slate-800 bg-[#080d18] p-3.5">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Alternativa sin token: solo el calendario (iCal)
          </summary>
          <div className="pt-3.5">
            <MoodleConnector
              initialUrl={user?.moodleFeedUrl ?? ''}
              lastSyncIso={user?.lastMoodleSync ? user.lastMoodleSync.toISOString() : null}
            />
          </div>
        </details>
      </div>

      {/* Estado de Conectores (Notion & NotebookLM MCP) */}
      <div className="p-6 rounded-2xl glass-card space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-400">
            <Plug className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100">
              Conectores Externos Desacoplados
            </h3>
            <p className="text-xs text-slate-400">
              La arquitectura de BrainUp es 100% tolerante a fallos: el sistema funciona siempre aunque estos servicios estén apagados.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
          {/* Notion API */}
          <div className="p-4 rounded-xl bg-[#080d18] border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-200">Notion API</span>
              <span
                className={`text-[10px] px-2 py-0.5 rounded font-mono font-semibold ${
                  notionConfigured
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {notionConfigured ? 'Conectado' : 'Sin Configurar (Opcional)'}
              </span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Permitirá sincronizar tus páginas de apuntes y calendario de Notion directamente en tu base de datos.
            </p>
          </div>

          {/* NotebookLM MCP */}
          <div className="p-4 rounded-xl bg-[#080d18] border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-200">
                NotebookLM MCP Bridge
              </span>
              <span
                className={`text-[10px] px-2 py-0.5 rounded font-mono font-semibold ${
                  notebookLmConfigured
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {notebookLmConfigured ? 'Conectado' : 'Puerto Local Listo (Fase 4)'}
              </span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Permitirá a BrainUp citar textualmente tus apuntes mediante el protocolo Model Context Protocol (MCP).
            </p>
          </div>
        </div>
      </div>

      {/* Perfil del Estudiante */}
      <div className="p-6 rounded-2xl glass-card space-y-4">
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200 flex items-center gap-2">
          <Shield className="w-4 h-4 text-emerald-400" />
          <span>Configuración del Perfil Académico</span>
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
          <div className="p-3 rounded-xl bg-[#080d18] border border-slate-800">
            <p className="text-[10px] text-slate-500 uppercase font-semibold">
              Estudiante
            </p>
            <p className="text-sm font-bold text-slate-200 mt-1">{user?.name}</p>
            <p className="text-[10px] text-slate-400 mt-0.5">{user?.modality}</p>
          </div>

          <div className="p-3 rounded-xl bg-[#080d18] border border-slate-800 font-mono">
            <p className="text-[10px] text-slate-500 uppercase font-semibold">
              Objetivo PAU
            </p>
            <p className="text-sm font-bold text-emerald-400 mt-1">
              {user?.targetGradePau.toFixed(2)} / 14.00
            </p>
            <p className="text-[10px] text-slate-400 mt-0.5">Meta que persigues (no una medición)</p>
          </div>

          <div className="p-3 rounded-xl bg-[#080d18] border border-slate-800 font-mono">
            <p className="text-[10px] text-slate-500 uppercase font-semibold">
              Capacidad Semanal
            </p>
            <p className="text-sm font-bold text-blue-400 mt-1">
              {user?.weeklyHoursCap} horas/semana
            </p>
            <p className="text-[10px] text-slate-400 mt-0.5">
              Ritmo diario: ~{(Number(user?.weeklyHoursCap) / 7).toFixed(1)}h
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
