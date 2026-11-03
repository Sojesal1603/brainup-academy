/**
 * Solo para instalaciones locales que hablan con un Moodle de certificado propio.
 *
 * Antes se desactivaba la verificación TLS SIEMPRE, incluso en producción. Eso
 * afecta a todas las conexiones salientes del proceso: también a PostgreSQL y a
 * las APIs de IA. En Vercel sería un agujero de seguridad, así que queda detrás
 * de una variable explícita y nunca se activa en producción.
 */
if (process.env.NODE_ENV !== 'production' && process.env.BRAINUP_INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/**
 * Configuración de Next.
 */
const nextConfig = {
  // Prisma lleva binarios nativos: no debe empaquetarse dentro del bundle.
  serverExternalPackages: ['pdfjs-dist', '@prisma/client'],
  // …pero al quedarse fuera del bundle hay que asegurarse de que el motor nativo
  // y el esquema generado VIAJAN con cada función. Las trazas de Next suelen
  // incluirlos, pero si el generador cambia de ruta o el host recorta archivos,
  // todas las consultas fallan con «Query engine library not found» y cada vista
  // devuelve el error #441. Aquí se declara de forma explícita.
  outputFileTracingIncludes: {
    '/**/*': [
      './node_modules/.prisma/client/**/*',
      './node_modules/@prisma/client/**/*',
    ],
  },
};

module.exports = nextConfig;
