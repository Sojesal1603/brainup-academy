import type { Metadata, Viewport } from 'next';
import './globals.css';
import Sidebar from '@/components/Sidebar';
import Header from '@/components/Header';
import SplashScreen from '@/components/SplashScreen';
import AppErrorReporter from '@/components/AppErrorReporter';
import SessionStorageGuard from '@/components/SessionStorageGuard';
import { getOptionalUser } from '@/lib/auth';
import { getViewerCourse } from '@/lib/viewerCourse';

// La app entera depende de PostgreSQL en tiempo de petición. Sin esto, Next
// intenta prerenderizar `/_not-found` durante el build, monta el `Header` y
// consulta la base: el build falla si la base no está accesible en ese instante.
// `/_not-found` también pasa a dinámico y el build no toca datos. Las páginas
// de lectura ya no lo fuerzan: sus datos van por caché con etiquetas.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'BrainUp Academy | Centro de Operaciones Bachillerato & PAU',
  description:
    'Sistema privado de alto rendimiento académico, planificación activa, banco de errores y tutores IA adaptado a Bachillerato y PAU.',
  // Nombre con el que el sistema guarda la app instalada (móvil y escritorio).
  applicationName: 'BrainUp Academy',
  manifest: '/manifest.json',
  // Iconos generados desde el logo del cerebro (`scripts/generate-icons.js`).
  // El PNG va primero: los navegadores modernos lo prefieren al .ico, que queda
  // como `shortcut` para los que aún lo piden.
  icons: {
    icon: [
      { url: '/icon.png', type: 'image/png', sizes: '192x192' },
      { url: '/icon-512.png', type: 'image/png', sizes: '512x512' },
    ],
    apple: [{ url: '/apple-touch-icon.png', type: 'image/png', sizes: '180x180' }],
    shortcut: '/favicon.ico',
  },
  // iOS no lee el manifest para la pantalla de inicio: esto es lo que hace que
  // se abra a pantalla completa y con la barra de estado integrada.
  appleWebApp: {
    capable: true,
    title: 'BrainUp',
    statusBarStyle: 'black-translucent',
  },
  // Evita que Safari convierta números de tema en enlaces de teléfono.
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: '#0a0a0c',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  // Sin `maximumScale`: bloquear el zoom impide ampliar a quien lo necesita
  // (WCAG 1.4.4). En una app de estudio con fórmulas, además, se usa.
  // `cover` deja que la barra inferior respete el notch y la barra de gestos.
  viewportFit: 'cover',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // La navegación necesita la etapa para ocultar las herramientas que no
  // aplican (PAU en ESO y Universidad). Sin perfil se pinta la normal.
  const course = await getViewerCourse();
  // Solo se usa para saber si el navegador sigue siendo del mismo dueño que
  // escribió lo que hay en `localStorage` (el id es público para el propio
  // usuario; no se pinta nada con él).
  const user = await getOptionalUser();

  return (
    <html lang="es" className="dark">
      <body className="bg-[#0a0a0c] text-slate-100 min-h-screen flex antialiased selection:bg-emerald-500 selection:text-slate-950">
        {/* Tapa la app hasta que el perfil de la cabecera está resuelto. */}
        <SplashScreen />
        {/* Estado del navegador (Enfoque, borradores, descartes) atado a la cuenta. */}
        <SessionStorageGuard userId={user?.id ?? null} />
        {/* Sin JavaScript no hay quien retire la splash: se oculta por CSS. */}
        <noscript>
          <style>{'#brainup-splash{display:none !important}'}</style>
        </noscript>
        {/* Escucha los errores que se escapan de React y los apunta en el taller. */}
        <AppErrorReporter />
        <Sidebar hiddenHrefs={course.hiddenHrefs} badge={course.badge} />
        <div className="flex-1 flex flex-col min-w-0 min-h-screen">
          <Header />
          {/* En tablet (md) el contenido gana ancho útil: el padding grande
              espera a xl, así una pantalla apaisada de 1024 px no pierde
              columnas por los márgenes. */}
          <main className="flex-1 p-4 md:p-6 xl:p-8 max-w-[1600px] mx-auto w-full min-w-0 pb-24 md:pb-8">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
