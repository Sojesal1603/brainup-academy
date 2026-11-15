/**
 * Constantes del cierre de sesión compartidas por servidor y cliente.
 *
 * Módulo puro a propósito: el panel de cierre es `'use client'` y no puede
 * importar `sessionClose.ts`, que arrastra Prisma.
 */

export const ROOT_CAUSES = [
  'concepto',
  'calculo',
  'lectura_enunciado',
  'tiempo',
  'bloqueo',
] as const;

// Los valores son los que enseña la UI; el servidor no admite otro texto.
export const ROOT_CAUSE_LABELS: Record<(typeof ROOT_CAUSES)[number], string> = {
  concepto: 'No lo tenía claro',
  calculo: 'Fallo de cálculo',
  lectura_enunciado: 'Leí mal el enunciado',
  tiempo: 'Me quedé sin tiempo',
  bloqueo: 'Me bloqueé',
};

export type RootCause = (typeof ROOT_CAUSES)[number];
