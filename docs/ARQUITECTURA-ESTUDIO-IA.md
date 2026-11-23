# Arquitectura de la Suite de Estudio y los apuntes modulares

Auditoría técnica y propuesta para el salto a una IA académica de nivel
profesional. Fecha: 2026-11-22. No se ha escrito código de producto: esto es el
plano, con lo que ya existe, lo que falta, y en qué orden conviene construirlo.

---

## 0. Punto de partida real (no el que parece)

BrainUp ya tiene más de lo que suele haber en una app así, y menos de lo que hace
falta para NotebookLM. Conviene no duplicar lo que funciona.

### Lo que ya existe y hay que reutilizar

| Pieza | Dónde | Qué hace hoy |
| --- | --- | --- |
| Extracción multiformato | `src/lib/docRead.ts` | PDF página a página con `--- Página N ---`, Word/PPT/Excel/ODT por ZIP+XML, HTML/RTF/TXT, Latin-1, tope 40 M caracteres |
| Troceado determinista | `src/lib/docContext.ts` | 1 500 caracteres por trozo, 200 de solape, etiqueta por título, rango de páginas, mapa del documento |
| Recuperación léxica | `rankChunks` en `docContext.ts` | Frecuencia inversa + bonus de título, sin IA, sin coste, ~milisegundos |
| Inyección de contexto | `buildDocumentContext` | Presupuesto 45 000 caracteres repartido entre documentos, extractos citables por página |
| Bucle de ampliación | `parsePageRequests` + `api/tutor/route.ts` | El modelo pide «páginas 210-214» y se le sirven en el turno siguiente |
| Adjuntos en chat | `docStore.ts`, `AiAttachment` | Subida en streaming, por cuenta, con índice persistido |
| Generación de apuntes | `apuntesIa.ts`, `api/tutor/notes/route.ts` | Un Markdown de una pieza, con contexto de temario, notas previas y documentos |
| Flujos tipo NotebookLM | `src/lib/notebooklm.ts` | 11 prompts quirúrgicos + importación del resultado pegado a mano |
| Seguridad | Fase 0 (paso 15) | RLS por cuenta (`app.user_id`), rol `prisma_app` sin DDL |

### Los cuatro huecos que bloquean el salto

1. **Los documentos viven en el disco del servidor.**
   `data/uploads/<userId>/<id>.bin|.txt|.index.json` y `AiAttachment.localPath`.
   En Render el disco es **efímero**: cada despliegue o reinicio borra las
   fuentes del alumno, y con varias instancias cada una ve las suyas. Hoy no hay
   pérdida visible porque el modo normal es local, pero en producción es una
   bomba de relojería. **Sin almacén de objetos no hay suite de estudio.**
2. **No hay búsqueda semántica.** El ranking léxico es bueno para «electrólisis»
   y malo para «por qué se calienta el cable» cuando el apunte dice «efecto
   Joule». Tampoco hay búsqueda entre documentos por tema: solo dentro de uno.
3. **No hay trabajos largos.** Un resumen cruzado de 300 páginas o un podcast de
   10 minutos no caben en una petición HTTP con timeout de proxy. Hace falta una
   cola duradera y reanudable.
4. **El apunte es un string.** `Note.content` es Markdown monolítico: no se puede
   expandir una sección, ni versionar un bloque, ni citar de dónde sale cada
   párrafo, ni pedir «más ejemplos solo de esto».

---

## 1. Principios que no se negocian

1. **La recuperación es determinista y medible; el modelo solo redacta.** Cada
   frase con contenido debe poder atarse a un trozo concreto. Si no hay trozo,
   se dice «no consta en tus fuentes», no se rellena.
2. **Dos niveles de contexto.** Mapa (de qué va) + extractos (lo que toca). Ya
   está resuelto así y se mantiene: es lo que permite citar página y pedir más.
3. **Nada se guarda en el disco del servidor como fuente de verdad.** Disco = caché.
4. **El coste se mide por artefacto, no por usuario/mes.** Cada generación guarda
   modelo, tokens y céntimos; sin eso no se puede poner un límite justo.
5. **Lo que ya funciona no se reescribe.** `docContext` se queda como capa léxica;
   los embeddings se **suman**, no sustituyen.

---

## 2. Arquitectura de datos y fuentes

### 2.1 De disco a almacén de objetos

Recomendación: **Supabase Storage** (ya está Supabase en la casa, mismo proyecto,
mismo respaldo, menos proveedores que operar). Alternativa si el egreso pesa:
**Cloudflare R2** (S3 compatible, egreso 0). En ambos casos el patrón es el mismo:

- Bucket privado `study-sources` (nunca público).
- Clave: `{userId}/{documentId}/original.{ext}` y `{userId}/{documentId}/text.txt`.
- La app **no** usa claves de larga vida en el navegador: la subida sigue pasando
  por la ruta de Next (ya es streaming y ya valida firma y tipo), y el servidor
  escribe en Storage con la clave de servicio. Se devuelven URLs firmadas de
  minutos solo para descargar o previsualizar.
- Ojo: la autenticación de BrainUp **no es Supabase Auth**, así que las políticas
  RLS de `storage.objects` basadas en `auth.uid()` no sirven aquí. El aislamiento
  se hace en el servidor por prefijo `userId/` (igual que hoy con las carpetas) y
  el bucket no se expone. Queda anotado como deuda consciente.
- `data/uploads` se queda como caché local de desarrollo (`BRAINUP_UPLOADS_DIR`
  ya permite apuntar a una carpeta temporal en pruebas).

### 2.2 Esquema Prisma propuesto (nuevo, aditivo)

```prisma
enum SourceKind { PDF DOCX PPTX XLSX ODT IMAGE TEXT WEB MOODLE }
enum SourceStatus { uploading queued extracting chunking embedding ready failed }
enum ArtifactKind { resumen guia cuestionario audio_script audio }
enum ArtifactStatus { queued running needs_review ready failed }
enum NoteNodeKind { definicion formula procedimiento ejemplo error_tipico aplicacion active_recall }

model SourceDocument {
  id          String   @id @default(uuid())
  userId      String
  user        UserProfile @relation(fields: [userId], references: [id], onDelete: Cascade)
  subjectId   String?
  topicId     String?          // una fuente puede servir a varias unidades
  title       String
  kind        SourceKind
  mimeType    String
  sizeBytes   Int
  pages       Int      @default(0)
  chars       Int      @default(0)
  sha256      String           // idempotencia: misma fuente, mismo documento
  storageKey  String
  textKey     String?
  status      SourceStatus @default(queued)
  mode        String   @default("texto") // texto | imagen | sin_texto
  notesJson   String?          // avisos honestos de la extracción
  error       String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  chunks      DocumentChunk[]
  artifacts   StudyArtifact[]

  @@unique([userId, sha256])
  @@index([userId, subjectId])
}

model DocumentChunk {
  id          String @id @default(uuid())
  userId      String
  documentId  String
  document    SourceDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)
  order       Int
  pageFrom    Int?
  pageTo      Int?
  label       String            // título del apartado, para el mapa
  text        String
  charCount   Int
  // 768 dimensiones (Gemini text-embedding-004 / gemini-embedding-001).
  // Prisma no lo consulta: se escribe y se lee con $queryRaw.
  embedding   Unsupported("vector(768)")?
  embeddedAt  DateTime?

  @@unique([documentId, order])
  @@index([userId, documentId])
}

model StudyArtifact {
  id          String @id @default(uuid())
  userId      String
  subjectId   String?
  topicId     String?
  kind        ArtifactKind
  status      ArtifactStatus @default(queued)
  title       String
  // Entrada exacta: documentos + consulta + ajustes. Es la clave de caché.
  inputHash   String
  paramsJson  String
  contentMd   String?          // resumen / guía / guion
  audioKey    String?          // audio final o manifiesto de segmentos
  durationMs  Int?
  model       String?
  costCents   Int      @default(0)
  coverage    Float?           // % de secciones con cita válida
  warningsJson String?
  createdFrom String   @default("suite")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  sections    ArtifactSection[]
  quizItems   QuizItem[]
  segments    AudioSegment[]
  jobs        StudyJob[]

  @@unique([userId, inputHash, kind])
  @@index([userId, createdAt])
}

model ArtifactSection {
  id          String @id @default(uuid())
  artifactId  String
  artifact    StudyArtifact @relation(fields: [artifactId], references: [id], onDelete: Cascade)
  order       Int
  title       String
  markdown    String
  // [{ chunkId, page, quote }] — el validador comprueba que `quote` está en el trozo.
  citationsJson String
  tokensIn    Int @default(0)
  tokensOut   Int @default(0)
}

model QuizItem {
  id          String @id @default(uuid())
  artifactId  String
  artifact    StudyArtifact @relation(fields: [artifactId], references: [id], onDelete: Cascade)
  order       Int
  format      String   // mcq | corta | numerica
  bloom       String   // recordar | aplicar | analizar…
  difficulty  Int      @default(2)
  prompt      String
  optionsJson String?
  answer      String
  explanation String
  chunkIds    String   // JSON array
}

model AudioSegment {
  id         String @id @default(uuid())
  artifactId String
  artifact   StudyArtifact @relation(fields: [artifactId], references: [id], onDelete: Cascade)
  order      Int
  speaker    String   // docente | alumno
  text       String
  storageKey String?
  durationMs Int?
  status     String   @default("pending")
}

model StudyJob {
  id          String @id @default(uuid())
  userId      String
  kind        String            // ingest | artifact | audio
  status      String @default("queued") // queued | running | done | failed
  step        Int      @default(0)
  totalSteps  Int      @default(1)
  inputJson   String
  resultJson  String?
  error       String?
  attempts    Int      @default(0)
  heartbeatAt DateTime?
  costCents   Int      @default(0)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([status, createdAt])
  @@index([userId, createdAt])
}
```

Notas de modelo:

- `DocumentChunk` guarda el texto **además** del índice del archivo: así la
  búsqueda no depende de un JSON en disco y se puede filtrar por `userId` en SQL.
- `embedding` es `Unsupported("vector(768)")`: Prisma genera la columna, pero las
  consultas van por `$queryRaw`. Migración con `CREATE EXTENSION IF NOT EXISTS
  vector` + índice HNSW.
- El `@@unique([userId, inputHash, kind])` es lo que evita pagar dos veces el
  mismo resumen o el mismo podcast. Si el alumno cambia una fuente, cambia el hash.

### 2.3 Ingesta (idempotente y reanudable)

```
subida (streaming, firma, tipo)  →  sha256  →  ¿ya existe?  →  sí: reutiliza
                                              →  no: crea SourceDocument(queued)
                                                       ↓
                         job ingest: extraer (docRead) → trocear (docContext)
                                     → guardar chunks + texto en Storage
                                     → embeddings por lotes → status ready
```

- Reutiliza `docRead` y `chunkDocument` tal cual. El troceado actual es el bueno
  para citar; solo se añade un **segundo nivel** para embeddings (ver 2.4).
- Web: `POST /api/study/sources/url`. Descarga con límite de tamaño, respeta
  `robots.txt`, extrae texto con `markupToText` y **bloquea SSRF** (nada de
  `localhost`, `169.254.*`, rangos privados, ni esquemas que no sean http/https).
- Moodle: `MoodleMaterial` ya tiene los materiales del curso. Un botón «usar como
  fuente» crea un `SourceDocument` con el binario descargado, no un duplicado
  conceptual.
- Cada paso escribe `StudyJob.step`. Si Render reinicia a mitad, el siguiente
  tick retoma desde el paso guardado, no desde cero.

### 2.4 Troceado en dos niveles

| Nivel | Tamaño | Para qué |
| --- | --- | --- |
| **Padre** (`DocumentChunk.text`) | 1 500 caracteres, 200 de solape (los de hoy) | Lo que se le enseña al modelo: mantiene una idea completa y la página |
| **Hijo** (para el embedding) | 400-600 caracteres, sin solape | Precisión de la búsqueda semántica; varios hijos apuntan a un padre |

No se guardan los hijos como filas: el vector del padre se calcula como media
normalizada de los vectores de sus hijos (o se embebe el padre directamente, más
simple; recomendado para la fase 1). Lo importante es que **el modelo siempre
recibe padres** y el ranking puede usar hijos. Si más adelante hace falta
precisión, se añade `DocumentChunk.parentId` y no se rompe nada.

### 2.5 Embeddings y recuperación híbrida

- Proveedor: **Gemini** (`text-embedding-004` o `gemini-embedding-001`, 768
  dimensiones), con la clave que el alumno ya tiene. Cero proveedores nuevos, y
  respeta la regla de oro de `docs/PROVEEDORES-IA.md`: el texto solo va al
  proveedor autorizado para esa cuenta. Si el alumno no tiene Gemini pero sí
  Groq, el modo híbrido no se activa para él y sigue el léxico (degradación
  limpia, no error).
- Alternativa de privacidad: embeddings con Ollama local (`nomic-embed-text`) si
  el alumno levanta el modelo; misma tabla, otra dimensión por documento (no
  mezclar dimensiones en el mismo índice: se guarda `embeddingModel` en
  `SourceDocument` y se filtra).
- Índice: `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)`.
- **Fusión por RRF** (Reciprocal Rank Fusion, k=60) entre la lista léxica
  (`rankChunks`) y la vectorial (`ORDER BY embedding <=> $1 LIMIT 40`). RRF no
  necesita calibrar puntuaciones y es robusto cuando un modo falla.
- **Diversidad (MMR ligero)** antes de recortar a presupuesto: evita cinco
  trozos casi idénticos del mismo párrafo.
- Filtros duros en SQL: `userId`, `documentId IN (...)`, `topicId`, y rango de
  páginas si el modelo las pide. La seguridad no se delega al prompt.
- Todo esto se activa con `RETRIEVAL_MODE=lexical|hybrid` (por defecto `lexical`
  hasta que la evaluación demuestre mejora). Un interruptor que se puede apagar
  en producción sin desplegar es la diferencia entre un experimento y una avería.

### 2.6 Anti-alucinación: el contrato de citas

Tres capas, de más barata a más cara:

1. **Contexto cerrado.** El prompt incluye solo extractos con identificador
   (`[S2:p213]`) y la instrucción: «si no está aquí, dilo; no completes con lo
   que sepas del mundo». Ya se hace en el tutor; se extiende a artefactos.
2. **Validador determinista.** El modelo devuelve `{chunkId, quote}` por
   afirmación. El servidor comprueba: (a) el `chunkId` pertenece al conjunto
   enviado; (b) `quote` aparece en el texto del trozo tras normalizar espacios y
   acentos. Si falla, la sección se marca `needs_review` y se reintenta **una**
   vez con el error delante. Esto es código puro, se prueba sin red.
3. **Verificación de dominio.** Para cuentas, fórmulas, unidades y resultados
   numéricos se reutiliza `src/lib/verify/*` (química, matemáticas…) y el
   corrector. Un cuestionario de Física cuyas soluciones no pasan el verificador
   no se publica: se regenera el ítem.

Métrica de cobertura: % de secciones con al menos una cita válida. Se enseña en
la UI («12 de 12 apartados con cita; 1 marcado para revisar»). Es la forma
honesta de decir «esto está atado a tus fuentes» sin prometer infalibilidad.

### 2.7 RLS y permisos de las tablas nuevas

- Todas las tablas nuevas llevan `userId` y entran en el bucle de
  `public.brainup_apply_app_rls()` (paso 15). **Hay que volver a ejecutarla**
  después de la migración: las políticas se crean sobre las tablas que existen en
  ese momento.
- `prisma_app.sql` usa `ALTER DEFAULT PRIVILEGES`, así que las tablas creadas por
  el rol de migraciones nacen con DML y sin DDL: no hay que tocar grants a mano.
- `StudyJob` es del usuario, pero el tick lo ejecuta el servidor; el `WHERE
  userId = ...` sigue siendo obligatorio en cada consulta (el RLS es la segunda
  capa, no la única).

---

## 3. Suite de estudio

### 3.1 Un solo pipeline para todos los artefactos

```
entrada (documentos + tema + ajustes)
   → mapa de cobertura (qué fuente cubre qué apartado)
   → esquema de secciones (JSON validado con zod)
   → por sección: recuperar → redactar → validar citas → guardar ArtifactSection
   → ensamblar (Markdown + índice) → estado ready | needs_review
```

Ventajas frente a «un prompt gigante»: cada sección cabe en contexto, se puede
regenerar sola, el progreso es real (3/8), el coste se imputa por sección y un
fallo no tira el trabajo entero. Es el mismo patrón que ya usa el planificador
con sus restricciones.

### 3.2 Resúmenes cruzados

- Agrupa por **conceptos**, no por documento: una matriz concepto × fuente.
- Marca **contradicciones** («tus apuntes dicen 9,8 y el libro 9,81») en vez de
  elegir en silencio. Eso es exactamente lo que un alumno necesita ver.
- Salida: Markdown con citas, tabla de cobertura y lista de vacíos («el libro no
  trata la parte de…»). Nunca rellena el vacío.

### 3.3 Guías de estudio interactivas

- Ruta ordenada con prerrequisitos, tiempo estimado por bloque (reutiliza la
  lógica de `StudyBlock`), objetivo de aprendizaje por sección.
- Cada bloque enlaza a los trozos y ofrece: «explícamelo», «pregúntame»,
  «ponme un problema». Son llamadas pequeñas con contexto del bloque, no del
  libro entero.
- Al terminar un bloque se puede crear una tarjeta SRS (`ReviewCard`) con la
  pregunta de recall: la guía se convierte en repaso, no en lectura pasiva.

### 3.4 Cuestionarios contextuales

- Generación por trozo con nivel de Bloom explícito y dificultad calibrada.
- Tres formatos: test (4 opciones con distractores que representan errores
  típicos, no aleatorios), respuesta corta (con rúbrica) y numérica (validada
  por `verify/`).
- Cada ítem guarda `chunkIds` y la explicación cita la página.
- Salida directa a `ReviewCard`/`SrsReview` y al registro de errores (`ErrorLog`)
  cuando falla: el sistema ya sabe qué hacer con un fallo.

### 3.5 Audio / podcast educativo

Diseño en dos fases, porque el audio es lo más caro y lo más frágil:

**Fase guion** (texto, barato, testeable): diálogo docente ↔ alumno, 1 200-1 800
palabras para 8-12 minutos (~1 000 caracteres ≈ 1 minuto). Cada intervención
lleva `chunkIds` internos (no se leen en voz alta). Reglas: una idea por
intervención, sin muletillas, sin inventar; el guion se revisa con el mismo
validador de citas que el resto.

**Fase voz** (TTS, caro): un proveedor con voces naturales en español y factura
por carácter.

| Opción | Encaje | Coste de referencia (nov 2026) |
| --- | --- | --- |
| **ElevenLabs** (Multilingual v2 / v3) | Mejor naturalidad en español y diálogo multi-voz; límite 10 000 caracteres por petición | 0,08 USD / 1 000 caracteres → **~0,80 USD por 10 min** |
| ElevenLabs Flash v2.5 | Mitad de precio, latencia baja, algo menos expresivo | 0,04 USD / 1 000 caracteres → ~0,40 USD por 10 min |
| **Cartesia** (Sonic) | Pensado para streaming y baja latencia; bueno para «escuchar mientras se genera» | consultar tarifa actual |
| Gemini TTS | Cero proveedor nuevo (clave existente), integrado en el motor actual | se factura por tokens de audio; validar precio antes de fijar cuota |

Recomendación: **ElevenLabs Flash v2.5 para el podcast final** (equilibrio
calidad/precio) y **Cartesia solo si se quiere reproducción en streaming
mientras se sintetiza**. Empezar con un adaptador `TtsProvider` con dos
implementaciones y un `fake` para pruebas: el resto del sistema no debe saber de
quién es la voz.

Detalles que ahorran dolores:

- Trocear el guion por intervención (≤ 2 000 caracteres), sintetizar en paralelo
  con concurrencia limitada (2-3), guardar cada MP3 como `AudioSegment`.
- **No concatenar con ffmpeg en Render** (no está garantizado y añade minutos de
  CPU): guardar segmentos + manifiesto con orden y duración, y reproducir en
  cadena en el cliente. Si más adelante se quiere un único archivo, se concatena
  en un job aparte o se usa el endpoint de diálogo del proveedor.
- Caché por `inputHash` del guion: el mismo podcast no se paga dos veces.
- Cuota explícita: p. ej. 2 podcasts/mes por cuenta en plan base; el coste está
  medido (`costCents`) y se puede cortar sin adivinar.

### 3.6 Trabajos largos sin infraestructura nueva

No hay Redis ni worker. La opción que menos piezas añade y sí sobrevive a un
reinicio de Render:

1. Tabla `StudyJob` como cola durable.
2. `POST /api/study/jobs/tick` (protegido con `STUDY_JOB_SECRET`) que reclama
   **un** trabajo con `UPDATE ... WHERE status='queued' ... FOR UPDATE SKIP
   LOCKED RETURNING *`, avanza **un** paso y devuelve.
3. Un cron de Render (o el `push:cron` que ya existe, ampliado) lo llama cada
   minuto; el trabajo avanza 1 paso por minuto como mínimo, y la UI puede llamar
   al tick tras crear el trabajo para que arranque de inmediato.
4. La UI hace polling de `GET /api/study/jobs/[id]` cada 2 s (o SSE si se quiere
   pulir) y muestra el paso real: «extrayendo 120/300 páginas», «redactando 4/8».

Esto es más lento que un worker dedicado, pero es **correcto**: no pierde
trabajo, no cuesta una instancia más y se puede migrar a un worker el día que
haga falta sin cambiar el modelo de datos.

---

## 4. Apuntes modulares (Outline-First)

### 4.1 Modelo: esquema editable + bloques

`Note` se queda como contenedor (título, materia, unidad, autor). Debajo:

- `NoteSection` (o `NoteOutlineNode`): árbol con `parentId`, `order`, `title`,
  `kind` (definición, fórmula, procedimiento, ejemplo, error típico, aplicación,
  active recall), `objective`, `estimatedMinutes`, `sourceChunkIds`, `status`
  (`draft | expanded | locked`).
- `NoteBlock`: contenido real de una sección (`type`, `markdown`, `citationsJson`,
  `order`).
- `NoteRevision`: snapshot por bloque al regenerar (permite «deshacer» sin perder
  lo que el alumno escribió).

`Note.content` **se mantiene** como Markdown derivado (exportación, descarga,
búsqueda actual). Es una caché, no la fuente de verdad. Así nada de lo que ya
funciona se rompe y la migración es incremental: un apunte antiguo es una nota
con una sola sección y un solo bloque.

### 4.2 Flujo UX

1. **Esquema primero.** El alumno pide apuntes de una unidad. En vez de esperar
   40 segundos a un texto, recibe en 3-5 segundos un **árbol de 6-12 apartados**
   con objetivo y minutos estimados. Puede renombrar, borrar, reordenar, marcar
   «esto ya lo sé» (se omite) y añadir «un ejemplo de esto».
2. **Expansión bajo demanda.** Cada apartado tiene «Desarrollar» (con streaming
   dentro del bloque) y «Desarrollar todo» (job con progreso por sección). La
   expansión recibe: el trozo que toca, el título y objetivo del apartado, los
   títulos hermanos (coherencia, no repetición) y el perfil editorial de la
   materia que ya existe en `apuntesIa.ts`.
3. **Acompañamiento vivo.** En cada bloque: «más ejemplos», «explícalo más
   simple», «ponme un ejercicio», «¿por qué este paso?». Son llamadas cortas con
   el bloque como contexto; la respuesta se inserta como bloque hijo o como
   revisión, nunca sobrescribe en silencio.
4. **Editor.** TipTap (ProseMirror) con KaTeX para fórmulas y `dnd-kit` para
   reordenar; ya hay `framer-motion` en el proyecto para las transiciones. El
   autoguardado va por bloque (debounce 800 ms), no por documento.
5. **Cierre del bucle.** Botón «examinarme de esto»: genera 5-10 preguntas solo
   de los bloques desarrollados ese día y las manda a SRS. Y «exportar a PDF»
   reutiliza la ruta de descarga que ya existe.

### 4.3 API propuesta

| Ruta | Qué hace |
| --- | --- |
| `POST /api/notes/outline` | Esquema desde fuentes + temario (JSON validado) |
| `PATCH /api/notes/[id]/outline` | Reordenar/renombrar/omitir nodos |
| `POST /api/notes/[id]/sections/[sectionId]/expand` | Expande una sección, streaming |
| `POST /api/notes/[id]/expand-all` | Crea `StudyJob` y devuelve id |
| `POST /api/notes/[id]/sections/[sectionId]/followup` | «más ejemplos», «más simple»… |
| `GET /api/notes/[id]` | Árbol + bloques (con `ETag` por `updatedAt`) |

Todo con `requireUser`, `db(user.id)` y comprobación de pertenencia de la nota
(el `WHERE userId` no se omite nunca, aunque el RLS lo cubra).

### 4.4 Migración sin big bang

1. Crear tablas y escribir un `backfill` idempotente: cada `Note` existente →
   una `NoteSection` «Contenido» + un `NoteBlock` con el Markdown actual.
2. La UI nueva lee del árbol; si una nota no tiene árbol (backfill pendiente),
   cae al render actual de `content`.
3. `content` se regenera al guardar (concatenación de bloques). Nunca se edita a
   mano a partir de ese momento.

---

## 5. Riesgos, rendimiento y costes

### 5.1 Presupuestos de latencia (objetivo, no promesa)

| Operación | Objetivo | Cuello real |
| --- | --- | --- |
| Búsqueda léxica | < 50 ms | ninguno (memoria/CPU) |
| Búsqueda vectorial | 80-200 ms | ida y vuelta a Postgres + embedding de la consulta (~100 ms) |
| Primer token del tutor | 0,8-2,5 s | proveedor |
| Esquema de apunte | 3-6 s | una llamada corta |
| Sección de apunte | 5-15 s | streaming, se ve escribir |
| Resumen de 8 secciones | 30-90 s | job, no request |
| Podcast 10 min (guion + voz) | 40-120 s | TTS y concurrencia |

### 5.2 Coste por artefacto (estimación con precios de nov 2026)

| Artefacto | Consumo aproximado | Coste estimado |
| --- | --- | --- |
| Ingesta + embeddings de un libro de 300 págs. | ~110 k tokens de embedding | ~0,02 USD |
| Resumen cruzado (8 secciones) | ~30 k entrada / 6 k salida | 0,02-0,10 USD (Flash) · 0,10-0,30 USD (modelo grande) |
| Cuestionario de 20 ítems | ~8 k / 4 k | céntimos |
| Guía de estudio | ~20 k / 5 k | céntimos |
| Podcast 10 min | ~10 k caracteres TTS | 0,40 USD (Flash) · 0,80 USD (Multilingual v2) |

Conclusiones prácticas:

- Lo caro es el **audio**, no el texto. Por eso el audio lleva cuota y se genera
  solo cuando el alumno lo pide (nunca «por si acaso» al crear el cuaderno).
- La caché por `inputHash` es la palanca de coste más grande: el mismo resumen
  pedido dos veces cuesta cero la segunda.
- Medir `costCents` desde el primer día evita descubrir el problema en la factura.

### 5.3 Render y contextos largos

- Memoria: un PDF de 300 páginas con `pdfjs` ya se procesa página a página, pero
  el texto completo (hasta 40 M caracteres) no debe volver a memoria en cada
  turno. Con los trozos en Postgres, la petición solo carga lo seleccionado
  (≤ 45 k caracteres). Eso **reduce** el consumo actual.
- Timeout del proxy (~100 s): cualquier cosa que pueda pasar de 60 s va a
  `StudyJob`. Regla simple y comprobable.
- Disco efímero: resuelto por el almacén de objetos; `data/uploads` queda como
  caché y se puede borrar sin perder nada.
- Arranque en frío (plan sin instancia siempre activa): el primer turno paga
  ~1-5 s extra. El tick de trabajos debe tolerar que la instancia despierte.

### 5.4 Privacidad

- El texto de las fuentes viaja al proveedor de IA del alumno (ya documentado) y
  ahora **también a embeddings** (Gemini u Ollama). Hay que añadir la fila
  «Embeddings» a `docs/PROVEEDORES-IA.md` y a la política de privacidad.
- Las fuentes no se comparten entre cuentas ni se usan para entrenar: mismo
  régimen que hoy (clave propia, `store: false` en Gemini).
- Borrar una fuente debe borrar: fila, chunks, vectores, objeto en Storage y
  artefactos que dependían solo de ella (o marcarlos como huérfanos). Es una
  operación compuesta: merece su propio endpoint y su prueba.

### 5.5 Riesgos técnicos y mitigación

| Riesgo | Mitigación |
| --- | --- |
| Alucinación sutil en resúmenes | contrato de citas + validador + cobertura visible |
| Embeddings malos para español técnico | evaluación con 25 preguntas reales antes de activar `hybrid`; RRF permite apagar la parte vectorial |
| Migración Prisma con `vector` | columna `Unsupported` + migración SQL a mano + `CREATE EXTENSION`; probar en copia local |
| pgvector no disponible en el plan | preflight: `SELECT * FROM pg_available_extensions WHERE name='vector'`; si no, posponer fase 2 (el resto no depende de ella) |
| Coste de audio descontrolado | cuota, caché, Flash por defecto, medidor por artefacto |
| Trabajos duplicados por doble tick | `FOR UPDATE SKIP LOCKED` + `inputHash` único + idempotencia por paso |
| Pérdida de datos al borrar cuenta | cascadas ya existen en `userId`; Storage se barre por prefijo en el mismo flujo |
| RLS olvidado en tablas nuevas | checklist en la migración + `verify:security` ampliado para exigir `userId` y política |

---

## 6. Hoja de ruta por commits

Cada fase deja el sistema funcionando, con su `verify:*` y sin cambiar el
comportamiento por defecto hasta que la fase anterior esté medida.

**Fase 1 — Fuentes persistentes (base de todo).**
`SourceDocument`, `DocumentChunk`, almacén de objetos, ingesta reanudable,
migración + RLS. `docStore` escribe en Storage y mantiene el disco como caché.
`verify:fuentes` (troceado, idempotencia por sha256, borrado completo, sin red).
*Salida: subir 300 páginas, reiniciar el servidor y que sigan ahí.*

**Fase 2 — Recuperación híbrida.**
Embeddings con Gemini, pgvector, RRF, `RETRIEVAL_MODE`, evaluación
`verify:retrieval` con preguntas doradas (recall@5 léxico vs híbrido).
*Salida: números que justifican encender el modo híbrido, o apagarlo.*

**Fase 3 — Artefactos de texto (resumen y guía).**
Pipeline secciones + validador de citas + `StudyJob` + tick + UI de progreso.
`verify:artefactos` (esquema, citas válidas, cobertura, caché, coste).
*Salida: resumen cruzado real con citas y «no consta» cuando toca.*

**Fase 4 — Cuestionarios y SRS.**
`QuizItem`, formatos, verificación numérica, enganche a `ReviewCard`/`ErrorLog`.
`verify:cuestionario` (respuestas correctas verificadas, distractores distintos,
sin ítems sin cita).

**Fase 5 — Audio.**
`TtsProvider` + ElevenLabs (y `fake` para pruebas), segmentos, manifiesto,
reproductor en cadena, cuota y medidor. `verify:audio` (límites de guion, coste
calculado, fallo de proveedor sin perder el guion).

**Fase 6 — Apuntes modulares.**
`NoteSection`/`NoteBlock`/`NoteRevision`, esquema editable, expansión por sección,
seguimientos, backfill y editor. `verify:apuntes-modulares` (árbol válido,
expansión solo de lo pedido, revisión recuperable, `content` derivado coherente).

**Fase 7 — Límites y observabilidad.**
Cuotas por cuenta, panel de coste por artefacto, métricas de trabajos,
borrado completo de fuente, ampliación de `verify:security` a las tablas nuevas.

Orden pensado para que **nada dependa de lo que aún no existe**: la fase 3
funciona con recuperación léxica; la 5 funciona con el resumen de la 3; la 6
funciona con la 3 y la 4.

---

## 7. Decisiones abiertas (hacen falta antes de la fase 1)

1. **Almacén**: Supabase Storage (menos proveedores) o Cloudflare R2 (egreso 0).
2. **Embeddings**: Gemini (cero fricción, texto a Google) u Ollama local
   (privacidad total, solo alumnos con equipo potente). ¿Híbrido por cuenta?
3. **Voz**: ElevenLabs Flash (calidad/precio) o Cartesia (streaming). ¿Aceptamos
   un proveedor nuevo con su clave, o Gemini TTS para no añadir ninguno?
4. **Cuota de audio**: ¿2 podcasts/mes, o solo desbloqueado con plan de pago?
5. **Alcance de «cero alucinaciones»**: ¿marcar `needs_review` y publicar con
   aviso, o bloquear hasta que el validador pase? Recomiendo publicar con aviso y
   cobertura visible; bloquear frustra más de lo que protege.

---

## 8. Límites de esta auditoría

- No se ha ejecutado nada contra la base de datos ni contra proveedores: no se ha
  comprobado si `vector` está disponible en el proyecto de Supabase, ni el plan
  de Render, ni la latencia real de TTS en español.
- Los costes son estimaciones con tarifas públicas de noviembre de 2026
  (ElevenLabs 0,04-0,08 USD/1 000 caracteres; embeddings de Gemini del orden de
  0,15 USD/1 M tokens). Hay que revalidarlos al contratar.
- La evaluación de recuperación (recall@5) es una propuesta de método, no un
  resultado: sin ella, activar el modo híbrido sería una corazonada.
