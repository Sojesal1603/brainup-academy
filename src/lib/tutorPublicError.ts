import { TutorError } from './aiEngine';

/**
 * Lo que el alumno puede leer cuando un turno falla.
 *
 * Nunca se reenvía `error.message`: puede nombrar un proveedor, un modelo o un
 * detalle de red. El detalle técnico se queda en el log del servidor; aquí solo
 * hay frases de la academia y, si procede, la opción de reintentar.
 */
export interface PublicTutorError {
  status: number;
  message: string;
  retryable: boolean;
}

const RETRY_MESSAGE =
  'El catedrático no ha podido responder en este momento. Tu mensaje no se ha perdido: vuelve a intentarlo en unos segundos.';

export function publicTutorError(error: unknown): PublicTutorError {
  const status = error instanceof TutorError ? error.status : 500;

  if (status === 400) {
    return {
      status,
      message: 'La consulta no se ha podido preparar. Revisa el mensaje y vuelve a enviarlo.',
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      status,
      message:
        'No encuentro ese catedrático o esa conversación. Recarga la página y vuelve a entrar.',
      retryable: false,
    };
  }
  if (status === 413) {
    return {
      status,
      message: 'La consulta es demasiado grande. Quita algún archivo o acorta el mensaje.',
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      status,
      message:
        'El catedrático está recibiendo muchas consultas ahora mismo. Espera unos segundos y vuelve a intentarlo: tu mensaje está guardado.',
      retryable: true,
    };
  }

  return {
    status: status >= 400 ? status : 500,
    message: RETRY_MESSAGE,
    retryable: true,
  };
}
