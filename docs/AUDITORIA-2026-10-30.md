# Auditoría de BrainUp Academy — 30 de octubre de 2026

**Encargo:** convertir la app en un producto estable, accesible desde cualquier
dispositivo, instalable en móvil y capaz de arrancar sola, sin depender de un CMD.

**Lo que se ha hecho ya en esta sesión:** el arranque automático sin CMD (tarea de
Windows + icono propio + autorreparación). El resto del documento es el
diagnóstico y el plan; **no se ha tocado** nada de datos, autenticación ni diseño,
porque son decisiones que requieren tu aprobación.

---

## 1. Resumen ejecutivo

BrainUp Academy es una aplicación **local de un solo usuario**, y está bien
construida para eso: 148 archivos TypeScript, 21 pantallas, 20 rutas de API,
Prisma con 25 modelos, y un mantenimiento propio que revisa y anota fallos. La
calidad del código y la ambición del producto están muy por encima de un
prototipo.

Pero **todo el producto vive dentro de este ordenador**: la base de datos es un
archivo SQLite, los PDFs y capturas están en `data/uploads`, las claves de IA en
`.env`, y el servidor solo existe mientras este PC esté encendido. No hay login:
cualquier dispositivo en la misma Wi-Fi puede leer y escribir todo. Y el móvil no
puede instalar la PWA porque el service worker exige HTTPS, que hoy no existe.

El salto a la nube no es "subir la carpeta". Son tres cambios de fondo, en este
orden:

1. **Autenticación** (sin ella, publicar la app es publicar tus datos).
2. **Datos fuera del disco local** (base de datos y archivos).
3. **Servidor persistente con HTTPS** (y una URL estable).

El arranque automático ya está resuelto y verificado.

---

## 2. Mapa de la arquitectura actual

| Capa | Qué hay hoy | Dónde vive |
|---|---|---|
| Interfaz | Next.js 15.1.7 (App Router), React 19, Tailwind 3.4 | `src/app` (21 páginas) |
| Componentes | 17 entradas de navegación, tarjetas de ajustes, panel de errores | `src/components` |
| API | 20 `route.ts` bajo `src/app/api` (tutor, apuntes, Moodle, salud…) | `src/app/api` |
| Lógica | Planificador, SRS, retos, Moodle, motor de IA | `src/lib` (148 archivos TS en total) |
| Datos | **SQLite** vía Prisma 5.22 (25 modelos) | `prisma/dev.db` |
| Archivos | PDFs, capturas, materiales de Moodle | `data/uploads` (48 MB en `data/`) |
| IA | Gemini, Groq, OpenRouter, Ollama local; reparto de claves | `.env` + `src/lib/aiEngine.ts` |
| Mantenimiento | `vigilante.js` revisa, repara y anota en `SystemIssue` | `scripts/` + `data/logs` |
| Servido | `scripts/sirve.js` (vigila Next), hoy en **modo desarrollo** | sin `BUILD_ID` |
| Pruebas | 25 scripts `verify:*` manuales; sin runner ni CI | `scripts/verify-*.js` |

**Estado de ejecución comprobado hoy:** la app responde en `http://localhost:3000`
con base de datos OK (9 materias, 103 temas, 5 apuntes, 37 días de memoria de IA)
y proveedores `gemini`, `groq`. El servidor está en modo desarrollo: no existe
`.next/BUILD_ID`.

---

## 3. Qué depende hoy de este ordenador

Todo lo que sigue se cae si el PC se apaga, se suspende o se queda sin red:

- **La base de datos**: `DATABASE_URL="file:./dev.db"`.
- **Los archivos**: adjuntos del tutor, materiales de Moodle y copias en
  `data/uploads`.
- **Las claves**: `.env` (Gemini, Groq, OpenRouter, OpenAI, Notion). `.gitignore`
  las excluye del repositorio, que está bien, pero no existen en ningún otro sitio.
- **La sesión de Moodle**: la contraseña se guarda cifrada con una clave **local
  del equipo** (`localSecrets.ts`). En otro host no se puede descifrar.
- **El servidor**: `sirve.js` es un proceso de Windows. Si el PC no está, no hay
  app.
- **El mantenimiento**: el vigilante corre en el mismo PC; en la nube necesita un
  cron o un worker.

---

## 4. Lo arreglado hoy: arranque automático, sin CMD

### Problema

Cada arranque dependía de un doble clic en un `.cmd`. Y antes había un `.ps1` que
desapareció (igual que el `.vbs` anterior): Windows Defender borra scripts que
abren procesos ocultos. El instalador se quejaba, con razón, de que faltaba un
script.

### Solución aplicada

- **Una sola tarea de Windows** (`BrainUp Academy`) con dos disparadores:
  - al iniciar sesión,
  - cada 5 minutos (latido).
- La acción es **PowerShell oculto → Node → `scripts/sirve.js`**. No hay `-File`:
  el comando va en la propia línea, así que **no hay ningún script que pueda
  faltar**.
- Se registra con principal **`Limited`** (nunca administrador), `IgnoreNew` (no
  se solapan dos latidos) y `StartWhenAvailable`.
- **Dos iconos** (escritorio y menú Inicio) que abren la app con
  `scripts/abre.js`: si la app ya está en pie, abre el navegador en menos de un
  segundo; si no, pide el arranque a la tarea, espera a que `/api/salud` responda
  de verdad y solo entonces abre el navegador. Si en 2,5 minutos no responde,
  abre una página local con el motivo y los últimos 45 renglones del diario.
- **Cerrojo de arranque** (`data/logs/arranque.lock`): dos procesos no pueden
  levantar dos Next sobre el mismo `.next`.
- **Autorreparación**: `sirve.js` vuelve a habilitar la tarea al arrancar. Si
  Windows o un antivirus la deshabilitan, abrir la app la deja reparada.
- **Diario del latido** (`data/logs/latido.log`): una línea por comprobación, para
  poder demostrar que late en vez de suponerlo.

### Verificación realizada

| Comprobación | Resultado |
|---|---|
| Sintaxis de `sirve.js`, `abre.js`, `instala-arranque.js` | 0 errores (`node --check`) |
| Tarea registrada | `Ready`, habilitada, principal `ojeda / Limited / Interactive` |
| Disparadores | `MSFT_TaskLogonTrigger` + `MSFT_TaskTimeTrigger` (cada 5 min) |
| Acción guardada | `powershell.exe … node.exe … sirve.js` con `WorkingDirectory` correcto |
| Ejecución real de la tarea | `LastTaskResult = 0`, app respondiendo `200` |
| Iconos | escritorio y menú Inicio existen; destino `node.exe` + `abre.js`; icono propio `brainup.ico` |

**Lo que no se puede verificar sin reiniciar el equipo:** que Windows ejecute la
tarea en el próximo inicio de sesión. Los disparadores y el resultado 0 son la
prueba disponible; el reinicio es la prueba definitiva.

---

## 5. Los 20 problemas, por gravedad

### P0 — bloquean la nube o exponen datos

| # | Problema | Causa raíz | Plan |
|---|---|---|---|
| 1 | **Sin autenticación ni permisos.** 20 rutas API abiertas; cualquier móvil en la Wi-Fi lee y escribe todo. | App de un solo usuario en un PC privado. | Login + cookie de sesión `httpOnly` firmada; proteger cada ruta y cada mutación. **Requiere aprobación.** |
| 2 | **Datos atados al PC**: SQLite y `data/uploads`. | Diseño local-first. | Fase 1: disco persistente en el host. Fase 2: Postgres + almacenamiento de objetos. **Aprobación.** |
| 3 | **Identidad fija `user_default`** repetida 48 veces. | Singleton de Prisma. | Añadir `userId` a los modelos y filtrar por sesión; migración de datos. **Aprobación.** |
| 4 | **Moodle no viaja**: contraseña cifrada con clave local y token en claro en SQLite. | Cifrado pensado para un solo equipo. | Clave en variable de entorno, rotar el token y volver a conectar Moodle tras migrar. **Aprobación.** |
| 5 | **PWA no instalable en el móvil**: sin HTTPS no hay service worker. | Solo se sirve por `http://` en la LAN. | Desplegar con TLS y URL estable (incluido en el hosting). |
| 6 | **Servidor en modo desarrollo** (sin `BUILD_ID`). | `sirve.js` usa `next dev` si no hay compilación. | `next build` + `next start`; el arranque ya lo detecta solo. |
| 7 | **TLS desactivado globalmente** en `next.config.js` (`NODE_TLS_REJECT_UNAUTHORIZED='0'`). | Parche para un certificado concreto. | Quitarlo y confiar en el certificado correcto; verificar Moodle y proveedores. |
| 8 | **Sin copias automáticas.** `db:backup` es manual. | No hay programación. | Copia diaria + retención + **prueba de restauración** mensual. |
| 9 | **Sin monitorización externa.** Si el host cae, nadie se entera. | Todo vive en logs locales. | Uptime sobre `/api/salud` + alerta por correo; Sentry o equivalente para errores. |
| 10 | **Sin límite de peticiones a la IA.** Con URL pública, cualquiera puede gastar tus cupos. | No hay middleware de cuota. | Límite por sesión/IP y tope diario; registrar consumo. |

### P1 — calidad y experiencia

| # | Problema | Causa raíz | Plan |
|---|---|---|---|
| 11 | **Sin pruebas automatizadas ni CI.** Hay 25 `verify:*`, pero ninguno corre solo. | Verificación manual. | Runner (Vitest/Node test) + CI que ejecute lint, tipos y `verify:*` clave. |
| 12 | **Escrituras a disco desde el servidor** (`data/`). | Todo asume un disco local. | Abstracción de almacenamiento: disco en fase 1, objeto en fase 2. |
| 13 | **Errores sin alertas**: `SystemIssue` y logs, pero nadie recibe aviso. | Mantenimiento local. | Monitorización externa y agrupación de errores. |
| 14 | **Zoom bloqueado** (`maximumScale: 1`). | Evitar el zoom accidental. | Quitarlo: WCAG 1.4.4 y usuarios con baja visión. Revisar foco y contraste con axe. |
| 15 | **Iconos PWA `any maskable`** en ambos tamaños. | Atajo del manifest. | Iconos maskable dedicados (zona segura) y uno normal para iOS. |
| 16 | **Sin página offline** para navegaciones (el SW no toca páginas a propósito). | Evitar el falso `ERR_FAILED` del servidor recompilando. | `offline.html` estática, mostrada solo si no hay red **y** el origen no responde. |
| 17 | **Rendimiento sin medir**: 1,1 GB de dependencias y desarrollo al vuelo. | Nunca se ha medido en producción. | Build de producción, medir LCP/INP/CLS y presupuesto por página. |
| 18 | **Moodle y mantenimiento dependen de un proceso local.** | Pensados para el PC. | Cron/worker en el host; reintentos y estado visible en Ajustes. |
| 19 | **Copia de interfaz desactualizada**: el pie dice «Sistema Local · SQLite DB Activa · 100% Offline» y 17 entradas en el menú. | Nace como panel local. | Guía de estilo y poda de navegación; **propuesta antes de aplicar**. |
| 20 | **Documentación mezclada**: `ESTADO.md` (68 KB) y `README.md` (34 KB) cuentan la historia y el estado a la vez. | Bitácora acumulada. | Separar «guía de operación» de «bitácora»; dejar un estado de una página. |

---

## 6. Arquitectura de producción propuesta

### Decisión: servidor persistente, no serverless

La app hace llamadas de IA largas (streaming), escribe archivos y ejecuta
mantenimiento en segundo plano. Vercel no encaja: límite de función y sin disco
persistente. La opción más simple y estable es **un contenedor Node siempre
encendido**, que es casi lo que ya hay.

### Fase 1 — la más corta (recomendada para empezar)

**Render**: servicio web Starter + disco persistente.

- Se sube el proyecto tal cual; `next build` y `next start`.
- El disco conserva **SQLite y `data/uploads`** en `/var/data`, con
  `DATABASE_URL=file:/var/data/dev.db` y `BRAINUP_DATA_DIR=/var/data`.
- HTTPS y dominio propio incluidos; sin límites de 60 s (hasta 100 minutos de
  respuesta).
- Copia diaria del archivo SQLite + subida de `uploads` a almacenamiento externo.
- **Antes de publicar**: login (punto 1) y revisar el TLS (punto 7).

Coste orientativo: **7 USD/mes** del servicio + **0,25 USD/GB/mes** del disco
(1 GB ≈ **7,25 USD/mes**, unos 6,5 €), más ancho de banda. Sin coste de base de
datos porque se conserva SQLite.

### Fase 2 — cuando haya más de un usuario o varios dispositivos a la vez

**Postgres gestionado + almacenamiento de objetos + autenticación**:

- Supabase (Postgres + Storage + Auth) es la pieza natural; su plan gratuito
  **pausa el proyecto tras una semana de inactividad**, así que para 24/7 hay que
  contar con el plan Pro (25 USD/mes).
- Alternativa: Postgres de Render (6 USD/mes) + almacenamiento S3 compatible.
- Migración de Prisma: `provider = "postgresql"`, migraciones y traslado de
  archivos. Es la parte que **requiere tu aprobación** y una ventana de pruebas.

### Comparativa de costes (precios publicados, octubre de 2026)

| Opción | Entrada | ¿Duerme? | Límite de respuesta | Nota |
|---|---|---|---|---|
| **Render** | 7 USD/mes web + 6 USD/mes Postgres + 0,25 USD/GB disco | No (plan pago) | Hasta 100 min | La más predecible; Prisma documentado. **Recomendada.** |
| **Railway** | 5 USD/mes con 5 USD de uso incluido | No (si se desactiva serverless) | 15 min máximo | Cómoda, pero el exceso de uso se factura. |
| **Fly.io** | 3,69 USD/mes (512 MB) + 0,15 USD/GB volumen | Configurable | No confirmado | La más barata con SQLite en volumen; más operación manual. |
| **Supabase** | Gratis (se pausa) / Pro 25 USD/mes | Gratis sí | Funciones: 400 s | Es base de datos, storage y auth, **no** host de Next. |
| **Vercel** | Gratis / Pro 20 USD/mes | Funciones | 60 s (Hobby) | No apta para este servidor persistente. |

Fuentes: [Render pricing](https://render.com/pricing),
[Railway pricing](https://railway.com/pricing),
[Fly pricing](https://docs.fly.io/about/pricing),
[Supabase pricing](https://supabase.com/pricing). Conversión BCE del 29/10/2026
(1 € = 1,113 USD), sin IVA.

### Autenticación propuesta

Para un solo usuario, lo más simple y seguro:

- Contraseña larga (hash Argon2/bcrypt) + cookie de sesión `httpOnly`, `Secure`,
  `SameSite=Lax`, firmada con un secreto de entorno.
- Opcional: Google con Auth.js si prefieres no recordar otra contraseña.
- Todas las rutas privadas y **todas** las mutaciones comprueban sesión y origen.
- Sin registro público: la cuenta se crea una vez, desde el servidor.

**Esto cambia el modelo de datos y el acceso; necesita tu aprobación expresa.**

---

## 7. Plan por fases

| Fase | Qué | Aprobación | Resultado |
|---|---|---|---|
| **0 (hecha)** | Arranque automático sin CMD, icono, autorreparación | No hacía falta | La app se enciende sola al entrar en Windows |
| **1** | Login de un usuario + TLS + build de producción + copias | **Sí** (auth y despliegue) | URL privada, usable desde el móvil |
| **2** | Despliegue en Render con disco + dominio + monitorización | **Sí** (contratar servicio) | 24/7 sin depender del PC |
| **3** | PWA instalable verificada en Android/iOS + página offline | No (bajo riesgo) | Icono en la pantalla de inicio |
| **4** | Postgres + almacenamiento de objetos + migración de datos | **Sí** (base de datos) | Base profesional y multi-dispositivo real |
| **5** | Planificador, apuntes y Catedráticos: mejoras de contenido | **Sí** (comportamiento central) | Calidad académica |
| **6** | Sistema de diseño y poda de navegación | **Sí** (identidad visual) | Producto premium coherente |

---

## 8. Riesgos y decisiones pendientes

1. **Publicar sin login sería el peor error posible.** No se desplegará nada
   público hasta que exista autenticación.
2. **La contraseña de Moodle no sobrevive** a la migración con el cifrado local
   actual; habrá que volver a conectarla una vez.
3. **SQLite en un disco** aguanta bien un usuario; no es la base para varios
   usuarios simultáneos. Se migrará cuando haga falta.
4. **La PWA en iOS** exige HTTPS y `apple-touch-icon` (ya existe); la instalación
   se probará en un dispositivo real, no solo en el escritorio.
5. **Los precios cambian**; los importes son orientativos y hay que confirmarlos
   al crear la cuenta.

---

## 9. Siguiente acción recomendada

1. Reiniciar el equipo una vez y comprobar que la app aparece sola y que el icono
   del escritorio la abre (prueba definitiva del arranque).
2. Aprobar **login + despliegue en Render** para la fase 1.
3. Con la aprobación, implementar la autenticación y el build de producción con
   pruebas, y desplegar una URL privada.
