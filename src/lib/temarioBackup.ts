import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from './db';

/**
 * Copia de seguridad del temario de una asignatura antes de sustituirlo.
 *
 * Si no se puede escribir, quien llama debe abortar: en esta app no se borra el
 * temario de nadie sin dejar una red antes.
 */
export async function writeTemarioBackup(
  userId: string,
  subjectId: string,
  subjectName: string,
  motivo: string
): Promise<string | null> {
  const topics = await db(userId).topic.findMany({
    where: { subjectId },
    orderBy: [{ unitNumber: 'asc' }],
  });
  if (topics.length === 0) return null;

  const dir = path.join(process.cwd(), 'data', 'backups');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `temario-${stamp}-antes-de-importar.json`);

  await writeFile(
    file,
    JSON.stringify(
      {
        motivo,
        fecha: new Date().toISOString(),
        asignatura: subjectName,
        unidades: topics.map((topic) => ({
          unitNumber: topic.unitNumber,
          title: topic.title,
          term: topic.term,
          status: topic.status,
          source: topic.source,
          difficulty: topic.difficulty,
          masteryLevel: topic.masteryLevel,
          masterySource: topic.masterySource,
          seenInClassAt: topic.seenInClassAt,
        })),
      },
      null,
      2
    ),
    'utf8'
  );

  return path.relative(process.cwd(), file);
}
