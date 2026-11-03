# Estado del sistema — BrainUp Academy

Fecha del informe: 15 de octubre de 2026 · **actualizado el 18 de octubre de 2026**.
Comprobado con la app en marcha, la base real y las verificaciones del proyecto.

---

## 1. Qué es y cómo se mantiene solo

BrainUp Academy es una app local (Next.js + SQLite) para estudiar Bachillerato y PAU.
Lo que la hace distinta de un cuaderno es que **se vigila a sí misma**. Cinco piezas:

| Pieza | Fichero | Qué hace |
|---|---|---|
| Motor de reglas | `src/lib/maintenance.ts` | Busca lo que no cuadra en los **datos**: títulos sucios, numeración rota o repetida, calendarios de repaso imposibles, niveles inventados, exámenes caducados, retos de semanas pasadas. Puro: sin Prisma, sin red, sin disco. |
| Rastro de funcionamiento | `src/lib/operationalTrace.ts` | Busca lo que no cuadra en **cómo va la app**: caídas del servidor, ratos sin responder, errores de ejecución, fallos de los modelos de IA. Se lee de los logs, así que funciona **incluso cuando la app está caída**. |
| Ronda automática (vigilante) | `src/lib/vigilante.ts` + `scripts/vigilante.js` | Cada 5 minutos: revisa, **arregla solo lo reversible**, atiende **lo que has reportado tú**, pregunta a la IA por lo que las reglas no alcanzan, abre incidencia de lo que no puede arreglar, la cierra sola cuando deja de pasar y **apunta la memoria del día**. |
| Servidor vigilado | `scripts/sirve.js` | La app no se queda caída: si el proceso muere se relanza en 2 s; si responde zombi (3 fallos de salud seguidos) se reinicia. Es lo que evita el «no se puede acceder a este sitio web». |
| Memoria entre días de la IA | `src/lib/agentMemory.ts` (+ `agentMemoryPolish.ts`) | Cada IA recuerda **lo que habló ayer** en su ámbito (catedráticos, coordinador de la puesta a punto, mantenimiento). Una fila por ámbito y día, con presupuesto de caracteres: recuerda mejor, no más. |
| Registro de errores propio | `src/instrumentation.ts` | Cada vez que una página o una acción del servidor revienta, el error se escribe con su hora y su ruta en `data/logs/errores-app.log`. |

Todo lo que se une a la hora de decidir vive en un solo sitio (`maintenanceScan.ts`), así que
**la página del taller, el vigilante y el doctor ven exactamente lo mismo**: no pueden discrepar.

### Lo que se añadió el 14 y el 15 de octubre

**Primera tanda (detección y reparación propias del funcionamiento):**

1. **Lee sus propios rastros** (`data/logs/servidor.log`, `vigilante.log`, `errores-app.log`) y
   saca de ahí hallazgos con la **causa exacta**: «se ha caído 3 veces, la última a las 15:55,
   motivo código 3221225794 (0xC0000142: el proceso no llegó a arrancar)».
2. **Se repara solo**: si hay un bucle de caídas reciente y repetido, **reinicia la app**; si el
   servidor no responde, **levanta el vigilado**. Ninguna de las dos cosas toca un dato.
3. **No se pasa de listo**: una caída suelta no dispara nada, lo que pasó hace más de 6 horas es
   historial, y un reinicio automático no se repite hasta media hora después.
4. **No puede perder nada mientras reordena**: antes de borrar una unidad se cuentan otra vez las
   filas que cuelgan dentro de la misma transacción; si hay una sola, no borra.

**Segunda tanda (los cuatro frentes que quedaban pendientes):**

5. **Memoria entre días para toda la IA.** Cada turno apunta un recuerdo del día —**por reglas, sin
   gastar cuota**; el modelo solo lo redacta mejor **una vez al día por ámbito**— y en el turno
   siguiente ese recuerdo entra en el prompt como algo que ya sabe. Está enchufada en los tres
   sitios: catedráticos (por materia), coordinador de la puesta a punto y mantenimiento (la ronda
   escribe cómo quedó el sistema, y la IA del taller lo lee antes de decidir).
6. **La IA atiende lo que reportas a mano.** Antes tu reporte quedaba apuntado esperando a que
   alguien lo mirara. Ahora la IA lo cruza con las comprobaciones del taller y con los arreglos que
   existen: **arregla sola lo que ya es seguro** y, cuando no lo es, te lo explica dentro del propio
   reporte con el arreglo señalado. La IA **no escribe en la base**: elige entre los arreglos que ya
   existen y cada id se valida (uno inventado no hace nada). Lo hace el vigilante en cada ronda y,
   a mano, el botón del taller.
7. **Respuestas más ligeras, y medido.** La cadena entera de modelos comparte ahora un
   **presupuesto de 30 s por turno y 16 s por intento** (antes cada intento podía quedarse colgado
   90 s y la cadena prueba varios modelos: un turno podía tardar minutos). Lo que de verdad redacta
   mucho —un apunte, un simulacro— **conserva su margen largo**: aligerar el chat no puede costarte
   un cuaderno a medias.
8. **Moodle se cuida solo.** Se comprueba la clave contra tu Moodle (con enfriamiento de 6 h, no en
   cada ronda): si **ha caducado**, se marca y aparece un aviso claro en Ajustes y en el taller (eso
   no se puede arreglar sin ti: pedir una clave nueva necesita tus credenciales); si la clave vale
   pero los datos se han quedado viejos, **vuelve a sincronizar sola**.
9. **El recuadro vacío del chat, arreglado.** Era uno de tus dos reportes y era real: cuando el
   modelo contestaba **solo** con sus etiquetas internas, quedaba un mensaje sin texto que se
   pintaba como una burbuja vacía. Ahora se trata como lo que es —una respuesta que no sirve— y se
   te pide repetir la pregunta.
10. **Moodle sin clave de Web Services: se entra por la sesión web.** Es tu caso: hay centros que no
    dejan crear la clave al alumnado (o el servicio móvil está apagado) y la petición de clave
    falla. Ahora, cuando pones **tu usuario y tu contraseña**, la app primero pide la clave (la vía
    limpia) y, si el centro no se la da, **entra como entraría el navegador**: abre la sesión con el
    formulario de tu Moodle, se queda con la cookie de sesión y desde ahí lee tus cursos, tus
    apuntes y tus tareas. No hace falta ninguna clave ni que nadie te la proporcione. La contraseña
    se guarda **cifrada con la clave de este equipo** (y solo si tú marcas la casilla) para poder
    volver a entrar sola cada día; se borra con «Desconectar», nunca sale del ordenador y nunca se
    manda a otro sitio que no sea tu Moodle.
11. **Apuntes de cátedra, y con la puerta cerrada a los resúmenes.** El redactor ya pedía el
    desarrollo punto por punto (120–250 palabras por punto del tema); lo que faltaba era la puerta:
    el apunte podía guardarse con cuerpo pero **sin un solo apartado `### `**. Ahora la calidad se
    mide en dos cosas distintas —**estructura** (apartados obligatorios y desarrollo punto por
    punto) y **extensión**—, si falta se le vuelve a pedir hasta **dos veces más** diciéndole
    exactamente qué falta (del mejor intento se queda lo mejor, nunca se pierde lo que ya estaba
    bien) y, si aun así sale cojo, se guarda —es tuyo y sirve para estudiar— pero **queda anotado en
    el taller** con el id del apunte para poder reescribirlo. Un apunte de mentira de prueba salió
    entero: **1.729 palabras, 7 apartados desarrollados**.
12. **Un solo motor de formato para el cuaderno y el chat.** Cada uno tenía su propia versión y las
    dos fallaban igual: con `**Apertura del *mito* al *lógos***` la negrita cerraba donde no tocaba
    y el alumno acababa viendo asteriscos en mitad del apunte. Ahora hay un único motor
    (`src/lib/inlineEmphasis.ts`) que además borra las marcas que el modelo deja sueltas **sin
    comerse el contenido** (`2*3` y `nombre_fichero.txt` se respetan), y negrita con cursiva dentro
    se anidan de verdad. *(14 de octubre.)*

13. **Los apuntes viejos también se limpian solos.** El limpiador existía, pero solo actuaba **al guardar**: los apuntes escritos antes seguían con sus etiquetas `<details>` dentro y salían así impresos. Ahora el taller los busca (vallas de código, etiquetas HTML, desplegables viejos, saltos de línea escapados) y los pasa por el **mismo** limpiador, con un solo camino para las dos puertas: uno recién escrito y uno de hace un mes quedan igual de limpios.

15. **Los documentos que le das al catedrático: hasta 512 MB, y de verdad leídos (15 de octubre).**
    El tope era **6 MB por archivo** y con razón: el adjunto viajaba en **base64 dentro del JSON del
    chat**, así que el navegador tenía que montarlo entero en memoria y el servidor volver a recibirlo
    entero. Eso dejaba fuera justo lo que hace falta para estudiar —un tema escaneado, el libro, los
    apuntes del profesor—. Ahora hay **dos cambios y una pieza nueva**:

    - **El archivo entra por su propia puerta, en crudo y en streaming** (`PUT /api/tutor/attachments`):
      el servidor lo escribe en disco mientras llega, sin pasar por la memoria, y en el chat solo viaja
      su **identificador**. Topes de sensatez: **12 archivos por mensaje y 512 MB por archivo**.
    - **Se le saca el texto al documento** (`docRead.ts`): PDF página a página con `pdfjs-dist` y su
      marca `--- Página N ---`; texto plano con reintento en Latin-1 (los apuntes de Windows con
      tildes rotas); Word/PowerPoint/Excel/ODF descomprimiendo el ZIP con `zlib` y leyendo su XML, sin
      dependencias; y RTF, HTML y subtítulos. Un `.txt` de 200 MB no se carga entero: se leen los
      primeros bytes que hacen falta.
    - **Y se le da al catedrático troceado, no en un bloque** (`docContext.ts`): al subir se construye
      **una sola vez** el índice (trozos de 1 500 caracteres, con su página y su rango de páginas) y en
      cada pregunta se le pasan el **mapa del documento** y los **extractos que puntúan** para esa
      pregunta, dentro de un presupuesto de 45 000 caracteres. Si necesita más, **pide páginas**
      («pásame las 210-214») y el turno siguiente se las trae. El tope de texto por documento subió a
      **40 millones de caracteres** (~8 000 páginas): un libro entero queda indexado y cualquier página
      suya se puede recuperar.
    - **Medido con archivos de verdad, no con uno pequeño:** un `.txt` de **34 MB** (70 000 páginas)
      se sube en **4,3 s**, se lee **entero** (32 866 774 caracteres, **sin ningún aviso de corte**) y
      el catedrático contesta citando la página 40 000 con el dato que había escondido ahí; un PDF de
      70 kB con texto se lee (2 330 caracteres); dos PDF escaneados (2,2 MB y 29 MB) se aceptan, se
      detecta que **no tienen capa de texto** y se dice con esas palabras, sin inventarse nada.
    - **Lo que se ha podido leer se ve en el chat:** por cada archivo, sus páginas, sus caracteres y
      sus avisos; los que no se pueden mirar por tamaño se nombran. La subida tiene su **barra de
      progreso**, y quitar un adjunto **lo borra también del disco del servidor**.

17. **El cupo gratuito se puede ampliar sin pagar: varias claves por proveedor (15 de octubre).**
    El límite de Google y de Groq se cuenta **por clave**, así que una sola clave convierte un día
    de estudio intenso en «modo local» aunque al proveedor le sobre capacidad. Ahora:

    - **Hasta cuatro claves por proveedor** en `.env` (`GEMINI_API_KEY`, `GEMINI_API_KEY_2`… y lo
      mismo con `GROQ_API_KEY`). La app las lee, ignora las vacías y las repetidas, y las pone en
      una sola lista ordenada, con su etiqueta («principal», «2»…) y sin exponer nunca su valor.
    - **Una clave agotada se aparta sola**: al primer `429` de esa clave, se apunta su enfriamiento
      y el turno sigue con la siguiente clave del mismo modelo. Si la clave es **inválida** (`401`),
      se aparta la clave entera y se sigue con la siguiente (antes eso abortaba el turno, con la
      segunda clave gratis sin usar en el `.env`).
    - **El cupo es de cada modelo con cada clave**, no del proveedor: es como lo cuentan de verdad
      las dos APIs. Una clave sin cupo en un modelo sigue sirviendo para los demás, y un modelo sin
      cupo con la clave 1 sigue teniendo cupo con la clave 2.
    - **Sin dar vueltas de más**: si a un proveedor no le queda ninguna clave con cupo, no se prueban
      sus ocho modelos uno detrás de otro (eso tardaba segundos y se comía el turno): se pasa al
      otro proveedor de inmediato.
    - **Los errores dejaron de confundirse.** El motor traducía a un mismo estado interno cosas muy
      distintas (el `401` de una clave inválida llegaba como `502`), así que una clave rechazada se
      trataba como «proveedor caído», se reintentaba tres veces y se pasaba al otro proveedor. Ahora
      cada error viaja con **su clasificación real** (`auth`, `quota`, `quota_daily`, `error`,
      `missing`) y el motor decide con el dato bueno.
    - **Y se ve en `/ajustes`**: cada proveedor enseña sus claves con lo que les queda, y cuando no
      queda cupo el mensaje dice **cómo ampliarlo gratis** en vez de dejar al alumno sin saber qué
      hacer.

    Comprobado sin gastar API (con `fetch` interceptado, 11 comprobaciones nuevas): con la clave
    principal sin cupo contesta la clave 2; el turno siguiente va **directo** a la que tiene cupo;
    una clave rechazada no tumba al proveedor (contesta la 3); el rastro distingue `#2:auth` de
    `#3:ok`; el estado no publica ningún valor de clave; y el `429` final explica cómo ampliar el
    cupo. Además se probó contra la API de verdad (`verify:ai --live`) y con un turno real del
    catedrático (`gemini-3.5-flash-lite`, HTTP 200).

18. **El cupo se reparte y el mantenimiento no le quita el turno al alumno (15 de octubre).**
    Con las claves extra ya en su sitio, quedaban dos formas de gastar el cupo gratuito peor de lo
    necesario, y las dos están cerradas:

    - **Reparto entre claves.** Antes el orden de las claves era siempre el mismo: la principal se
      comía **todo** el consumo hasta agotar su cupo diario mientras las otras tres miraban. Ahora
      el turno empieza por la **clave que menos se ha usado**, así que cuatro claves aguantan cuatro
      veces más antes de que ninguna toque su tope. Y hay un matiz que importa: en cuanto hay cupo
      caído (una clave sin cupo para ese modelo), va primero **la clave que acaba de funcionar con
      ese modelo**, porque ir directo a la que responde ahorra el turno entero.
    - **Prioridad del trabajo de fondo.** La app pide IA para dos cosas muy distintas: la respuesta
      que alguien está esperando y el mantenimiento de la casa (rondas del vigilante, memoria de los
      agentes, auditorías del temario). Los segundos no tienen prisa y su resultado es para mañana,
      así que ahora **se apartan solos** cuando el cupo está justo (`isQuotaTight()`: ninguna clave
      libre, o solo una y ya con cupo caído, o el modelo en uso sin ninguna clave con cupo) y el
      turno de fondo **ni siquiera llega a llamar al proveedor**: falla en el acto con un aviso
      propio («este trabajo de fondo cede el turno para no quitarte el cupo»). El chat, los apuntes y
      los exámenes son interactivos y **nunca ceden**. Con una sola clave configurada esto no
      bloquea nada mientras su cupo esté sano: solo se aparta cuando de verdad se ha agotado.
      En la ronda se ve claro: en vez de un error, el vigilante apunta «cupo de IA justo: la ronda se
      aparta para no competir con el alumno» y sigue con sus reglas.

    Comprobado sin gastar API (9 comprobaciones nuevas, 69 en total en el motor): con tres claves
    sanas, cuatro turnos seguidos salen por **clave 1 → 2 → 3 → 1** y cada uno a la primera; el uso
    real de cada clave se publica en `/ajustes`; con el cupo sano un turno de fondo se ejecuta
    normal; agotada la última clave, `isQuotaTight()` pasa a verdadero, el estado lo enseña y el
    turno de fondo se aparta con **0 llamadas al proveedor** mientras un turno normal sigue
    funcionando igual.

19. **Un proveedor saturado ya no se come el turno entero.** Es un fallo real, medido: con Gemini sin cupo (sus modelos devolviendo 502 de «high demand», cada uno tardando segundos) y una clave de Groq de respaldo **sana**, el turno acababa en **503 sin haber probado ni un solo modelo de Groq** — los reintentos del primer modelo se comían los 30 s. Ahora hay dos cosas nuevas: el reintento de un modelo solo se hace si al turno le sobra tiempo *para los modelos que quedan detrás*, y cuando un fallo es del **proveedor** (502, 503, tiempo agotado) el mejor candidato del proveedor de al lado **pasa delante**. Medido con el mismo caso: **30 113 ms y 503 antes → 5 029 ms y respuesta de Groq ahora**, con un solo intento contra Gemini.

**Tercera tanda (16 de octubre: la organización deja de ser arbitraria, y el cupo aguanta más):**

20. **El horario de clases se construye en la entrevista, no se importa «cuando puedas».** Era el último dato que la puesta a punto dejaba para después y el que más falta hacía: sin él, la tarde no sabe qué se ha explicado hoy ni qué toca mañana, y el reparto de horas entre asignaturas era una corazonada. Ahora el coordinador pregunta por días («¿qué días tienes Matemáticas y a qué hora?») y tiene **dos etiquetas nuevas**: `[[clase:L|1|Matemáticas I|Aula 104]]` (día · número de hora, hora de inicio `08:15` o rango `08:15-09:10` · materia · aula opcional) y `[[borrar-clase:L|Matemáticas I]]` (o `[[borrar-clase:Matemáticas I]]` para quitarla todos los días). Se aplica en la base (`ClassPeriod`), **el horario cuenta para cerrar la puesta a punto** —si falta, la entrevista no se da por terminada— y cada alta **recalcula el plan de la semana**, que ya coloca los bloques la tarde antes de la clase de esa asignatura. Comprobado de extremo a extremo con la app: dictando «los lunes y miércoles Matemáticas a primera hora, los martes Física a tercera», el coordinador apuntó **3 clases con su día, su hora y su materia**, lo confirmó en el chat y siguió con la siguiente pregunta. *(Las etiquetas viejas siguen funcionando: nada de lo apuntado antes se invalida.)*

21. **El temario que se perdió en silencio, repuesto, y una puerta para que no vuelva a pasar.** El 16 de octubre la base amaneció con **7 materias y 0 unidades**: la semilla de demostración (`npm run db:seed`) había borrado el temario, los apuntes y el horario, y **nadie se enteró porque no había nada que lo repusiera**. Ahora hay tres cosas: (a) el temario está **de vuelta con sus 111 unidades** del currículo de la Comunidad de Madrid (`data/referencia/curriculo-comunidad-de-madrid-1bach.json`), con su origen (`curriculo`) y **sin ningún nivel inventado** (111 unidades sin medir); (b) el taller tiene una regla nueva —**«Temario perdido: una materia sin unidades cuando hay copia disponible»**— con su arreglo automático, que repone solo las materias vacías y **nunca toca una que ya tenga temario** (escribe copia antes, así que es reversible); y (c) la ronda del vigilante **guarda una copia del temario una vez al día** (`data/backups/temario-auto-…)` para que, si algún día se pierde, siempre haya de dónde reponerlo. El nivel medido **no se restaura a propósito**: reponer un índice no es saberlo.

22. **OpenRouter: un tercer proveedor gratuito detrás de Gemini y Groq.** Cuando el cupo gratuito se agota, se acaba, y el motor tenía dos proveedores. Ahora hay tres, en este orden: **Gemini → Groq → OpenRouter → Ollama**. OpenRouter habla el dialecto de OpenAI, tiene modelos `:free` (solo se aceptan los gratuitos: el motor filtra el catálogo y descarta los de pago y los de audio) y su cupo es **de la cuenta, no de la clave** —la interfaz lo dice así, sin prometer de más—. Comprobado sin gastar API (11 comprobaciones nuevas, **80 en total**): con Gemini y Groq secos, el turno lo contesta OpenRouter **con una sola llamada**; una clave rechazada (401) no tumba al proveedor; el estado no publica ningún valor de clave; y el orden de la cadena es el pactado.

23. **Los niveles «medidos» que dejaban las pruebas, fuera.** Al pasar las suites, cuatro unidades de Tecnología aparecían con `masterySource: simulacro` y nivel 0: la corrección de un simulacro **mide de verdad**, pero la prueba del examinador se olvidaba de deshacer su propia medición, así que dejaba unidades «medidas» que nadie había medido (y eso ensucia el plan y las estadísticas: la página llegaba a decir «sin datos» con cuatro unidades medidas). Ahora la prueba apunta el estado previo y **lo devuelve en el `finally`**, también si falla a medias; la base quedó con **0 unidades medidas** y la comprobación de estadísticas mira **lo mismo que mira la página** (materias de fase general con dato), que era el otro falso positivo.

**Cuarta tanda (18 de octubre: el curso entero, y los catedráticos que ya no se caen):**

24. **El enlace del catedrático ya no lleva a una página muerta.** El error que viste (`ERR_FAILED` en
    `/brainup/c15329db-…`) era un enlace guardado a un agente que **ya no existía**: al volver a
    sembrar la base, los UUID cambian y el historial del navegador apunta a un sitio que no está.
    Ahora la dirección usa el **nombre de la materia** (`/brainup/lengua-castellana-y-literatura-i`),
    que sobrevive a cualquier regeneración, y los UUID viejos **no dan 404**: se redirigen a la
    lista de catedráticos. Además hay una página 404 propia, en castellano, con salida a Inicio y a
    Catedráticos. Comprobado con la app en marcha: el UUID que te falló devuelve **307 → /brainup**,
    y los tres slugs de prueba devuelven **200**.

25. **Los errores del navegador también quedan apuntados (y entran en el circuito de reparación).**
    Antes, si un componente de cliente reventaba, el fallo solo existía en tu consola: el servidor no
    se enteraba y el vigilante no tenía nada que revisar. Ahora `window.onerror` y
    `window.unhandledrejection` (y los `error.tsx`) mandan el fallo a `POST /api/errores`, que escribe
    en el **mismo** `data/logs/errores-app.log` que ya leen el taller y el vigilante. Sin datos
    personales (mensaje, pila recortada, ruta sin parámetros), con deduplicación de 60 s y sin poder
    fallar nunca: si el aviso no sale, se pierde el aviso, no la pantalla. Probado: el POST devuelve
    `{ok:true}` y deja su línea en el log.

26. **La puesta a punto ya monta el curso ENTERO, no una muestra.** Tres agujeros reales, cerrados:
    - **El horario incluye las materias que no se estudian.** Religión, Educación Física o Tutoría
      ocupan horas reales y tienen que salir en el horario, pero no se les puede pedir temario ni
      exámenes. Ahora se marcan con `[[solo-horario:Religión]]` (y `[[estudiar:…]]` para lo
      contrario): siguen en el horario, cuentan sus horas de clase y **dejan de aparecer como
      pendientes**. Si una de esas materias aparece por primera vez dictando el horario, se crea ya
      como «solo horario».
    - **El horario no se da por cerrado con medio horario.** El coordinador tiene que repasar los
      cinco días y emitir `[[horario-completo]]`; cualquier alta o baja de clase vuelve a abrirlo.
      El estado enseña ahora **clases y horas de clase a la semana** (`6 clases · 5,5 h/semana`), que
      es el tiempo que de verdad no está libre.
    - **Un temario con unidades no es un temario completo.** Se pregunta **cuántas unidades** tiene el
      curso, se comparan con las anotadas y no se da por bueno hasta `[[temario-completo:Materia]]`.
      Con 3 de 12 unidades el plan salía corto y el examen pillaba sin la mitad del curso. Añadir o
      borrar una unidad **retira** esa confirmación sola.
    El prompt del coordinador se ha reescrito con el orden completo (horas → horario → temario →
    exámenes → cierre) y con la orden explícita de pedir **todas** las materias del horario.

27. **Ollama, si algún día se instala, sin comerse la RAM.** El motor local ya no entra a lo loco:
    antes de usarlo se mira la **RAM libre de verdad** (`OLLAMA_MIN_FREE_MB`, 1200 MB por defecto) y,
    si no hay margen, no se carga (en este ordenador, con 1041 MB libres, queda en espera y lo dice
    en `/api/salud`). Solo corre **una generación local a la vez**, con poca RAM no se ofrecen modelos
    de 7B o más, y el modelo se **descarga de memoria** cuando el equipo queda justo o tras 3 minutos
    sin usarlo (`OLLAMA_IDLE_UNLOAD_MS`). Así el respaldo 24/7 no cuesta la fluidez del portátil.

28. **El catedrático tampoco se queda en un error.** Era el único chat que, con los tres
    proveedores secos y sin motor local, devolvía un `429/503` y pintaba un error. Ahora contesta un
    **respaldo local** (`src/lib/tutorFallback.ts`) con lo que el sistema sí sabe: examen más próximo,
    unidad más floja medida, unidades sin medir, errores pendientes y un plan de acción para esos
    minutos. **No inventa la explicación** —eso sería peor que no contestar—: la deja dicha para
    cuando vuelva la IA. La respuesta se guarda como un turno más, así que la conversación no se
    rompe. Probado el texto con datos reales de una materia (Lengua: examen en 2 días, unidad al 32%,
    16 sin medir, 3 errores) y el chat real sigue funcionando con IA (suite `verify:tutor` en verde).

29. **El taller ya no pide temario a las materias que solo están en el horario.** La regla
    «Asignaturas sin temario» respeta `isTracked`: Religión y Educación Física quedan marcadas como
    **solo horario** (0 unidades, 0 clases) y dejan de salir como hallazgo. Siguen existiendo y, en
    cuanto se dicte el horario, aparecerán en él con sus horas. Si algún día entran en el curso, se
    marcan con `[[estudiar:…]]` y vuelven al circuito normal.

30. **Un «sustituir» mal puesto ya no puede borrar el temario (fallo real, encontrado y cerrado).**
    Durante un turno real de prueba, el coordinador emitió `[[sustituir:Lengua…]]` al contestar una
    duda (no al recibir una lista) y **dejó Lengua con 8 unidades inventadas de las 16 que tenía**.
    La copia previa existía y se restauró. Ojo con la secuencia, porque hubo dos pasos: después tú
    dictaste **tus 8 unidades reales** de Lengua y el coordinador las guardó (13:03); la primera
    restauración devolvió las 16 del currículo por error y se ha corregido: **Lengua tiene ahora tus
    8 unidades, con el temario marcado como completo**, y las 16 anteriores quedan en copia. Las dos
    redes para que no vuelva a pasar:
    - **En el producto:** antes de borrar, se cuenta cuántas unidades trae la lista nueva. Si es más
      corta que la que ya hay, **no se borra nada**, se descarta esa lista y se pide confirmación
      explícita («sustituye el temario de X»). La etiqueta se documenta además en el prompt como
      prohibida al contestar dudas.
    - **En la prueba en vivo:** guarda una foto del temario **materia por materia** (el total no
      basta: una materia puede perder 8 y otra ganar 8), restaura lo que falte y **falla** si
      detecta una pérdida. Comprobado con un caso nuevo: 2 unidades contra 14 existentes → avisa,
      conserva las 14 y no crea las de prueba.

31. **La IA ya recuerda la conversación (el estancamiento que reportaste).** La causa era concreta:
    la API de Gemini no entiende `messages` (formato OpenAI), necesita una lista de pasos. El tutor
    le pasaba sus pasos crudos y sí recordaba; **el coordinador solo le mandaba `messages`, que
    Gemini ignoraba**, así que contestaba cada turno como si fuera el primero. Groq y OpenRouter sí
    leían el historial, y por eso el fallo dependía de quién contestara. Ahora, si no hay pasos
    crudos, se construyen desde el historial ([chatMessagesToGeminiHistory](src/lib/aiEngine.ts)):
    cada turno del alumno como `user_input` y cada respuesta como `model_output`. Además, los turnos
    viejos del tutor sin pasos guardados se reconstruyen desde su texto en vez de perderse, y la
    prueba de memoria ya no puede dar un falso «TODO EN VERDE» si revienta a mitad. Verificado con
    dos turnos reales: se le dice una palabra secreta y, dos turnos después, **el coordinador y el
    catedrático la repiten** (`verify:memoria`, sección 4.b).

32. **La puesta a punto obedece: «sustituye el temario de Lengua» se hace.** La red del punto 30
    protegía los datos pero se pasó de freno: bloqueaba **también** los reemplazos que pedías tú,
    porque el modelo tenía prohibido emitir `[[sustituir:…]]` con listas más cortas. Ahora la
    autorización viene de **tu mensaje**, no de la respuesta del modelo
    ([setupReplaceIntent.ts](src/lib/setupReplaceIntent.ts)):
    - Se reconoce la orden («sustituye / reemplaza / cambia / borra … temario / unidades / lista») y
      **no** se confunde con una pregunta («¿qué temario me falta?») ni con una negación («no lo
      cambies»).
    - Se identifica la materia aunque la nombres corto («Lengua» → Lengua Castellana y Literatura I).
    - Si el modelo emite las unidades pero se olvida de la etiqueta, **el sistema antepone el
      reemplazo**: es tu orden, no una invención suya. Y si pides sustituir y la lista llega en el
      mensaje siguiente, la petición queda apuntada 10 minutos.
    - El prompt ya no le prohíbe hacerlo: le ordena emitir `[[sustituir:Materia]]` + **todas** las
      unidades en el mismo turno y decir cuántas han quedado, aunque sean menos.
    - El bloqueo sigue vivo para lo que **no** has pedido tú: si el modelo intenta un reemplazo por
      su cuenta, no borra nada.
    **Probado de extremo a extremo por la API real:** «sustituye el temario de Lengua por este» con
    3 unidades → `Temario de Lengua sustituido: 8 unidades anteriores fuera` y la base quedó con 3;
    después se restauraron tus 8 y se marcó otra vez como completo (103 unidades en total).

33. **La vista previa de los apuntes ya no enseña el tema equivocado (fallo real, encontrado y
    cerrado).** «Le pido unos apuntes de química orgánica y la vista previa es de trabajo mecánico».
    La causa no estaba en la vista previa: estaba en **qué unidad se elegía antes de escribir**. El
    catedrático propone el apunte con una etiqueta `[[apunte:U16=…]]`, y el modelo escribía el número
    de la unidad **que está dando en clase** (U16, trabajo mecánico) aunque el título fuera de otra
    (U9, química orgánica); el redactor recibía esa unidad y redactaba ese tema. Quedó probado en el
    log: dos vistas previas de Física y Química **U16 «Trabajo, energía y potencia»** antes del
    arreglo. Se corrige por los dos lados:
    - **El catedrático ya tiene el temario delante.** El prompt le lleva la lista con la numeración
      real (hasta 24 unidades) y le ordena que la etiqueta use el número de la unidad **de la que
      habla**, no la de clase ([tutor.ts](src/lib/tutor.ts)).
    - **Y si aun así se equivoca, manda el título.** Antes de redactar, el número se contrasta con el
      título del apunte contra el temario ([noteUnitMatch.ts](src/lib/noteUnitMatch.ts)): cuentan las
      palabras significativas y pesan más las primeras del título; solo cambia de unidad si gana **en
      solitario** y comparte más con ese título que con la unidad del número. Si empata o el título
      es genérico («apuntes de la unidad»), **no se toca nada**: no se adivina. La corrección se
      aplica también al guardar la propuesta, así que la tarjeta del chat y el redactor hablan de la
      misma unidad, y la vista previa dice de qué unidad son y avisa si el número se ha corregido.
    **Probado por la API real con el caso exacto:** propuesta U16 «Química del carbono: formulación y
    nomenclatura» → la vista previa sale **U9 «Química orgánica: grupos funcionales y formulación»**,
    3.132 palabras y 9 apartados, sin una línea de trabajo mecánico. Y por el camino normal, pidiendo
    los apuntes por el chat, el catedrático ya propone **U9** él solo.

34. **«No se puede acceder a este sitio web · ERR_FAILED»: la app no estaba en pie, y ahora arranca
    sola.** El reporte («me ha vuelto a dar el error el catedrático de Lengua») no era del
    catedrático ni de Lengua: era el navegador diciendo que **no había nadie escuchando en el puerto
    3000**. Los rastros lo dejaron claro: la URL que falló tenía un id de catedrático antiguo
    (`c15329db…`, ya no existe) y la app la redirige bien (`307 → /brainup`, y eso responde 200); lo
    que faltaba era el servidor. La causa de fondo: el servidor vigilado (`scripts/sirve.js`) se
    levanta solo si se cae, **pero nadie lo arrancaba al iniciar Windows**, así que cualquier
    reinicio —o cerrar la terminal de la que colgaba— dejaba el marcador roto hasta que alguien lo
    arrancaba a mano. Arreglado en tres piezas:
    - **Arranque sin ventana, y sin ningún script que se pueda perder**
      ([instala-arranque.js](scripts/instala-arranque.js) y [sirve.js](scripts/sirve.js)): el acceso
      directo y el latido ejecutan una línea de PowerShell (`-Command`, **sin fichero de script**) que
      lanza el servidor vigilado. Él decide si hay que arrancar: mira el PID y pregunta a
      `/api/salud`, así que **no abre una segunda copia** (dos Next sobre el mismo `.next` se pelean).
      Antes era un `.vbs` y **Windows Defender lo borró**; después, un `arranca-oculto.ps1` que
      **también desapareció** — el 28 de octubre el instalador avisaba «falta un script» y tenía
      razón. Un script en disco que lanza procesos ocultos es justo lo que un antivirus se lleva.
      Ahora no hay fichero que borrar: el comando va en la propia línea y el lanzador es el propio
      servidor.
    - **Arranque al iniciar sesión** ([instala-arranque.js](scripts/instala-arranque.js)):
      `npm run arranque:instala` · `arranque:estado` · `arranque:quita`. Aquí se empezó con una tarea
      programada de Windows y **no funcionó** (deshabilitada, política de batería y muerte del hijo al
      terminar la tarea): el mecanismo que queda es un acceso directo en la carpeta de Inicio. Ver el
      punto 37, que es el que vale.
    - **Un solo mecanismo a la vez**: cuando la tarea existe, el instalador quita el acceso de Inicio
      (y los restos `.vbs` de la versión anterior).
    **Verificado con la app en marcha:** tarea `Habilitado` ejecutándose como `ojeda`; la app en pie a
    los 9 s de lanzar el oculto (`salud=200`); volver a lanzarlo con la app viva **no duplica**
    (mismo pid, mismos cuatro procesos, 200); y el proceso sobrevive a la terminal que lo lanzó.
    Queda una cosa que no se puede probar sin cerrar sesión: el disparo real en el próximo inicio de
    sesión (la tarea está habilitada y su acción es la correcta).

35. **El «ERR_FAILED» de verdad: el service worker y el compilado al vuelo.** El error volvió a
    salir con el servidor **perfectamente vivo** (`salud=200`), y esta vez sí se ha encontrado la
    causa, que no era una: eran dos capas que solo existen para «mejorar» la app y la rompían.
    - **El service worker interceptaba las páginas.** Pedía la página, y si esa petición fallaba un
      instante (el servidor compilando), la relanzaba tal cual: el navegador lo pinta como web
      caída, `ERR_FAILED`, aunque la app estuviera ahí. Ahora **no toca las navegaciones**
      ([sw.js](public/sw.js), caché `brainup-v3`): el navegador pide la página y punto. Sigue
      cacheando solo lo estático, que es lo único donde el offline tiene sentido.
    - **La app se servía compilando cada ruta al vuelo** (`next dev`: 800+ módulos, varios segundos
      por página, y con el alumno esperando). `scripts/sirve.js` ahora sirve **producción** cuando
      existe `.next/BUILD_ID` y solo cae a desarrollo si no hay compilación. Medido con reloj, antes
      y después: `/brainup/lengua…` **818 ms y compilando** → **340 ms ya hecha**; `/apuntes` 83 ms;
      `/api/salud` 84 ms.
    - **Y generar apuntes dejó de colgarse un minuto para fallar.** Con todas las claves sin cupo,
      el motor encadenaba treinta intentos (una petición real tardó **74 s**) antes de dar el mismo
      error. Ahora, si no queda ninguna clave con cupo, se dice en el acto
      ([aiEngine.hasAnyFreeKey](src/lib/aiEngine.ts) + [route](src/app/api/tutor/notes/route.ts)) con
      el consejo de esperar o añadir otra clave.
    - **La tarea programada se quedaba deshabilitada** y aun así parecía instalada: `arranque:estado`
      ahora lo dice con esas palabras y, si Windows la deshabilita, el instalador deja además el
      acceso directo de Inicio. Comprobado: habilitada y sigue así tras un minuto.
    **Verificado con la app en producción:** página de Lengua cargando y navegable en el navegador,
    `sw.js` servido con `brainup-v3`, y unos apuntes de Lengua U1 generados por la API en **20 s**
    (2.377 palabras, 8 apartados, unidad correcta). Ojo al trabajar con código: en producción los
    cambios no salen hasta `npm run build` + reiniciar.

36. **«Hydration failed»: la pestaña era vieja, no la app.** El aviso de React («el HTML del
    servidor no coincide con el del cliente», con el botón «Sí, escríbelos» en un lado y «Sí,
    enséñamelos antes» en el otro) no era un fallo del cuaderno: era una **pestaña abierta desde
    antes del último compilado**. Su JavaScript era el viejo (incluso el de desarrollo) y, al
    navegar, recibió del servidor una respuesta de la compilación nueva. React regenera el árbol y
    la página sigue funcionando, pero asusta y no dice qué hacer. Arreglado por dos sitios:
    - **La app avisa en vez de dejar que React se queje.** `/api/salud` devuelve ahora el `build`
      (el `BUILD_ID` de la compilación que se está sirviendo) y [PwaRegister](src/components/PwaRegister.tsx)
      compara cada dos minutos con el que cargó la pestaña: si cambió, sale un aviso discreto abajo
      con **«Recargar ahora»**. No recarga solo (nadie pierde lo que está escribiendo).
    - **Y el error deja de poder repetirse por el otro lado:** el service worker ya no intercepta
      navegaciones (punto 35) y la app se sirve compilada, no recompilando rutas al vuelo.
    **Probado en el navegador de verdad:** con la pestaña en la compilación actual, se falseó su
    `sessionStorage` a una compilación vieja y, al recargar, el aviso apareció (`banner: true`);
    después se limpió y la página volvió a su estado normal. El HTML servido y el `build` de
    `/api/salud` coinciden (`JvAivY4G8_26dq0H5kKUQ`).

37. **El arranque automático, de tarea programada a acceso directo (corrección del punto 34).** La
    tarea programada de Windows **no sirve aquí**, y no por un fallo de configuración: se probó tres
    veces y falló de tres maneras distintas, todas mudas (la tarea «parecía» puesta): Windows la dejó
    **deshabilitada**; su política de energía decía «no iniciar con batería»; y al terminar la
    acción se llevaba por delante el servidor que acababa de arrancar (`-Foreground` lo evitaba, pero
    la tarea se quedaba en cola esperando a una instancia anterior). Ahora el mecanismo es un
    **acceso directo en la carpeta de Inicio del usuario** (lo lanza Explorer, no una terminal, y no
    depende de políticas de energía ni de permisos): `npm run arranque:instala` lo crea, `arranque:estado`
    lo consulta y `arranque:quita` lo borra. La tarea antigua se ha **eliminado** (como administrador)
    para que no haya dos mecanismos ni uno muerto que parezca vivo. El lanzador escribe ahora
    `data/logs/arranque.log` con lo que hace, que es lo que faltaba para diagnosticar los tres fallos
    anteriores. **Verificado:** acceso directo con destino, argumentos y carpeta correctos; `salud=200`;
    relanzarlo con la app en pie no abre una segunda copia; y el proceso sobrevive al cierre de la
    terminal que lo lanzó. Sigue sin poder probarse sin cerrar sesión el disparo real del inicio de
    sesión.

---

## 2. Qué está verificado (y con qué)

| Comprobación | Comando | Resultado |
|---|---|---|
| Tipos de todo el proyecto | `npx tsc --noEmit` | Limpio |
| Motor de IA (**80 comprobaciones**: claves, reparto de carga, prioridad del fondo y **OpenRouter** como tercer proveedor) | `npm run verify:ai` | TODO EN VERDE |
| **Memoria entre días (47 comprobaciones, con app en vivo)** | `npm run verify:memoria` | TODO EN VERDE |
| Mantenimiento (reglas + rastro, con la regla nueva de apuntes) | `node scripts/verify-mantenimiento.js` | TODO EN VERDE |
| **Apuntes con restos de código: detección y arreglo** | `verify:mantenimiento` + el taller en `/mantenimiento` | TODO EN VERDE (1 apunte limpiado de verdad) |
| Contexto del catedrático (apuntes y presupuesto) | `npm run verify:tutor-contexto` | TODO EN VERDE |
| **Documentos del catedrático (troceado, páginas y recuperación, 37 comprobaciones sin gastar IA)** | `npm run verify:tutor-documentos` | TODO EN VERDE |
| **Adjuntos, incluida la subida en streaming de un documento de 11 MB** | `npm run verify:tutor-adjuntos` | TODO EN VERDE |
| **Puesta a punto (protocolo, integridad, horario y curso entero: materias sin seguimiento, temario confirmado y horario cerrado)** | `npm run verify:puesta-a-punto` (+ `--live`) | TODO EN VERDE (con la app: 3 clases dictadas, apuntadas y retiradas; Religión marcada como «solo horario» y revertida; 14 unidades confirmadas y revertido) |
| **Rutas de los catedráticos: slug estable, UUID vivo y UUID obsoleto** | `curl` con la app en marcha | `200` en los tres slugs · `200` con UUID vivo · **`307 → /brainup`** con el UUID que falló |
| **Errores del navegador registrados en el mismo log que lee el taller** | `POST /api/errores` | `{ok:true}` y línea escrita en `data/logs/errores-app.log` |
| **Motor local sin tocar la RAM del equipo** | `GET /api/salud` | `localModel: {freeMb: 1041, minFreeMb: 1200, room: false}` → no se carga |
| **Catedrático sin IA: respaldo local en vez de error** | módulo transpilado + `verify:tutor` | Texto útil con datos reales, sin contenido inventado · el chat con IA sigue en verde |
| **El taller no pide temario a lo que solo está en el horario** | `npm run doctor` | Hallazgo «Asignaturas sin temario» desaparece para Religión y Educación Física |
| **Un «sustituir» con lista más corta no borra el temario** | `verify:puesta-a-punto` (caso nuevo contra la base) | conservadas=true · avisa=true · sin unidades de prueba=true |
| **Si el alumno pide sustituir, se sustituye (aunque sea más corto)** | `verify:puesta-a-punto` + API real | reconocida la orden y la materia · 8→3 aplicado · restaurado a 8 |
| **El turno real no toca el temario** | `verify:puesta-a-punto -- --live` | La base sigue igual · sin pérdidas por materia |
| **Memoria de la conversación (dos turnos, coordinador y catedrático)** | `npm run verify:memoria` | Verde · ambos repiten la palabra secreta · 0 unidades/exámenes tocados |
| **Memoria entre días** | `npm run verify:memoria` | Verde · 19 recuerdos restaurados tal cual tras la prueba |
| **Temario perdido: regla, reposición y copia diaria (13 comprobaciones nuevas)** | `npm run verify:mantenimiento` (+ `--live`) | TODO EN VERDE (reposición real medida: ninguna materia pierde unidades) |
| **Examinador: la prueba ya no deja mediciones falsas** | `npm run verify:examinador` | TODO EN VERDE (4 unidades restauradas a su estado previo) |
| Capa de honestidad (niveles y notas) | `npm run verify:conocimiento` | TODO EN VERDE |
| Moodle por Web Services simulado | `npm run verify:moodle-ws` | TODO EN VERDE (16 llamadas) |
| **Moodle por sesión web (sin clave), con login HTTP real** | `npm run verify:moodle-sesion` (+ `--live`) | TODO EN VERDE |
| Formato inline (cuaderno y chat) | `npm run verify:inline` | TODO EN VERDE (23 comprobaciones) |
| Apuntes que escribe la IA (con la puerta de estructura y **la unidad correcta**, 10 comprobaciones nuevas) | `npm run verify:apuntes-ia` (+ `--live`) | TODO EN VERDE |
| Repaso SRS · retos · horario · temario | `verify:srs`, `verify:retos`, `verify:horario`, `verify:temario` | TODO EN VERDE |
| Diagnóstico del sistema en un comando | `npm run doctor` | La app funciona; ver §4 para los hallazgos abiertos |
| **La app se levanta sola al iniciar sesión (acceso directo de Inicio + lanzador sin ventana)** | `npm run arranque:estado` · `curl /api/salud` | Acceso directo con destino/argumentos correctos · oculto levanta la app en 3-9 s · relanzarlo no duplica · `salud=200` |
| **La pestaña avisa si la app se ha recompilado** | `/api/salud` + navegador | `build` = `BUILD_ID`; con la pestaña falseada a una compilación vieja, el aviso aparece (`banner: true`) |
| La app y el vigilante en marcha | `curl /api/salud` · `data/logs/*.pid` | HTTP 200 · `ok=true` · rondas cada 300 s (última, 16:43) |
| Base intacta tras todas las pruebas | consulta directa | 9 materias · **103 unidades** (Lengua con tus 8 dictadas) · 27 clases · 0 restos de prueba |

**Lo medido hoy, con reloj, no «a ojo»:**

- Un proveedor colgado de mentira, con presupuesto de 6 s: el turno **termina en 4,7 s** en vez de
  esperar los 90 s de antes por intento. Sin presupuesto (1 ms) la respuesta se rechaza en
  **0 ms y sin una sola llamada al proveedor**.
- Con **tres claves sanas**, cuatro turnos seguidos del motor salen por **clave 1 → 2 → 3 → 1** y
  cada uno a la **primera llamada** (antes la principal habría hecho los cuatro). Y con el cupo ya
  justo, el turno de mantenimiento se aparta en **0 llamadas al proveedor** (no gasta ni el intento).
- Un turno real por `/api/tutor` y otro por `/api/puesta-a-punto`:
  **0,99–3,5 s el catedrático** y **1,1–4,4 s el coordinador**, según el momento (el tope es 30 s).
  La diferencia entre la primera medida y la segunda es la caché de compilación en frío.

**Comprobado en vivo, no en teoría:**

- **La memoria, de ayer a hoy:** se plantó un recuerdo de «ayer» y se le habló al catedrático. El
  log de la app dice `[tutor] memoria del catedrático: 234 caracteres` → ese recuerdo **entró en el
  prompt de hoy**. Y lo hablado hoy se apuntó solo para mañana (`writtenBy: ia`).
- **Tus dos reportes, atendidos por el sistema:** en la ronda de las 16:28 el vigilante los leyó
  (con `gemini-3.5-flash-lite`) y los dejó diagnosticados, cada uno con su explicación escrita
  dentro del propio reporte, que en `/mantenimiento` pasa de «abierto» a «revisado» y enseña la
  frase del diagnóstico como resolución. No los tocó nadie a mano.
- **Moodle, con un Moodle de mentira:** clave rechazada (`invalidtoken`) → marcada como caducada y
  aviso abierto en el taller diciendo qué hay que hacer; la clave vuelve a valer → `ok`, el aviso se
  cierra solo y **se sincroniza sin que se lo pidas**.
- **El recuadro vacío:** forzando esa respuesta concreta, el tutor **lanza un error claro** en vez de
  guardar un mensaje sin texto (y una respuesta normal sigue pasando con su etapa socrática).
- **Moodle por sesión, con un Moodle de mentira servido por HTTP:** se abre la sesión con usuario y
  contraseña, viaja la cookie, se leen los dos cursos, la página del curso entera (recursos y
  tareas), el PDF de verdad de un recurso y las entregas; con la contraseña mal se dice **«Usuario o
  contraseña incorrectos»** y queda marcado como credenciales inválidas; el sitio que no enseña el
  formulario de acceso se explica en vez de inventarse una sesión. Y el caso que era el tuyo: el
  centro **no da clave** → en vez de fallar, la app entra por sesión, guarda las credenciales y
  sincroniza por esa vía (2 cursos, 3 tareas, 3 apuntes con su archivo).
- **Un apunte real, pedido por la API como lo pide el chat:** salió de **1.729 palabras con 7
  apartados `### `**, sus 7 secciones, fórmulas en LaTeX y sin una sola etiqueta HTML ni valla de
  código; la API devolvió `attempts: 1` (pasó la puerta a la primera) y no dejó ningún aviso en el
  taller. El `.md` descargado y la vista de impresión salen igual de limpios.

### Fallos encontrados y arreglados durante esta sesión

1. **El recuadro vacío del chat** (lo reportaste tú): ver §1.9.
2. **Dos verificaciones medían mal** y fallaban por el estado de tu base, no por un fallo real:
   - `verify:puesta-a-punto` daba por «nivel inventado» cualquier unidad nacida en la entrevista que
     **luego se hubiera medido de verdad** (un chat del catedrático, un simulacro). Ahora comprueba
     lo que de verdad protege: que **ningún nivel exista sin una medición detrás** (`sin_medir`
     siempre a 0 y orígenes solo los reales). Sigue siendo exigente con un dato más: 88 de tus 94
     unidades de la entrevista están sin medir y 6 lo están con medición real.
   - `verify:conocimiento` exigía el texto «sin datos aún» en `/estadisticas` **siempre**, aunque ya
     hubiera datos (con datos, la página enseña el número real, que es lo correcto). Ahora acepta el
     estado que toque, igual que ya hacía con el Cuartel.
3. **Un giro de la cadena de modelos podía saltarse el tope nuevo**: si se agotaba el
   presupuesto durante una espera de reintento, se empezaba igualmente un intento más.
   Detectado probándolo con un proveedor colgado y corregido (ahora se mira el reloj antes de cada intento).
4. **Un proveedor caído se comía el turno entero** (el 503 con Groq sano): ver §1.14. Se
   encontró verificando la memoria con la app en marcha, se reprodujo primero con un mock
   (motor viejo: 30,1 s → 503; motor nuevo: 5,0 s → respuesta) y se dejó su prueba en `verify:ai`.
5. **Un apunte guardado con etiquetas `<details>` dentro** (de antes de que existiera el
   limpiador): el taller no lo veía porque no miraba dentro de los apuntes. Ahora lo ve, lo
   limpia y lo demuestra: los tres apuntes de la base están con **cero restos de código**.
6. **Dos fallos de forma en la verificación, no en la app**: el log de la memoria se lee de
   `data/logs/servidor.log` (si la app se levanta a mano con `next dev`, esa línea no llega
   ahí), y el caso «resumen con cuerpo y sin apartados» del taller se mide ahora como lo que
   es: estructura, no extensión.

---

## 3. Cómo se usa

```bash
npm run sirve              # arranca la app + el vigilante de mantenimiento (recomendado)
npm run sirve -- --status  # ¿está viva? ¿quién escucha en el puerto?
npm run sirve -- --stop    # para la app y el vigilante
npm run movil              # la dirección para abrirlo en el móvil, comprobada
npm run doctor             # parte completo: salud, base, IA, hallazgos y arreglos
npm run verify:memoria     # comprueba que la memoria funciona (con la app en marcha)
```

Y en la app: **Taller de Mantenimiento** (`/mantenimiento`) enseña todo lo que se ha detectado,
cuántos casos hay, un ejemplo de cada uno, qué se arregla solo y qué no. Los fallos que anotas tú
tienen su botón —*Atender lo que has reportado*— y, si no lo pulsas, los atiende el vigilante en su
siguiente ronda. **No hace falta que reportes nada** para lo que el sistema puede medir solo.

Dónde queda todo escrito: `data/logs/servidor.log`, `data/logs/vigilante.log`,
`data/logs/vigilante-ultimo.json` (última ronda entera en JSON), `data/logs/errores-app.log`.
La memoria de la IA se puede ver en `GET /api/salud` (`memory`: días guardados, ámbitos y último
recuerdo).

---

## 4. Qué falta (y qué es un límite, no un olvido)

### Pendiente de hacer

1. **Los apuntes anteriores se fueron con la semilla y hay que volver a pedirlos.** El
   16 de octubre la base quedó en **0 apuntes** (la semilla borra temario, apuntes, horario y
   conversaciones). El temario ya está repuesto y lo que falte lo repone el taller solo, pero
   un apunte **solo se puede volver a pedir**: se pide en el chat del catedrático de esa
   materia y ahora sale con la vista previa delante, la puerta de estructura y las anotaciones
   de cómo lo explicó el profesor.
2. **Moodle conectado con tus datos reales.** El sistema ya sabe cuidar la conexión (detecta la
   clave caducada y resincroniza solo) y **ya se puede conectar sin clave**, entrando por la sesión
   web con tu usuario y contraseña. Lo que falta es solo el último paso, que no puede dar nadie más
   que tú: escribir tus credenciales en **Ajustes → Moodle**. Si tu centro no te deja crear la clave
   de Web Services, no pasa nada: esa es precisamente la vía que no la necesita.
3. **Tu horario de clases real.** La entrevista ya lo pregunta y lo estructura sola (etiqueta
   `[[clase:…]]`), y el plan de la tarde ya lo usa para poner el bloque la tarde antes de la
   clase de esa asignatura. Lo que falta es solo el dato: dictárselo al coordinador en
   `/puesta-a-punto` (o importarlo si lo tienes en un `.ics`). Hasta entonces, `npm run
   verify:horario` se niega a verificar con razón: **no hay franjas lectivas**.
4. **Notion, de verdad.** El cuaderno que usa la app es el suyo (local, con vista previa,
   impresión y descarga `.md`). `NOTION_API_KEY` y `NOTION_PAGE_ID` siguen con el valor de
   relleno del `.env` (dos caracteres), así que no hay conexión con Notion: si algún día
   quieres escribir en tu Notion real, hay que poner una clave de verdad y probarlo.
5. **El motor local (Ollama) no está instalado en este ordenador**, y no es un olvido: el
   chequeo dice que tiene **7,8 GB de RAM y ~1,0–1,1 GB libres**, así que lo más grande que
   recomienda es un `llama3.2:1b` (~1,3 GB), que escribe mucho peor que cualquiera de los
   tres proveedores gratuitos. Ya está preparado para no hacer daño si se instala —mira la RAM
   antes de cargar, una generación a la vez y descarga el modelo cuando deja de usarse—, pero la
   vía que de verdad amplía el cupo son las claves (varias por proveedor) y OpenRouter. **Notion**
   tampoco hace falta: el cuaderno de la app (vista previa, impresión y `.md`) es el que se usa.
6. **Memoria con más horizonte.** Se recuerdan los últimos 30 días, un recuerdo por día (antes
   eran 7). El bloque sigue acotado a 1 400 caracteres, así que si hay mucho se cae primero el día
   más viejo. Para mirar más atrás de un mes habrá que **resumir por semanas** (y olvidar lo que no
   aporta) en vez de acumular días, que es lo que mantiene el prompt corto.
7. **El aviso «Fallos reportados sin revisar» debería mirar solo los tuyos**, no contar también las
   incidencias que abre el propio vigilante: es el ruido que se describe en los límites.

### Límites honestos

- **El texto de un documento lo lee cualquier proveedor; una imagen necesita visión.** PDFs con
  capa de texto, Word, PowerPoint, TXT, Markdown… se extraen en el servidor y viajan como texto,
  así que Groq, OpenRouter y Ollama también los leen (antes solo Gemini). Una **captura** o un
  **PDF escaneado sin capa de texto** solo lo lee un modelo multimodal: Gemini siempre; Groq solo
  si su catálogo tuviera un modelo con visión (hoy no); OpenRouter y Ollama si el modelo elegido es
  de visión. Si en ese turno no hay ninguno disponible, se avisa con el nombre exacto y no se finge
  haberlo visto. La salida pendiente para los escaneos es **OCR** (o visión página a página), que
  sigue siendo trabajo por hacer.
- **Un documento de más de 40 millones de caracteres se corta** (~8 000 páginas: más que un temario
  y dos cursos juntos). Entonces se te dice con los números delante («se han leído 40 000 000 de
  52 000 000 caracteres»), en vez de dejar creer que se ha leído todo. Ningún material de estudio
  real llega ahí: el libro de prueba de 70 000 páginas son 32,8 millones y entra entero.
- **La primera pregunta sobre un documento grande tarda algo más** (entre 1 y 2 s de búsqueda sobre
  35 000 trozos): el índice se construye al subir, pero elegir los extractos de cada pregunta se
  hace en el turno. Está medido y es de sobra para el tope de 30 s del chat.

- **El tope de 30 s es un tope, no una promesa de 30 s.** Si los tres modelos gratuitos están
  saturados, el chat contesta **en modo local** y te lo dice; lo que no hace es dejarte mirando
  la pantalla. Con una clave de Groq de respaldo se nota mucho menos.
- **Cada proveedor gratuito tiene su propio techo, y son distintos.** Gemini: 20 peticiones al día
  por clave en su modelo grande (por eso hay tres claves puestas: el cupo se cuenta por clave).
  Groq: cupo diario por clave, también ampliable con más claves. **OpenRouter: 20 peticiones por
  minuto y 50 al día, y ese tope es de la CUENTA, no de la clave** (más claves no lo multiplican,
  y la app lo dice así en Ajustes en vez de prometer de más). Ollama no tiene techo, pero depende
  de tu ordenador: en este equipo, con 1,1 GB libres, solo caben modelos pequeños.
- **El cupo gratuito de Gemini es de 20 peticiones al día** en su modelo grande (`gemini-3.8-flash`;
  los demás, 5 por minuto): un día de estudio intenso lo agota, y a partir de ahí todo va por Groq
  hasta que se renueve. No es un fallo de la app y se ve en el taller («Modelos de IA en
  enfriamiento»): es la realidad de las claves gratuitas, y por eso el motor usa las dos. Desde el
  15 de octubre hay una salida que no cuesta nada: **añadir más claves gratuitas** (`GEMINI_API_KEY_2`,
  `GEMINI_API_KEY_3`, `GEMINI_API_KEY_4`) multiplica el cupo diario, porque el límite es de cada
  clave. Todo eso sigue siendo un techo: cuando se agota, la app lo dice y contesta en local.
- **La IA puede tardar en el pulido de la memoria**, pero nunca bloquea: el recuerdo de las reglas
  se guarda siempre, y el pulido va después de tu respuesta (`after`).
- **Una clave de Moodle caducada no se puede arreglar sola** y es a propósito: pedir una clave nueva
  exige tus credenciales. Lo que sí hace el sistema es detectarlo, decírtelo en Ajustes con el aviso
  del taller y seguir funcionando con lo ya descargado.
- **«Fallos reportados sin revisar» ya no se cuenta a sí mismo.** Antes la incidencia que abría
  ese aviso lo mantenía abierto en cada ronda (un aviso sobre sí mismo), así que el taller
  enseñaba un problema permanente que no existía y nunca se cerraba solo. Ahora la comprobación
  ignora las incidencias nacidas de ese mismo aviso: se abre cuando hay fallos reales y se cierra
  sola cuando no queda ninguno.
- **El sistema no puede arreglar lo que nunca se ha visto.** Detecta lo que sabe medir: datos
  incoherentes, caídas, paradas, errores registrados, IA fallando, tu Moodle. Un fallo nuevo se
  convierte en incidencia con su causa, y a partir de ahí se le puede enseñar la comprobación que lo
  caza.

## 20 de octubre: el chat no se reinicia y la IA deja de caer por el tamaño del prompt

El parte de las 18:00 tenía tres síntomas que parecían tres averías y eran dos: el chat se
«reiniciaba» al volver a entrar y todos los modelos decían estar saturados cuando Groq estaba sano.

1. **El chat se reiniciaba por una consulta mal hecha, no por falta de memoria.** La página del
   catedrático buscaba la conversación con el valor de la URL. El listado enlaza por el *slug* de la
   materia («matematicas-i»), no por el UUID, así que la búsqueda no encontraba nada, el chat se
   pintaba vacío y el siguiente mensaje abría otra conversación. Ahora se busca por `agent.id` y,
   además, el servidor **reutiliza la última conversación** del catedrático cuando el navegador no
   manda `conversationId`: recargar, cambiar de pestaña o volver desde el móvil ya no parte el hilo.
   La memoria entre días sigue escribiéndose sola; su ventana pasa de 7 a **30 días** (el bloque
   sigue limitado a 1 400 caracteres, así que no engorda el prompt).
2. **«Todos los modelos saturados» era, sobre todo, un prompt que no cabía.** El bloque de
   documentos puede ocupar 45 000 caracteres. Gemini estaba en 429/502 y el turno caía en Groq, que
   rechaza la petición entera por ITPM (límite 7 000–8 000 tokens) con «Request too large». El motor
   lo apuntaba como `too_large`, enfriaba el modelo y probaba otro: al final, ningún modelo contestaba
   aunque Groq tuviera cupo. Ahora, **antes de llamar**, el motor estima el tamaño y recorta el
   historial y el bloque de documentos para que quepa (conservando identidad, expediente y protocolo);
   si el proveedor aún se queja, aprieta el recorte y **reintenta el mismo modelo**. Medido con el
   documento de prueba de 30 000 caracteres: **Groq contestó en 0,68 s con el dato correcto** y
   `legibles: true`; con el temario de 11,4 millones de caracteres y 15 000 páginas, Groq citó la
   página 12 000 correctamente. También se lleva una ventana de tokens por minuto para no mandar dos
   turnos seguidos que se rechacen entre sí.
3. **El catálogo metía modelos que no podían contestar.** Groq tiene en su lista modelos de voz
   (`canopylabs/orpheus-*`) y de guardia; el motor les daba 6 000 puntos por defecto y los probaba
   como catedráticos. Ahora solo entran familias de texto conocidas y se excluyen TTS, audio, guard,
   embeddings y previews. En Gemini se vetaron las generaciones retiradas (`2.5`, `2.0`, `1.5`), que
   el catálogo anuncia pero devuelven 404 a cuentas nuevas.
4. **Adjuntos en todos los proveedores.** El texto de PDFs, Word, PowerPoint y texto ya se extraía,
   pero solo se le decía a Gemini; a Groq se le mandaba el nombre y un aviso de que no podía leerlo,
   aunque el texto estuviera en el prompt. Ahora el motor recibe qué adjuntos son legibles como
   texto, no los marca como «no leídos», y manda las **imágenes** como `image_url` (data URL) a los
   modelos con visión de Groq, OpenRouter y Ollama. El aviso al alumno solo nombra lo que de verdad
   no se ha podido leer y ya no dice «(Groq)» a todo.

Verificado con `npm run verify` (lint + TypeScript), `verify:ai` (incluye dos pruebas nuevas:
recorte con reintento y visión fuera de Gemini), `verify:tutor-adjuntos`, `verify:tutor-documentos`,
`verify:tutor-contexto`, `verify:tutor` y `verify:memoria`. En vivo: la página por slug carga los
mensajes anteriores, un POST sin `conversationId` reutiliza la misma conversación y contesta Groq
sin degradar, y el documento de prueba se lee con el dato correcto. Lo que sigue pendiente es el
**OCR** para escaneos sin capa de texto cuando no hay ningún modelo con visión disponible; el texto
de documentos ya no depende del proveedor.

## 27 de octubre: la app, también en el móvil

Lo que faltaba no era que la app no escuchase a la red —Next ya se abre a todas las conexiones y el
log lo venía diciendo desde el principio: `Network: http://172.16.0.2:3000`— sino saber **con qué
dirección** (que no es fija) y que el **cortafuegos de Windows** deje pasar al móvil.

1. **La dirección, dicha por quien la sabe.** Se pregunta al sistema operativo
   (`os.networkInterfaces()`), en vez de apuntar una a mano, porque no es fija: en este ordenador se
   han visto `192.168.1.135`, `192.168.1.43`, `192.168.1.149` y `172.16.0.2` en dos semanas. Se
   señalan las conexiones de mentira (VPN, máquinas virtuales, WSL, Bluetooth), que existen pero no
   llevan a casa, y se enseñan primero las de verdad (Wi-Fi, cable).
2. **Tres sitios donde leerla:** la tarjeta nueva **Ajustes → «Usarlo desde el móvil»** (con los
   pasos y el cortafuegos), el comando `npm run movil` (comprueba que la app contesta en cada
   dirección y devuelve 1 si no contesta en ninguna) y la línea `Móvil:` que ahora imprime
   `npm run sirve` al arrancar, junto a la `Network:` de Next.
3. **La app escucha a la red de forma explícita.** `scripts/sirve.js` pasa `-H 0.0.0.0` y admite
   `BRAINUP_HOST=127.0.0.1` para quien prefiera que sea solo de este ordenador: la app no tiene
   contraseña, así que en la Wi-Fi de casa la vería cualquiera que esté en esa misma red.
4. **El cortafuegos, con el comando delante.** Es lo único que no se puede arreglar desde aquí: la
   petición que sale de este ordenador hacia su propia dirección no pasa por el cortafuegos, así que
   la comprobación local no puede demostrar que el móvil entra. La regla (una vez, en un PowerShell
   como administrador) queda escrita en la tarjeta de Ajustes, en `npm run movil` y en el README:
   `New-NetFirewallRule -DisplayName "BrainUp Academy (movil)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Private`

Límite honesto: sobre `http://` (la red de casa) el navegador del móvil no permite instalar la app
«de verdad» —el service worker y la instalación exigen HTTPS, y `localhost` es la excepción—, así que
en el móvil se abre como página y el icono de la pantalla de inicio es un acceso directo. Para
tenerla instalada de verdad en el móvil haría falta HTTPS (un túnel con certificado).

## 27 de octubre (tarde): por qué dejó de responder también en el móvil, y por qué nadie la levantó

El síntoma: la app dejó de responder **a la vez** en el ordenador y en el móvil («temporalmente
inactiva o trasladada a otra dirección»). La causa está en los registros, no se ha supuesto:

- El servidor se había arrancado **desde una aplicación** (el lanzador anotó «inicio (a mano)» a las
  17:27:49 en `data/logs/arranque.log`) y, cuando esa aplicación se cerró, Windows se llevó por
  delante **todo el árbol de procesos**: servidor, vigilante y lo que colgaba de él. El rastro es
  exacto: `vigilante.log` tiene su última ronda a las 18:13 y **ni una línea más**, y en
  `servidor.log` no hay ninguna caída registrada — no hubo caída, hubo un cierre del árbol entero.
- Y no la levantó nadie porque el **arranque automático no estaba puesto**: en `arranque.log` no hay
  ni una línea de arranque al iniciar sesión, todas dicen «a mano».

Lo que se ha cambiado para que no vuelva a pasar:

1. **Un latido de 5 minutos** (tarea programada «BrainUp Academy (latido)», la instala
   `npm run arranque:instala`): su acción es el servidor vigilado, que primero pregunta si la app
   responde y, si responde, **termina en el acto** (un latido barato); si no responde, se queda
   **bloqueado** ejecutándola. Así el fallo de hoy no puede repetirse: mientras la app vive la tarea
   está «en ejecución», y si el árbol muere, el siguiente tick la levanta otra vez.
2. **Los tres fallos mudos de la tarea de antes, desactivados uno a uno**:
   `-AllowStartIfOnBatteries` y `-DontStopIfGoingOnBatteries` (la política de energía que decía «no
   iniciar con batería»), **sin límite de tiempo de ejecución**, `-StartWhenAvailable`, y **se
   comprueba el estado al instalar**: si quedara `Disabled` se dice con esas palabras, en vez de dar
   por bueno que «parece puesta».
3. **Dos archivos de doble clic en la raíz del proyecto**, para no depender de ninguna terminal:
   `Arranca BrainUp.cmd` (la levanta ahora) e `Instala el arranque automatico.cmd` (deja el acceso
   directo de Inicio y el latido, y arranca la app).
4. `npm run arranque:estado` informa ya del latido (estado, último resultado y próxima vez) y
   `npm run arranque:quita` lo retira.

**28 de octubre — el primer intento de esos dos dobles clics falló, y la causa era real:** el
instalador avisaba «falta un script» y no se equivocaba. El lanzador `scripts/arranca-oculto.ps1`
**ya no existía en el proyecto** (como antes el `.vbs`, que se llevó Defender): un script en disco que
abre procesos ocultos es justo lo que un antivirus borra. Se ha quitado esa pieza de en medio:
- El acceso directo y el latido ejecutan una línea de PowerShell **sin fichero** (`-Command`) que
  lanza `sirve.js`; es el propio servidor el que decide si hay que arrancar (PID + `/api/salud`), así
  que ya no hay nada que pueda faltar ni borrar.
- `Arranca BrainUp.cmd` no llama a ningún script externo: busca Node (PATH, `Program Files`,
  `LocalAppData`), ejecuta el servidor **en su propia ventana** —que es la que lo mantiene en
  marcha— y abre el navegador en cuanto la app responde de verdad, no a los N segundos.
- Los dos `.cmd` ya no se cierran en silencio: si algo falla, dejan el error en pantalla y dicen en
  qué log mirar.

Regla que queda escrita para el futuro: **la app no se arranca desde la terminal de otra
instalación**. Con el latido puesto da igual —la levanta en cinco minutos—, pero el arranque bueno es
el de Inicio (acceso directo) o el del latido.

**30 de octubre — el arranque pasa a ser una app de Windows, no un CMD.**

El alumno lo dijo claro: «no debe iniciarse cuando le doy a arrancar en CMD; debe iniciarse cuando
la abro, y si da error, solucionarlo». Se ha cambiado el diseño entero del arranque:

- **Una sola tarea** `BrainUp Academy` con dos disparadores (iniciar sesión + cada 5 minutos) y
  `IgnoreNew`: Windows no solapa dos latidos. El principal es `Limited`: la app nunca corre como
  administrador, aunque la tarea se registre desde una ventana elevada.
- **Iconos propios** en el escritorio y en el menú Inicio. El icono ejecuta `scripts/abre.js`, que
  pregunta primero a `/api/salud`, pide el arranque a la tarea si hace falta y espera a que la app
  responda de verdad antes de abrir el navegador. Si a los 2,5 minutos no responde, abre
  `data/ultimo-arranque.html` con el motivo y el final del diario: se acabó el `ERR_FAILED` mudo.
- **Cerrojo de arranque** (`data/logs/arranque.lock`): dos procesos no pueden levantar dos Next
  sobre el mismo `.next` (era el riesgo real de tener tarea y acceso de Inicio a la vez).
- **Autorreparación**: `sirve.js` vuelve a habilitar la tarea cada vez que arranca, y deja una línea
  por latido en `data/logs/latido.log`. Si Windows o un antivirus la deshabilitan, abrir la app deja
  el arranque automático reparado.
- **Acceso de respaldo en Inicio** (Node directo, minimizado), independiente del Programador de
  tareas.

Verificado en el equipo: tarea registrada (`Ready`), dos disparadores, acción correcta, ejecución
real con `LastTaskResult = 0` y la app respondiendo `200`. Los tres scripts pasan `node --check`.
Queda pendiente la prueba definitiva (reiniciar y ver que aparece sola), que no se puede hacer desde
esta sesión.Lección aprendida: **el canal elevado de este entorno corta los comandos largos**. Por eso la instalación se parte en pasos cortos (`instala-tarea.ps1`) con diario propio, en vez de una línea gigante que muere a medias y deja la tarea «parece puesta».

## 2 de noviembre: el móvil, sin puertas cerradas

Cuatro fallos reales, corregidos con la app en marcha (`next dev`) y comprobados en el navegador a
390 × 844:

1. **Once secciones no tenían puerta en el móvil.** La barra inferior enseñaba seis destinos y
dejaba fuera Temario, Repaso, Cuaderno, NotebookLM, BrainUp IA, Examinador, Retos, Estadísticas,
Taller y Ajustes; desde el teléfono solo se llegaba escribiendo la dirección. Ahora la barra tiene
cuatro destinos diarios (Cuartel, Planificador, Horario, Exámenes) y un botón **Más** que abre un
cajón con las trece restantes. La sección activa se marca también en sus subpáginas, el cajón se
cierra al navegar, con Escape, al tocar el fondo y al pasar a escritorio; bloquea el desplazamiento
del fondo y respeta las áreas seguras. Comprobado: las 17 secciones se alcanzan, Ajustes navega y
el cajón se cierra; abierto a 390 px y pasado a 900, se cierra y devuelve el scroll.
2. **La cabecera desbordaba en el móvil** (391 px de contenido en 390; peor en 360). El badge de
modalidad y los huecos fijos empujaban el grupo derecho fuera de la pantalla. Ahora el badge se
oculta por debajo de `sm` y los huecos se reducen. Medido: `scrollWidth` 385 = `clientWidth` 385.
3. **«Iniciar Enfoque» no tenía texto nunca.** Usaba `hidden xs:inline`, y `xs` no existe en el tema
de Tailwind: el texto quedaba oculto también en escritorio y el enlace no tenía nombre accesible.
Ahora aparece desde `sm` y lleva `aria-label`.
4. **La guía de instalación era de Windows también en el móvil.** Ahora se elige al pulsar (iOS,
Android o escritorio), cada uno ve sus pasos y en iOS/Android se avisa de que la instalación
completa necesita HTTPS. El diálogo tiene `role="dialog"`, `aria-modal`, etiqueta, Escape y altura
máxima con scroll.

**Límite de esta tanda:** no se ha podido pasar `tsc` ni el build. El terminal de este entorno está
caído (la app que lo ejecuta no encuentra su `bash.exe`), así que la comprobación es de ejecución en
el servidor de desarrollo, no de compilación. Los cambios están vivos porque `sirve.js` sirve en
modo desarrollo; en producción no saldrían hasta `npm run build`.
