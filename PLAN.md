# PLAN — BrainUp Academy

Regla de reanudación: leer `docs/ENCARGO.md`, este archivo y `PROGRESS.md`;
continuar por el primer paso sin marcar. No rehacer pasos marcados: si hay duda,
ejecutar sus tests.

Cada paso se cierra en **un commit propio** y actualiza `PROGRESS.md` en ese mismo
commit. Una casilla solo se marca cuando su criterio de cierre está verificado:
typecheck, lint, build y los tests del paso, en verde, con la salida real.

**Parada obligatoria** antes de la migración de datos 1e, antes de cualquier
acción destructiva o difícil de deshacer, y siempre antes de desplegar o hacer
push. El despliegue no es un paso del modo autónomo (ver «Fuera de alcance»).

**Base del entorno:** `DATABASE_URL` y `DIRECT_URL` apuntan al pooler de Supabase
en `aws-0-eu-north-1` (base `postgres`), la misma que producción. Las migraciones
de esquema son solo expand; si hace falta algo destructivo, parar y avisar.

## [ ] 1. Identidad única Supabase y migración de datos (1a–1f)

- 1a. Commits separados del trabajo previo de Fase 0 y árbol limpio.
- 1b. `pg_dump` (o Docker `postgres:17-alpine`) y recuentos por tabla en
  `data/backups/`.
- 1c. Login email+contraseña, `/login`, `proxy.ts` (equivalente a
  `middleware.ts` en Next 16), rutas públicas explícitas, `/api/*` 401 sin sesión
  y registro público **deshabilitado**.
- 1d. Cero `user_default` en `src`, scripts, seeds, tests, SQL, service worker y
  cookies; todo por `requireUser()`/`db(userId)`; `db()` sigue rechazándolo.
- 1e. Migración `UserProfile.id` con `DIRECT_URL`, una transacción, FKs
  `ON UPDATE CASCADE`, recuentos antes/después y `ROLLBACK` si descuadra.
- 1f. Mantener los `@default("user_default")` transitorios.

**Cierre:** la cuenta real ve todos sus datos; un segundo usuario ve la app
vacía; `user_default` solo aparece en migraciones históricas, comentarios y los
`@default` transitorios; recuentos coinciden.

## [ ] 2. Esquema expand: PlanState, PlanConstraint y TutorSessionOutcome

Migración **no destructiva** (solo tablas, columnas e índices nuevos; sin tocar
columnas actuales de `StudyBlock`): `PlanState` y `PlanConstraint` con el
contrato de `docs/ENCARGO.md`, más `TutorSessionOutcome` para el resultado de
cada sesión (qué se trabajó, qué quedó pendiente y qué debe entrar en el plan).
Relaciones en `UserProfile` con `onDelete/onUpdate: Cascade`; `@@unique` y
`@@index` según el contrato; sin quitar todavía los defaults históricos.

Antes de aplicar: confirmar la base, backup verificado y que la migración es solo
expand. Si el entorno apunta a producción, dejarlo escrito en `PROGRESS.md`.

**Cierre:** `prisma validate`, migración aplicada y reversible; ninguna escritura
de plan todavía desde la UI.

## [ ] 3. Motor puro del planificador

`src/lib/planner/engine.ts` con `score`, `pickBlocks` e `interleave`; sin base de
datos, sin IA y sin reloj global (recibe `now` y `timezone`). Capacidad al 70 %
del tiempo disponible, energía 0.5/1/1.2, bloques de 10–15 min como mínimo,
3–5 bloques, máximo 2 por materia, `weeklyHoursCap`, horario y restricciones.

**Cierre:** el módulo no importa Prisma ni IA; los tests del paso 4 pasan.

## [ ] 4. Tests del motor

`scripts/verify-planificador.js` con el patrón `scripts/verify-*.js`:
determinismo, capacidad al 70 %, intercalado de materias, energía 0.5/1/1.2,
mínimo 10–15 min, 3–5 bloques, máximo 2 por materia y un examen a 2 días por
delante de una unidad nueva.

**Cierre:** el script sale en verde y cubre cada regla del paso 3.

## [ ] 5. Orquestador y persistencia del plan

`ensureTodayPlan(userId, day)` con `pg_advisory_xact_lock` por usuario/día,
doble comprobación e idempotencia; conserva el `DayPlan` actual y solo sustituye
los bloques pendientes con `origin = 'plan'` (nunca empezados, hechos o
abandonados). Dentro de `$transaction`, solo `tx`; fechas en
`UserProfile.timezone`.

**Cierre:** dos aperturas concurrentes producen un solo plan; no se tocan bloques
empezados/hechos/abandonados; repetir la apertura no duplica nada.

## [ ] 6. `invalidatePlan` y sus disparadores

`invalidatePlan(reason)` desde completar/abandonar una sesión, exámenes, Moodle,
chequeo de clase, cambio de horario, restricciones y el botón Recalcular. No
recalcular en cascada; el motivo se conserva y se muestra al reconstruir.

**Cierre:** cada disparador invalida una vez; la reconstrucción no duplica y
respeta lo ya empezado/hecho/abandonado.

## [ ] 7. Entradas reales del planificador

`loadInputs`, `buildCandidates` y `toRow` contra el código real (`FSRS`,
`ReviewCard`, `ErrorLog`, `MoodleTask`, `Exam`, `ClassPeriod`), reutilizando
`sessionEngine` para objetivo, técnica y descanso. Toda consulta con `userId`.

**Cierre:** el plan se construye con datos reales; la apertura del Cuartel no
llama a ningún modelo.

## [ ] 8. UX del Cuartel: un solo «Ahora»

Un único bloque «Ahora» con botón **Empezar** (cronómetro + material), el resto
plegado, selector de energía, microacción de 2 minutos y arrastre limitado.
Reutiliza `HoyTocaEsto` y `SessionActions`.

**Cierre:** la apertura no llama a ningún modelo; móvil sin scroll horizontal;
el plan se ve y se puede empezar en un toque.

## [ ] 9. Restricciones y contexto real del catedrático

Restricciones con `responseSchema` de Gemini + Zod y confirmación visible antes
de guardar. El primer mensaje del catedrático se genera por reglas con el
expediente real (errores, exámenes, método del profesor), sin gastar IA.
`open_document(kind, query)` se ejecuta en servidor con el `userId` de la sesión;
citas `?doc=note:ID`, apertura `[[abrir:clave]]` + `NoteSplitPanel`, sin SSE; al
modelo solo se le devuelve `{ ok, title }`.

**Cierre:** el modelo nunca recibe ni decide `userId`; abrir un apunte no usa
SSE; el primer mensaje no gasta IA; una restricción inválida se rechaza.

## [ ] 10. Cierre de sesión, corrector, foto y banco

Cierre confirmado por el alumno → `ErrorLog`, `ReviewCard` (con `frontHash`),
`TutorSessionOutcome` e `invalidatePlan`, de forma idempotente. Corrector tipo
tribunal con rúbrica JSON validada con Zod, doble corrección y mediana, sin
inventar notas ni apartados. Foto manuscrita transcrita y corregida sobre la
transcripción, con confianza; si no se puede leer, se dice. Banco de evaluación
por materia/bloque y error absoluto medio, sin ocultarlo cuando es alto.

**Cierre:** una sesión con fallos deja exactamente las tarjetas y el bloque
esperados; repetirla no duplica nada; dos pasadas producen mediana; el MAE se
calcula y se muestra.

## [ ] 11. B3 — Salidas persistentes de la sesión

Pedir intento antes de explicar; la «solución directa» está disponible pero se
registra (`directSolutionCount`) y añade repaso corto.

**Cierre:** una sesión con fallos deja las 3–4 `ReviewCard` y el bloque de
repaso; repetirla no duplica; la solución directa queda registrada.

## [ ] 12. Verificación determinista

SymPy para matemáticas, unidades para física/química y ajuste/estequiometría
para química. Un fallo de verificación se marca, no se convierte en cero
automáticamente; «verificado» solo se muestra si pasó.

**Cierre:** casos de prueba con error detectado y sin falsos positivos en casos
correctos.

## [ ] 13. Proactividad diaria

Propuesta proactiva diaria basada en el plan y en riesgo real (examen próximo,
error repetido, repaso vencido), sin LLM en la apertura y respetando horas de
silencio y push nocturno.

**Cierre:** no hay push nocturno; la propuesta sale del plan y no escribe
`StudyBlock` directamente.

## [ ] 14. B7 — Modos por materia

Modos visibles por materia (Diagnosticar, Entrenar, Simulacro, Corregir,
Preparar examen) con un módulo de flujo por materia.

**Cierre:** cada modo cambia la pedagogía; la proactividad y el repaso pasan
solo por `invalidatePlan`.

## Fuera de alcance del modo autónomo

- **Despliegue, publicación y `git push`**: requieren autorización explícita del
  autor y no son un paso del plan.
- **Registro público**: no se activa hasta pasar el test de aislamiento.
- **Quitar los `@default("user_default")`**: es un contrato posterior (1f).
