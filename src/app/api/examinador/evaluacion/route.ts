import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { ensureAiAccess } from '@/lib/ai/access';
import { EVAL_CASES, runEvalBank, saveEvalRun } from '@/lib/evalBank';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Mide el corrector contra el banco de referencia.
 *
 * Es caro a propósito (dos pasadas por caso), así que se lanza a mano desde el
 * Examinador o desde `verify:corrector`. Si un caso no se puede corregir, la
 * medición falla entera: un MAE calculado con la mitad de los casos mentiría.
 */
export async function POST() {
  const user = await requireUser();
  const denied = await ensureAiAccess(user.id);
  if (denied) return denied;

  try {
    const run = await runEvalBank(EVAL_CASES);
    const file = await saveEvalRun(run).catch(() => null);
    return NextResponse.json({ ok: true, run, saved: Boolean(file) });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'No se ha podido medir el corrector.',
      },
      { status: 503 }
    );
  }
}
