import { NextResponse } from 'next/server';
import { AuthRequiredError, requireUser } from '@/lib/auth';
import { isPlatformAiUser } from '@/lib/ai/credentials';
import { readUserAiKeySummary } from '@/lib/ai/userKeyStore';
import { vaultStatus } from '@/lib/security/vault';

export const dynamic = 'force-dynamic';

/**
 * Estado de la clave propia para la pantalla de Ajustes.
 *
 * Se lee con la sesión del alumno y el cliente acotado por `userId` (Prisma),
 * NUNCA con `service_role`: la tabla tiene RLS y anon/authenticated no tienen
 * privilegios. Devuelve solo el estado y los últimos cuatro caracteres; el
 * sobre cifrado no sale de la base.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const [summary, vault] = await Promise.all([
      readUserAiKeySummary(user.id, 'gemini'),
      Promise.resolve(vaultStatus()),
    ]);

    return NextResponse.json(
      {
        ok: true,
        key: summary,
        vault,
        platform: isPlatformAiUser(user.id),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
    }
    console.error('[ai] no se pudo leer el estado de la clave propia:', error instanceof Error ? error.name : 'error');
    return NextResponse.json(
      {
        ok: false,
        code: 'ai_key_unavailable',
        error: 'No se pudo leer el estado de tu clave. Inténtalo de nuevo en unos segundos.',
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
