/**
 * Comprueba qué puede hacer la anon key contra PostgREST.
 *
 * No imprime claves ni valores de filas: solo el estado HTTP, el número de
 * filas devueltas y el código/mensaje de error. Sirve para la prueba «antes»
 * y «después» de aplicar RLS.
 *
 *   node scripts/verify-anon-rls.js
 */
const fs = require('fs');

function readEnv() {
  const env = fs.readFileSync('.env', 'utf8');
  const get = (key) => {
    const match = env.match(new RegExp(`^${key}=("?)([^"\\r\\n]+)\\1`, 'm'));
    return match ? match[2] : '';
  };
  return {
    url: get('NEXT_PUBLIC_SUPABASE_URL').replace(/\/+$/, ''),
    key: get('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  };
}

const TABLES = ['UserProfile', 'Subject', 'Note', 'AiMessage', 'ErrorLog', '_prisma_migrations'];

async function main() {
  const { url, key } = readEnv();
  if (!url || !key) throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_ANON_KEY en .env');

  for (const table of TABLES) {
    const endpoint = `${url}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`;
    try {
      const response = await fetch(endpoint, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      const text = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }

      if (Array.isArray(parsed)) {
        const columns = parsed[0] ? Object.keys(parsed[0]).length : 0;
        console.log(`${table}\tHTTP ${response.status}\tfilas=${parsed.length}\tcolumnas=${columns}`);
      } else {
        const code = parsed?.code ? ` ${parsed.code}` : '';
        const message = parsed?.message ? ` ${parsed.message}` : '';
        console.log(`${table}\tHTTP ${response.status}\terror=${(code + message).trim() || 'sin cuerpo JSON'}`);
      }
    } catch (error) {
      console.log(`${table}\tERROR DE RED\t${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
