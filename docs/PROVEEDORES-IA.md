# Qué proveedores de IA pueden recibir contenido del alumno

Documento para la política de privacidad. Describe lo que hace **este** código
(`src/lib/aiEngine.ts`, `src/lib/ai/credentials.ts`, `src/lib/tutorAttachments.ts`),
no lo que permiten los contratos de cada proveedor.

## Regla de oro

1. Si el alumno tiene **su propia clave**, todas sus peticiones van con **esa**
   clave y a **ese** proveedor. No se completa la cadena con claves de
   plataforma: el alumno con solo Gemini no cae a Groq, NVIDIA ni OpenRouter
   aunque Gemini falle. Lo único que recibe es un mensaje claro de que la IA no
   está disponible.
2. Las claves de plataforma solo se usan para los UUID de
   `PLATFORM_AI_USER_IDS` (el autor de la app). Ese es el único usuario cuyas
   peticiones pueden viajar a varios proveedores a la vez.
3. Sin clave propia y sin estar en la lista, la petición muere en un 402
   `ai_key_required` antes de construir ningún cliente.
4. **Los archivos no se reenvían como plan B.** Si una petición lleva una
   imagen o un PDF que hay que *ver*, solo la atienden modelos con visión. Si no
   queda ninguno disponible, se avisa y no se manda el archivo a otro proveedor.

## Quién puede recibir qué

| Proveedor | Texto del chat | Texto extraído de documentos | Imágenes | PDF binario | Cuándo |
| --- | --- | --- | --- | --- | --- |
| Google Gemini | Sí | Sí | Sí | Sí (`document`) | Clave propia del alumno; clave de plataforma solo con UUID autorizado |
| Groq | Sí | Sí (va dentro del prompt) | No | No | Solo clave de plataforma (usuario autorizado) |
| OpenRouter | Sí | Sí (va dentro del prompt) | Según el modelo `:free` elegido | No | Solo clave de plataforma (usuario autorizado) |
| NVIDIA | Sí | Sí (va dentro del prompt) | No | No | Solo clave de plataforma (usuario autorizado) |
| Ollama local | Sí | Sí | Solo modelos con visión | No | Solo si el alumno levanta el modelo en su equipo; no sale de su red |

Notas:

- «Texto extraído de documentos»: Word, PowerPoint, Excel, ODT/ODP/ODS, PDF con
  capa de texto, Markdown, CSV, LaTeX y código se leen en el servidor y su texto
  entra en el prompt. Por eso puede llegar a **cualquier** proveedor, no solo a
  los que tienen visión.
- La tarjeta «Mi clave de IA» de Ajustes solo acepta claves de **Google AI
  Studio**. Un alumno no puede guardar una clave de Groq, OpenRouter o NVIDIA:
  esos proveedores son, a día de hoy, exclusivos del usuario de plataforma.
- Gemini se llama con `store: false`: la conversación no se guarda como estado
  en el proveedor.
- Las claves nunca aparecen en logs, mensajes de error ni en el estado que pinta
  la interfaz; los errores del proveedor se sanean antes de mostrarse.

## Qué se envía en cada caso

| Tipo de adjunto | Qué viaja | A quién |
| --- | --- | --- |
| Captura (PNG/JPG/WEBP/GIF) ≤ 15 MB | Bytes en base64 como parte `image` | Solo modelos con visión |
| Captura > 15 MB | Nada; se avisa de que no se ha podido mirar | — |
| PDF ≤ 15 MB | Bytes como parte `document` (Gemini) | Solo Gemini |
| PDF/Word/Excel/PPT de cualquier tamaño | El **texto** extraído, troceado por relevancia | Cualquier proveedor de texto |
| Escaneo sin capa de texto y > 15 MB | Nada; se pide subirlo por partes o como capturas | — |

Los archivos se guardan en disco del servidor (`AiAttachment`) para poder
trocearlos y releerlos en turnos posteriores; el contenido binario solo se
adjunta a la petición en los **3 turnos** siguientes al que lo subió
(`ATTACHMENT_LIVE_TURNS`).

## Fallback y errores

- Un proveedor caído no hace que se pruebe otro proveedor **con contenido del
  alumno** si ese otro no está autorizado para esa cuenta.
- Los errores 429/502/503 del proveedor hacen que el catedrático conteste con el
  respaldo local (`tutorFallback.ts`), generado por reglas con los datos del
  propio curso: no se envía nada a nadie más.
- El mensaje del respaldo local dice explícitamente «Sin IA ahora mismo» y no
  inventa contenido del archivo que no se ha podido leer.
