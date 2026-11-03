import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { runAiText, hasAiProvider, hasAnyFreeKey, type ChatMessage } from '@/lib/aiEngine';
import { formatNotebookLmContent } from '@/lib/notebooklm';
import { sanitizeNoteContent, NOTE_WRITER_INSTRUCTIONS } from '@/lib/apuntesIa';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { topicId, rawContent, flowName } = body;

    if (!topicId || typeof topicId !== 'string') {
      return NextResponse.json({ error: 'Falta topicId obligatorio' }, { status: 400 });
    }

    if (!rawContent || typeof rawContent !== 'string' || rawContent.trim().length === 0) {
      return NextResponse.json({ error: 'El contenido en bruto de NotebookLM no puede estar vacío' }, { status: 400 });
    }

    if (!hasAiProvider()) {
      return NextResponse.json(
        { error: 'No hay proveedor de IA configurado en .env (GEMINI_API_KEY o GROQ_API_KEY)' },
        { status: 503 }
      );
    }

    if (!hasAnyFreeKey()) {
      return NextResponse.json(
        { error: 'Todas las claves de IA están en enfriamiento temporal. Espera un momento o añade otra clave gratuita en Ajustes.' },
        { status: 429 }
      );
    }

    // 1. Obtener tema, asignatura y su Catedrático correspondiente
    const topic = await prisma.topic.findUnique({
      where: { id: topicId },
      include: {
        subject: {
          include: {
            aiAgent: true,
          },
        },
      },
    });

    if (!topic) {
      return NextResponse.json({ error: 'Tema no encontrado' }, { status: 404 });
    }

    const agent = topic.subject.aiAgent;
    const agentName = agent?.name || `Catedrático de ${topic.subject.name}`;
    const agentSpecialty = agent?.specialty || `Especialista en ${topic.subject.name}`;

    // 2. Pre-formatear citas y sanitizar texto de entrada
    const preformatted = formatNotebookLmContent(rawContent.trim());

    // 3. Prompt de transformación de cátedra
    const systemPrompt = [
      `Eres ${agentName}, ${agentSpecialty} de BrainUp Academy.`,
      `Tu alumno Santiago (1º de Bachillerato) ha obtenido un extracto de fuentes oficiales en Google NotebookLM para la unidad U${topic.unitNumber ?? '?'}: «${topic.title}».`,
      '',
      'TU MISIÓN COMO CATEDRÁTICO:',
      'Actúa como el editor y profesor jefe. Toma la información en bruto de NotebookLM, FILTRA las redundancias o saludos de chat, y TRANSFÓRMALA en unos apuntes magistrales para el Cuaderno Notion de BrainUp.',
      '',
      'REGLAS DE ORO:',
      '1. CONSERVA TODAS LAS CITAS: Cualquier referencia a páginas o documentos (`📌 Pág. X`, `📌 Diapositiva Y` o `[Pág. X]`) DEBE mantenerse y destacarse como insignia de fidelidad.',
      topic.teacherMethod ? `2. CRITERIO DEL PROFESOR: Aplica estrictamente la metodología y notación que exige su profesor: «${topic.teacherMethod}».` : '2. RIGOR: Mantén la máxima precisión formal y notación científica.',
      '3. FORMATO NOTION DE BRAINUP:',
      '   - Comienza con `# <Título del apunte>` (ej. `# U' + (topic.unitNumber ?? 1) + ' · ' + topic.title + '`)',
      '   - Bloque inicial: `> 📌 ` Una sola frase resumen de la importancia del tema.',
      '   - `## 🎯 Conceptos Clave` — definiciones y principios esenciales.',
      '   - `## 📖 Desarrollo Estructurado` — explicación clara, deducciones y conceptos bien ordenados con subtítulos `### `.',
      '   - `## ⚡ Fórmulas y Leyes` — tabla Markdown con Fórmula (en LaTeX `$..$`) | Uso | Criterio.',
      '   - Callouts Notion: usa `> 💡 **Truco:**`, `> ⚠️ **Cuidado con:**`, `> 📌 **Definición:**` para destacar puntos clave.',
      '   - `## 🧠 Compruébalo tú (Active Recall)` — 4 o 5 preguntas de autoevaluación. Cada una con `**Respuesta:** ` justo debajo para que el visor Notion la convierta en desplegable.',
      '',
      '4. NO inventes contenidos fuera de lo que NotebookLM ha extraído de las fuentes. Tu labor es pulir, ordenar, dar rigor de cátedra y estructurar.',
      '5. Responde ÚNICAMENTE con el Markdown final de los apuntes, sin comentarios previos ni saludos.',
    ].join('\n');

    const userMessage = [
      `Aquí tienes el material extraído de Google NotebookLM para el flujo «${flowName || 'Estudio Oficial'}»:`,
      '---',
      preformatted,
      '---',
      `Por favor, procésalo, ordénalo y transfórmalo en los apuntes definitivos de ${topic.subject.name} para mi Cuaderno Notion.`,
    ].join('\n');

    // 4. Llamar al motor de IA multiclave
    const aiResult = await runAiText({
      systemInstruction: systemPrompt,
      message: userMessage,
    });

    const rawOutput = aiResult.text.trim();
    const cleanOutput = sanitizeNoteContent(rawOutput);

    // Extraer título generado
    const titleMatch = cleanOutput.match(/^#\s+(.+)$/m);
    const generatedTitle = titleMatch ? titleMatch[1].trim() : `U${topic.unitNumber ?? 1} · ${topic.title}`;

    const words = cleanOutput.split(/\s+/).filter(Boolean).length;

    return NextResponse.json({
      success: true,
      title: generatedTitle,
      content: cleanOutput,
      agentName,
      subjectName: topic.subject.name,
      topicTitle: topic.title,
      unitNumber: topic.unitNumber,
      words,
      provider: aiResult.provider,
      model: aiResult.model,
    });
  } catch (error) {
    console.error('[notebooklm/transform] error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Error al procesar con el Catedrático' },
      { status: 500 }
    );
  }
}
