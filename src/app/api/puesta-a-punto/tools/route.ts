import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { currentTenant } from '@/lib/tenantContext';
import { executeSetupTool, previewSetupTool, type SetupToolCall } from '@/lib/setupTools';
import type { SetupToolApiResponse, SetupToolName } from '@/lib/setupToolTypes';
import { prismaErrorCode } from '@/lib/databaseDiagnostics';

/**
 * Herramientas del coordinador: previsualizar y ejecutar.
 *
 * Contrato:
 *
 *   POST { tool, input }                  → valida y devuelve la tarjeta (NO escribe)
 *   POST { tool, input, confirmed: true } → ejecuta (solo tras un clic real)
 *
 * Seguridad:
 *   - el `userId` sale de la sesión (`currentTenant`), jamás del cuerpo;
 *   - el cliente acotado (`tenant`) añade el dueño a cada `where`, y además las
 *     herramientas lo pasan explícito en el borrado;
 *   - la ejecución **vuelve a validar** contra la base: no se fiducia del
 *     `input` que llega ni de que la tarjeta siga siendo cierta.
 *
 * No se acepta el `userId` del cuerpo ni se usa para nada: si llega, se ignora.
 */

const TOOL_NAMES: readonly SetupToolName[] = [
  'deleteSubject',
  'updateStudentCurriculum',
  'purgeOrphanSubjects',
];

interface Body {
  tool?: unknown;
  input?: unknown;
  confirmed?: unknown;
}

export async function POST(request: Request) {
  const { userId, tenant } = await currentTenant();

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, applied: [], problems: ['Petición inválida.'] }, { status: 400 });
  }

  const tool = typeof body.tool === 'string' ? body.tool : '';
  if (!TOOL_NAMES.includes(tool as SetupToolName)) {
    return NextResponse.json(
      { ok: false, applied: [], problems: ['Esa herramienta no existe.'] },
      { status: 400 }
    );
  }

  const call: SetupToolCall = {
    tool: tool as SetupToolName,
    input:
      body.input && typeof body.input === 'object' && !Array.isArray(body.input)
        ? (body.input as Record<string, unknown>)
        : {},
    raw: '',
  };

  try {
    if (body.confirmed !== true) {
      const preview = await previewSetupTool(tenant, userId, call);
      const response: SetupToolApiResponse = preview.proposal
        ? { ok: false, applied: [], problems: [], proposal: preview.proposal }
        : { ok: false, applied: [], problems: [preview.problem ?? 'No se ha podido validar la acción.'] };
      return NextResponse.json(response);
    }

    const result = await executeSetupTool(tenant, userId, call);
    console.log(
      `[puesta-a-punto] herramienta ${call.tool} · ${result.ok ? 'ejecutada' : 'rechazada'}${
        result.ok ? ` · ${result.applied.join(' | ')}` : ''
      }`
    );

    if (result.ok) {
      // Lo borrado/cambiado tiene que desaparecer de las vistas al instante:
      // si no, el alumno confirma un borrado y sigue viendo la materia.
      for (const path of ['/', '/puesta-a-punto', '/temario', '/examenes', '/planificador', '/ajustes', '/horario']) {
        try {
          revalidatePath(path);
        } catch {
          // Fuera de una petición cacheable no hay nada que revalidar.
        }
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    const code = prismaErrorCode(error);
    console.error('[puesta-a-punto] fallo al ejecutar una herramienta:', code ?? '', error);
    return NextResponse.json(
      {
        ok: false,
        applied: [],
        problems: [
          code
            ? `La base de datos ha rechazado la operación (${code}). No se ha cambiado nada.`
            : 'No se ha podido completar la acción. No se ha cambiado nada.',
        ],
      },
      { status: code ? 503 : 500 }
    );
  }
}
