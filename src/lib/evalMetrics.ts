/**
 * Banco de evaluación: esquema de los casos y sus métricas.
 *
 * Módulo puro (Zod y aritmética, sin IA ni disco) para que las cuentas del MAE
 * se puedan comprobar en una prueba sin gastar una sola llamada de modelo.
 */

import { z } from 'zod';

export const evalCaseSchema = z.object({
  id: z.string().trim().min(1).max(60),
  subject: z.string().trim().min(1).max(80),
  block: z.string().trim().min(1).max(80),
  topicTitle: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(20).max(2_000),
  answer: z.string().trim().min(1).max(8_000),
  /** Nota de referencia puesta a mano (0 a maxPoints). */
  expectedScore: z.number().min(0).max(2.5),
  maxPoints: z.number().min(0.5).max(10).default(2.5),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;

/**
 * Casos de referencia. Se eligen respuestas «de frontera» —las que un corrector
 * duda— porque son las que revelan si el modelo es exigente o generoso.
 */
export const EVAL_CASES: EvalCase[] = z.array(evalCaseSchema).parse([
  {
    id: 'mates2-algebra-1',
    subject: 'Matemáticas II',
    block: 'Álgebra',
    topicTitle: 'Sistemas de ecuaciones',
    prompt:
      'Discute el sistema x + y + z = 3; 2x − y + z = 4; x + 2y − z = 1 según el parámetro y resuélvelo cuando sea compatible determinado.',
    answer:
      'Planteo la matriz ampliada y escalono. El determinante de la matriz de coeficientes es −3 ≠ 0, así que es compatible determinado para todo valor del parámetro. Por Cramer: x = 1, y = 1, z = 1. Compruebo en la tercera ecuación: 1 + 2 − 1 = 2 ≠ 1, luego el sistema es incompatible y no hay solución.',
    expectedScore: 1,
    maxPoints: 2.5,
  },
  {
    id: 'mates2-analisis-1',
    subject: 'Matemáticas II',
    block: 'Análisis',
    topicTitle: 'Optimización',
    prompt:
      'Halla las dimensiones del rectángulo de área máxima inscrito en una circunferencia de radio 5, justificando que es un máximo.',
    answer:
      'Sea el rectángulo de lados 2x y 2y con x² + y² = 25. Área A = 4xy. Sustituyo y = √(25 − x²): A(x) = 4x√(25 − x²). Derivando e igualando a cero: A′(x) = 4√(25 − x²) − 4x²/√(25 − x²) = 0 ⇒ 25 − x² = x² ⇒ x = 5/√2. Entonces y = 5/√2 y el área máxima es A = 4·(25/2) = 50. La segunda derivada es negativa en ese punto, luego es un máximo. El rectángulo óptimo es un cuadrado de lado 5√2.',
    expectedScore: 2.5,
    maxPoints: 2.5,
  },
  {
    id: 'fisica-campo-1',
    subject: 'Física',
    block: 'Electromagnetismo',
    topicTitle: 'Campo eléctrico',
    prompt:
      'Calcula el campo eléctrico en el punto medio entre dos cargas de +2 µC y −2 µC separadas 20 cm. Indica dirección y sentido.',
    answer:
      'El campo de cada carga vale E = kq/r² con r = 0,1 m: E = 9·10⁹ · 2·10⁻⁶ / 0,01 = 1,8·10⁶ N/C. Como las cargas son opuestas, los campos en el punto medio apuntan en el mismo sentido (de la positiva a la negativa), así que se suman: E_total = 3,6·10⁶ N/C dirigido de la carga positiva hacia la negativa.',
    expectedScore: 2.5,
    maxPoints: 2.5,
  },
  {
    id: 'lengua-comentario-1',
    subject: 'Lengua Castellana y Literatura',
    block: 'Comentario de texto',
    topicTitle: 'Comentario crítico',
    prompt:
      'Realiza el comentario crítico de un texto argumentativo sobre el uso de la tecnología en el aula, indicando tesis, estructura y recursos.',
    answer:
      'El texto defiende que la tecnología en el aula distrae más de lo que enseña. Su estructura es inductiva: parte de un ejemplo y termina con la tesis. Usa un registro culto y alguna metáfora. En mi opinión el autor exagera porque no cita datos, aunque es verdad que el móvil distrae.',
    expectedScore: 1.25,
    maxPoints: 2.5,
  },
]);

export interface EvalCaseResult {
  id: string;
  subject: string;
  block: string;
  expectedScore: number;
  gotScore: number;
  absoluteError: number;
}

export interface EvalGroup {
  label: string;
  cases: number;
  mae: number;
}

export interface EvalSummary {
  cases: number;
  mae: number;
  bySubject: EvalGroup[];
  byBlock: EvalGroup[];
}

/** Error absoluto medio: media de |nota − referencia|. */
export function meanAbsoluteError(pairs: Array<{ expected: number; got: number }>): number {
  if (pairs.length === 0) return 0;
  const total = pairs.reduce((acc, p) => acc + Math.abs(p.got - p.expected), 0);
  return total / pairs.length;
}

function groupBy(results: EvalCaseResult[], key: 'subject' | 'block'): EvalGroup[] {
  const map = new Map<string, EvalCaseResult[]>();
  for (const result of results) {
    const label = result[key];
    map.set(label, [...(map.get(label) ?? []), result]);
  }
  return [...map.entries()]
    .map(([label, rows]) => ({
      label,
      cases: rows.length,
      mae:
        Math.round(
          meanAbsoluteError(rows.map((r) => ({ expected: r.expectedScore, got: r.gotScore }))) * 100
        ) / 100,
    }))
    .sort((a, b) => b.mae - a.mae);
}

export function summarizeResults(results: EvalCaseResult[]): EvalSummary {
  return {
    cases: results.length,
    mae:
      Math.round(
        meanAbsoluteError(
          results.map((r) => ({ expected: r.expectedScore, got: r.gotScore }))
        ) * 100
      ) / 100,
    bySubject: groupBy(results, 'subject'),
    byBlock: groupBy(results, 'block'),
  };
}

