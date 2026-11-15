# Qué proveedores de IA pueden recibir contenido del alumno

Documento para la política de privacidad. Describe lo que hace **este** código
(`src/lib/aiEngine.ts`, `src/lib/ai/credentials.ts`, `src/lib/tutorAttachments.ts`),
no lo que permiten los contratos de cada proveedor.

## Regla de oro

1. Si el alumno tiene **alguna clave propia**, todas sus peticiones van con
   **esas** claves y a **esos** proveedores. No se completa la cadena con claves
   de plataforma: el alumno con solo Gemini no cae a Groq, NVIDIA ni OpenRouter
   aunque Gemini falle, y el que tiene Groq no usa el Gemini de la plataforma.
   Lo único que recibe es un mensaje claro de que ese proveedor no está
   disponible (o el respaldo local del catedrático).
2. Las claves de plataforma solo se usan cuando la cuenta **no tiene ninguna
   clave propia** y su UUID está en `PLATFORM_AI_USER_IDS` (el autor de la app).
   En ese caso la cadena puede viajar a varios proveedores a la vez.
3. Sin clave propia y sin estar en la lista, la petición muere en un 402
   `ai_key_required` antes de construir ningún cliente.
4. **Los archivos no se reenvían como plan B.** Si una petición lleva una
   imagen o un PDF que hay que *ver*, solo la atienden modelos con visión. Si no
   queda ninguno disponible, se avisa y no se manda el archivo a otro proveedor.

## Quién puede recibir qué

| Proveedor | Texto del chat | Texto extraído de documentos | Imágenes | PDF binario | Cuándo |
| --- | --- | --- | --- | --- | --- |
| Google Gemini | Sí | Sí | Sí | Sí (`document`) | Clave propia del alumno, o clave de plataforma si la cuenta no tiene ninguna |
| Groq | Sí | Sí (va dentro del prompt) | No | No | Clave propia del alumno, o clave de plataforma si la cuenta no tiene ninguna |
| OpenRouter | Sí | Sí (va dentro del prompt) | Según el modelo `:free` elegido | No | Clave propia del alumno, o clave de plataforma si la cuenta no tiene ninguna |
| NVIDIA | Sí | Sí (va dentro del prompt) | No | No | Clave propia del alumno, o clave de plataforma si la cuenta no tiene ninguna |
| Ollama local | Sí | Sí | Solo modelos con visión | No | Solo si el alumno levanta el modelo en su equipo; no sale de su red |

Cada alumno puede guardar, comprobar, cambiar y borrar su clave en **Ajustes →
Mi clave de IA** para los cuatro proveedores. Se guarda cifrada (AES-256-GCM con
AAD `userId:provider`) y se comprueba contra el endpoint real del proveedor
antes de darla por válida: Gemini y Groq generan una respuesta mínima con el
primer modelo de la cadena; OpenRouter valida con `/api/v1/key` y NVIDIA con su
catálogo `/v1/models` (su cadena de chat puede estar vacía).

Notas:

- «Texto extraído de documentos»: Word, PowerPoint, Excel, ODT/ODP/ODS, PDF con
  capa de texto, Markdown, CSV, LaTeX y código se leen en el servidor y su texto
  entra en el prompt. Por eso puede llegar a **cualquier** proveedor, no solo a
  los que tienen visión.
- La tarjeta «Mi clave de IA» de Ajustes acepta claves de **Google AI Studio
  (Gemini), Groq, OpenRouter y NVIDIA**. Un alumno puede tener las cuatro a la
  vez; el motor elige por proveedor, en el orden Gemini → Groq → OpenRouter →
  NVIDIA, y solo prueba proveedores para los que tiene clave.
- Gemini se llama con `store: false`: la conversación no se guarda como estado
  en el proveedor.
- El enrutado es por capacidad: una imagen o un PDF que hay que *mirar* solo
  viaja a modelos con visión (hoy, Gemini). Si no hay ninguno disponible, se
  avisa y no se manda el archivo a un modelo de texto.
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
