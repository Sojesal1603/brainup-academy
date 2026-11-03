import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: { provider?: string; key?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'JSON inválido' }, { status: 400 });
  }

  const { provider, key } = body;
  const startTime = Date.now();

  if (provider === 'gemini') {
    const apiKey = (key || process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: 'Falta la clave de Gemini' }, { status: 400 });
    }
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=5', {
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(8000),
      });
      const latencyMs = Date.now() - startTime;
      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        return NextResponse.json({
          ok: false,
          status: res.status,
          latencyMs,
          error: res.status === 429 ? 'Cupo agotado (429 Too Many Requests)' : `Error HTTP ${res.status}: ${errorText.slice(0, 180)}`,
        });
      }
      const data = await res.json().catch(() => ({}));
      return NextResponse.json({
        ok: true,
        latencyMs,
        provider: 'Google Gemini',
        modelsCount: Array.isArray(data.models) ? data.models.length : 0,
      });
    } catch (err) {
      return NextResponse.json({
        ok: false,
        latencyMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (provider === 'groq') {
    const apiKey = (key || process.env.GROQ_API_KEY || '').trim();
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: 'Falta la clave de Groq' }, { status: 400 });
    }
    try {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      const latencyMs = Date.now() - startTime;
      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        return NextResponse.json({
          ok: false,
          status: res.status,
          latencyMs,
          error: res.status === 429 ? 'Cupo agotado (429 Too Many Requests)' : `Error HTTP ${res.status}: ${errorText.slice(0, 180)}`,
        });
      }
      const data = await res.json().catch(() => ({}));
      return NextResponse.json({
        ok: true,
        latencyMs,
        provider: 'Groq Cloud',
        modelsCount: Array.isArray(data.data) ? data.data.length : 0,
      });
    } catch (err) {
      return NextResponse.json({
        ok: false,
        latencyMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (provider === 'openrouter') {
    const apiKey = (key || process.env.OPENROUTER_API_KEY || '').trim();
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: 'Falta la clave de OpenRouter' }, { status: 400 });
    }
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      const latencyMs = Date.now() - startTime;
      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        return NextResponse.json({
          ok: false,
          status: res.status,
          latencyMs,
          error: res.status === 429 ? 'Cupo agotado (429 Too Many Requests)' : `Error HTTP ${res.status}: ${errorText.slice(0, 180)}`,
        });
      }
      const data = await res.json().catch(() => ({}));
      // Se cuentan solo los gratuitos: son los únicos que usa la app, y decirlo
      // aquí evita que alguien crea que se está conectando a un modelo de pago.
      const models: Array<{ id?: string }> = Array.isArray(data.data) ? data.data : [];
      const freeModels = models.filter((m) => String(m.id || '').endsWith(':free'));
      return NextResponse.json({
        ok: true,
        latencyMs,
        provider: 'OpenRouter',
        modelsCount: models.length,
        freeModelsCount: freeModels.length,
      });
    } catch (err) {
      return NextResponse.json({
        ok: false,
        latencyMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (provider === 'ollama') {
    const baseUrl = (key || process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
    try {
      const res = await fetch(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      const latencyMs = Date.now() - startTime;
      if (!res.ok) {
        return NextResponse.json({
          ok: false,
          status: res.status,
          latencyMs,
          error: `Ollama respondió HTTP ${res.status}`,
        });
      }
      const data = await res.json().catch(() => ({ models: [] }));
      const models = Array.isArray(data.models) ? data.models.map((m: { name?: string }) => m.name || '') : [];
      return NextResponse.json({
        ok: true,
        latencyMs,
        provider: 'Ollama Local',
        models,
      });
    } catch (err) {
      return NextResponse.json({
        ok: false,
        latencyMs: Date.now() - startTime,
        error: 'Ollama no está iniciado o no está instalado en este puerto (11434).',
      });
    }
  }

  return NextResponse.json({ ok: false, error: 'Proveedor no soportado' }, { status: 400 });
}
