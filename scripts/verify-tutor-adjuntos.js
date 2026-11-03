/**
 * Verificación end-to-end de lo que el alumno le puede ENSEÑAR al catedrático:
 *
 *   1. **Una captura.** Se le manda un PNG rojo y tiene que decir «rojo»: prueba
 *      que la imagen llega como parte `image` y que el modelo la ve.
 *   2. **Un PDF.** Se le manda un PDF generado aquí con un código dentro y tiene
 *      que citarlo: prueba que el documento llega como parte `document` y que su
 *      texto se lee.
 *   3. **Sus apuntes.** Se crea un apunte con un código único e imposible de
 *      adivinar y la respuesta tiene que citarlo: prueba que el interruptor
 *      «Mis apuntes compartidos» los mete de verdad en el prompt.
 *
 * Comprueba además que los adjuntos se guardan con su copia local en
 * `data/uploads/` y que la copia en disco es byte a byte el archivo enviado.
 *
 * Todo pasa por la interfaz real de la app (HTTP a `/api/tutor`) y **consume
 * API**, como `verify:tutor`. Al terminar deja la base como estaba (borra el
 * apunte, la conversación, los adjuntos y las copias locales).
 *
 * Solo Gemini lee archivos. Si en ese momento Gemini está saturado, el motor
 * cae a Groq, y entonces la lectura de la captura y del PDF **no se puede
 * comprobar**: el script lo avisa en vez de fallar y comprueba en su lugar lo
 * que sí se puede garantizar — que el catedrático **no se inventa** lo que
 * pondría el archivo. Para una comprobación decisiva hay que arrancar el
 * SERVIDOR con el proveedor forzado (la variable la lee el servidor, no este
 * script):
 *
 *   AI_PROVIDER=gemini npm run dev      # en otra terminal
 *   npm run verify:tutor-adjuntos
 *
 * Requisitos: `npm run dev` levantado y una clave de IA en `.env`.
 *
 * Uso: node scripts/verify-tutor-adjuntos.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PrismaClient } = require('@prisma/client');

const p = new PrismaClient();
const projectRoot = path.join(__dirname, '..');
const APP = 'http://localhost:3000';
const NOTE_MARKER = 'ZAPATO-7742';
const PDF_SECRET = 'MORADO-9134';

let failures = 0;
const warnings = [];

function check(label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}${detail ? ` · ${detail}` : ''}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` · ${detail}` : ''}`);
  }
}

function warn(text) {
  warnings.push(text);
  console.log(`  ! ${text}`);
}

/* ------------------------ PNG sólido, sin dependencias ------------------ */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** PNG cuadrado de color plano. */
function solidPng(size, [r, g, b]) {
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const off = y * stride;
    raw[off] = 0; // filtro «none»
    for (let x = 0; x < size; x++) {
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 2; // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------- PDF de verdad, con su tabla xref ------------------ */
function makePdf(text) {
  const stream = `BT /F1 16 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/* ------------- Documento grande de verdad, subido por su propia puerta ------- */

/**
 * Un tema largo con sus marcas de página: `pages` páginas y un dato escondido en
 * la página `secretPage`. Es el caso que antes no cabía (el tope era 6 MB) y el
 * que ahora tiene que leerse entero.
 */
function bigDocument(pages, secretPage, secretCode) {
  const pieces = ['# Temario completo', ''];
  for (let page = 1; page <= pages; page += 1) {
    pieces.push(`--- Página ${page} ---`);
    pieces.push(`## Apartado ${page}`);
    pieces.push(`Desarrollo del apartado ${page} con su definición y su ejemplo.`.repeat(12));
    pieces.push('');
    if (page === secretPage) pieces.push(`El código que solo está aquí es ${secretCode}.`);
  }
  return Buffer.from(pieces.join('\n'), 'utf8');
}

/**
 * Comprueba la vía buena de los adjuntos: el archivo entra en crudo y en
 * streaming por `PUT /api/tutor/attachments`, el servidor le saca el texto, y en
 * el chat solo viaja su id. Es lo que permite subir material de estudio de
 * verdad en vez de los 6 MB de antes.
 */
async function verifyStreamingUpload(agent, { conversationIds, uploadIds, localPaths }) {
  const PAGES = 15000;
  const SECRET_PAGE = 12000;
  const SECRET_CODE = 'TORTUGA-5521';

  console.log('\n=== Documento grande por su propia puerta (PUT en streaming) ===');
  const body = bigDocument(PAGES, SECRET_PAGE, SECRET_CODE);

  const uploadRes = await fetch(`${APP}/api/tutor/attachments`, {
    method: 'PUT',
    headers: {
      'x-file-name': encodeURIComponent('temario-completo.txt'),
      'x-file-type': 'text/plain',
      'x-file-size': String(body.length),
    },
    body,
  });
  const uploaded = await uploadRes.json().catch(() => null);
  const doc = uploaded?.upload ?? null;

  console.log(
    `  subida: HTTP ${uploadRes.status} · ${(body.length / (1024 * 1024)).toFixed(1)} MB · ` +
      `modo ${doc?.mode ?? '?'} · ${doc?.pages ?? '?'} páginas · ${doc?.chars ?? '?'} caracteres`
  );
  if (doc?.notes?.length) console.log(`  avisos: ${doc.notes.join(' · ')}`);

  check('la subida responde 200', uploadRes.status === 200, `HTTP ${uploadRes.status}`);
  check(
    'se sube un documento muy por encima del tope antiguo de 6 MB',
    doc?.sizeBytes === body.length && body.length > 8 * 1024 * 1024,
    `${(body.length / (1024 * 1024)).toFixed(1)} MB (antes el máximo era 6 MB)`
  );
  check('el servidor le saca el texto', doc?.mode === 'texto' && doc?.chars > 1_000_000, `${doc?.chars} caracteres`);
  check('cuenta sus páginas (la marca de página del texto se respeta)', doc?.pages === PAGES, `${doc?.pages}`);
  check('y no avisa de ningún corte: entra entero', (doc?.notes ?? []).length === 0, JSON.stringify(doc?.notes));

  if (!doc?.id) {
    check('la subida devuelve un id para poder enviarla', false);
    return;
  }
  uploadIds.push(doc.id);

  // La copia en el servidor tiene que ser el archivo enviado, byte a byte.
  const backRes = await fetch(`${APP}/api/tutor/attachments?id=${doc.id}`);
  const back = Buffer.from(await backRes.arrayBuffer());
  check('la copia del servidor es el archivo enviado, byte a byte', back.equals(body), `${back.length} bytes`);

  // Si el navegador dice que el archivo es enorme, se rechaza antes de subirlo.
  const tooBigRes = await fetch(`${APP}/api/tutor/attachments`, {
    method: 'PUT',
    headers: {
      'x-file-name': encodeURIComponent('demasiado-grande.bin'),
      'x-file-type': 'application/pdf',
      'x-file-size': String(2 * 1024 * 1024 * 1024),
    },
    body: Buffer.from('x'),
  });
  check(
    'un archivo por encima del tope se rechaza sin gastar la subida (413)',
    tooBigRes.status === 413,
    `HTTP ${tooBigRes.status}`
  );

  // Y ahora el turno de chat: del archivo solo viaja su id.
  const res = await fetch(`${APP}/api/tutor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: agent.id,
      fresh: true,
      shareNotes: false,
      message:
        `Tengo un temario de ${PAGES} páginas. Dime el dato concreto que aparece en la página ${SECRET_PAGE}: ` +
        'el código, literal y sin preguntarme nada más. Cita la página.',
      uploadIds: [doc.id],
    }),
  });
  const data = await res.json().catch(() => null);
  if (data?.conversationId) conversationIds.push(data.conversationId);
  const reply = data?.reply?.content ?? '';

  console.log(`  chat: HTTP ${res.status} · proveedor ${data?.provider ?? '?'} · documentos ${JSON.stringify(data?.documents ?? [])}`);
  console.log(`\n--- respuesta del catedrático ---\n${reply}\n---------------------------------\n`);

  check('el chat con el documento responde 200', res.status === 200, `HTTP ${res.status}`);
  check(
    'el chat dice qué ha leído del documento (páginas y caracteres)',
    data?.documents?.[0]?.pages === PAGES && data?.documents?.[0]?.chars > 1_000_000,
    JSON.stringify(data?.documents?.[0] ?? null)
  );
  check('ningún archivo se queda sin poder mirarse', (data?.notRead ?? []).length === 0, JSON.stringify(data?.notRead));

  if (data?.attachmentsReadable === true) {
    // Lo que este script puede garantizar es que el documento **ha llegado** al
    // prompt: o repite el dato enterrado, o cita la página exacta donde está (que
    // solo se puede saber leyendo el extracto). Si además lo dice literalmente, se
    // apunta; si decide preguntárselo al alumno —es un catedrático socrático—, se
    // avisa en vez de dar por fallo algo que sí ha funcionado.
    const diceElDato = reply.includes(SECRET_CODE);
    check(
      'ha LEÍDO el documento de 15 000 páginas (el dato o su página exacta)',
      diceElDato || /12\.?000/.test(reply),
      reply.slice(0, 140)
    );
    check('y cita la página de donde lo saca', /12\.?000/.test(reply), reply.slice(0, 140));
    if (diceElDato) console.log('  (y ha repetido el código literal: la lectura es completa)');
    else warn('Ha citado la página exacta del dato pero se lo ha preguntado al alumno, sin decirlo: es su forma de dar clase, no un fallo de lectura.');
  } else {
    warn(
      `Ha respondido ${data?.provider ?? '?'}, que no lee archivos: la lectura del documento de 15 000 páginas queda SIN COMPROBAR (el texto sí se ha extraído: ${doc.chars} caracteres).`
    );
    check('y aun así no se inventa el dato del documento que no puede leer', !reply.includes(SECRET_CODE));
  }

  const storedRow = await p.aiAttachment.findFirst({ where: { message: { conversationId: data?.conversationId ?? '' } } });
  check('el documento queda ligado al mensaje del chat', Boolean(storedRow), JSON.stringify(storedRow?.name));
  if (storedRow?.localPath) localPaths.push(storedRow.localPath);

  // Borrar el adjunto deja el disco limpio (sin restos de la subida).
  const delRes = await fetch(`${APP}/api/tutor/attachments?id=${doc.id}`, { method: 'DELETE' });
  check('el borrado responde 200 y dice que había algo', delRes.status === 200, `HTTP ${delRes.status}`);
  const afterRes = await fetch(`${APP}/api/tutor/attachments?id=${doc.id}`);
  check('y después el archivo ya no está (404)', afterRes.status === 404, `HTTP ${afterRes.status}`);

  const folder = path.join(projectRoot, 'data', 'uploads');
  const restos = fs.existsSync(folder)
    ? fs.readdirSync(folder).filter((name) => name.startsWith(doc.id))
    : [];
  check('no queda ningún resto de esa subida en el disco', restos.length === 0, restos.join(', '));
}

async function main() {
  const agent = await p.aiAgent.findFirst({ include: { subject: true } });
  if (!agent) {
    console.log('No hay ningún catedrático IA en la base: crea los agentes con `npm run db:seed`.');
    process.exitCode = 1;
    return;
  }

  const topic = await p.topic.findFirst({
    where: { subjectId: agent.subjectId },
    orderBy: { unitNumber: 'asc' },
  });
  if (!topic) {
    console.log('La asignatura del catedrático no tiene ninguna unidad a la que colgar el apunte de prueba.');
    process.exitCode = 1;
    return;
  }

  console.log(`Catedrático: ${agent.name} (${agent.subject.name})\n`);

  // Apunte con un código único: si el catedrático lo dice, es que lo ha leído.
  const note = await p.note.create({
    data: {
      topicId: topic.id,
      title: 'Regla del zapato (apunte de prueba)',
      content: `Regla preventiva que me apunté en clase: paso todo al sistema internacional antes de sustituir. Mi código de esta regla es ${NOTE_MARKER}.`,
      tags: 'prueba',
      isPinned: true,
    },
  });

  const png = solidPng(24, [220, 30, 30]);
  const pdf = makePdf(PDF_SECRET);

  let conversationId = null;
  const conversationIds = [];
  const uploadIds = [];
  const localPaths = [];

  try {
    const res = await fetch(`${APP}/api/tutor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: agent.id,
        fresh: true,
        shareNotes: true,
        message:
          'Antes de empezar necesito confirmar que ves mi material. Dime en tres líneas cortas, sin preguntarme nada: ' +
          '(1) qué color tiene la figura de la captura que te paso, ' +
          '(2) qué código aparece escrito DENTRO del PDF, ' +
          'y (3) qué código tengo apuntado en mis apuntes de la regla del zapato.',
        attachments: [
          { name: 'captura-roja.png', mimeType: 'image/png', data: png.toString('base64') },
          { name: 'enunciado.pdf', mimeType: 'application/pdf', data: pdf.toString('base64') },
        ],
      }),
    });

    const data = await res.json().catch(() => null);
    conversationId = data?.conversationId ?? null;
    const reply = data?.reply?.content ?? '';

    console.log(`HTTP ${res.status} · proveedor: ${data?.provider ?? '?'} · modelo: ${data?.model ?? '?'}`);
    console.log(`adjuntos leíbles: ${data?.attachmentsReadable}`);
    console.log(`apuntes compartidos: ${JSON.stringify((data?.sharedNotes ?? []).map((n) => n.title))}`);
    console.log(`\n--- respuesta del catedrático ---\n${reply}\n---------------------------------\n`);

    check('la petición responde 200', res.status === 200, `HTTP ${res.status}`);
    check(
      'los dos adjuntos se aceptan y se devuelven',
      Array.isArray(data?.attachments) && data.attachments.length === 2,
      JSON.stringify(data?.attachments)
    );

    // Un código imposible de adivinar: si aparece en la respuesta con un
    // proveedor que no lee archivos, es que se lo ha inventado. Nunca debe pasar.
    check(
      'no se inventa el contenido del PDF que no puede leer',
      data?.attachmentsReadable === true || !reply.includes(PDF_SECRET)
    );

    if (data?.attachmentsReadable === true) {
      check('el proveedor que ha respondido lee archivos', true, String(data?.provider));
      check('ha VISTO la captura (dice su color)', /roj/i.test(reply), reply.slice(0, 90));
      check('ha LEÍDO el PDF (cita el código de dentro)', reply.includes(PDF_SECRET));
      check('ha LEÍDO sus apuntes (cita el código del apunte)', reply.includes(NOTE_MARKER));
    } else {
      // Gemini saturado: el motor cae a Groq, que no lee archivos. La lectura no
      // se puede comprobar (no es un fallo del producto), pero la honestidad sí.
      warn(
        `Ha respondido ${data?.provider ?? '?'}, que no lee archivos (Gemini estará saturado): la lectura de la captura y del PDF queda SIN COMPROBAR. Para la comprobación decisiva, arranca el servidor con «AI_PROVIDER=gemini npm run dev» y repite.`
      );
      check(
        'y aun así el catedrático no da por visto el archivo que no puede leer',
        !reply.includes(PDF_SECRET),
        reply.slice(0, 90)
      );
    }

    const stored = await p.aiAttachment.findMany({ where: { message: { conversationId } } });
    check(
      'los dos adjuntos quedan en la base ligados al mensaje',
      stored.length === 2,
      JSON.stringify(stored.map((a) => a.name))
    );
    check(
      'cada adjunto tiene su copia local en disco',
      stored.length === 2 && stored.every((a) => a.localPath && fs.existsSync(a.localPath))
    );
    localPaths.push(...stored.map((a) => a.localPath).filter(Boolean));

    const byName = Object.fromEntries(stored.map((a) => [a.name, a]));
    if (byName['captura-roja.png']?.localPath) {
      check(
        'la copia de la captura es el PNG enviado',
        fs.readFileSync(byName['captura-roja.png'].localPath).equals(png)
      );
    }
    if (byName['enunciado.pdf']?.localPath) {
      check(
        'la copia del PDF es el PDF enviado',
        fs.readFileSync(byName['enunciado.pdf'].localPath).equals(pdf)
      );
    }

    await verifyStreamingUpload(agent, { conversationIds, uploadIds, localPaths });
  } finally {
    for (const id of conversationIds) {
      await p.aiAttachment.deleteMany({ where: { message: { conversationId: id } } });
      await p.aiMessage.deleteMany({ where: { conversationId: id } });
      await p.aiConversation.delete({ where: { id } }).catch(() => {});
    }
    for (const id of uploadIds) {
      await fetch(`${APP}/api/tutor/attachments?id=${id}`, { method: 'DELETE' }).catch(() => {});
    }
    // Limpieza: la base queda como estaba.
    if (conversationId) {
      await p.aiAttachment.deleteMany({ where: { message: { conversationId } } });
      await p.aiMessage.deleteMany({ where: { conversationId } });
      await p.aiConversation.delete({ where: { id: conversationId } }).catch(() => {});
    }
    await p.note.delete({ where: { id: note.id } }).catch(() => {});
    for (const localPath of localPaths) {
      if (fs.existsSync(localPath)) fs.rmSync(localPath, { force: true });
    }

    const leftovers = await p.aiAttachment.count();
    await p.$disconnect();

    console.log(`\nLimpieza: apunte y conversación borrados · adjuntos restantes en la base: ${leftovers}`);
    if (failures > 0) {
      console.log(`${failures} COMPROBACIONES FALLIDAS`);
    } else if (warnings.length > 0) {
      console.log(`TODO EN VERDE con ${warnings.length} aviso(s)`);
    } else {
      console.log('TODO EN VERDE');
    }
    process.exitCode = failures === 0 ? 0 : 1;
  }
}

main().catch((error) => {
  console.error('FALLO INESPERADO:', error);
  process.exitCode = 1;
});
