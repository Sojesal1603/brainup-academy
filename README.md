# 🧠 BrainUp Academy

> **Academia privada de rendimiento académico de élite, adaptada a 2º de Bachillerato y Selectividad (PAU).**

BrainUp Academy no es una lista de tareas: es un centro de operaciones táctico y militarizado de estudio activo, dotado de algoritmos de distribución matemática de horas, banco de errores con diagnóstico post-mortem, sala de enfoque Zen con temporizador neurocognitivo y proyección de nota de corte sobre 14.000 puntos.

---

## ⚡ Características Principales (Fase 1: Núcleo Funcional)

1. **Cuartel General (Dashboard):**
   - Vista de bloques estratégicos del día asignados con métodos activos.
   - Radar de exámenes con cuenta atrás en días y urgencia.
   - Diagnóstico automático de temas en zona de riesgo.
   - Hábitos diarios configurables con contador de rachas continuas.
   - Selector en 1-clic entre **Zona de Confort** y **Modo Atleta**.

2. **Planificador Estratégico:**
   - Cálculo automático de horas necesarias por tema y materia según dificultad (1-5), nota meta y dominio actual.
   - Asignación inteligente de técnicas: *Active Recall, Problemas, Flashcards, Simulacro, Corrección de Errores y Repaso Espaciado (SRS)*.
   - **Horario escolar real integrado** (`/horario`): importa tu cuadrícula de clases en un comando y el planificador pasa a estudiar cada tarde las asignaturas que tienes **al día siguiente**, además de mostrarte la clase actual, la carga lectiva semanal y el próximo día lectivo.
   - Recálculo dinámico con un solo clic.

3. **Gestor de Exámenes & PAU:**
   - Control de convocatorias (parciales, finales, simulacros PAU).
   - Indicador de ponderación (0.2 / 0.1 en fase específica) y cuenta atrás.
   - Detección de los temas más vulnerables de cada materia.

4. **Modo Enfoque & Registro de Estudio:**
   - Temporizador Pomodoro/Libre (25m, 45m, 60m, 90m PAU) en pantalla completa sin distracciones.
   - Alarma sutil mediante síntesis Web Audio (cero dependencias externas).
   - Calibración rápida post-sesión (*Entendido: +8%*, *Con dudas: +2%*, *Fallado: -8%*) que actualiza automáticamente la base de datos local SQLite.

5. **Banco de Errores Quirúrgico:**
   - Registro con autopsia de fallos: *Enunciado, Mi Respuesta, Solución Oficial, Causa Raíz (Concepto, Cálculo, Lectura, Tiempo, Bloqueo), Lección Aprendida y Regla Preventiva*.
   - Aumento automático de la prioridad del tema fallado en el planificador.
   - Filtros por materia y causa con botón directo para repasar errores en el Modo Enfoque.

6. **Estadísticas & Simulador Predictivo PAU:**
   - Proyección oficial de nota PAU sobre 14 puntos ponderando 60% Bachillerato + 40% Fase General + 2 mejores ponderaciones de 0.2.
   - Desglose de horas por asignatura y análisis causal de errores.

7. **Privacidad & Portabilidad Local-First:**
   - Base de datos local SQLite con Prisma ORM (`prisma/dev.db`).
   - Cero dependencias de nubes externas en el núcleo.
   - Exportador completo a formato JSON desde `/ajustes`.

8. **Tutor IA Socrático (Fase 2):**
   - Catedráticos de IA por asignatura (`/brainup`) con conversaciones guardadas en tu SQLite local.
   - Protocolo socrático: diagnóstico previo, pistas escalonadas, verificación y resolución guiada — nunca la solución directa.
   - El catedrático **habla primero**: al abrir una consulta nueva te saluda con tu expediente real (tema más flojo, examen más próximo, errores pendientes) y te ofrece arranques de un clic.
   - **Markdown y LaTeX renderizados**: listas, negritas, citas y fórmulas con KaTeX ($...$ y $$...$$) en lugar del texto en crudo.
   - Barra de progreso socrática que muestra en qué etapa va la sesión (diagnóstico → pista 1 → pista 2 → verificación → resolución).
   - Contexto real del alumno: temas débiles, próximos exámenes y errores pendientes.
   - **Le enseñas lo que quieras, del tamaño que sea (Fase 3):** adjúntale **capturas, fotos, PDF, Word, PowerPoint, Excel, OpenDocument, apuntes en texto, Markdown, CSV o LaTeX** con el clip o pegando con **Ctrl+V**. Hasta **12 archivos por mensaje y 512 MB por archivo** (el tope de 6 MB que había antes dejaba fuera justo el material de estudio de verdad: el tema escaneado, el libro entero, los apuntes del profesor).
   - **Por qué el tamaño ya no es el problema:** el archivo **no viaja dentro del mensaje** en base64 (eso obligaba a tenerlo entero en la memoria del navegador y del servidor). Se sube en crudo y **en streaming** por su propia puerta (`/api/tutor/attachments`) a `data/uploads/`, y en el chat solo viaja su identificador. El servidor le saca el **texto** —página a página en los PDF, con sus fuentes y tablas de caracteres—, lo trocea y lo indexa una sola vez, al subirlo.
   - **Cómo lo lee sin mandárselo entero:** al catedrático se le dan el **mapa del documento** (sus apartados con su página) y los **extractos que le tocan a tu pregunta**, cada uno con su página delante para poder citarla («en la página 213 de tus apuntes pone…»). Si necesita algo que no está ahí, **pide páginas** («pásame las 210-214», o la 40 000 de un temario de 70 000) y se le traen en el turno siguiente: así un libro entero se puede leer sin volcar un libro entero en cada mensaje.
   - **Lo que sí mira directamente:** las **capturas** y los **PDF escaneados** que caben en una petición (≤15 MB) viajan como `image`/`document` y el modelo los ve de verdad. Un escaneo **sin capa de texto** y más grande que eso se guarda igual, se te dice claro y se te pide por partes o como capturas.
   - **Qué se ha podido leer, a la vista:** en el chat ves **cuántas páginas y caracteres** se han leído de cada archivo y sus avisos («12 de 300 páginas no tienen capa de texto»), además de la barra de progreso de la subida. Lo que no se puede leer se dice **antes** de gastar una llamada de IA; nunca se finge que se ha leído.
   - **Lee tus apuntes (Fase 3):** el interruptor **«Mis apuntes compartidos»** le da acceso al cuaderno de esa materia (un extracto por apunte, con su unidad, y con tope de caracteres; nada de volcar el cuaderno entero en cada mensaje). El prompt se lo presenta como **tu** material, no como verdad: si algo no está en tus apuntes ni en tu temario, te lo pregunta. Y en el chat ves **qué apuntes está leyendo** en ese momento.
   - **Honestidad con los archivos:** si quien responde es Groq (que no lee archivos), el catedrático recibe el nombre del adjunto y la orden explícita de no suponer su contenido —y tú ves el aviso—, en vez de inventarse lo que pone la foto.
   - **Memoria entre días:** cada catedrático recuerda lo que habló contigo **ayer** en esa materia (y el coordinador de la puesta a punto, lo de la entrevista). Al terminar cada turno se apunta un recuerdo del día —por reglas, sin gastar cuota; el modelo solo lo redacta mejor **una vez al día**— y en el turno siguiente ese recuerdo entra en el prompt como algo que ya sabe: «no lo vuelvas a preguntar». Se puede ver en `GET /api/salud` (`memory`).
   - **Nunca un recuadro vacío:** si el modelo contesta solo con sus etiquetas internas (cosa que pasaba y se veía como una burbuja sin texto), la respuesta se trata como lo que es y se te pide repetir la pregunta.
   - Motor de IA con **selección automática de modelo** (ver más abajo): requiere `GEMINI_API_KEY` en `.env` (ver instalación).

9. **Examinador PAU Interactivo (Fase 2):**
   - Simulacros completos de 4 bloques × 2,5 puntos generados sobre tus temas más débiles, con cronómetro oficial de 90 minutos.
   - Corrección por rúbrica PAU (rigor conceptual, desarrollo justificado, resultado, notación y unidades) con feedback bloque a bloque.
   - La nota del simulacro entra automáticamente en el dominio de cada tema y en las estadísticas.
   - Sin IA disponible, genera plantillas locales y pasa a autoevaluación guiada: nunca se queda colgado.

10. **Motor de IA Multiproveedor con Selección Automática:**
   - **Elige solo el mejor modelo gratuito disponible en cada petición**: consulta el catálogo real de la API (caché de 10 min) y puntúa los modelos por idoneidad, del más nuevo al más antiguo.
   - **Cero gasto por sorpresa**: los modelos de pago (`pro`), los experimentales, imagen y audio quedan excluidos por política.
   - **Memoria de salud por modelo**: si un modelo agota su cupo (429), no está disponible (404) o da error, entra en enfriamiento y se salta sin volver a intentarlo en cada mensaje; el último modelo que funcionó pasa al frente.
   - **Doble proveedor**: Gemini es el primario y **Groq** (opcional, con cuota gratuita propia) entra automáticamente cuando la cuota de Gemini se satura.
   - **El cupo es de cada clave, así que se puede ampliar gratis**: en `.env` caben hasta **cuatro claves por proveedor** (`GEMINI_API_KEY_2`, `GROQ_API_KEY_2`…, cada una de una cuenta gratuita distinta). La app **reparte la carga sola**: si una clave agota su cupo, se aparta ella sola y el siguiente turno usa la siguiente, sin que el alumno note nada. Y el cupo es de cada **modelo con cada clave**, así que una clave sin cupo en un modelo sigue sirviendo para los demás (antes, un `429` en el primer modelo marcaba el modelo entero y se recorría la lista de modelos gastando el turno; ahora va directo a lo que de verdad queda).
   - **Deja de dar vueltas cuando no hay nada que probar**: si a un proveedor no le queda ninguna clave con cupo, no se prueban sus ocho modelos uno detrás de otro —lo que tardaba segundos y comía el turno—, pasa al otro proveedor de inmediato.
   - **Las claves se reparten la carga de verdad**: el turno empieza por la clave **que menos se ha usado**, así que cuatro claves aguantan cuatro veces más antes de que ninguna toque su tope diario (antes la principal se comía todo y se agotaba mientras las demás miraban). Y en cuanto hay cupo caído, va primero la clave que acaba de funcionar con ese modelo: ir directo a la que responde ahorra el turno entero.
   - **El mantenimiento de la casa no le quita el cupo al alumno**: las rondas del vigilante, la memoria de los agentes y las auditorías del temario son trabajo de fondo, sin nadie esperando. Cuando el cupo está justo (no queda ninguna clave libre, o solo una y ya con cupo caído), esos turnos **se apartan solos y no llegan ni a llamar al proveedor**: el chat, los apuntes y los exámenes siguen teniendo todo el cupo para ellos. Se ve en `/ajustes` («cupo justo») y en el log de la ronda.
   - **Estado de las claves en `/ajustes`**: cada proveedor enseña sus claves («clave principal», «clave 2»…) con lo que les queda de cupo, y el aviso de que no hay cupo dice **cómo ampliarlo gratis**. Nunca se expone el valor de ninguna clave.
   - **Tope de tiempo por turno (30 s, 16 s por intento)**: antes cada intento podía quedarse colgado 90 s y la cadena prueba varios modelos, así que una respuesta podía tardar minutos. Ahora, si nadie contesta dentro del presupuesto, se deja de esperar y el chat responde en local. Lo que de verdad redacta mucho (un apunte, un simulacro completo) pide su propio margen y lo conserva.
   - Estado en vivo en `/ajustes` (ranking real de modelos, enfriamientos y contador de uso del día).

11. **Temario Vivo y Chequeo de Clase (Fase 3):**
    - Cada asignatura tiene **su temario real** (`/temario`): unidades numeradas, evaluación en la que se dan y estado (*por dar, en curso, visto, repasado*).
    - **El temario lo cargas tú**, pegándolo en `/temario`: el índice de tu profesor, el de tu libro o una lista tuya. (El listado curricular de Madrid que traía la app antes, con sus 111 unidades, se retiró: queda solo como referencia en `data/referencia/` y hay copia en `data/backups/`.) La app lo lee (numeración, viñetas, cabeceras de evaluación como «1ª evaluación» y dificultad opcional `[4]`), lo numera y guarda de dónde salió cada unidad. **No hay temario de fábrica ni niveles de partida**: todo entra como *pendiente* y *sin medir*, y cargar el índice no es saberlo. Puedes sustituir el de una materia (con copia automática en `data/backups/`) o añadir al final lo que ya tenías.
    - **Chequeo de clase diario en el Cuartel:** al llegar a casa, un clic por asignatura ("¿hemos visto la U5 de Trigonometría?") y el temario queda al día. Si el profesor va por otro sitio, eliges la unidad de una lista.
    - **Ajuste de mitad de curso:** el botón » marca *«vamos por aquí»*: esa unidad pasa a *en curso* y todo lo anterior a *dado*, sin inventar fechas de clase.
    - **Proyección honesta:** con las fechas reales de clase calcula tu ritmo (unidades/semana) y la fecha prevista de fin de temario, avisando si a ese ritmo no cierras el curso.
    - El planificador **sube la prioridad de lo que se está dando en clase** (+18 puntos la unidad en curso, +6 las ya explicadas): la tarde se dedica a lo que hoy ha entrado en el aula.

12. **Expediente Honesto: cero análisis inventados (Fase 3):**
    - **Ningún dato se inventa.** Cada unidad guarda de dónde sale su nivel (`sin medir`, *tu autoevaluación*, *diagnóstico del catedrático*, *sesión de estudio* o *simulacro corregido*) y cada asignatura el origen de su nota (*sin declarar* o *declarada por ti*).
    - **Lo que no está medido no se juzga**: el Cuartel no marca «temas críticos» que nadie ha medido, el Planificador le da el valor neutro (no el 0% de un tema que suspendes), el Examinador prioriza lo medido o el temario en curso, y las Estadísticas no proyectan nota PAU sin datos reales.
    - **Los catedráticos IA solo ven lo medido**: si no hay mediciones, el prompt les ordena explícitamente no dar nada por sabido ni por flojo, no citar notas que no conoces y diagnosticarte ellos. Y a partir de ahí, **ellos sí miden**: cuando comprueban tu nivel con tus respuestas anotan `[[nivel:U4=55]]` y esa unidad queda como *diagnosticada*.
    - **Tú pones tus datos en dos sitios**: *Mis notas reales* en Ajustes (media y objetivo por asignatura) y el selector de nivel de cada unidad en el Temario (autoevaluación en un clic).

13. **Puesta a punto guiada por IA (Fase 3):**
    - Un **coordinador** te entrevista en `/puesta-a-punto`: una pregunta por turno, empezando por tus horas reales y siguiendo por el temario de cada materia y por las fechas de tus exámenes.
    - **Lo anota él mismo**: cada respuesta se convierte en datos reales (unidades del temario, exámenes con fecha, horas semanales, ritmo de estudio) mediante un protocolo de etiquetas internas que el sistema interpreta y ejecuta en el mismo turno. A la derecha ves qué se ha guardado y qué falta.
    - **Si se le pasa algo, se lo recuerdas**: «recuérdame que el examen es el 14» o «esa unidad ya no va» y lo corrige en el momento (renombra, borra o cambia la fecha) sin salir del chat.
    - **Nunca inventa**: si no tienes el índice a mano ni sabes las fechas, lo dice y deja el hueco. Lo que te dicta él queda con su origen declarado y todo entra *sin medir*. Cero temario de fábrica.
    - Al terminar, **recalcula el plan**: las horas, el temario y los exámenes nuevos se reflejan en el Cuartel, el Planificador y el Horario sin tocar nada.

14. **Moodle conectado de verdad: apuntes y tareas (Fase 3):**
    - **La vía fácil:** en vez de ir a buscar la clave, pon tu **usuario y tu contraseña de Moodle** y la app pide la clave a Moodle por ti (`/login/token.php`, el mismo servicio que usa la app oficial del móvil). **La contraseña se usa una vez y no se guarda**: lo único que queda en tu SQLite es la clave. Si tu centro entra con Google/SSO esa vía no sirve (te lo dice), y si el servicio móvil está apagado lo distingue de una contraseña mal puesta. La clave manual y el enlace iCal siguen disponibles como alternativa.
    - En `/ajustes` conectas tu Moodle con la **dirección del sitio + el token de Web Services** (tu perfil → Preferencias → Seguridad → Claves). El token se guarda en tu SQLite local, **nunca viaja al navegador ni dentro de un enlace**.
    - **Apuntes**: BrainUp entra en tus cursos con `core_course_get_contents` e indexa lo que sube tu profesor —archivos, carpetas, enlaces, páginas y libros— con **su tema (la sección) y su curso**. Lo tienes en «Cuaderno Notion» (`/apuntes`), con buscador y filtro por curso. Las secciones y los módulos ocultos del profesor no se indexan.
    - **Los archivos se abren sin exponer el token**: `/api/moodle/file/<id>` añade el token en el servidor, guarda una copia en `data/moodle/` y la sirve después **incluso sin conexión**. Un archivo de otro dominio no se descarga jamás.
    - **Tareas**: con `mod_assign_get_assignments` + `mod_assign_get_submissions` lee tus entregas con su fecha, su enunciado en limpio y **si ya las has entregado o si están corregidas**. Aparecen en el Cuartel con acceso directo a Moodle y la etiqueta «entregada».
    - **Sin duplicados**: si una entrega ya estaba anotada por el enlace iCal, se adopta en vez de repetirse; cada curso se empareja con su asignatura por nombre para que el planificador sepa cuándo aprieta.
    - **Alternativa sin token**: el enlace iCal del calendario sigue disponible (solo fechas de entrega y exámenes) para quien no pueda activar los servicios web.
    - Si tu centro tiene los servicios web apagados o el token no trae las funciones necesarias, la app **lo dice con el nombre exacto de lo que falta** y el resto de BrainUp sigue funcionando.
    - **Si usas Moodle Centros (Andalucía), empieza por aquí:** no es una sola plataforma, son **ocho**, una por provincia (`…/centros/almeria`, `/cadiz`, `/cordoba`, `/granada`, `/huelva`, `/jaen`, `/malaga`, `/sevilla`). En `/ajustes` tienes un bloque con las ocho para rellenar la tuya con un clic. Después, el botón **Comprobar mi Moodle** analiza la dirección **sin pedir ninguna clave** y te dice en qué de estos cuatro casos estás: *servicios web encendidos* (solo falta la clave), *servicios web apagados*, *esa dirección no es un Moodle* o *no se puede contactar*, cada uno con el paso siguiente concreto. En Moodle Centros los servicios web **están encendidos** (se ha comprobado contra la instancia real de Sevilla); lo que puede faltar es el permiso del alumnado para crear la clave, y entonces la alternativa es pedírsela a un profesor o al coordinador TIC, o usar el calendario iCal.

---

## 🛠️ Requisitos e Instalación

### Requisitos:
* **Node.js:** v18 o superior (v24 LTS recomendada).
* **NPM:** v9 o superior.

### Pasos para arrancar el proyecto:

1. **Entrar en la carpeta del proyecto:**
   ```bash
   cd brainup-academy
   ```

2. **Instalar dependencias (si no se han instalado):**
   ```bash
   npm install
   ```

3. **Sincronizar la base de datos SQLite y cargar los datos de Bachillerato/PAU:**
   ```bash
   npm run db:push
   npm run db:seed
   ```

4. **Configurar el motor de IA (opcional):** crea una clave gratuita en [Google AI Studio](https://aistudio.google.com/api-keys) y pégala en `.env` como `GEMINI_API_KEY`. Sin clave, el resto de la app funciona con normalidad (tutor y examinador lo indicarán).

   Opcionalmente, añade `GROQ_API_KEY` (clave gratuita en [console.groq.com/keys](https://console.groq.com/keys)) como proveedor de respaldo: cuando Gemini agote su cupo, BrainUp cambia solo a Groq.

   | Variable | Por defecto | Para qué sirve |
   | --- | --- | --- |
   | `GEMINI_API_KEY` | — | Clave de Google AI Studio (proveedor primario). |
   | `GROQ_API_KEY` | — | Clave de Groq (respaldo gratuito; opcional). |
   | `GEMINI_MODEL` | `auto` | Fuerza un modelo concreto de Gemini. |
   | `GROQ_MODEL` | `auto` | Fuerza un modelo concreto de Groq. |
   | `AI_PROVIDER` | `auto` | `auto` (Gemini y luego Groq), `gemini` o `groq`. |
   | `GEMINI_API_KEY_2`…`_4` | — | Claves extra de Gemini (opcional): el cupo gratuito es de cada clave, así que cuatro claves aguantan cuatro veces más y la carga se reparte entre ellas. |
   | `GROQ_API_KEY_2`…`_4` | — | Lo mismo para Groq. |

   Con `auto` (recomendado) no hay que tocar nada más: el sistema elige el mejor modelo disponible en cada momento y verás el ranking en vivo en `/ajustes`.

5. **Iniciar el servidor de desarrollo:**
   ```bash
   npm run dev
   ```

   O mejor, **vigilado** (si se cae, se vuelve a levantar solo, y arranca además el mantenimiento):
   ```bash
   npm run sirve
   ```

6. **Abrir en el navegador:**
   Accede a [http://localhost:3000](http://localhost:3000).

7. **Que arranque sola al iniciar Windows (recomendado):**
   ```bash
   npm run arranque:instala
   ```

   **Ya no hay que arrancar nada a mano.** El instalador deja (sin pedir administrador):
   - una **tarea de Windows** llamada `BrainUp Academy` con dos disparadores: **al iniciar sesión**
     y **cada 5 minutos** (latido). Su acción es PowerShell oculto → Node → `sirve.js`; no depende
     de ningún `.cmd` ni de ningún script que pueda faltar;
   - **dos iconos** (escritorio y menú Inicio) que abren la app con `scripts/abre.js`: si ya está en
     pie, abre el navegador en menos de un segundo; si no, la arranca y espera a que `/api/salud`
     responda de verdad antes de abrir nada;
   - un **acceso de respaldo en la carpeta Inicio** (arranque directo de Node, minimizado), por si
     Windows deshabilitara la tarea. Los dos caminos usan el mismo cerrojo, así que nunca levantan
     dos servidores a la vez.

   Si algo falla, el icono abre una **página de diagnóstico local** con el motivo y las últimas
   líneas del diario, en vez del `ERR_FAILED` del navegador. Se consulta con
   `npm run arranque:estado` y se deshace con `npm run arranque:quita`.

   Los `.cmd` de la raíz quedan solo como **reparación manual**: no hacen falta para el día a día y
   no son el camino normal de arranque.

8. **Servir la versión compilada (recomendado para el día a día):**
   ```bash
   npm run build
   npm run sirve
   ```

   Si existe `.next/BUILD_ID`, el servidor vigilado arranca con `next start` en lugar de `next dev`:
   las páginas salen ya hechas (cientos de ms en vez de segundos compilando), que es lo que evita
   que el navegador dé la página por caída mientras compila. **A partir de ahí, cada cambio de
   código necesita `npm run build`**; para desarrollo con recarga al vuelo, usa `npm run dev`.

---

## 📱 Instalación como Aplicación (PWA)

* **En el Ordenador (Windows):** Abre `http://localhost:3000` en Microsoft Edge o Google Chrome. En el lateral de la barra de direcciones aparecerá el icono de **"Instalar BrainUp Academy"**. Al hacer clic, se abrirá en su propia ventana sin marcos como una app nativa en tu barra de tareas.
* **En el Móvil:** abre la dirección de la red de casa (ver justo abajo) y pulsa en **"Añadir a la pantalla de inicio"**. Sobre `http://` el navegador no deja instalarla «de verdad» —el service worker y la instalación exigen HTTPS, y `localhost` es la excepción—, así que en el móvil se abre como página y el icono es un acceso directo.

---

## 📲 Abrirlo desde el móvil (o desde otro cacharro de casa)

La app **ya escucha en toda la red de casa** (el servidor vigilado la abre con `-H 0.0.0.0`); lo que hay que saber es **con qué dirección**, y esa cambia cuando cambia la red: en el log de esta app se han visto `192.168.1.135`, `192.168.1.43`, `192.168.1.149` y `172.16.0.2`, según el día.

1. **La dirección de hoy**, por cualquiera de estas tres vías:
   - En la app: **Ajustes → «Usarlo desde el móvil»**.
   - En una terminal: `npm run movil` (además comprueba que la app contesta en cada dirección y deja escrito el comando del cortafuegos).
   - En el log: la línea `Network:` de `data/logs/servidor.log`, y la línea `Móvil:` que imprime `npm run sirve` al arrancar.
2. **En el móvil, en la misma Wi-Fi**, teclea esa dirección (por ejemplo `http://192.168.1.149:3000`). Para dejarlo a un toque: Safari → Compartir → *Añadir a la pantalla de inicio*; Chrome (Android) → menú ⋮ → *Añadir a la pantalla de inicio*.
3. **Si el móvil no la abre y en el PC sí funciona**, es el **cortafuegos de Windows**, que deja entrar al móvil solo si se le dice una vez. En un PowerShell **como administrador**:
   ```powershell
   New-NetFirewallRule -DisplayName "BrainUp Academy (movil)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Private
   ```
   Para deshacerlo: `Remove-NetFirewallRule -DisplayName "BrainUp Academy (movil)"`. Y si tu Wi-Fi figura como red **pública**, Windows la bloquea igual: pásala a **privada**.

Dos cosas que conviene tener claras: si has activado la **contraseña de acceso** (siguiente apartado), el móvil la pedirá la primera vez y luego entra solo durante 30 días (si prefieres que la app sea solo de este ordenador, pon `BRAINUP_HOST=127.0.0.1` en `.env` y reinicia con `npm run sirve`); y el PC tiene que estar **encendido y con la app en marcha** (`npm run sirve`, o el arranque automático del punto 7).

---

## 🔒 Acceso privado (usuario y contraseña, sin pagar la protección de Netlify)

Netlify cobra por la contraseña del sitio. Esta app trae la suya: un `proxy.ts` que corta **todas** las páginas y APIs antes de que respondan, y un formulario en `/login` que, si aciertas, deja una cookie firmada en el dispositivo.

**Las credenciales viven en variables de entorno, nunca en el código:**

| Variable | Para qué sirve |
| --- | --- |
| `AUTH_USER` | Tu usuario. |
| `AUTH_PASSWORD` | Tu contraseña. Larga: es la única llave. |
| `AUTH_SECRET` | Clave con la que se firma la cookie. Si falta, se usa la contraseña (y cambiarla cierra todas las sesiones). |
| `AUTH_SESSION_DAYS` | Días que dura la sesión en un dispositivo (`30` por defecto). |

**En Netlify:** *Site configuration → Environment variables* → añade `AUTH_USER`, `AUTH_PASSWORD` y `AUTH_SECRET`, y vuelve a desplegar (Netlify no aplica variables nuevas a un despliegue que ya está en pie). A partir de ahí, la dirección del sitio pide usuario y contraseña aunque Netlify no tenga activada su propia protección.

**En local**, las mismas dos/ tres variables en `.env`. El archivo ya puede traer una contraseña generada: cámbiala por la tuya si quieres.

Lo que se queda abierto a propósito: `/login`, `/api/auth/*` (entrar y salir), `/api/salud` (lo consulta el icono al arrancar; sin él, la app «no arrancaría») y los archivos que el navegador necesita para pintar la puerta y para instalar la PWA (manifest, iconos, service worker). Todo lo demás —incluidas las APIs de datos, la IA y Moodle— contesta **401** o redirige al formulario.

Tres detalles que se agradecen cuando se usa a diario:

- La cookie es `httpOnly`, `SameSite=Lax` y `Secure` en HTTPS: no la lee el JavaScript de la página y no se puede reutilizar desde otro sitio. Caducado el plazo, se vuelve a pedir la contraseña.
- El formulario funciona **sin JavaScript** (es un POST normal), que es justo lo que hace falta en el móvil.
- Tras 10 intentos fallidos desde la misma IP en 10 minutos, la puerta espera. En serverless el contador es por instancia, pero con una contraseña larga no hay nada que rascar.
- El botón de **cerrar sesión** está en la cabecera, a la derecha.

Si una comprobación local que habla con la app (`npm run verify:*`, el taller, el vigilante) te devuelve la puerta en vez de la app, arráncala con la puerta abierta solo para esa prueba:

```bash
AUTH_DISABLED=1 npm run verify:memoria
```

(En Windows CMD: `set AUTH_DISABLED=1 && npm run verify:memoria`.) `AUTH_DISABLED` no se pone en Netlify.

---

## ✅ Verificación rápida (scripts incluidos)

Con el servidor levantado (`npm run dev`) puedes comprobar tú mismo que todo sigue funcionando (si tienes la puerta puesta, arráncalo con `AUTH_DISABLED=1` para que los scripts que llaman a la app no se la encuentren):

| Comando | Qué comprueba |
| --- | --- |
| `npm run verify` | **Lo más rápido antes de dar algo por bueno**: ESLint sobre la app y sobre los `scripts/*.js` (sin asistente y sin avisos) y el typecheck completo. No toca la base ni gasta API. |
| `npm run lint` | Solo el lint: `next lint` para `src` y ESLint para los scripts de Node. |
| `npm run verify:ai` | Motor de IA **sin gastar API** (94 comprobaciones): política de modelos gratuitos, forma exacta de la petición a Groq, rotación ante un 429 y ranking de `/ajustes`. Incluye la **petición con adjuntos** (el PDF como `document`, la captura como `image`, y sin campos que la API real rechace), el aviso honesto al proveedor que no lee archivos, el **tope de tiempo del turno** (con un proveedor colgado de mentira y el reloj de verdad, un turno de 6 s no puede durar más), el **cupo por clave** (una clave agotada o inválida no tumba al proveedor) y el **reparto con prioridad**: tres claves sanas rotan 1 → 2 → 3 → 1, y con el cupo justo el trabajo de fondo se aparta con **cero llamadas al proveedor** mientras un turno normal sigue funcionando. Incluye el caso del **prompt que no cabe** en un modelo (límite de tokens por minuto): se prueba una sola vez y el turno sigue con el siguiente, sin reintentos inútiles. |
| `npm run verify:ai -- --live` | Una llamada **real** a Groq con tu clave del `.env`, para confirmar que el proveedor de respaldo responde. |
| `npm run verify:tutor` | Dos turnos reales de tutor: etapa socrática, memoria entre turnos y persistencia local (consume API). |
| `npm run verify:tutor-adjuntos` | **Lo que le enseñas al catedrático (consume API)**: le manda una captura (y comprueba que dice su color), un PDF con un código dentro (y comprueba que lo lee) y un apunte con un código único (y comprueba que lo cita). Verifica también que los adjuntos quedan en tu SQLite con su copia local idéntica al archivo enviado, y deja la base como estaba. |
| `npm run verify:tutor-contexto` | **Sin gastar API**: el módulo que decide qué apuntes ve el catedrático — extracto sin markdown, corte por palabra, fijados primero, máximo de seis apuntes y presupuesto de caracteres que nunca se pasa. |
| `npm run verify:examinador` | Simulacro completo: generación, cronómetro, corrección por rúbrica, informe e idempotencia del reenvío (consume API). |
| `npm run verify:moodle` | Sincronización del feed iCal demo sin duplicar tareas (deja las tareas demo visibles en el Cuartel). |
| `npm run verify:moodle -- cleanup` | Borra esas tareas demo y restaura la URL y la fecha de sincronización del perfil. |
| `npm run ai:models` | Catálogo real de modelos que permite tu clave y cuáles entran en la rotación automática. |
| `npm run plan:dump` | Volcado del plan semanal para entender las prioridades del planificador. |
| `npm run horario:import -- "<ruta al HTML>"` | Importa tu horario de clases real (materias, franjas y aulas) desde la cuadrícula HTML. |
| `npm run verify:horario` | Comprueba que los bloques del plan caen en asignaturas con clase el día siguiente. |
| `npm run temario:import` | Carga **en bloque** un índice tuyo desde un archivo JSON (el camino normal es pegarlo en `/temario`). |
| `npm run temario:import -- --file "<ruta.json>" --replace` | Sustituye el temario de una asignatura por **tu índice del profesor** (deja copia en `data/backups/`). |
| `npm run verify:temario` | **Lectura del temario que pegas** (numeración, viñetas, evaluaciones, duplicados y líneas que no son unidades), integridad (estados, numeración), ritmo real de clase, fin de temario previsto y rutas `/temario`, `/horario`. |
| `npm run verify:conocimiento` | **Capa de honestidad**: pruebas reales del módulo que impide inventarte el nivel y las notas (12 aserciones), integridad de los orígenes de medición y las vistas del Cuartel/Planificador/Temario/Ajustes/Estadísticas. |
| `npm run verify:conocimiento -- --live` | Añade un turno real de tutor en una materia sin mediciones y comprueba que **no cita ninguna nota ni debilidad inventadas** (consume API). |
| `npm run verify:puesta-a-punto` | **Puesta a punto**: protocolo del coordinador (etiquetas → acciones, datos imposibles rechazados, fechas en formato español y suelto), checklist de qué falta y qué toca preguntar, integridad de lo anotado y vistas del Cuartel. |
| `npm run verify:puesta-a-punto -- --live` | Un turno real del coordinador al que se le dice que **no tiene los datos a mano**: comprueba que no se inventa temario ni fechas, que termina preguntando y que la base no cambia (consume API). |
| `npm run verify:memoria` | **La memoria entre días, piezas y en vivo**: el bloque de recuerdos (ordenado de hoy hacia atrás, con su presupuesto de caracteres) y lo que se apunta de una conversación, sin gastar API; y contra la app en marcha, se planta un recuerdo de «ayer», se le habla al catedrático y se comprueba que ese recuerdo **entra en su prompt** (queda en `data/logs/servidor.log`, con sus caracteres), que lo hablado hoy **se apunta solo** para mañana, que el coordinador también y **cuánto tarda** cada respuesta. Deja la base y el chat como estaban. |
| `npm run verify:mantenimiento` | **Taller de mantenimiento (sin gastar API)**: las reglas sobre los datos (títulos sucios, numeración rota o repetida, calendarios de repaso imposibles, niveles inventados, unidades repetidas, exámenes y retos caducados) y el **rastro de funcionamiento** (caídas del servidor con su código de salida, ratos sin responder, errores registrados por la propia app, fallos de los modelos de IA), con sus ventanas de tiempo, el guardián que nunca borra una unidad con datos y el blindaje anti-bucle de los reinicios. Incluye las reglas que **atienden lo que reportas tú** (la IA solo puede elegir entre los arreglos que ya existen: un id inventado no hace nada, un reporte que no existe se ignora) y reconocer una **clave de Moodle caducada**. |
| `node scripts/verify-mantenimiento.js --live` | La ronda de verdad **contra tu base y tu app en marcha**: rompe un temario en una asignatura de prueba, comprueba que el motor lo detecta y lo arregla, que el guardián del borrado se niega a tocar una unidad con datos, que las incidencias se abren y se cierran solas, que el rastro se lee de los logs reales, que el control del servidor no toca nada si el vigilado ya está en marcha, que **un reporte tuyo queda diagnosticado** (con la IA simulada, sin gastar cuota) y que el cuidado de **Moodle** funciona contra un Moodle de mentira: clave caducada → marcada y avisada en el taller → al volver a valer, se sincroniza sola. Deja el expediente y tu perfil exactamente como estaban. |
| `npm run verify:moodle-ws` | **Moodle por Web Services con un Moodle simulado**: **la vía fácil por usuario y contraseña** (clave conseguida en `login/token.php`, contraseña mala rechazada sin pisar el perfil, contraseña nunca guardada y caso del servicio móvil apagado), token inválido rechazado sin tocar el perfil, apuntes indexados por tema (y los ocultos ignorados), tareas con su estado de entrega, adopción de las tareas del iCal sin duplicar, descarga del PDF con el token puesto en el servidor, copia local que abre sin conexión y rechazo de archivos de otro dominio. Restaura el perfil al terminar. |
| `npm run verify:moodle-ws -- --serve` | Levanta solo el Moodle simulado (dirección y token en pantalla) para probar la conexión tú mismo desde Ajustes. |
| `npm run verify:moodle-ws` (incluye) | **Diagnóstico sin token**: distingue servicios web encendidos, apagados, dirección que no es un Moodle y dirección inexistente; y si hay internet, comprueba **Moodle Centros de verdad** (reconoce la provincia y los servicios web encendidos; si no hay conexión, avisa pero no falla). |
| `npm run movil` | **La dirección para abrirlo en el móvil**, dicha por quien la sabe: pregunta al sistema las direcciones de este ordenador en la red local (señalando las VPN y máquinas virtuales, que no llevan a casa), comprueba que la app contesta en cada una y, si el móvil no abriese la página, deja escrito el comando del cortafuegos. Termina en 1 si la app no contesta en ninguna dirección de red. |
| `npx tsc --noEmit` | Comprobación de tipos de todo el proyecto. |

---

## 🗺️ Próximas Fases del Desarrollo

* **Fase 2:** ✅ Completada. Tutor IA socrático por materia (chat con diagnóstico previo y pistas escalonadas, memoria local) y ✅ Examinador PAU interactivo con cronómetro de 90 minutos, generación sobre temas débiles y corrección por rúbrica. Motor de IA multiproveedor con selección automática de modelo (Gemini + Groq de respaldo).
* **Fase 3:** En curso. ✅ Temario vivo por asignatura con chequeo de clase diario, importador de índices reales y proyección de fin de temario. ✅ Expediente honesto: cada nivel y cada nota declaran su origen, lo no medido no se juzga y los catedráticos IA miden en conversación. Pendiente: retos semanales y analíticas de retención SRS.
* **Fase 4:** Conector con Notion API y puente MCP local para NotebookLM.
