import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: { keys?: Record<string, string> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'JSON inválido' }, { status: 400 });
  }

  const keys = body.keys;
  if (!keys || typeof keys !== 'object') {
    return NextResponse.json({ ok: false, error: 'Faltan las claves' }, { status: 400 });
  }

  try {
    const envPath = path.resolve(process.cwd(), '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    const lines = envContent.split(/\r?\n/);
    const updatedKeys: string[] = [];

    for (const [keyName, rawVal] of Object.entries(keys)) {
      const trimmedKey = keyName.trim();
      const trimmedVal = String(rawVal ?? '').trim();
      if (!/^[A-Z0-9_]+$/.test(trimmedKey)) continue;

      let found = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith(`${trimmedKey}=`)) {
          lines[i] = `${trimmedKey}="${trimmedVal}"`;
          found = true;
          break;
        }
      }

      if (!found && trimmedVal) {
        lines.push(`${trimmedKey}="${trimmedVal}"`);
      }

      // Update runtime process.env
      if (trimmedVal) {
        process.env[trimmedKey] = trimmedVal;
      } else {
        delete process.env[trimmedKey];
      }
      updatedKeys.push(trimmedKey);
    }

    fs.writeFileSync(envPath, lines.join('\n'), 'utf8');

    return NextResponse.json({
      ok: true,
      message: 'Variables guardadas correctamente en .env',
      updatedKeys,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
