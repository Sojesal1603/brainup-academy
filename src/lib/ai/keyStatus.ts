/** Estados de una clave de IA propia. Módulo puro: lo puede importar el cliente. */
export const USER_AI_KEY_STATUSES = [
  'sin_comprobar',
  'valida',
  'invalida',
  'sin_cuota',
] as const;

export type UserAiKeyStatus = (typeof USER_AI_KEY_STATUSES)[number];

export interface AiKeySummaryView {
  provider: string;
  status: UserAiKeyStatus;
  /** Últimos cuatro caracteres. Nunca la clave completa. */
  last4: string;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface AiKeyActionResult {
  ok: boolean;
  message: string;
  status?: UserAiKeyStatus;
  /** Proveedor al que se refiere el resultado (la tarjeta tiene cuatro). */
  provider?: string;
  last4?: string;
  /** Segundos de espera si se ha superado el límite de intentos. */
  retryAfterSeconds?: number;
  code?: string;
}

export const AI_KEY_STATUS_LABEL: Record<UserAiKeyStatus, string> = {
  sin_comprobar: 'Sin comprobar',
  valida: 'Válida',
  invalida: 'Inválida',
  sin_cuota: 'Sin cupo',
};
