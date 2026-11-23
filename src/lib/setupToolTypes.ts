/**
 * Tipos compartidos de las herramientas del coordinador de puesta a punto.
 *
 * Este archivo NO importa nada del servidor: lo usan tanto el registro de
 * herramientas (`setupTools.ts`, solo servidor) como las tarjetas del cliente.
 * Si metiéramos aquí `prisma` o `db`, el componente de React arrastraría el
 * cliente de base de datos al bundle del navegador.
 */

/** Herramientas que el coordinador puede PROPONER (nunca ejecutar solo). */
export type SetupToolName =
  | 'deleteSubject'
  | 'updateStudentCurriculum'
  | 'purgeOrphanSubjects';

/** Una línea de impacto: qué se va a tocar, en palabras del alumno. */
export interface SetupToolImpact {
  label: string;
  /** Detalle secundario (nombres, fechas, recuentos). */
  detail?: string;
}

/**
 * Propuesta ya validada contra la base. El cliente solo la pinta: no calcula
 * nada ni decide nada. Si el alumno confirma, se reenvía `tool` + `input` y el
 * servidor vuelve a validar la propiedad antes de escribir.
 */
export interface SetupToolProposal {
  /** Identificador de la tarjeta en el cliente (no se usa para autorizar). */
  id: string;
  tool: SetupToolName;
  input: Record<string, unknown>;
  title: string;
  description: string;
  /** Texto del botón que ejecuta: «Borrar materia», «Aplicar cambios»… */
  confirmLabel: string;
  destructive: boolean;
  impact: SetupToolImpact[];
  /** Avisos que el alumno debe leer ANTES de confirmar. */
  warnings: string[];
}

/** Resultado de ejecutar (o de rechazar) una herramienta. */
export interface SetupToolResult {
  ok: boolean;
  /** Qué se ha hecho, en pasado y en una línea por cosa. */
  applied: string[];
  problems: string[];
}

/** Respuesta de `POST /api/puesta-a-punto/tools`. */
export interface SetupToolApiResponse extends SetupToolResult {
  /** Propuesta recalculada (para refrescar la tarjeta con datos reales). */
  proposal?: SetupToolProposal;
}
