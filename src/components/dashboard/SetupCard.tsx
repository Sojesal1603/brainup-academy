import Link from 'next/link';
import { ArrowRight, ClipboardList } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { getSetupState } from '@/lib/setupApply';

/**
 * Tarjeta «tu curso está al X% de montado».
 *
 * Vive aparte y se renderiza dentro de un `Suspense` porque, para decidir si
 * hay que enseñarla, hay que calcular el estado completo del curso (perfil,
 * asignaturas, unidades, exámenes y horario). Ese cálculo ya no bloquea al
 * Cuartel: la página se pinta y se puede usar mientras llega esta tarjeta, y si
 * al final sobra, no aparece.
 *
 * Es un componente de servidor puro: no añade JavaScript al móvil.
 */
export default async function SetupCard() {
  const setup = await getSetupState();
  const setupPending = setup.checklist.pending.map((subject) => subject.name);
  const showSetupCard =
    !setup.snapshot.setupCompletedAt &&
    (setupPending.length > 0 || !setup.snapshot.weeklyHoursDeclared);

  if (!showSetupCard) return null;

  // Solo se consulta la conversación si la tarjeta se va a enseñar.
  const setupConversation = await prisma.aiConversation.findFirst({
    where: { agentId: null, title: 'Puesta a punto' },
    select: { id: true },
  });

  return (
    <div className="glass-card glow-emerald border-emerald-500/25 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <ClipboardList className="w-5 h-5 text-emerald-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-bold text-slate-100">
              Tu curso está al {setup.checklist.percent}% de montado
            </p>
            <p className="text-xs text-slate-400 mt-0.5">
              {setupPending.length > 0 ? (
                <>
                  Te falta el temario o los exámenes de:{' '}
                  <span className="text-slate-200">{setupPending.join(', ')}</span>.
                </>
              ) : (
                <>Solo falta que confirmes cuántas horas puedes estudiar a la semana.</>
              )}{' '}
              El coordinador te lo pregunta paso a paso y lo anota él mismo.
            </p>
          </div>
        </div>

        <Link
          href="/puesta-a-punto"
          className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold transition-all shrink-0"
        >
          {setupConversation ? 'Continuar la puesta a punto' : 'Empezar la puesta a punto'}
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </div>
  );
}
