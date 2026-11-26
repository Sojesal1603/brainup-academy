# Arquitectura comercial: latencia, orquestación y temario estricto

Evaluación técnica de la propuesta de producto (academia de pago, «nivel NASA») y
plano de ejecución sobre el repositorio real. Fecha: 2026-11-26.

Complementa a `docs/ARQUITECTURA-ESTUDIO-IA.md` (fuentes, RAG y apuntes
modulares). Aquel documento resuelve **de dónde sale el conocimiento**; este
resuelve **cómo se sirve sin latencia, sin errores visibles y con un director que
decide**. No se repite lo ya decidido allí.

---

## 0. Veredicto en una página

| Idea de la propuesta | Veredicto | Qué se hace en su lugar |
| --- | --- | --- |
| Transición instantánea entre secciones | **Correcta, pero hoy imposible**: todo es `force-dynamic` y no hay caché de datos ni de segmento | Caché por etiquetas + snapshot del alumno + `DailyBrief` precalculado; el plan se abre **sin IA** |
| «Cero bloqueos ni errores en el chat» | **Correcta como objetivo, mal formulada**: no es un problema de keep-alive, es que hoy el turno es una única petición de 60 s sin streaming | SSE con heartbeat, primer token < 1 s, reanudación por id, idempotencia y tres niveles de degradación **transparentes** |
| Mega-Agente Director que orquesta en tiempo real | **Riesgo alto si el LLM está en la ruta crítica** | Orquestador **determinista** (ya existe `planner/engine.ts`) + capa fina de IA para narrar y para *what-if*; el «director» LLM va fuera de la petición |
| RAG estricto sobre el temario del alumno | **Correcta y es el foso defensivo** | Modo `estudio` con ámbito cerrado, citas validadas por código y cobertura visible; `curiosidad` como modo aparte y etiquetado |
| **BYOK: el alumno elige y aporta su proveedor** | **Ya es la política del código, pero está a medias**: el catálogo está cerrado en 8 sitios y el libro de salud de claves se comparte entre alumnos | Registro de proveedores *data-driven*, salud por cuenta y enrutado derivado **solo** de las claves del alumno (§2.7, Fases 0-3) |
| 3 APIs en paralelo + evaluador interno en cada turno | **No es viable en el chat**: multiplica latencia de cola, coste y probabilidad de 429, y **viola la política de privacidad actual** | Campeón por intención elegido *offline* + *hedging* a partir de 700 ms; comparación 3-vías solo en artefactos asíncronos |
| Agente Entrenador que ajusta prompts en vivo | **Peligroso en caliente** | Auditoría *offline* por muestreo, métricas deterministas primero, versiones de prompt en estado `draft` con puerta y A/B |
| Dibujo Técnico interactivo | **Muy diferencial y viable** | `VisualSpec` validado con Zod + motor geométrico determinista en TS; el modelo **no escribe SVG** |

Tres frases que resumen el criterio:

1. **La inmediatez no se consigue con más IA, sino con menos IA en el camino crítico.**
2. **El paralelismo de proveedores es una técnica de disponibilidad, no de latencia**, y aquí choca con el cupo gratuito y con `docs/PROVEEDORES-IA.md`.
3. **«Cero errores» es inalcanzable; «cero callejones sin salida» sí es un requisito de ingeniería** y se puede verificar.
4. **El proveedor es un dato del alumno, no una constante del producto.** El código no puede tener un proveedor «de la casa»: el que responde es el que el alumno ha pegado, con sus límites, y la interfaz se llama BrainUp en todos los casos.

---

## 1. Punto de partida real (con evidencia, no impresiones)

| Hecho | Dónde | Consecuencia comercial |
| --- | --- | --- |
| No hay streaming en ninguna ruta | `src/app/api` no contiene `ReadableStream`, `text/event-stream` ni `EventSource` (solo `attachments` usa stream de subida) | El alumno espera a que termine **todo** el turno; con 300 palabras son 4-10 s de pantalla congelada |
| El turno del catedrático es un `POST` único con techo de 60 s | `src/app/api/tutor/route.ts:198` | Cualquier cosa por encima del techo del proxy corta a media respuesta; el mensaje del alumno **se guarda solo al final** |
| El cliente espera hasta 60 s sin feedback | `TutorChat.tsx:69` (`CHAT_TIMEOUT_MS`) | Al agotarse, el alumno ve error y el turno puede haberse cobrado igual |
| Todo el árbol es `force-dynamic` | `src/app/layout.tsx:15`, `src/app/page.tsx:22`, `src/app/brainup/[agentId]/page.tsx:26` | Cada navegación ejecuta todas las consultas; el *prefetch* de `next/link` **calienta la base, no la caché** |
| El prompt del turno se compone con ~14 consultas en `Promise.all` + historial completo + ranking de documentos | `src/app/api/tutor/route.ts` (bloque `Promise.all`) | 6-8 saltos de red al pooler antes de llamar al modelo; el presupuesto de 30 s del motor se come este tiempo |
| El motor ya encadena proveedores con presupuesto por turno | `aiEngine.ts:1425` (`AI_TEXT_BUDGET_MS`), `:1434` (7 s/intento, 4 s en Netlify), `:1403` (3 intentos) | Base sólida: **no hay que reescribirlo**, hay que alimentarlo con presupuesto distinto según intención |
| La cadena es secuencial, no paralela | `runAiText`, `for` sobre `queue` | Correcto para cupo; la latencia p95 depende del proveedor elegido |
| El modelo y el proveedor se devuelven al cliente y **se pintan** | `api/tutor/route.ts` (respuesta), `TutorChat.tsx:1725-1730,1808-1813` | **Rompe la marca blanca hoy mismo**: el alumno lee «Groq · llama-3.3-70b» |
| El panel de apuntes compara «motores» con nombre | `TutorChat.tsx:1632-1699,2372` | Segundo punto de fuga de marca blanca |
| El planificador es determinista y ya tiene *advisory lock* e invalidación | `src/lib/planner/engine.ts`, pasos 3-8 de `PROGRESS.md` | El «director» de la propuesta **ya existe en un 60 %**; no hay que sustituirlo |
| La recuperación es léxica y por página | `docContext.rankChunks`, presupuesto 45 000 caracteres | Rápida y citable; falla con sinónimos («efecto Joule» vs «por qué se calienta el cable») |
| Los documentos viven en disco local | `docStore.ts`, `AiAttachment.localPath` | Bomba de relojería en multi-instancia; bloquea el RAG estricto serio (ya anotado en el otro doc) |

**Conclusión del diagnóstico:** la propuesta no parte de cero ni hay que rehacerla.
El 70 % de la infraestructura pedagógica existe; lo que falta es la **capa de
entrega** (streaming, caché, identidad oculta) y tres piezas nuevas (ámbito
estricto, visuales, auditoría). El riesgo real del proyecto no es la IA: es que
hoy la experiencia se percibe lenta y que la marca blanca está rota.

---

## 2. Evaluación crítica de la arquitectura propuesta

### 2.1 Las 3 APIs en paralelo + evaluador: por qué no en el chat

**Modelo de latencia.** Si cada proveedor tarda `T` y se lanzan tres, el turno
espera al **máximo** de los tres, no a la media. Con distribuciones reales de
cola pesada:

| Escenario | Secuencial (campeón) | 3 en paralelo | 3 en paralelo + juez |
| --- | --- | --- | --- |
| p50 por proveedor 1,2 s | ~1,2 s | ~1,9-2,2 s | +0,8-1,5 s → **2,7-3,7 s** |
| p95 por proveedor 4 s | ~1,2 s si el campeón va bien | **~5-6 s** (basta que uno se atasque) | **~7 s** |
| Caída de un proveedor | reintento/cadena | no afecta | no afecta |
| Coste por turno | 1× | **3×** | **4×** |
| Probabilidad de 429 | 1× | **~3×** (misma ventana de cupo) | 4× |
| Proveedores que ven el contenido | 1 | **3** | **4** |

Con el cupo gratuito que documenta el proyecto (se cuenta **por modelo y por
clave**, ver `ESTADO.md` §17-19), el paralelismo convierte un día de estudio
intenso en «sin cupo» tres veces antes. Y en Netlify/serverless el presupuesto
por intento ya baja a 4 s (`aiEngine.ts:1434`): tres llamadas simultáneas no
caben sin recortar la calidad de todas.

**Bloqueo de cumplimiento.** `docs/PROVEEDORES-IA.md` establece como regla de oro
que un alumno **con clave propia** solo viaja a **su** proveedor. La comparación
3-vías envía su conversación a tres proveedores: hoy es una violación de la
política escrita, no una optimización. Cambiarla exige consentimiento explícito
por cuenta y un texto nuevo de privacidad; no es un flag.

**El evaluador como cuarto salto.** Un juez LLM (a) añade latencia, (b) añade
otra cuota, (c) no es reproducible —la misma terna puede ganar distinto según el
día— y (d) puede elegir la respuesta **más larga**, no la mejor, si el prompt no
está calibrado. Para auditar calidad sirve; para decidir en 2 s, no.

**Estrategia recomendada: campeón + *hedging* + evaluación offline.**

```
                     ┌─ si no hay primer token en 700 ms → lanzar suplente (hedge)
petición → campeón ──┤
                     └─ si responde, se cancela el suplente (AbortController)
```

- **Campeón por intención**, elegido con datos: `chat_explicacion`,
  `diagnostico`, `correccion`, `apunte`, `visual`, `idioma`. Una tabla
  `ModelRoute` (o constante versionada) decide; se recalibra con el *harness*
  offline, no en producción.
- **Hedge con presupuesto**: solo si a los 700 ms no ha llegado el primer token
  (no la respuesta completa), y **solo entre proveedores ya autorizados** para
  esa cuenta. El que llega primero gana; el otro se aborta. Esto sí reduce p95
  sin triplicar coste (el hedge ocurre en una minoría de turnos).
- **Fan-out 3-vías + juez** queda reservado a artefactos **asíncronos** donde la
  latencia no importa y el valor sí: corrección de un simulacro, redacción de un
  apunte largo, generación de un examen. Ahí el juez compara y se guarda la
  puntuación; el alumno recibe una sola respuesta.
- **Caché semántica** por cuenta: pregunta normalizada + unidad + versión de
  prompt → respuesta. Dos alumnos preguntando «explícame la derivada de un
  cociente» no deberían pagar dos veces; el mismo alumno repitiendo, tampoco.
- **El juez se mide, no se cree**: 50 pares respuesta A/B con nota humana y se
  calcula correlación. Si el juez no correlaciona, no decide.

**Regla operativa que se puede verificar en CI:** en la ruta del chat, el número
de llamadas a proveedores por turno es **1** (2 solo si hubo hedge) y el
`provider`/`model` **no** aparece en la respuesta HTTP ni en el DOM.

Y todas esas llamadas salen del **perfil BYOK del alumno** (§2.7): el campeón y
el hedge se eligen dentro del conjunto de claves que él ha autorizado. Un perfil
de una sola clave no tiene hedge posible; uno sin claves no llama a nadie.

### 2.2 «Cero latencia» y «cero bloqueos»: qué significa en este código

Tres correcciones al planteamiento:

1. **El chat abierto sin escribir no puede «congelarse»**: es HTTP sin estado. Lo
   que sí se rompe hoy es (a) el turno largo sin feedback, (b) la conversación
   que se pierde si el navegador corta, (c) el mensaje del alumno que **no se
   guarda hasta que la IA termina** (`withTransaction` al final de la ruta). Si
   el proxy corta a los 60 s, el alumno ve error y su pregunta desaparece del
   hilo.
2. **Un SSE permanente mientras el alumno no escribe es peor**: los móviles
   matan sockets en segundo plano, los proxies cierran a los 60-100 s y cada
   pestaña abierta consume una conexión. La solución no es *keep-alive* infinito,
   es **reanudación**: el cliente reconecta con el id del turno y recibe lo que
   quedó escrito.
3. **«Cero errores»** se traduce en: *ningún turno termina en callejón sin
   salida*. Tres niveles, todos ya esbozados en el código:
   - **N1** modelo campeón (streaming).
   - **N2** modelo suplente / hedge.
   - **N3** respuesta local determinista (`tutorFallback.ts`) con datos reales del
     expediente, redactada en tono de producto, sin «⚠️ Sin IA ahora mismo» y sin
     inventar la explicación. La UI la presenta como respuesta normal, con un
     aviso discreto y la opción «reintentar con IA».
   - **N4** (nuevo) último recurso: la explicación cacheada de esa misma pregunta
     para ese alumno, marcada con su fecha.

   Lo que **no** se hace: mentir diciendo que hay IA, ni mostrar el error crudo
   del proveedor, ni un `429` en pantalla.

**Presupuesto de latencia objetivo (medible, no promesa):**

| Operación | p50 | p95 | Cómo se consigue |
| --- | --- | --- | --- |
| Abrir el Cuartel / plan de hoy | 120 ms | 300 ms | `DailyBrief` precalculado + caché de segmento; **0 llamadas a IA** |
| Navegar entre secciones ya vistas | 60 ms | 150 ms | RSC cacheado por etiquetas + *prefetch* en hover |
| Primer token del catedrático | 0,9 s | 2,5 s | streaming + campeón + contexto ya cargado |
| Respuesta completa de 250 palabras | 4 s | 9 s | streaming (se lee mientras llega) |
| Resolver perfil BYOK (caché) | 1 ms | 5 ms | memoria de proceso, TTL 60 s por `(userId, updatedAt)` |
| Resolver perfil BYOK (frío) | 15 ms | 60 ms | 1 `findMany` + descifrados en paralelo (hoy: 4-8 secuenciales) |
| Recuperación léxica de apuntes | 30 ms | 80 ms | en memoria, ya existe |
| Recuperación híbrida (si se enciende) | 120 ms | 250 ms | pgvector + RRF |
| Esquema/visual de una explicación | 1,5 s | 3 s | spec pequeño, no SVG libre |
| Sección de apunte | 1,5 s (primer token) | 6 s | streaming por bloque |

Sin `p50/p95` medidos, cualquier afirmación de «cero latencia» es marketing. Por
eso la Fase 0 es instrumentar.

### 2.3 Mega-Agente Director: deterministic-first, LLM solo donde aporta

Un «director» que en cada apertura llame a un modelo para decidir qué hacer es
el antipatrón exacto de la inmediatez: convierte una consulta de 40 ms en una de
2-4 s y hace que el plan cambie si el proveedor está saturado. Peor: deja de ser
reproducible, y un plan de estudio **tiene que** serlo (el alumno pierde la
confianza si el plan «piensa distinto» cada vez).

Lo que ya existe y hay que **reutilizar como núcleo**:

- `planner/engine.ts`: `capacityFor`, `score`, `pickBlocks`, `interleave`; puro,
  sin reloj global, con tests (`verify-planificador`).
- `ensureTodayPlan` con advisory lock por usuario/día e idempotencia.
- `invalidatePlan` con motivo y versión, disparado por sesión, examen, Moodle y
  horario.
- `proactivity.ts` con ranking determinista y `tutorFallback` con datos reales.

**Diseño propuesto: `DirectorSnapshot` + `DailyBrief`.**

```
                 ┌──────────────────────────────────────────────┐
 eventos ───────►│ invalidatePlan(motivo)                       │
 (sesión,       │   ↓                                          │
  error,        │ buildDailyBrief(userId, day)  ← reglas puras  │
  examen,       │   · capacidad real (horario, sueño, energía)  │
  Moodle)       │   · 3-5 bloques intercalados                  │
                 │   · riesgos (examen a 2 días, racha rota)     │
                 │   · texto de apertura (reglas; IA solo pulido)│
                 └───────────────┬──────────────────────────────┘
                                 ▼
                    PlanState + DailyBrief (materializado)
                                 ▼
             apertura del alumno: 1 lectura, 0 llamadas a IA
```

- El **Mega-Agente** es un *servicio* (`director.ts`) con una política
  determinista y un contrato de datos, no un prompt gigante. Agrega el estado de
  todos los coordinadores en un solo `StudentState` versionado.
- La IA del director se usa en **tres sitios acotados**:
  1. **Narrar** el plan ya calculado («hoy priorizo Física porque el examen es el
     jueves y tu último simulacro bajó 12 puntos»), una vez al día, en `after()`.
  2. **What-if** explícito del alumno («solo tengo 40 minutos y estoy cansado»):
     el LLM traduce a `PlanConstraints` con JSON Schema, y **el motor puro**
     recalcula. Nunca el LLM decide horas ni inventa bloques.
  3. **Explicar** por qué cambió el plan tras una invalidación.
- **Retroalimentación real**: al cerrar cada sesión, `TutorSessionOutcome` ya
  guarda qué se trabajó y qué quedó. Se añade un `adjustedMinutes` (estimado vs
  real) que alimenta la calibración que ya existe en el paso 7. Ese es el bucle
  que «se retroalimenta en tiempo real», y es un `UPDATE`, no una llamada a IA.
- **Presupuesto**: el director nunca bloquea la apertura. Si la narración no está
  lista, se abre el plan y el texto llega 1 s después (streaming de una línea).

**Contrapropuesta explícita a «conectar todos los coordinadores»:** se conectan
por **datos** (una tabla/vista `StudentState` y eventos de invalidación), no por
conversaciones entre agentes. El patrón «agente A le pregunta a agente B» en
tiempo de petición es un árbol de latencias y de costes imposible de depurar.
Los agentes se comunican por el estado, y el estado se lee una vez.

### 2.4 RAG estricto: el foso, y cómo hacerlo infalible de verdad

Lo que ya está bien y se conserva: extracción multiformato (`docRead`), troceado
con página (`docContext`), ranking léxico, presupuesto de 45 000 caracteres,
petición de páginas concretas por parte del modelo y citas `?doc=note:ID`.

Lo que falta para que sea «sagrado»:

1. **Ámbito cerrado por modo.** Tres modos explícitos, no un flag:
   - `estudio` (por defecto en un catedrático): el corpus es **solo** temario del
     alumno (unidades), sus apuntes, materiales de Moodle y documentos subidos.
     Si la pregunta cae fuera, **no se responde con conocimiento general**: se
     dice «esto no está en tu temario» y se ofrece un botón «explorar en modo
     curiosidad».
   - `curiosidad`: abierto, con etiqueta visible en la respuesta («fuera de tu
     temario») y sin mezclarse con el expediente.
   - `examen`: sin pistas, sin resolución, solo corrección.
2. **Contrato de respuesta con citas.** El modelo no devuelve Markdown libre sino
   `{sections:[{text, citations:[{chunkId, page, quote}]}], outOfScope}` validado
   con Zod. El servidor comprueba que `quote` **existe** en el trozo enviado
   (normalizando espacios, tildes y comillas). Cita inválida → sección marcada
   `sin_respaldo`, reintento **una** vez con el error delante, y la UI lo dice.
3. **Cobertura visible.** «12 de 12 apartados con cita · 1 sin respaldo». Es la
   forma honesta de decir «atado a tus fuentes» sin prometer infalibilidad.
4. **Búsqueda híbrida con interruptor.** El ranking léxico falla con sinónimos.
   Se añade `DocumentChunk` con `embedding vector(768)` (pgvector, `$queryRaw`) y
   fusión RRF con el léxico. **Apagado por defecto** hasta que `verify:retrieval`
   demuestre mejora con 25 preguntas reales; si no mejora, se queda apagado.
   Nunca se sustituye el léxico: se suma.
5. **Persistencia de fuentes.** Sin objeto (Supabase Storage, bucket privado,
   prefijo `userId/`) no hay RAG multi-instancia. Esto es **prerrequisito**, ya
   argumentado en `ARQUITECTURA-ESTUDIO-IA.md` §2.1.
6. **Aislamiento**. `userId` en todas las tablas nuevas, RLS reaplicado
   (`brainup_apply_app_rls()` hay que **volver a ejecutarla** tras la migración),
   y el filtro `WHERE userId` en cada consulta aunque el RLS lo cubra.

**Lo que no se promete:** «infalible» no existe con un LLM. Se promete y se
verifica: *toda afirmación con contenido tiene respaldo localizable o se marca
como no respaldada*. Eso es comprobable con código puro y es lo que un padre
puede entender.

### 2.5 Catedráticos visuales y Dibujo Técnico interactivo

**Riesgo del enfoque ingenuo:** pedirle al modelo «genera un SVG» produce
(a) HTML/JS inyectable si se pinta sin sanear, (b) estilos incoherentes entre
explicaciones, (c) geometría incorrecta —una mediatriz que no pasa por el punto
medio— y (d) imposibilidad de animar paso a paso.

**Diseño: el modelo emite datos, el renderizador dibuja.**

```ts
type VisualSpec =
  | { kind: 'diagram'; nodes: {id,label,x,y,role}[]; edges: {from,to,label?}[] }
  | { kind: 'plot'; fn: 'lineal'|'cuadratica'|'seno'|...; params: Record<string,number>; domain:[number,number] }
  | { kind: 'geometry'; construction: GeometryId; params: Record<string,number>; steps: GeometryStep[] }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'molecule'; formula: string; bonds: ... }
```

- Validado con Zod y **rechazado** si no encaja; el servidor re-renderiza a
  partir del spec, nunca del SVG del modelo.
- Registro de renderizadores (`src/components/visual/registry.tsx`) + un único
  `<VisualBlock spec>` dentro de la respuesta del chat, con KaTeX para fórmulas
  y `framer-motion` para las transiciones (ya está en el proyecto).
- El spec se guarda junto al mensaje (JSON versionado) → la explicación se puede
  reabrir, imprimir y auditar sin volver a llamar al modelo.

**Dibujo Técnico merece motor propio, no prompt.** `src/lib/geometry/` con
funciones puras y test (`verify:geometria`):

| Construcción | Salida determinista |
| --- | --- |
| Mediatriz, bisectriz, perpendicular por un punto | recta + punto de corte exactos |
| Tangentes desde un punto exterior a una circunferencia | dos tangentes, puntos de tangencia |
| Intersección recta-circunferencia, circunferencia-circunferencia | 0/1/2 soluciones, sin redondeos a ojo |
| Giro, traslación, simetría, homotecia | matriz 2D aplicada |
| Abatimiento / cambio de plano / diédrico básico | proyecciones y rectas de unión |
| Polígonos regulares, arco capaz, empalmes | vértices y centros exactos |

Cada paso devuelve `{ elementos, resaltado, explicación, cota }`. El modelo elige
**qué construcción** y **qué parámetros**; el motor calcula **dónde**. Así la
línea pasa de verdad por el punto medio, y el alumno puede mover un parámetro y
ver cómo cambia. Es el tipo de rigor que separa a un profesor particular de una
IA genérica, y es la pieza más defendible del producto.

### 2.6 Marca blanca real y Agente Entrenador

**Marca blanca: hoy está rota, y es un cambio pequeño y de alto impacto.**

- `TutorChat.tsx:1725-1730` deriva «Groq/OpenRouter/Local/Gemini» del nombre del
  modelo; `:1808-1813` lo pinta con el modelo. `api/tutor` devuelve `model` y
  `provider`. El panel de apuntes compara «motores» con su nombre.
- Cambio: la respuesta pública pasa a `{ tutor: 'BrainUp', nivel, ... }`; el
  detalle técnico se queda en un log interno con `turnId`. En la UI, «Catedrático
  de Matemáticas» y nada más. Un test (`verify:marca`) comprueba que ninguna
  cadena de proveedor/modelo aparece en el HTML ni en las respuestas de las rutas
  públicas de chat.

**Entrenador: auditoría offline, no auto-modificación en vivo.**

Un agente que reescribe prompts «según lo que ve» en producción es
irreproducible, imposible de auditar y puede degradar a todos los alumnos por un
caso raro. Diseño correcto:

1. **Muestreo** (p. ej. 2 % de turnos + 100 % de turnos con incidencia).
2. **Rúbrica determinista primero** (gratis): ¿citas válidas?, ¿respondió fuera de
   ámbito?, ¿herramienta bien formada?, ¿longitud dentro de rango?, ¿el alumno
   repreguntó lo mismo (señal de fallo)?, ¿abandonó la sesión?
3. **Juez LLM después**, solo sobre la muestra y con el proveedor autorizado de
   la cuenta o con datos anonimizados de plataforma; guarda puntuación y
   justificación.
4. **Propuesta de prompt** en estado `draft` (`PromptVersion`), nunca aplicada
   sola; se valida con el *harness* de evaluación (30 casos dorados por materia y
   modo) y sale al 10 % con *rollback* automático si baja la métrica.
5. **Panel** por materia/modo: precisión de citas, tasa de «no consta», tasa de
   repregunta, tiempo hasta el primer token, abandono.

Eso es «mejora continua» verificable. Lo otro es un generador de regresiones.

### 2.7 Capa BYOK: el alumno decide el proveedor (y hoy hay tres grietas)

**Requisito de producto.** El servicio de IA de cada alumno es **exactamente el
que él configure**: una clave (Groq, Gemini, OpenRouter, NVIDIA, OpenAI,
Anthropic o un endpoint compatible), varias, o ninguna. El motor no asume un
proveedor corporativo, no completa con claves ajenas y no obliga a contratar una
API concreta. La marca que ve la familia es **BrainUp Academy** siempre.

**Lo que ya está construido y se conserva** (no se reescribe):

| Pieza | Dónde | Qué garantiza |
| --- | --- | --- |
| Cifrado por cuenta y proveedor | `lib/ai/userKeyStore.ts`, `lib/security/vault.ts` | AES-256-GCM, AAD `userId:provider`; copiar una fila a otra cuenta no descifra |
| Política de resolución | `lib/ai/credentials.ts` | Clave propia manda; sin clave propia solo la cuenta de plataforma; nunca se cae a la de plataforma |
| Ámbito por petición | `activateAiCredentials` + `AsyncLocalStorage` | Dos alumnos simultáneos no comparten claves; el motor no lee `.env` |
| Validación real de clave | `lib/ai/providerKeyCheck.ts` | Se comprueba contra el endpoint del proveedor antes de darla por válida |
| Estado en Ajustes | `/api/ia/status`, `Mi clave de IA` | El alumno ve qué tiene, qué le queda y qué le falta |

**Grieta 1 — el libro de salud de claves es global (fallo real de aislamiento).**
`ownCredential()` marca **todas** las claves propias con `envVar: 'usuario'`, y el
motor identifica cada clave con `keyId(provider, envVar)` → `gemini#usuario`
(`aiEngine.ts:1076-1077`). Consecuencias medibles:

- Un `429` del alumno A pone en enfriamiento «la clave» que consulta el alumno B:
  B puede ver su Gemini sano como agotado y ser desviado a otro proveedor o al
  respaldo local.
- `keyCalls` suma los usos de todos los alumnos: el reparto de carga por «clave
  menos usada» deja de significar nada.
- `lastGoodKey` es una variable de módulo única: el «último modelo que funcionó»
  de un alumno reordena la cadena de todos.

**Arreglo:** un identificador de libro **por cuenta**, nunca la clave ni algo
reversible: `ledgerId = 'u:' + hmac(userId|provider, SECRETS_KEY).slice(0,12)`.
El enfriamiento, el contador y el último bueno pasan a ser
`Map<ledgerId, …>`; las claves de plataforma conservan su `envVar` real. Prueba
de regresión obligatoria: A con 429 → B sigue con cupo y a la primera.

**Grieta 2 — el catálogo está cerrado en ocho sitios.** Añadir OpenAI, Anthropic
o un endpoint propio exige hoy tocar: unión `AiProvider` (`aiEngine.ts:56`),
`AI_KEY_PROVIDERS` y `providerLabel` (`credentials.ts`), `USER_KEY_PROVIDERS` +
etiquetas + alta + pistas (`keyFormat.ts`), `ModelProviderId` + mapa de variables
(`modelCatalog.ts`), el mapa de comprobadores (`providerKeyCheck.ts`), las ramas
de `runAiText` y el bucle de estado (`aiEngine.ts:2231`, que además **omite
NVIDIA**). Nueve cambios para un proveedor: eso no es flexibilidad, es deuda.

**Grieta 3 — el orden y las capacidades no son del alumno.**
`configuredProviderOrder()` (`aiEngine.ts:1309`) impone Gemini → Groq →
OpenRouter desde el entorno; con BYOK la cadena acaba usando solo las claves
presentes (bien), pero **la prioridad no es la que eligió el alumno**, y el
enrutado por capacidad asume que «visión = Gemini». Un alumno con solo Groq no
puede recibir una imagen, y hoy se le dice tarde y mal. Además,
`resolveAllAiCredentials` (y `readOwnKeys` dentro de `resolveAiCredentials`)
recorren los proveedores con `await` dentro del bucle: **4 lecturas + descifrados
secuenciales** por petición (8 si la ruta resuelve además un proveedor concreto)
antes de llamar al modelo.

**Diseño: perfil de IA del alumno, resuelto una vez por petición.**

```
petición
  → requireUser
  → resolveUserAiProfile(userId)          // 1 findMany + N descifrados EN PARALELO
      { credentials:[{provider, key, priority, models, capabilities, health}],
        consent, zeroKeyPolicy }
  → buildCandidateChain(profile, { intent, requiresVision, requiresTools, requiresJson })
      = proveedores que el alumno tiene
        ∩ capacidades que el turno exige
        ∩ catálogo declarado
      orden: preferencia del alumno → salud de ESA cuenta → coste/latencia histórica
  → campeón + hedge SOLO dentro del perfil
  → si queda vacío: respuesta local (N3) + mensaje neutro;
    jamás se pide prestado otro proveedor
```

| Perfil del alumno | Comportamiento correcto | Hoy |
| --- | --- | --- |
| Solo Groq | Todo por Groq; sin visión, se ofrece PDF con texto o subir por partes | Parcial: el aviso llega después de intentarlo |
| Gemini + Groq | Orden **elegido por el alumno**; hedge entre esos dos; cero llamadas a OpenRouter/NVIDIA | El orden lo impone el entorno |
| Una clave inválida | Se marca solo esa cuenta; el resto de alumnos intacto | **Fuga**: enfriamiento compartido |
| Sin clave y sin autorización de plataforma | `402 ai_key_required` + alta guiada, sin gastar nada | Correcto |
| Cuenta de plataforma | Las claves de plataforma se comportan como un perfil BYOK más | Correcto |
| Endpoint propio (compatible OpenAI) | `baseUrl` HTTPS validada + clave cifrada; SSRF bloqueado | No existe |

**Contrato del adaptador (para que añadir un proveedor sea configuración).**

```ts
type AdapterKind = 'gemini-interactions' | 'openai-chat' | 'anthropic-messages'

interface ProviderDescriptor {
  id: string                 // 'openai', 'anthropic', 'mi-endpoint'
  label: string              // solo Ajustes
  adapter: AdapterKind
  baseUrl?: string           // fijo o aportado por el alumno (validado)
  models: { id: string; vision?: boolean; tools?: boolean; json?: boolean; context?: number }[]
  keyFormat: RegExp
  signupUrl?: string
  check: 'models' | 'chat-minimal' | 'key-endpoint'
}
```

Un proveedor nuevo = **una entrada de catálogo** (JSON versionado) + un adaptador
si habla otro dialecto. Ni el tutor, ni el planificador, ni el director, ni la UI
del chat cambian. Criterio de aceptación de Fase 3: «añadir OpenAI es una entrada
de catálogo, no una refactorización», y `verify:byok` lo demuestra con un
proveedor de mentira.

**Marca blanca con BYOK.** El nombre del proveedor se permite en **un solo
sitio**: Ajustes → Mi clave de IA, porque el alumno tiene que saber qué está
pegando y de dónde sacarlo. Fuera de ahí: ni cabecera del chat, ni burbuja, ni
error, ni respuesta HTTP, ni evento SSE, ni panel de calidad que vea la familia.
Los errores se reescriben en clave de producto («tu proveedor de IA no responde
ahora mismo») y el detalle técnico se guarda en el log interno con `turnId`.

**Capacidades variables, degradación honesta.** El router no promete lo que la
clave del alumno no puede: sin visión, se avisa antes de leer la imagen; sin
`tools`, las herramientas se sustituyen por texto estructurado; sin streaming
nativo, el adaptador simula deltas (la UI no cambia). El alumno nunca ve una
función rota: ve una función adaptada, explicada en una línea.

**Privacidad y consentimiento.** Con varias claves, el alumno elige cuál se usa
para qué (texto, visión, artefactos). El hedge solo puede usar proveedores de su
propio perfil; el fan-out 3-vías del §2.1 sigue prohibido en el chat y, en
asíncrono, exige consentimiento explícito por cuenta. Borrar una clave la borra
del servidor y se le recuerda revocarla en el proveedor.

**Latencia del propio BYOK.** Resolver el perfil no puede costar más que una
consulta: un `findMany`, descifrado en paralelo y caché **en memoria de proceso**
por `(userId, updatedAt)` durante 60 s como máximo. Sin esa caché, cada turno
paga 4-8 descifrados y lecturas; con ella, el coste es ~0 en el 95 % de turnos y
la invalidación es exacta al guardar o borrar una clave.

---

## 3. Blueprint técnico

### 3.1 Capas (de fuera hacia dentro)

```
Cliente (RSC + islas)
  ├─ caché de mensajes y plan (memoria + IndexedDB)
  ├─ optimistic send (mensaje aparece al instante, con id de cliente)
  └─ stream reader (SSE, reconexión por turnId)

Next 16 (Node runtime)
  ├─ caché de segmento/etiquetas  ← student:{id}, plan:{id}:{day}, notes:{subject}
  ├─ StreamingResponse (SSE)      ← heartbeat 15 s, deltas, eventos de herramienta
  ├─ snapshot loader (1 lectura)  ← sustituye las 14 consultas por turno
  ├─ perfil BYOK (1 lectura + descifrado en paralelo, caché 60 s)
  └─ orquestador
       ├─ director determinista (reglas) → PlanState + DailyBrief
       ├─ router BYOK (proveedores del alumno ∩ capacidades ∩ intención)
       ├─ tutor (campeón + hedge, presupuesto 30 s, 1 llamada/turno)
       ├─ recuperador (léxico → híbrido opcional) + validador de citas
       └─ herramientas (problemas, laboratorio, visual, geometría)

Datos
  ├─ Postgres/Supabase (RLS, `app.user_id`) — verdad
  ├─ Storage privado `{userId}/…`          — fuentes
  └─ cola `StudyJob` + tick cada minuto    — trabajos > 60 s
```

### 3.2 Modelo de datos (solo lo nuevo; aditivo y expand-only)

```prisma
// Un turno con estado, para streaming y reanudación.
model AiMessage {
  // …campos actuales…
  clientKey   String?   // idempotencia: mismo envío repetido no duplica
  status      String    @default("done") // streaming | done | failed
  partialText String?   // lo escrito hasta ahora, para reconectar
  turnId      String?   @unique
  @@unique([conversationId, clientKey])
}

// Brief del día: el plan ya «masticado», sin IA en la apertura.
model DailyBrief {
  id              String   @id @default(uuid())
  userId          String
  day             DateTime @db.Date
  planStateId     String?
  headline        String            // «Hoy: Física 25 min y Lengua 20 min»
  blocksJson      String            // copia denormalizada para pintar en 1 lectura
  risksJson       String?
  narration       String?           // la pule la IA en `after()`
  narrationStatus String   @default("pending")
  generatedBy     String   @default("rules")
  version         Int      @default(1)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@unique([userId, day])
}

// Fuentes persistentes y trozos (detalle en ARQUITECTURA-ESTUDIO-IA.md).
model DocumentChunk {
  // …tal como está definido allí, incluido embedding Unsupported("vector(768)")
}

// Ampliación BYOK (aditiva): la fila existente gana prioridad y endpoint propio.
model UserAiKey {
  // …campos actuales (ciphertext, last4, status, lastCheckedAt, lastError)…
  priority    Int      @default(100)  // menor = antes; lo elige el alumno
  isActive    Boolean  @default(true)
  baseUrl     String?               // solo para endpoints compatibles OpenAI (HTTPS)
  modelsJson  String?               // modelos preferidos/allowlist del alumno
  capabilitiesJson String?          // declaradas y comprobadas (vision, tools, json)
  // El libro de salud NO se guarda aquí: es efímero y por cuenta.
}

// Preferencias de enrutado y consentimiento, una por cuenta.
model UserAiPreference {
  // UserProfile gana la relación inversa: aiPreference UserAiPreference?
  userId          String   @id
  user            UserProfile @relation(fields: [userId], references: [id], onDelete: Cascade)
  providerOrderJson String               // ["groq","gemini"] — elección explícita
  fanOutConsentAt DateTime?              // solo para artefactos asíncronos
  showDiagnostics Boolean  @default(false) // panel técnico opcional, nunca en el chat
  updatedAt       DateTime @updatedAt
}

// Especificación visual de una explicación (versionada y cacheable).
model VisualSpecRow {
  id        String   @id @default(uuid())
  userId    String
  turnId    String?
  kind      String   // diagram | plot | geometry | table | molecule
  specJson  String
  specHash  String   // caché: mismo spec, mismo render
  version   Int      @default(1)
  createdAt DateTime @default(now())
  @@unique([userId, specHash])
}

// Calidad y prompts (offline).
model PromptVersion {
  id        String   @id @default(uuid())
  scope     String   // tutor:matematicas:entrenar
  version   Int
  body      String
  status    String   @default("draft") // draft | canary | active | retired
  metricsJson String?
  createdAt DateTime @default(now())
  @@unique([scope, version])
}

model QualityAudit {
  id        String   @id @default(uuid())
  userId    String
  turnId    String
  scope     String
  deterministicJson String   // citas, ámbito, herramienta, longitud…
  judgeScore Float?
  judgeNotes String?
  createdAt DateTime @default(now())
  @@index([scope, createdAt])
}
```

Nada de esto cambia columnas existentes: todo es aditivo. Las tablas nuevas
entran en el bucle de RLS y en `verify:security`.

### 3.3 Protocolo de streaming (SSE)

`POST /api/tutor/stream` (se conserva `/api/tutor` un tiempo como *fallback*).

```
event: meta      { turnId, conversationId, userMessageId }
event: delta     { text: "La derivada de un cociente…" }        (N veces)
event: tool      { kind: "visual"|"noteProposal"|"openNote"|"verification", payload }
event: heartbeat { t }                                          (cada 15 s, comentario `:ping`)
event: done      { degraded:false, measured:null, citationsCoverage:0.92 }
event: error     { code:"sin_respaldo", retryable:true, message:"…" }  (nunca del proveedor)
```

Reglas duras:

1. **El mensaje del alumno se persiste antes** de llamar al modelo (idempotente
   por `clientKey`), y la fila del asistente nace `streaming`.
2. **Cada 400 caracteres** se guarda `partialText` (no en cada token: eso cuesta
   más que la IA).
3. **Reconexión**: `GET /api/tutor/turns/[turnId]/stream` reanuda desde
   `partialText`; si el turno ya terminó, devuelve `done` y el texto completo.
4. **Desconexión del cliente no cancela el turno** (salvo botón «detener»): al
   volver, está completo. Es lo que hace que cambiar de pestaña no pierda nada.
5. **Nada de identidad de modelo** en ningún evento.
6. **Heartbeat solo mientras hay turno abierto**; no se mantiene un SSE en reposo.

### 3.4 Caché y *prefetch* (donde está la sensación de instantaneidad)

Cuatro niveles, con invalidación por etiqueta:

| Nivel | Qué guarda | Invalidación |
| --- | --- | --- |
| L0 navegador | últimos mensajes, plan del día, HTML de apuntes | `revalidateTag` → evento SSE / version en `/api/salud` |
| L1 Next (`'use cache'`/`unstable_cache`) | `student:{id}`, `plan:{id}:{day}`, `subject:{id}`, `notes:{subject}` | al escribir: sesión, examen, nota, Moodle, restricciones |
| L2 Postgres materializado | `DailyBrief`, `PlanState`, calibraciones | `invalidatePlan` (ya existe) |
| L3 IA | respuesta semántica por (cuenta, pregunta normalizada, unidad, versión de prompt) | cambio de prompt o de fuente |

- **Quitar `force-dynamic` de las páginas de lectura** (no de las rutas de IA).
  Es el cambio con mejor relación esfuerzo/impacto de todo el plan.
- **`prefetch` en hover** de la barra lateral, pero **solo tiene sentido con L1**:
  hoy, sin caché, el hover dispara las consultas dos veces.
- **Suspense por bloque**: cabecera y «Ahora» se pintan con el brief; el resto
  (estadísticas, «Después») llega en streaming de RSC. El alumno ve la tarea
  antes de que termine la página.
- **Optimistic UI**: el mensaje del alumno aparece con un id temporal; al llegar
  `meta` se reconcilia. Nunca un spinner de 5 s sin texto.

### 3.5 Enrutado BYOK (sin latencia añadida)

El router nunca parte de un catálogo global: parte del **perfil del alumno**. La
intención elige la forma del turno; el perfil decide quién puede contestarlo.

```
perfil (claves + prioridad + capacidades)
   │
   ├─ filtro duro: ¿tiene la capacidad que el turno exige? (visión, tools, json)
   ├─ filtro duro: ¿esa cuenta está sana? (enfriamiento POR CUENTA)
   ▼
intención ──► ModelRoute(intent) ──► campeón dentro del perfil (1 llamada)
                  │                        │
                  │                        ├─ primer token < 700 ms → seguir
                  │                        └─ no → hedge a OTRO proveedor del perfil
                  │                               (nunca fuera de él; abortar perdedor)
                  └─ cupo agotado → siguiente del ranking del perfil (ya existe)
                       └─ perfil vacío → N3 local + oferta de añadir clave
```

`ModelRoute` es una constante versionada `{intent, preference, hedgePreference,
budgetMs, maxTokens, temperature}` **relativa al perfil**, no ids absolutos: si el
alumno no tiene el proveedor preferido, se elige el siguiente que sí tenga y que
cumpla capacidades. Se recalibra con `scripts/eval-routing.js` (offline, 40
prompts por intención, mide TTFB, coste, citas válidas y nota de un juez) y el
resultado se commitea; no se aprende en caliente.

Tres invariantes que se prueban en CI (`verify:byok`):

1. **Cero llamadas fuera del perfil.** Un alumno con solo Groq no genera ni una
   petición a Gemini/OpenRouter/NVIDIA, ni siquiera en un fallo total.
2. **Cero contaminación entre cuentas.** 429 de A ⇒ B sigue a la primera; el
   contador de uso de A no altera el orden de B.
3. **Cero identidad de proveedor** en respuestas públicas, SSE y DOM del chat.

El *hedging* también es por perfil: solo entre claves que el alumno ya autorizó,
lo que mantiene intacta la regla de `docs/PROVEEDORES-IA.md`. Si el perfil tiene
una sola clave, no hay hedge: se prefiere reintentar y, si no, N3 local.

### 3.6 Flujo del director (una apertura, un camino)

```
GET /  (Cuartel)
  ├─ L1: plan:{user}:{day}  → hit (95 %)  → pintar en <150 ms
  └─ miss → ensureTodayPlan (advisory lock) → reglas → DailyBrief → cachear
             └─ after(): narración IA (no bloquea)

evento (sesión cerrada / examen / Moodle)
  └─ invalidatePlan(motivo, versión)
       └─ revalidateTag('plan:{user}') + 'student:{user}'
            └─ siguiente apertura reconstruye una vez (ya probado en el paso 5)
```

### 3.7 Flujo del catedrático en modo `estudio`

```
mensaje
  ├─ 1 lectura: StudentSnapshot (cacheado) + historial (últimos N)
  ├─ detección determinista de ámbito (unidad/materia/temario)
  │    └─ fuera → oferta «modo curiosidad» (sin llamar al modelo)
  ├─ recuperación: léxica (+ vectorial si RETRIEVAL_MODE=hybrid)
  ├─ prompt: ámbito cerrado + extractos citables + método del profesor + modo
  ├─ stream del campeón (presupuesto 30 s, hedge 700 ms)
  ├─ validador de citas (código puro) → cobertura
  ├─ herramientas: visualSpec / problemas / laboratorio (Zod + motor)
  └─ persistir turno + auditoría muestreada (after)
```

---

## 4. Hoja de ruta priorizada

Criterio de orden: primero lo que **el alumno y el padre perciben** (velocidad,
sensación de producto), después lo que **protege el margen** (cupo y coste),
después el **foso pedagógico** (RAG estricto, visuales), y al final la mejora
continua. Cada fase deja el sistema funcionando y con su `verify:*`.

### Fase 0 — Medir y blindar el contrato BYOK (3-4 días)

- `src/lib/telemetry/turn.ts`: tiempos por etapa (perfil BYOK, auth, snapshot,
  retrieval, proveedor, validación, persistencia) y `Server-Timing` en las rutas.
- `scripts/verify-latencia.js`: 20 turnos canónicos contra la app local; imprime
  p50/p95 por etapa y falla si se supera el presupuesto de §2.2.
- **Contrato BYOK congelado por escrito y por test** (`scripts/verify-byok.js`):
  perfil del alumno = única fuente de proveedores; cero llamadas fuera del
  perfil; capacidades filtradas; identidad oculta. Se ejecuta contra un proveedor
  de mentira (fetch interceptado), sin gastar cuota.
- **Arreglar la grieta 1 ya, antes de escalar**: `ledgerId` por cuenta en
  enfriamiento, contadores y `lastGoodKey`; regresión A/B en el mismo script.
- `resolveUserAiProfile`: un `findMany`, descifrado en paralelo, caché de 60 s por
  `(userId, updatedAt)`, **sobre los cuatro proveedores actuales** (el registro
  data-driven llega en Fase 3). Medir antes/después (hoy: 4 awaits secuenciales
  por resolución, 8 si se resuelve dos veces).

**Salida:** una tabla real de latencias **y** un test que impide que un alumno
vea o gaste las claves de otro. Sin esto, ninguna fase siguiente se puede
declarar «más rápida» ni «aislada».

### Fase 1 — Chat que no se bloquea y marca blanca (4-5 días)

- `POST /api/tutor/stream` + `GET /api/tutor/turns/[id]/stream` (SSE, heartbeat,
  reanudación, cancelación).
- `AiMessage.status/partialText/clientKey/turnId`; guardar el mensaje del alumno
  antes de la IA; `after()` para memoria y plan.
- `TutorChat` con lector SSE, *optimistic send*, botón «detener», reconexión al
  volver a la pestaña y sin `CHAT_TIMEOUT_MS` de 60 s para el cuerpo.
- **Quitar proveedor y modelo de la UI y de la respuesta pública**; `verify:marca`
  pasa a cubrir también los eventos SSE y los errores.
- **Errores neutros con BYOK**: el texto nunca nombra al proveedor; el detalle va
  al log interno con `turnId`. El alumno lee «tu proveedor de IA», no «Groq». 
- Degradación N1→N4 con texto de producto (sin «⚠️») y N3 redactado sin asumir
  un proveedor concreto.

**Salida:** primer token < 2,5 s p95; cambiar de pestaña a mitad no pierde nada;
ningún nombre de modelo en el DOM.

### Fase 2 — Instantaneidad de navegación (4-5 días)

- `loadStudentSnapshot(userId)` con una sola lectura y `'use cache'` por etiquetas.
- `DailyBrief` + `ensureTodayPlan` existente; narración en `after()`.
- Quitar `force-dynamic` de páginas de lectura; `revalidateTag` en las acciones
  que ya invalidan; Suspense por bloque; prefetch en hover.
- `verify:cache`: dos aperturas seguidas = 1 cálculo, 0 IA, misma versión.

**Salida:** abrir el Cuartel < 300 ms p95; navegar entre secciones ya vistas
< 150 ms; el plan del día se ve completo sin esperar a la IA.

### Fase 3 — Enrutado BYOK dinámico y cupo sano (4-5 días)

- **Registro de proveedores *data-driven*** (`src/lib/ai/providers.json` +
  `ProviderDescriptor`) con tres adaptadores: `gemini-interactions`,
  `openai-chat` (Groq, OpenRouter, NVIDIA, OpenAI, endpoints propios) y
  `anthropic-messages`. Sustituye las ocho listas cerradas de §2.7.
- `UserAiPreference.providerOrderJson`: **el alumno ordena sus proveedores** en
  Ajustes; el router obedece ese orden y, a igualdad, la salud de su cuenta.
- `ModelRoute` relativo al perfil + campeón por intención + hedge a 700 ms solo
  dentro del perfil + aborto del perdedor.
- Capacidades por descriptor: sin visión → aviso previo y alternativa; sin
  `json`/`tools` → herramienta en modo texto; sin streaming nativo → deltas
  simulados.
- Caché semántica por cuenta (hash normalizado + unidad + versión de prompt).
- `eval-routing.js` offline; `verify:rutas` exige **1 llamada/turno** (2 con
  hedge), **0 llamadas** en hit de caché y **0 llamadas fuera del perfil**.
- Enviar la comparación 3-vías al camino asíncrono de apuntes/exámenes, no al chat
  y solo con `fanOutConsentAt`.

**Salida:** un alumno con OpenAI pega su clave y funciona sin tocar código; un
alumno con solo Groq nunca genera tráfico a otro proveedor; p95 del chat sin
colas de 5 s; consumo por turno medido y publicado **solo para esa cuenta**.

### Fase 4 — RAG estricto verificable (6-8 días)

- Modos `estudio|curiosidad|examen` con ámbito cerrado y etiqueta visible.
- Contrato de respuesta con citas + validador (normalización de tildes/espacios) +
  cobertura en la UI + «no consta en tu temario».
- `DocumentChunk` en Postgres + Storage privado (cierra la deuda del disco);
  `RETRIEVAL_MODE=lexical|hybrid` con RRF y `verify:retrieval` (recall@5).
- RLS reaplicado y `verify:security` ampliado a las tablas nuevas.

**Salida:** una pregunta fuera del temario **no** se contesta con conocimiento
general; toda sección con contenido tiene cita localizable o se marca; reiniciar
el servidor no borra fuentes.

### Fase 5 — Director y ruta diaria masticada (4-6 días)

- `StudentState` versionado (materias, unidades medidas, errores, exámenes,
  disponibilidad, adherencia, energía).
- `buildDailyBrief` sobre el motor puro existente; eventos → `invalidatePlan`.
- What-if del alumno: LLM → `PlanConstraints` validado → motor recalcula.
- `adjustedMinutes` por sesión cerrada → calibración existente.

**Salida:** el alumno entra, ve tres tareas y pulsa «Empezar»; 0 IA en la
apertura; cambiar de energía o de disponibilidad recalcula en < 300 ms.

### Fase 6 — Catedráticos visuales y Dibujo Técnico (6-10 días)

- `VisualSpec` Zod + registro de renderizadores + `<VisualBlock>` en el chat y en
  los apuntes; spec guardado y reabrible.
- `src/lib/geometry/` con 8-10 construcciones exactas + `verify:geometria`
  (mediatriz, tangentes, intersecciones, giros, abatimiento, polígonos).
- Prompt de Dibujo Técnico: el modelo elige construcción y parámetros, prohíbido
  inventar coordenadas; pasos con resaltado y cota.
- `verify:visual` (spec inválido rechazado, sin HTML crudo, geometría exacta).

**Salida:** una explicación de mediatriz se ve correcta, se puede recorrer paso a
paso y el alumno puede mover un dato y ver la construcción actualizada.

### Fase 7 — Entrenador y calidad continua (4-6 días)

- Muestreo + rúbrica determinista + juez; `QualityAudit`; panel por materia/modo.
- `PromptVersion` con `draft|canary|active`; `eval-harness.js` con 30 casos
  dorados; promoción solo con mejora medida y *rollback*.
- `verify:calidad` (métrica reproducible, sin auto-modificación en runtime).

**Salida:** cada cambio de prompt tiene antes/después; una regresión se detecta en
el *harness*, no en la queja de un padre.

### Fase 8 — Blindaje comercial (continuo)

- Cuotas por cuenta y por artefacto, medidor de coste (`costCents`) visible.
- Borrado completo de fuente (fila + chunks + vector + objeto).
- Carga: 50 alumnos concurrentes contra el pooler; *timeouts* por etapa.
- Privacidad actualizada (embeddings, juez, retención) y consentimiento del
  fan-out si algún día se activa.

**Estimación conjunta:** 6-8 semanas de una persona a tiempo completo para
F0-F5 (lo que cambia la percepción del producto), y 3-4 semanas más para F6-F8.

---

## 5. Lo que NO hay que construir

| Tentación | Por qué no |
| --- | --- |
| Un LLM «director» que decide en cada apertura | Convierte 120 ms en 2-4 s, no es reproducible y depende del cupo |
| Comparar 3 APIs + juez en cada mensaje del chat | 3-4× coste y cupo, p95 peor, viola la política de proveedores propia |
| Auto-modificar prompts con lo que pasa en producción | Irreproducible; un caso raro degrada a todos. Va por `draft` + A/B |
| Generar SVG/HTML libre desde el modelo | Riesgo de inyección y geometría incorrecta; se emite spec y se renderiza |
| SSE permanente «para que no se corte» | Los móviles lo matan; se resuelve con reanudación por `turnId` |
| «Infalible / cero alucinaciones» como promesa | No es verificable; sí lo es «toda afirmación tiene cita o se marca» |
| Microservicio de agentes que se hablan entre sí | Árbol de latencias y costes; se comunican por `StudentState` y eventos |
| Un proveedor «de la casa» como camino por defecto | Impide el BYOK real, ata el precio y filtra contenido a un tercero no elegido |
| Completar el perfil de un alumno con claves de otro proveedor | Gasta una cuenta que el alumno no autorizó; ya está prohibido por escrito, hay que impedirlo por test |
| Enfriamiento/contadores de claves en un libro global | Un 429 de un alumno degrada a todos (§2.7, grieta 1) |
| Enseñar el proveedor «para que se vea que hay IA» | Rompe la marca blanca y expone la cadena interna al cliente |

---

## 6. Decisiones que hacen falta antes de la Fase 3

1. **Consentimiento de fan-out**: ¿se pide a las cuentas con clave propia poder
   comparar 3 proveedores en trabajos asíncronos? Si no, el juez solo compara
   respuestas del mismo proveedor.
2. **Catálogo inicial BYOK**: ¿OpenAI y Anthropic entran en Fase 3, o primero se
   consolida el registro con los cuatro actuales + un endpoint compatible
   genérico? Recomiendo lo segundo: el registro se prueba con un proveedor de
   mentira y añadir OpenAI después es una entrada de catálogo.
3. **Endpoints propios**: ¿se permite `baseUrl` del alumno (autoalojado, Azure,
   LiteLLM) desde el día uno, con validación SSRF y HTTPS obligatoria, o se
   limita a proveedores conocidos hasta tener cuotas por cuenta?
4. **Orden por cuenta**: ¿la prioridad la fija el alumno a mano o se propone la
   más barata/rápida y él la confirma? La segunda enseña menos y acierta más.
5. **Embeddings**: Gemini (cero proveedor nuevo, texto a Google) u Ollama local
   (privacidad, solo equipos potentes). ¿Híbrido por cuenta? Con BYOK, el
   embedding debe salir del perfil del alumno o ser una función de plataforma
   declarada aparte; no se puede usar la clave de embeddings de otro.
6. **Almacén**: Supabase Storage (menos proveedores) o R2 (egreso 0). Bloquea F4.
7. **Juez**: ¿qué proveedor y con qué datos? Si es de plataforma, los turnos
   auditados deben anonimizarse y declararse; si es del alumno, consume su cupo
   y hay que pedir permiso.
8. **Alcance de Dibujo Técnico**: lista cerrada de construcciones para F6 (mi
   propuesta: mediatriz/bisectriz/perpendicular, tangentes, intersecciones,
   giros/simetrías, abatimiento, polígonos, empalmes).

---

## 7. Límites de esta evaluación

- No se ha ejecutado ninguna medición: la tabla de latencia de §2.2 son
  **objetivos**, no resultados. Fase 0 existe precisamente para sustituirlos por
  números.
- Los porcentajes de mejora por caché y *hedging* son estimaciones de diseño;
  dependen de la distribución real de latencia de cada proveedor y del pooler.
- No se ha comprobado la disponibilidad de `pgvector` en el proyecto de Supabase
  ni el plan de Netlify (timeout, concurrencia). Ambas son preflight de F4.
- «Marca blanca» se ha verificado por lectura de código, no en navegador: el
  badge de `TutorChat.tsx:1808-1813` pinta proveedor y modelo, y la respuesta de
  `/api/tutor` los incluye. Es un hallazgo, no una hipótesis.
- El aislamiento BYOK es también un hallazgo de lectura: `ownCredential` asigna
  `envVar: 'usuario'` a todas las claves propias y el motor indexa por
  `provider#envVar` (`aiEngine.ts:1076-1077`), de modo que el enfriamiento y los
  contadores son compartidos. No se ha reproducido con dos cuentas reales porque
  este entorno no tiene sesión; la regresión A/B de `verify:byok` es obligatoria
  antes de cerrar Fase 0.
- No se ha validado ningún proveedor nuevo (OpenAI, Anthropic, endpoint propio):
  el registro y los adaptadores son diseño. La comprobación real de clave y
  capacidades depende de sus endpoints y debe hacerse con 
  `providerKeyCheck` extendido y un `fake` en las pruebas.
- El coste del fan-out asíncrono no se ha medido contra tarifas reales; debe
  hacerse con `costCents` desde el primer artefacto (F4/F7).
