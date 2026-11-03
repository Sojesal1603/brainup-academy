import type { Metadata, Viewport } from 'next';
import './globals.css';
import Sidebar from '@/components/Sidebar';
import Header from '@/components/Header';
import AppErrorReporter from '@/components/AppErrorReporter';

// La app entera depende de PostgreSQL en tiempo de petición. Sin esto, Next
// intenta prerenderizar `/_not-found` durante el build, monta el `Header` y
// consulta la base: el build falla si la base no está accesible en ese instante.
// `/_not-found` también pasa a dinámico y el build no toca datos.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'BrainUp Academy | Centro de Operaciones Bachillerato & PAU',
  description:
    'Sistema privado de alto rendimiento académico, planificación activa, banco de errores y tutores IA adaptado a Bachillerato y PAU.',
  // Nombre con el que el sistema guarda la app instalada (móvil y escritorio).
  applicationName: 'BrainUp Academy',
  manifest: '/manifest.json',
  // Iconos generados desde el logo del cerebro estudioso (`scripts/generate-icons.js`).
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className="dark">
      <body className="bg-[#0a0a0c] text-slate-100 min-h-screen flex antialiased selection:bg-emerald-500 selection:text-slate-950">
        {/* Escucha los errores que se escapan de React y los apunta en el taller. */}
        <AppErrorReporter />
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0 min-h-screen">
          <Header />
          <main className="flex-1 p-4 md:p-8 max-w-7xl mx-auto w-full pb-24 md:pb-8">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
