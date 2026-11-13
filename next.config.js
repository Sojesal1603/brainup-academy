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
      // La CA del pooler de Supabase se lee en runtime con `sslcert`.
      './prisma/certs/**/*',
    ],
  },
};

module.exports = nextConfig;
