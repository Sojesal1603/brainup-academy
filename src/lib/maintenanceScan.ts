/**
 * La revisión completa: datos + funcionamiento.
 *
 * El motor de mantenimiento tiene dos mitades y están separadas a propósito:
 *
 *   - `maintenance.ts` mira **los datos** (temario, numeración, calendarios de
 *     repaso, exámenes, retos) y es puro: se puede probar solo.
 *   - `operationalTrace.ts` mira **cómo va la app** (caídas, paradas, errores,
 *     fallos de la IA) a partir de los rastros, y también es puro.
 *
 * Este módulo es la única puerta que las junta: la página del taller, el
 * vigilante y el motor de arreglos llaman **a esto**, nunca a una mitad suelta.
 * Así no puede pasar que el taller vea siete problemas y el vigilante seis: los
 * dos ven lo mismo porque los dos entran por aquí.
 */

import {
  buildMaintenanceFixes,
  runMaintenanceChecks,
  sortFindings,
  type MaintenanceFix,
  type MaintenanceFinding,
  type MaintenanceInput,
} from './maintenance';
import { buildOperationalFixes, runOperationalChecks, type OperationalTrace } from './operationalTrace';

/** Un rastro vacío: no hay noticias del sistema (ni buenas ni malas). */
const NO_TRACE: OperationalTrace = {
  serverLogFound: false,
  vigilanteLogFound: false,
  serverLogAt: null,
  vigilanteLogAt: null,
  crashes: [],
  intentionalRestarts: [],
  healthFailures: [],
  storms: [],
  aiFailures: [],
  roundProblems: [],
  appErrors: [],
  lastHealthState: null,
  health: null,
};

function traceOf(input: MaintenanceInput): OperationalTrace {
  return input.trace ?? NO_TRACE;
}

/**
 * El instante de la pasada. `today` es el día (para comparar fechas) y `now` es la
 * hora: las ventanas del rastro necesitan la hora de verdad, porque un fallo de
 * hace media hora no es lo mismo que uno de esta mañana.
 */
function nowOf(input: MaintenanceInput): Date {
  return input.now ? new Date(input.now) : new Date(input.today);
}

/** Todos los hallazgos: los de los datos y los del funcionamiento, en un orden. */
export function scanAll(input: MaintenanceInput): MaintenanceFinding[] {
  return sortFindings([
    ...runMaintenanceChecks(input),
    ...runOperationalChecks(traceOf(input), nowOf(input)),
  ]);
}

/** Todos los arreglos: los de los datos y los del funcionamiento. */
export function allFixes(input: MaintenanceInput): MaintenanceFix[] {
  return [
    ...buildMaintenanceFixes(input),
    ...buildOperationalFixes(traceOf(input), scanAll(input), nowOf(input)),
  ];
}
