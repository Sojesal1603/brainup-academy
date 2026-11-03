import { ClipboardList } from 'lucide-react';
import SetupChat, { type SetupMessage } from '@/components/setup/SetupChat';
import { prisma } from '@/lib/prisma';
import { getSetupState } from '@/lib/setupApply';
import { getConfiguredModelLabel } from '@/lib/aiEngine';

export const dynamic = 'force-dynamic';

const SETUP_TITLE = 'Puesta a punto';

export default async function SetupPage() {
  const [{ snapshot, checklist }, conversation] = await Promise.all([
    getSetupState(),
    prisma.aiConversation.findFirst({
      where: { agentId: null, title: SETUP_TITLE },
      orderBy: { createdAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    }),
  ]);

  const messages: SetupMessage[] = (conversation?.messages ?? []).map((message) => ({
    id: message.id,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.content,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 border-b border-white/10 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ClipboardList className="h-6 w-6 text-emerald-400" />
            <h1 className="font-mono text-2xl font-black uppercase tracking-tight text-slate-100">
              Puesta a punto
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-xs text-slate-400">
            Tu coordinador te entrevista y monta el curso contigo: primero tus horas reales, después el
            temario materia por materia y por último las fechas de examen. Lo que te va anotando lo ves
            a la derecha, y si se le pasa algo se lo recuerdas en cualquier momento.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-[#0c1322] px-3 py-2">
          <span className="font-mono text-lg font-bold text-emerald-300">{checklist.percent}%</span>
          <span className="text-[10px] uppercase tracking-widest text-slate-500">
            del curso
            <br />
            montado
          </span>
        </div>
      </div>

      <SetupChat
        conversationId={conversation?.id ?? null}
        initialMessages={messages}
        initialChecklist={checklist}
        initialSnapshot={snapshot}
        modelLabel={getConfiguredModelLabel()}
      />

      <p className="text-[11px] text-slate-500">
        Nada de lo que aparezca aquí se inventa: el coordinador solo anota lo que le cuentas, y cada
        dato lleva su origen. Lo que no sepas hoy se puede completar otro día.
      </p>
    </div>
  );
}
