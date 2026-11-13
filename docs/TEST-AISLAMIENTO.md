# Test de aislamiento entre cuentas

Comprobación manual, sin `service_role` y sin scripts que salten el login. La
ejecuta el autor en el navegador.

## Datos

- App: `http://localhost:3000`
- Cuenta real: `ojedasalazarsantiago@gmail.com` (`16bb4958-5288-493b-8c65-379dd31782f5`)
- Cuenta de prueba: `miguel.montilla.arechabala@gmail.com` (`3af632ee-22dc-4e75-85a8-139aa70600bf`)

## Pasos

1. Abrir una ventana de incógnito (sin sesión previa).
2. Entrar en `http://localhost:3000/login` e iniciar sesión con la cuenta de prueba.
3. Comprobar que la app arranca vacía: sin materias, temas, apuntes, exámenes,
   bloques ni tarjetas de repaso. Si aparece cualquier dato de la cuenta real,
   **parar y reportarlo**.
4. Cerrar la ventana de incógnito.
5. En una ventana normal, iniciar sesión con la cuenta real.
6. Comprobar que siguen sus datos: 9 materias, 102 temas, 25 bloques, 8 tarjetas
   de repaso, 4 exámenes y 3 apuntes.

## Qué NO hacer

- No usar la clave `service_role` ni el panel de Supabase para «arreglar» lo que
  se vea: el test mide el comportamiento real de la app.
- No activar el registro público antes de que este test pase.
- No repetir el login con la cuenta real en incógnito: la sesión debe quedar
  limpia entre cuentas.

## Resultado esperado

La cuenta de prueba ve 0 filas en todas las tablas con `userId`; la cuenta real
conserva las 473 filas migradas (471 de datos + 2 avisos del vigilante).
