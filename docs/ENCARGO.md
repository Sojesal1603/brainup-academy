# ENCARGO — BrainUp Academy, Partes A y B

> **Nota de recuperación (2026-11-12).** La conversación se compactó y el texto
> literal del encargo original ya no está disponible en esta sesión. Este
> documento conserva **todos los requisitos, decisiones y contratos de código**
> que sí quedaron registrados. Si el autor pega el texto original, se sustituirá
> este archivo sin cambiar el plan ni el progreso.

## 0. Objetivo

Convertir BrainUp Academy en una app multiusuario real y cerrar dos frentes:

- **Parte A — Planificador determinista.** Al abrir el Cuartel, el plan del día
  ya está decidido por reglas, sin IA, con los datos reales del alumno.
- **Parte B — Catedráticos IA con contexto real.** Responden con el expediente
  del alumno, abren apuntes guardados, persisten el resultado de cada sesión y
  corrigen como un tribunal.

La identidad es **una sola en todo el repo**: Supabase Auth, un `userId` de
sesión, una migración de datos y un despliegue. No se activa solo el vertical
del planificador.

## 1. Paso 1 obligatorio y bloqueante: identidad única

### 1a. Punto de partida limpio

- Revisar y commitear por separado el trabajo previo de Fase 0.
- No mezclarlo con la migración de identidad.
- Dejar el árbol limpio antes de tocar datos.

### 1b. Copia de seguridad

- `pg_dump` o punto de restauración antes de tocar datos.
- Anotar el recuento de filas por tabla.
- Guardar la copia y los recuentos en `data/backups/`.

### 1c. Login mínimo con Supabase

- Email + contraseña (o magic link), página `/login`.
- `middleware.ts`/`proxy.ts` que refresca la sesión en cada petición.
- Rutas públicas explícitas; todo lo demás exige sesión.
- `/api/*` sin sesión responde **401** en JSON.
- Registro público **deshabilitado** en Supabase hasta pasar el test de
  aislamiento. Solo existen la cuenta real y un segundo usuario de prueba creado
  con la API de admin.

### 1d. Sustituir todos los `user_default`

- Buscar en `src`, `scripts`, seeds, tests, SQL, service worker y cookies.
- Toda lectura/escritura pasa por `requireUser()` / `db(userId)`.
- `db()` sigue rechazando `user_default`; no se relaja.
- Si algo no se puede migrar todavía, se lista con su motivo antes de seguir.

### 1e. Migración de datos

- Usar `DIRECT_URL`, en **una transacción**.
- `UPDATE "UserProfile" SET id = '<uuid de auth.users>' WHERE id = 'user_default'`.
- Comprobar en el SQL de las migraciones que todas las FKs relevantes tienen
  `ON UPDATE CASCADE`.
- Comparar recuentos por tabla antes y después.
- Si algo no cuadra: `ROLLBACK` y avisar.

### 1f. Contrato

- **No quitar todavía** los `@default("user_default")` del esquema.
- Eso va en un paso posterior (contract), cuando todo funcione.

### Criterio de cierre del paso 1

1. El alumno entra con su cuenta real y ve **todos** sus datos.
2. Un segundo usuario de prueba ve una app vacía y **ninguno** de los datos del
   primero.
3. Buscar `user_default` no devuelve nada fuera de migraciones históricas,
   comentarios y los `@default` transitorios del esquema.

## 2. Parte A — Planificador determinista

### 2.1 Modelos

Añadir, en migración expand:

```prisma
model PlanState {
  id            String   @id @default(cuid())
  userId        String
  day           DateTime
  status        String   @default("draft") // draft | active | invalidated
  energy        Float?
  capacityMin   Int?
  decidedAt     DateTime?
  invalidatedAt DateTime?
  version       Int      @default(1)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  user UserProfile @relation(fields: [userId], references: [id], onDelete: Cascade, onUpdate: Cascade)

  @@unique([userId, day])
  @@index([userId, status])
}

model PlanConstraint {
  id        String   @id @default(cuid())
  userId    String
  planId    String
  kind      String
  payload   Json
  createdAt DateTime @default(now())

  user UserProfile @relation(fields: [userId], references: [id], onDelete: Cascade, onUpdate: Cascade)
  plan PlanState   @relation(fields: [planId], references: [id], onDelete: Cascade, onUpdate: Cascade)

  @@index([userId, planId])
}
```

### 2.2 Motor puro

Vive en `src/lib/planner/engine.ts`. No toca base de datos, no llama a IA, no lee
la hora del sistema: recibe `now`, `timezone` y los candidatos.

Contrato mínimo:

```ts
export interface PlanCandidate {
  key: string;
  topicId: string;
  subjectId: string;
  title: string;
  subjectName: string;
  minutes: number;
  priority: number;      // 0..1
  deadline?: Date | null;
  mastery: number;       // 0..1
  difficulty: number;    // 0..5
  kind: 'repaso' | 'nuevo' | 'examen' | 'error' | 'clase';
}

export interface PlanContext {
  now: Date;
  timezone: string;
  energy: 0.5 | 1 | 1.2; // baja | normal | alta
  capacityMin: number;   // 70 % del tiempo disponible
  minBlockMin: number;   // 10–15
  maxBlocks: number;     // 3–5
}

export function score(candidate: PlanCandidate, context: PlanContext): number;
export function pickBlocks(
  candidates: PlanCandidate[],
  context: PlanContext
): PlanCandidate[];
export function interleave(blocks: PlanCandidate[]): PlanCandidate[];
```

Reglas:

- Capacidad = **70 %** del tiempo disponible.
- Energía: **0.5 / 1 / 1.2**.
- Bloques de **10–15 min** como mínimo.
- **3–5 bloques** visibles.
- No tocar bloques empezados, hechos o abandonados.
- Intercalar materias; no dos bloques seguidos de la misma materia si hay
  alternativa.
- Un solo “Ahora” en la interfaz.
- La IA **no** decide el plan ni escribe `StudyBlock` en la apertura.

### 2.3 Orquestador de servidor

- `buildTodayPlan(userId, now, energy)` lee datos reales y llama al motor.
- `persistTodayPlan(userId, plan)` escribe `PlanState`, `PlanConstraint` y
  `StudyBlock` en una transacción.
- Advisory lock por `userId` + día para que dos aperturas simultáneas no creen
  dos planes.
- `invalidatePlan(userId, reason)` marca el plan como invalidado; el planificador
  lo reconstruye sin tocar lo ya empezado/hecho/abandonado.
- Fechas y “hoy” en `UserProfile.timezone` (por defecto `Europe/Madrid`).
- Migraciones expand/contract; toda consulta lleva `userId`.
- Dentro de `$transaction` usar solo `tx`.
- Zod en entradas de Server Actions y salidas de Gemini.

### Criterio de cierre de la Parte A

- Abrir el Cuartel no llama a ningún modelo.
- Dos aperturas concurrentes producen un único plan.
- El plan respeta capacidad, energía, mínimo, número de bloques e intercalado.
- Los bloques ya empezados/hechos/abandonados no se reescriben.
- Tests del motor con el patrón `scripts/verify-*.js`.

## 3. Parte B — Catedráticos IA

### 3.1 Primer mensaje por reglas

El primer mensaje del catedrático se construye con **reglas y datos reales** del
expediente: unidad actual, exámenes próximos, errores sin dominar, repasos
vencidos y apuntes guardados. No se gasta una llamada de IA solo para saludar.

### 3.2 Citas y apertura de apuntes

- Las citas van a `?doc=note:ID`.
- Los apuntes guardados se abren con `[[abrir:clave]]` y `NoteSplitPanel`.
- **SSE descartado.**
- Requisitos innegociables:
  - la apertura se ejecuta en servidor con el `userId` de la sesión;
  - el modelo **nunca** decide `userId`;
  - al modelo solo se le devuelve `{ ok, title }`.

### 3.3 Salidas persistentes (B3)

- `TutorSessionOutcome` registra el resultado de cada sesión: qué se trabajó,
  qué quedó pendiente y qué debe entrar en el plan.
- Si hay fallos, se crea/actualiza `ErrorLog` y **3–4 `ReviewCard`**.
- Se añade un bloque de repaso mediante `invalidatePlan`.
- Idempotente: repetir la misma sesión no duplica tarjetas ni errores.

### 3.4 Corrector tipo tribunal (B4)

- Rúbrica en JSON, validada con Zod.
- Doble corrección y **mediana**.
- Foto manuscrita admitida.
- Comparación con el banco de evaluación y **error absoluto medio**.
- No se inventan notas ni apartados.

### 3.5 Foto manuscrita (B5)

- Subida de foto/PDF, transcripción y corrección sobre la transcripción.
- La imagen no se envía al modelo si no hace falta; se guarda localmente.
- Si la transcripción es insuficiente, se dice y se pide otra foto.

### 3.6 Banco de evaluación y MAE (B6)

- Banco de preguntas/respuestas de referencia por materia y bloque.
- El corrector se calibra contra el banco.
- Se reporta el error absoluto medio y no se oculta cuando es alto.

### 3.7 Verificación SymPy/unidades/química

- Verificación simbólica cuando el bloque es matemático.
- Verificación de unidades cuando el bloque es físico/químico.
- Verificación de ajuste de ecuaciones y estequiometría cuando es química.
- Un fallo de verificación se marca; no se convierte automáticamente en cero.

### 3.8 Proactividad y modos por materia (B7)

- El catedrático propone repaso cuando detecta riesgo real (examen próximo,
  error repetido, repaso vencido).
- Respeta horas de silencio y no manda push de madrugada.
- Modos por materia: exposición, resolución de problemas, laboratorio,
  comentario de texto, idioma, etc.
- La proactividad no escribe `StudyBlock` sin pasar por `invalidatePlan`.

## 4. Decisiones cerradas

- Una única identidad Supabase para todo el repo.
- `proxy.ts` (equivalente a `middleware.ts` en Next 16); no se crean ambos.
- Se elimina la puerta antigua `AUTH_USER`/`AUTH_PASSWORD`/`authGate.ts`.
- `currentTenant()` memoizado con `cache()` centraliza `requireUser()` + `db()`.
- `db()` rechaza `user_default`; no se relaja.
- Backup con Docker `postgres:17-alpine` + `pg_dump` cuando no hay binario local.
- Migraciones expand/contract.
- Un commit por paso.
- Tests con `scripts/verify-*.js`.
- Sin IA en la apertura del Cuartel.
- SSE descartado.

## 5. Respuestas posteriores del autor

### 5.1 Identidad primero para toda la app

> «SÍ, identidad primero, pero NO solo el vertical Planificador. El planificador
> lee Topic, Exam, ErrorLog, ReviewCard, ClassPeriod, MoodleTask, etc., y todas
> esas filas cuelgan de `user_default`. Si solo el vertical usa mi UUID real, ve
> una app vacía; si muevo los datos al UUID, el resto de la app (aún en
> `user_default`) se queda en blanco. El cambio de identidad debe ser único en
> todo el repo: una fuente de userId, una migración de datos, un despliegue.»

Se mantiene el orden 1a–1f y el criterio de cierre del paso 1.

### 5.2 `open_document` sin SSE

> «SOBRE SSE: no hace falta. Adapta `open_document` al flujo actual
> `[[abrir:clave]]` + `NoteSplitPanel`. Requisitos innegociables: se ejecuta en
> servidor con el userId de la sesión, el modelo nunca decide userId, y al modelo
> solo se le devuelve `{ok, title}`.»

### 5.3 Modo autónomo

El modo autónomo puede avanzar solo entre pasos, pero tiene una **parada
obligatoria** y una lista de prohibiciones.

**Parada obligatoria antes de:**

- borrar o migrar datos de producción sin copia verificada;
- cambiar la identidad o el alcance de `userId`;
- desplegar, publicar o hacer `git push`;
- cambiar secretos, DNS o configuración de un servicio externo;
- ejecutar cualquier acción destructiva o difícil de deshacer.

**Prohibiciones:**

- No inventar datos del alumno ni resultados de tests.
- No desactivar, debilitar ni saltar tests para que pasen.
- No añadir supresiones de tipos/lint para ocultar un fallo.
- No usar `user_default` en código nuevo.
- No dejar que el modelo decida `userId`.
- No escribir `StudyBlock` desde la IA en la apertura del Cuartel.
- No mezclar pasos en un mismo commit.
- No reescribir pasos ya marcados sin ejecutar sus tests.
- No decir que algo está probado si solo se ha compilado.
