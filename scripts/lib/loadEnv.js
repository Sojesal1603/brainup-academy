/**
 * Carga `.env` en `process.env` para los scripts que ejecutan código de la app.
 *
 * Next carga el archivo por su cuenta; un `node scripts/...` no. No se usa
 * `dotenv` para no añadir una dependencia solo por esto. Las variables que ya
 * existen en el entorno mandan: así un test puede sobrescribir una clave sin
 * que el archivo la pise.
 */
const fs = require('node:fs');
const path = require('node:path');

function loadEnv(fileName = '.env') {
  const file = path.join(__dirname, '..', '..', fileName);
  if (!fs.existsSync(file)) return false;

  const content = fs.readFileSync(file, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (process.env[name] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
  }
  return true;
}

module.exports = { loadEnv };
