import { runAiText } from './aiEngine';

/**
 * La redacción del recuerdo, a cargo del modelo.
 *
 * El recuerdo **ya está escrito** por las reglas de `agentMemory.ts` cuando se
 * llega aquí: esto solo lo pule. Por eso, si el modelo no contesta (clave gastada,
 * proveedores saturados, tope de tiempo) se devuelve `null` y se sigue con lo que
 * hay: la memoria del día no depende de que hoy haya cuota libre.
 *
 * Se llama **una vez al día y ámbito** (lo garantiza `isPolishedToday`), nunca en
 * cada turno: pulir es un lujo y la cuota es del alumno.
 */

const POLISH_MAX_TOKENS = 220;

/** Tope de tiempo de esta llamada: si el modelo tarda, el recuerdo ya existe. */
const POLISH_BUDGET_MS = 20_000;

export async function polishMemoryWithAi(
  raw: string,
  who: string
): Promise<string | null> {
  const summary = String(raw ?? '').trim();
  if (summary.length === 0) return null;

  const systemInstruction = [
    'Escribes la memoria diaria de una IA que ayuda a un estudiante de Bachillerato.',
    `Quien recuerda eres «${who}».`,
    '',
    'Recibes un resumen en bruto de lo hablado hoy (con las palabras del alumno) y tienes que devolver la misma información mejor dicha:',
    '- En tercera persona, en dos o tres frases seguidas, en español.',
    '- Conserva TODO dato concreto: fechas, números de unidad, acuerdos y lo que quedó pendiente. No añadas nada que no esté.',
    '- Escribe pensando en quien lo leerá mañana para no volver a preguntar lo mismo.',
    '',
    'Devuelve solo el texto del recuerdo, sin títulos, sin listas y sin comillas.',
  ].join('\n');

  try {
    const reply = await runAiText({
      systemInstruction,
      message: summary,
      maxTokens: POLISH_MAX_TOKENS,
      budgetMs: POLISH_BUDGET_MS,
      // Pulir la memoria es para mañana: si el cupo está justo, se aparta y se
      // guarda el resumen en bruto (que no se pierde nada).
      priority: 'fondo',
    });

    const polished = reply.text
      .replace(/^["'«\s]+|["'»\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 900);

    return polished.length > 0 ? polished : null;
  } catch {
    return null;
  }
}
