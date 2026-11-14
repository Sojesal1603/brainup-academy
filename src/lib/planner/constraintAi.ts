import { resolveAiCredentials } from '../ai/credentials';
import {
  CONSTRAINT_INVALID_MESSAGE,
  PLAN_CONSTRAINT_RESPONSE_SCHEMA,
  parseConstraintModelJson,
  type PlanConstraintInput,
} from './constraints';

/**
 * Interpreta una frase libre («hoy solo 45 minutos», «hoy sin Filosofía») con
 * la API clásica de Gemini y `responseSchema`. No guarda nada: devuelve lo que
 * ha entendido para que la persona lo confirme.
 *
 * Solo se usa la clave del alumno (o la de plataforma si está autorizado). La
 * petición no lleva ningún `userId`: el dueño lo pone el servidor al guardar.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const PARSE_TIMEOUT_MS = 20_000;

const SYSTEM_INSTRUCTION = `Eres un intérprete estricto de restricciones de estudio.
Devuelve SOLO el JSON del esquema. No inventes restricciones que el alumno no haya dicho.
- max_minutes: úsalo cuando diga un límite de tiempo para hoy (minutos entre 10 y 480).
- avoid_subject: cuando diga que hoy no quiere una materia concreta.
- only_subject: cuando diga que hoy solo quiere una materia concreta.
- Usa EXACTAMENTE uno de los nombres de materia de la lista que recibe el usuario.
- Si no hay ninguna restricción clara, devuelve {"constraints":[]}.`;

export class ConstraintAiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConstraintAiError';
    this.code = code;
  }
}

interface GeminiModel {
  name?: string;
  supportedGenerationMethods?: string[];
}

function modelId(name: string): string {
  return name.replace(/^models\//, '');
}

function pickModel(models: GeminiModel[]): string | null {
  const forced = (process.env.GEMINI_MODEL ?? '').trim();
  if (forced && forced !== 'auto') return modelId(forced);

  const usable = models
    .filter((model) => Array.isArray(model.supportedGenerationMethods))
    .filter((model) => model.supportedGenerationMethods!.includes('generateContent'))
    .map((model) => modelId(String(model.name ?? '')))
    .filter((name) => name.length > 0)
    .filter((name) => !/embedding|imagen|aqa|veo|tts/i.test(name));

  const flash = usable.find((name) => /flash/i.test(name) && !/lite|thinking/i.test(name));
  return flash ?? usable.find((name) => /flash/i.test(name)) ?? usable[0] ?? null;
}

async function listModels(key: string): Promise<GeminiModel[]> {
  const response = await fetch(`${GEMINI_BASE}/models?pageSize=50`, {
    headers: { 'x-goog-api-key': key },
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new ConstraintAiError(
      'ai_unavailable',
      response.status === 429
        ? 'Tu clave de Gemini no tiene cupo ahora mismo. Inténtalo en unos minutos.'
        : 'No se pudo consultar los modelos de Gemini. Revisa tu clave en Ajustes.'
    );
  }
  const data = (await response.json().catch(() => null)) as { models?: GeminiModel[] } | null;
  return Array.isArray(data?.models) ? data!.models! : [];
}

async function generateJson(key: string, model: string, prompt: string): Promise<string> {
  const response = await fetch(
    `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: PLAN_CONSTRAINT_RESPONSE_SCHEMA,
        },
      }),
      signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
      cache: 'no-store',
    }
  );

  if (!response.ok) {
    throw new ConstraintAiError(
      'ai_unavailable',
      response.status === 429
        ? 'Tu clave de Gemini no tiene cupo ahora mismo. Inténtalo en unos minutos.'
        : 'Gemini no ha podido interpretar la restricción. Inténtalo de nuevo.'
    );
  }

  const data = (await response.json().catch(() => null)) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  } | null;
  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim() ?? '';
  if (!text) {
    throw new ConstraintAiError('ai_unavailable', 'Gemini ha devuelto una respuesta vacía. Inténtalo otra vez.');
  }
  return text;
}

export async function interpretPlanConstraints(input: {
  userId: string;
  text: string;
  subjects: string[];
}): Promise<PlanConstraintInput[]> {
  const text = input.text.trim().slice(0, 600);
  if (text.length === 0) {
    throw new ConstraintAiError('invalid_input', 'Escribe qué restricción quieres poner para hoy.');
  }

  let key: string;
  try {
    key = (await resolveAiCredentials(input.userId, 'gemini')).key;
  } catch {
    throw new ConstraintAiError(
      'ai_key_required',
      'Necesitas tu clave de Gemini en Ajustes para interpretar la restricción. También puedes escribirla a mano.'
    );
  }

  let models: GeminiModel[];
  try {
    models = await listModels(key);
  } catch (error) {
    if (error instanceof ConstraintAiError) throw error;
    throw new ConstraintAiError('ai_unavailable', 'No se pudo contactar con Gemini. Inténtalo en un minuto.');
  }

  const model = pickModel(models);
  if (!model) {
    throw new ConstraintAiError(
      'ai_unavailable',
      'Tu clave no tiene ningún modelo de Gemini con generación de texto disponible.'
    );
  }

  const prompt = [
    `Frase del alumno: ${JSON.stringify(text)}`,
    `Materias reales (usa el nombre exacto): ${input.subjects.slice(0, 30).join(' | ') || '(ninguna)'}`,
  ].join('\n');

  const raw = await generateJson(key, model, prompt);
  const parsed = parseConstraintModelJson(raw);
  if (!parsed.ok) {
    throw new ConstraintAiError('invalid_response', CONSTRAINT_INVALID_MESSAGE);
  }
  return parsed.constraints;
}
