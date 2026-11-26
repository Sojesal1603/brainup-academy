/**
 * Almacén de objetos (Cloudflare R2 / cualquier S3) con respaldo local.
 *
 * El problema que resuelve: en Render el disco es **efímero**. Los documentos de
 * una cuenta vivían en `data/uploads/` y desaparecían en cada despliegue. Aquí
 * los binarios, el texto extraído y los índices van a un bucket privado, y el
 * disco queda como caché.
 *
 * Reglas que se comprueban en cada llamada, no en el llamador:
 *
 *   1. La clave **empieza por el UUID del dueño**. Una clave de otra cuenta no
 *      se puede leer, escribir ni borrar aunque alguien la construya a mano.
 *   2. Los segmentos son `[A-Za-z0-9._-]`: ni `..`, ni barras dobles, ni
 *      caracteres que puedan escapar de la carpeta en el respaldo local.
 *   3. Sin configuración de S3 se usa `data/objects/` (o `BRAINUP_OBJECTS_DIR`).
 *      Así el desarrollo y las pruebas funcionan sin credenciales y sin red, y
 *      la app no arranca en un modo a medias: o hay bucket, o hay disco local.
 *
 * Nunca se expone el bucket al navegador. Para descargar se firma una URL de
 * minutos (`signedDownloadUrl`) o se sirve el objeto por una ruta autenticada.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Clave que no pertenece a la cuenta o que intenta salirse de su carpeta. */
export class ObjectKeyError extends Error {
  readonly code = 'OBJECT_KEY';

  constructor(message = 'La clave del objeto no pertenece a esta cuenta.') {
    super(message);
    this.name = 'ObjectKeyError';
  }
}

/** El almacén no ha podido completar la operación (red, credenciales, bucket). */
export class ObjectStoreError extends Error {
  readonly code = 'OBJECT_STORE';

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ObjectStoreError';
  }
}

export interface ObjectStorageConfig {
  bucket: string;
  endpoint: string | null;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Configuración leída del entorno, o `null` si no hay bucket. */
export function objectStorageConfig(): ObjectStorageConfig | null {
  const bucket = (process.env.BRAINUP_S3_BUCKET ?? '').trim();
  const accessKeyId = (process.env.BRAINUP_S3_ACCESS_KEY_ID ?? '').trim();
  const secretAccessKey = (process.env.BRAINUP_S3_SECRET_ACCESS_KEY ?? '').trim();
  if (!bucket || !accessKeyId || !secretAccessKey) return null;

  return {
    bucket,
    endpoint: (process.env.BRAINUP_S3_ENDPOINT ?? '').trim() || null,
    region: (process.env.BRAINUP_S3_REGION ?? '').trim() || 'auto',
    accessKeyId,
    secretAccessKey,
    // R2 y MinIO funcionan con path-style; S3 de AWS también lo acepta.
    forcePathStyle: (process.env.BRAINUP_S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
  };
}

export function objectStorageConfigured(): boolean {
  return objectStorageConfig() !== null;
}

/** Carpeta del respaldo local. `BRAINUP_OBJECTS_DIR` permite usar una temporal. */
export function localObjectsDir(): string {
  const override = (process.env.BRAINUP_OBJECTS_DIR ?? '').trim();
  return override || path.join(process.cwd(), 'data', 'objects');
}

/**
 * Comprueba que la clave pertenece a la cuenta y normaliza los segmentos.
 *
 * Devuelve la clave limpia (sin barras iniciales) o lanza. Es la única puerta:
 * todas las operaciones pasan por aquí.
 */
export function assertOwnedKey(userId: string, key: string): string {
  if (!UUID_RE.test(String(userId ?? ''))) {
    throw new ObjectKeyError('La cuenta no es válida para acceder al almacén.');
  }

  const raw = String(key ?? '').replace(/\\/g, '/').trim();
  if (raw.startsWith('/') || raw.includes('//')) {
    throw new ObjectKeyError('La clave del objeto no es válida.');
  }

  const segments = raw.split('/');
  if (segments.length < 2) throw new ObjectKeyError('La clave del objeto está incompleta.');
  if (segments[0] !== userId) {
    throw new ObjectKeyError('La clave del objeto no pertenece a esta cuenta.');
  }

  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new ObjectKeyError('La clave del objeto intenta salir de su carpeta.');
    }
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new ObjectKeyError('La clave del objeto tiene caracteres no permitidos.');
    }
  }

  return segments.join('/');
}

/** Construye una clave segura: `<userId>/<carpeta>/<archivo>`. */
export function buildObjectKey(userId: string, folder: string, file: string): string {
  const cleanFolder = String(folder ?? '')
    .split('/')
    .map((part) => part.replace(/[^A-Za-z0-9._-]/g, '_'))
    .filter((part) => part.length > 0 && part !== '.' && part !== '..')
    .join('/');
  const cleanFile = String(file ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  if (!cleanFolder || !cleanFile) throw new ObjectKeyError('No se ha podido construir la clave.');
  return assertOwnedKey(userId, `${userId}/${cleanFolder}/${cleanFile}`);
}

/* ------------------------------------------------------------------ */
/* Respaldo local                                                      */
/* ------------------------------------------------------------------ */

function localPath(userId: string, key: string): string {
  const clean = assertOwnedKey(userId, key);
  return path.join(/* turbopackIgnore: true */ localObjectsDir(), ...clean.split('/'));
}

async function localPut(key: string, body: Uint8Array): Promise<void> {
  const target = path.join(/* turbopackIgnore: true */ localObjectsDir(), ...key.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
}

async function localGet(key: string): Promise<Buffer | null> {
  try {
    return await readFile(path.join(/* turbopackIgnore: true */ localObjectsDir(), ...key.split('/')));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Cliente S3 (carga diferida)                                         */
/* ------------------------------------------------------------------ */

type S3Module = typeof import('@aws-sdk/client-s3');
let s3Cache: { module: S3Module; client: import('@aws-sdk/client-s3').S3Client } | null = null;

async function s3(): Promise<{ module: S3Module; client: import('@aws-sdk/client-s3').S3Client }> {
  const config = objectStorageConfig();
  if (!config) throw new ObjectStoreError('No hay bucket configurado.');

  if (s3Cache) return s3Cache;

  // Import diferido: quien no usa el almacén (la mayoría de las páginas) no
  // carga el SDK de AWS en su bundle.
  const s3Module = await import('@aws-sdk/client-s3');
  const client = new s3Module.S3Client({
    region: config.region,
    endpoint: config.endpoint ?? undefined,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  s3Cache = { module: s3Module, client };
  return s3Cache;
}

/** Solo para pruebas: olvida el cliente cacheado. */
export function resetObjectStoreForTests(): void {
  s3Cache = null;
}

/* ------------------------------------------------------------------ */
/* API pública                                                        */
/* ------------------------------------------------------------------ */

export interface PutObjectResult {
  key: string;
  storage: 's3' | 'local';
  bytes: number;
}

/**
 * Guarda un objeto. Lanza `ObjectStoreError` si el bucket está configurado y
 * falla: quien escribe decide si eso es fatal (una fuente) o solo una caché.
 */
export async function putObject(params: {
  userId: string;
  key: string;
  body: Uint8Array;
  contentType?: string;
}): Promise<PutObjectResult> {
  const key = assertOwnedKey(params.userId, params.key);
  const config = objectStorageConfig();

  if (!config) {
    await localPut(key, params.body);
    return { key, storage: 'local', bytes: params.body.byteLength };
  }

  try {
    const { module, client } = await s3();
    await client.send(
      new module.PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: params.body,
        ContentType: params.contentType,
      })
    );
    return { key, storage: 's3', bytes: params.body.byteLength };
  } catch (error) {
    throw new ObjectStoreError(
      `No se ha podido guardar el objeto en el almacén (${
        error instanceof Error ? error.message.slice(0, 120) : 'error desconocido'
      }).`,
      error
    );
  }
}

/** Lee un objeto, o `null` si no existe. */
export async function getObject(userId: string, key: string): Promise<Buffer | null> {
  const clean = assertOwnedKey(userId, key);
  const config = objectStorageConfig();

  if (!config) return localGet(clean);

  try {
    const { module, client } = await s3();
    const result = await client.send(
      new module.GetObjectCommand({ Bucket: config.bucket, Key: clean })
    );
    if (!result.Body) return null;
    const bytes = await result.Body.transformToByteArray();
    return Buffer.from(bytes);
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === 'NoSuchKey' || name === 'NotFound') return null;
    throw new ObjectStoreError(
      `No se ha podido leer el objeto del almacén (${
        error instanceof Error ? error.message.slice(0, 120) : 'error desconocido'
      }).`,
      error
    );
  }
}

/** Borra un objeto. No falla si ya no estaba. */
export async function deleteObject(userId: string, key: string): Promise<void> {
  const clean = assertOwnedKey(userId, key);
  const config = objectStorageConfig();

  if (!config) {
    await rm(localPath(userId, clean), { force: true }).catch(() => {});
    return;
  }

  try {
    const { module, client } = await s3();
    await client.send(new module.DeleteObjectCommand({ Bucket: config.bucket, Key: clean }));
  } catch (error) {
    throw new ObjectStoreError(
      `No se ha podido borrar el objeto del almacén (${
        error instanceof Error ? error.message.slice(0, 120) : 'error desconocido'
      }).`,
      error
    );
  }
}

/**
 * Borra todo lo de una cuenta (o una carpeta suya). Se usa al eliminar una
 * fuente o una cuenta: sin esto quedarían binarios huérfanos en el bucket.
 */
export async function deleteUserObjects(userId: string, folder = ''): Promise<number> {
  if (!UUID_RE.test(String(userId ?? ''))) throw new ObjectKeyError();
  const prefix = folder
    ? assertOwnedKey(userId, `${userId}/${folder.replace(/^\/+|\/+$/g, '')}`)
    : userId;
  const config = objectStorageConfig();

  if (!config) {
    const target = folder
      ? path.join(/* turbopackIgnore: true */ localObjectsDir(), ...prefix.split('/'))
      : path.join(/* turbopackIgnore: true */ localObjectsDir(), userId);
    let count = 0;
    try {
      const entries = await readdir(target, { recursive: true, withFileTypes: true });
      count = entries.filter((entry) => entry.isFile()).length;
    } catch {
      return 0;
    }
    await rm(target, { recursive: true, force: true }).catch(() => {});
    return count;
  }

  try {
    const { module, client } = await s3();
    let token: string | undefined;
    let count = 0;
    do {
      const listed = await client.send(
        new module.ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: `${prefix}/`,
          ContinuationToken: token,
        })
      );
      const objects = (listed.Contents ?? [])
        .map((item) => item.Key)
        .filter((item): item is string => Boolean(item));
      if (objects.length > 0) {
        await client.send(
          new module.DeleteObjectsCommand({
            Bucket: config.bucket,
            Delete: { Objects: objects.map((Key) => ({ Key })), Quiet: true },
          })
        );
        count += objects.length;
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
    return count;
  } catch (error) {
    throw new ObjectStoreError(
      `No se han podido borrar los objetos de la cuenta (${
        error instanceof Error ? error.message.slice(0, 120) : 'error desconocido'
      }).`,
      error
    );
  }
}

/**
 * URL firmada de descarga (minutos). En respaldo local no hay URL: la ruta
 * autenticada sirve el archivo. Devuelve `null` en ese caso.
 */
export async function signedDownloadUrl(
  userId: string,
  key: string,
  expiresInSeconds = 300
): Promise<string | null> {
  const clean = assertOwnedKey(userId, key);
  const config = objectStorageConfig();
  if (!config) return null;

  try {
    const { module, client } = await s3();
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    return await getSignedUrl(
      client,
      new module.GetObjectCommand({ Bucket: config.bucket, Key: clean }),
      { expiresIn: Math.min(Math.max(expiresInSeconds, 30), 3600) }
    );
  } catch (error) {
    throw new ObjectStoreError('No se ha podido firmar la descarga del objeto.', error);
  }
}
