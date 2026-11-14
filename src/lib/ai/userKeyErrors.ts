/**
 * Fallo del almacén cifrado de claves.
 *
 * Vive en un módulo sin Prisma ni vault para que `credentials.ts` pueda
 * reconocerlo sin cargar la base de datos al importar el motor. Eso mantiene
 * hermético el arranque de la app (y de los tests) cuando `SECRETS_KEY_V1` no
 * está o cuando no hay conexión.
 */
export class AiKeyStoreError extends Error {
  readonly code = 'ai_key_unavailable';
  readonly status = 503;

  constructor(
    message = 'No se pudo leer tu clave de IA: la clave de cifrado del servidor no está disponible o el dato guardado está dañado. Revisa SECRETS_KEY_V1.'
  ) {
    super(message);
    this.name = 'AiKeyStoreError';
  }
}
