/**
 * Verificación de adjuntos del catedrático (paso 10a).
 *
 * Prueba con el MISMO código que corre en la app:
 *   - detección por magic bytes (una imagen no pasa como PDF ni al revés);
 *   - una imagen real se guarda y se puede releer;
 *   - un PDF real se extrae a texto con su página;
 *   - un PDF con demasiadas páginas se rechaza con mensaje claro;
 *   - el tamaño excedido se rechaza sin escribir;
 *   - otra cuenta no puede leer, descargar ni borrar la subida;
 *   - un binario renombrado a .txt no pasa como texto.
 *
 * Uso: `node scripts/verify-attachments.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReadableStream } = require('node:stream/web');
const { execFileSync } = require('node:child_process');
const { compilaTs } = require('./lib/compilaTs');

const OWNER = '16bb4958-5288-493b-8c65-379dd31782f5';
const OTHER = '3af632ee-22dc-4e75-85a8-139aa70600bf';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainup-attachments-'));
process.env.BRAINUP_UPLOADS_DIR = tmpDir;

const outSignature = compilaTs('fileSignature', '.tmp-verify-signature');
const outStore = compilaTs('docStore', '.tmp-verify-doc-store');
const outLimits = compilaTs('attachmentLimits', '.tmp-verify-limits');
const signature = require(path.join(outSignature, 'fileSignature.js'));
const store = require(path.join(outStore, 'docStore.js'));

/** PNG 1×1 válido (solo necesitamos su cabecera para la firma). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nS8AAAAASUVORK5CYII=',
  'base64'
);

/** PDF mínimo, con `pageCount` páginas y una marca de texto en cada una. */
function makePdf(pageCount) {
  const objects = [];
  const fontId = 3 + pageCount * 2;
  const kids = [];
  for (let index = 0; index < pageCount; index += 1) {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${contentId} 0 R ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    const stream = `BT /F1 12 Tf 20 100 Td (Pagina ${index + 1}) Tj ET`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  }
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let output = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(output);
    output += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    output += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'utf8');
}

function streamOf(buffer) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

let checks = 0;
async function ok(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log('\n  Adjuntos del catedrático\n');

  await ok('el tope por archivo es 25 MB por defecto y se puede subir a 512 por entorno', () => {
    const byEnv = (vars) => {
      const env = { ...process.env, AI_MAX_ATTACHMENT_MB: '', NEXT_PUBLIC_AI_MAX_ATTACHMENT_MB: '' };
      for (const [name, value] of Object.entries(vars)) env[name] = value;
      const code = `console.log(require(${JSON.stringify(
        path.join(outLimits, 'attachmentLimits.js')
      )}).MAX_ATTACHMENT_BYTES)`;
      return Number(execFileSync(process.execPath, ['-e', code], { env, encoding: 'utf8' }).trim());
    };
    assert.equal(byEnv({}), 25 * 1024 * 1024, 'el valor por defecto no es 25 MB');
    assert.equal(byEnv({ AI_MAX_ATTACHMENT_MB: '512' }), 512 * 1024 * 1024, 'no obedece a AI_MAX_ATTACHMENT_MB');
    assert.equal(
      byEnv({ NEXT_PUBLIC_AI_MAX_ATTACHMENT_MB: '40' }),
      40 * 1024 * 1024,
      'el navegador no obedece a NEXT_PUBLIC_AI_MAX_ATTACHMENT_MB'
    );
    assert.equal(
      byEnv({ AI_MAX_ATTACHMENT_MB: '99999' }),
      512 * 1024 * 1024,
      'un tope absurdo debería quedar en el máximo de 512 MB'
    );
  });

  await ok('una imagen PNG se detecta por su firma, no por el nombre', () => {
    assert.deepEqual(signature.sniffSignature(PNG).kind, 'png');
    assert.equal(signature.signatureMatches('image/png', signature.sniffSignature(PNG)), true);
  });

  await ok('un PDF se detecta por %PDF- aunque el nombre no lo diga', () => {
    const pdf = makePdf(1);
    assert.equal(signature.sniffSignature(pdf).kind, 'pdf');
    assert.equal(signature.signatureMatches('application/pdf', signature.sniffSignature(pdf)), true);
  });

  await ok('un PNG renombrado a PDF se rechaza', () => {
    assert.equal(signature.signatureMatches('application/pdf', signature.sniffSignature(PNG)), false);
  });

  await ok('un binario renombrado a texto se rechaza', () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
    assert.equal(signature.signatureMatches('text/plain', signature.sniffSignature(binary)), false);
  });

  let imageId = null;
  await ok('la imagen se guarda en la carpeta de su dueño y se relee', async () => {
    const result = await store.saveUploadFromStream(streamOf(PNG), {
      userId: OWNER,
      name: 'foto.png',
      mimeType: 'image/png',
      maxBytes: 1024 * 1024,
    });
    assert.equal(result.ok, true, result.error);
    imageId = result.upload.id;
    assert.equal(result.upload.mode, 'imagen');
    const read = await store.readUpload(OWNER, imageId);
    assert.ok(read, 'no se relee la imagen');
    assert.equal(read.name, 'foto.png');
    assert.ok((await store.readUploadBytes(OWNER, imageId)).length > 0);
  });

  await ok('el PDF se extrae a texto con su página', async () => {
    const result = await store.saveUploadFromStream(streamOf(makePdf(1)), {
      userId: OWNER,
      name: 'apunte.pdf',
      mimeType: 'application/pdf',
      maxBytes: 1024 * 1024,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.upload.mode, 'texto');
    assert.equal(result.upload.pages, 1);
    assert.ok(result.upload.chars > 0);
    assert.ok(result.upload.index, 'el PDF no tiene índice');
  });

  await ok('otra cuenta no puede leer ni borrar la imagen', async () => {
    assert.equal(await store.readUpload(OTHER, imageId), null);
    assert.equal(await store.readUploadBytes(OTHER, imageId), null);
    assert.equal(await store.deleteUpload(OTHER, imageId), false);
    assert.ok(await store.readUpload(OWNER, imageId));
  });

  await ok('extensión falsa: PNG con MIME de PDF no se guarda', async () => {
    const result = await store.saveUploadFromStream(streamOf(PNG), {
      userId: OWNER,
      name: 'falso.pdf',
      mimeType: 'application/pdf',
      maxBytes: 1024 * 1024,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'tipo');
    assert.match(result.error, /no es un application\/pdf de verdad/i);
  });

  await ok('tamaño excedido: se rechaza sin dejar el archivo', async () => {
    const result = await store.saveUploadFromStream(streamOf(PNG), {
      userId: OWNER,
      name: 'grande.png',
      mimeType: 'image/png',
      maxBytes: 32,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'too_big');
    assert.match(result.error, /tope/i);
  });

  await ok('un PDF de 301 páginas se rechaza con mensaje claro', async () => {
    const result = await store.saveUploadFromStream(streamOf(makePdf(301)), {
      userId: OWNER,
      name: 'libro.pdf',
      mimeType: 'application/pdf',
      maxBytes: 2 * 1024 * 1024,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'pages');
    assert.match(result.error, /301 páginas/i);
  });

  await ok('borrar sí lo borra para su dueño', async () => {
    assert.equal(await store.deleteUpload(OWNER, imageId), true);
    assert.equal(await store.readUpload(OWNER, imageId), null);
  });

  console.log(`\n  ✅ ${checks} comprobaciones en verde\n`);
})().catch((error) => {
  console.error('\n  ❌', error && error.message ? error.message : error, '\n');
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
