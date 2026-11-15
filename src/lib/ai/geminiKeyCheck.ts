/**
 * Compatibilidad: la comprobación de Gemini vivía aquí.
 *
 * La lógica real está en `providerKeyCheck.ts`, que ya cubre los cuatro
 * proveedores con el mismo saneado de errores. Este archivo se queda para que
 * los imports antiguos (y `scripts/verify-user-ai-key.js`) sigan funcionando.
 */
export { checkGeminiKey } from './providerKeyCheck';
export type { GeminiKeyCheck } from './providerKeyCheck';
