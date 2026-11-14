import { NextResponse } from 'next/server';
import { getEngineStatus } from '@/lib/aiEngine';
import { aiCredentialsForStatus } from '@/lib/ai/access';
import { runWithAiCredentials } from '@/lib/ai/credentials';
import { AuthRequiredError, requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Estado del motor de IA: proveedores configurados, ranking real de modelos
 * gratuitos y qué está enfriando por cupo. Nunca expone las claves.
 *
 * Se responde con las credenciales de ESTE usuario: el estado de una cuenta no
 * cuenta lo que tiene configurado otra. `keyRequired` es lo que la interfaz usa
 * para enseñar «Añadir mi clave» en vez de un «sin configurar» genérico.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const credentials = await aiCredentialsForStatus(user.id);
    const status = await runWithAiCredentials(credentials, () => getEngineStatus());
    return NextResponse.json(
      { ...status, keyRequired: credentials.length === 0 },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error('[ia] No se pudo consultar el estado del motor:', error);
    return NextResponse.json(
      { error: 'No se pudo consultar el estado del motor de IA.' },
      { status: 500 }
    );
  }
}
