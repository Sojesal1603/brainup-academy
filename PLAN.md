# PLAN — BrainUp Academy

Regla de reanudación: leer `docs/ENCARGO.md`, este archivo y `PROGRESS.md`;
continuar por el primer paso sin marcar. No rehacer pasos marcados: si hay duda,
ejecutar sus tests.

Cada paso se cierra en **un commit propio** y actualiza `PROGRESS.md` en ese mismo
commit. Una casilla solo se marca cuando su criterio de cierre se ha verificado.

## [ ] 1. Identidad única Supabase y migración de datos (1a–1f)

- 1a. Commits separados de Fase 0 y árbol limpio.
- 1b. `pg_dump` y recuentos por tabla.
- 1c. Login email+contraseña, `/login`, `proxy.ts`, rutas públicas explícitas,
  `/api/*` 401 sin sesión y registro público deshabilitado.
- 1d. Cero `user_default` en `src`, scripts, seeds, SQL, service worker y
  cookies; todo por `requireUser()`/`db(userId)`.
- 1e. Migración `UserProfile.id` con `DIRECT_URL`, una transacción, FKs
  `ON UPDATE CASCADE`, recuentos antes/después y `ROLLBACK` si descuadra.
- 1f. Mantener los `@default("user_default")` transitorios.

**Cierre:** la cuenta real ve todos sus datos; un segundo usuario ve la app
vacía; `user_default` solo aparece en migraciones históricas, comentarios y los
`@default` transitorios; recuentos coinciden.

## [ ] 2. Modelos `PlanState` y `PlanConstraint`

Migración expand, relaciones y FKs con `onDelete/onUpdate: Cascade`, sin quitar
los defaults históricos.

**Cierre:** `prisma validate`, migración aplicada y reversible; ninguna escritura
de plan todavía desde la UI.

## [ ] 3. Motor puro del planificador

`src/lib/planner/engine.ts` con `score`, `pickBlocks` e `interleave`; sin base de
datos, IA ni reloj global.

**Cierre:** `scripts/verify-planificador.js` prueba capacidad 70 %, energía
0.5/1/1.2, mínimo 10–15 min, 3–5 bloques, intercalado y determinismo.

## [ ] 4. Orquestador y persistencia del plan

`buildTodayPlan`, `persistTodayPlan`, advisory lock por usuario/día,
`invalidatePlan`, timezone del perfil y transacciones con `tx`.

**Cierre:** dos aperturas concurrentes producen un solo plan; no se tocan bloques
empezados/hechos/abandonados; una invalidación reconstruye sin duplicar.

## [ ] 5. Cuartel: un solo “Ahora” y microacción

3–5 bloques, energía opcional, microacción y push PWA; sin IA al abrir.

**Cierre:** la apertura no llama a ningún modelo; móvil sin scroll horizontal;
el plan se ve y se puede empezar en un toque.

## [ ] 6. Contexto real de los catedráticos (B1–B2)

Primer mensaje por reglas con expediente real; citas `?doc=note:ID`; apertura
`[[abrir:clave]]` + `NoteSplitPanel`, ejecutada en servidor con el `userId` de la
sesión; al modelo solo `{ok, title}`.

**Cierre:** el modelo nunca recibe ni decide `userId`; abrir un apunte no usa
SSE; el primer mensaje no gasta IA.

## [ ] 7. Corrector tipo tribunal (B4)

Rúbrica JSON con Zod, doble corrección y mediana, bloques y notas sin inventar.

**Cierre:** dos pasadas producen mediana; entradas/salidas inválidas se rechazan;
no se recalifica en silencio.

## [ ] 8. Verificación matemática, unidades y química

SymPy para matemáticas, unidades para física/química y ajuste/estequiometría para
química; los fallos se marcan, no se convierten en cero automáticamente.

**Cierre:** casos de prueba con error detectado y sin falsos positivos en casos
correctos.

## [ ] 9. Cierre de la Parte A y B base

Integración, migraciones, limpieza, documentación y verificación completa.

**Cierre:** `tsc`, `prisma validate`, tests del motor y flujo manual de Cuartel y
tutor sin regresiones; sin `user_default` en código.

## [ ] 10. Despliegue controlado y comprobación de aislamiento

Solo con autorización explícita. Aplicar migraciones, desplegar y repetir el test
de dos usuarios.

**Cierre:** cuenta real con datos; segundo usuario vacío; logs sin errores de
identidad; rollback documentado.

## [ ] 11. B3 — Salidas persistentes de la sesión

`TutorSessionOutcome`, `ErrorLog`, 3–4 `ReviewCard`, bloque de repaso vía
`invalidatePlan`; idempotencia.

**Cierre:** una sesión con fallos deja exactamente las tarjetas y el bloque
esperados; repetirla no duplica nada.

## [ ] 12. B5 — Foto manuscrita

Subida, transcripción y corrección sobre la transcripción; imagen local cuando
no haga falta enviarla; aviso si no se puede leer.

**Cierre:** una foto legible corrige; una ilegible se rechaza con motivo; no se
inventa contenido.

## [ ] 13. B6 — Banco de evaluación y error absoluto medio

Banco por materia/bloque, calibración del corrector y reporte de MAE.

**Cierre:** el MAE se calcula contra el banco y se muestra; un MAE alto no se
oculta.

## [ ] 14. B7 — Proactividad y modos por materia

Avisos con riesgo real, horas de silencio, modos de exposición/problemas/
laboratorio/comentario/idioma y bloque de repaso solo vía `invalidatePlan`.

**Cierre:** no hay push nocturno; cada modo cambia la pedagogía; la proactividad
no escribe `StudyBlock` directamente.
