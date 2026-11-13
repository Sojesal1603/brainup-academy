/**
 * Generador de iconos de BrainUp Academy.
 *
 * Hay **una sola fuente de verdad**: el logo del cerebro que está en
 * `public/PublicLogoNuevo.png` (cerebro rojo guiñando un ojo, con bombilla y
 * gráfica). De ahí salen todos los tamaños que usa la app:
 *
 *   - `public/icon.png` y `public/icon-512.png` → manifest de la PWA
 *   - `public/apple-touch-icon.png`            → icono de iOS
 *   - `public/logo-brainup.png`                → marca del menú lateral y login
 *   - `public/favicon.ico` y `public/brainup.ico` → pestaña y acceso directo de
 *                                                 Windows (ICO real, con varias
 *                                                 tallas dentro)
 *
 * La ilustración ya viene con su propio fondo oscuro, así que se usa tal cual:
 * no hay que recortar ni hacer transparente ningún borde.
 *
 * Uso: `node scripts/generate-icons.js`
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');
const sourcePath = path.join(publicDir, 'PublicLogoNuevo.png');
const BACKGROUND = '#090d16';

if (!fs.existsSync(sourcePath)) {
  console.error(`Falta el logo original: ${path.relative(projectRoot, sourcePath)}.`);
  process.exit(1);
}

if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

/** ICO real: cabecera + una entrada por talla, cada una con su PNG dentro. */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reservado
  header.writeUInt16LE(1, 2); // tipo: icono
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + 16 * images.length;

  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0); // 0 = 256
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
    entry.writeUInt8(0, 2); // colores de paleta
    entry.writeUInt8(0, 3); // reservado
    entry.writeUInt16LE(1, 4); // planos
    entry.writeUInt16LE(32, 6); // bits por píxel
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

async function main() {
  const logo = await sharp(sourcePath).png().toBuffer();

  const png = (size) =>
    sharp(logo)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      // Paleta de 256 colores: el logo es ilustración plana, así que baja de
      // ~490 KB a una fracción sin que se note, y el icono se carga al instante.
      .png({ compressionLevel: 9, palette: true, quality: 92 })
      .toBuffer();

  fs.writeFileSync(path.join(publicDir, 'icon.png'), await png(192));
  fs.writeFileSync(path.join(publicDir, 'icon-512.png'), await png(512));
  fs.writeFileSync(path.join(publicDir, 'logo-brainup.png'), await png(256));

  // iOS no respeta la transparencia: se aplana sobre el fondo de la app.
  fs.writeFileSync(
    path.join(publicDir, 'apple-touch-icon.png'),
    await sharp(logo)
      .resize(180, 180, { fit: 'contain', background: BACKGROUND })
      .flatten({ background: BACKGROUND })
      .png({ compressionLevel: 9 })
      .toBuffer()
  );

  // Pestaña del navegador y acceso directo de Windows: ICO de varias tallas.
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoImages = [];
  for (const size of icoSizes) {
    icoImages.push({ size, data: await png(size) });
  }
  const ico = buildIco(icoImages);
  fs.writeFileSync(path.join(publicDir, 'favicon.ico'), ico);
  fs.writeFileSync(path.join(publicDir, 'brainup.ico'), ico);

  const written = ['icon.png', 'icon-512.png', 'logo-brainup.png', 'apple-touch-icon.png', 'favicon.ico', 'brainup.ico'];
  console.log(`✅ Iconos generados desde «${path.basename(sourcePath)}»: ${written.join(', ')}`);
}

main().catch((error) => {
  console.error('No se pudieron generar los iconos:', error.message);
  process.exit(1);
});
