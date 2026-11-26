-- Fase 3: preferencias BYOK del alumno y endpoint compatible OpenAI.
--
-- Expand-only: dos columnas nulables, sin default y sin tocar filas existentes.
-- `providerOrderJson` guarda el orden elegido (["groq","gemini"]); `baseUrl` es
-- solo para el proveedor `custom` y se valida como HTTPS público en la app.
-- Hasta que el despliegue aplique esta migración, el perfil cae al orden del
-- catálogo y las claves normales siguen funcionando.

ALTER TABLE "UserProfile"
  ADD COLUMN "providerOrderJson" TEXT;

ALTER TABLE "UserAiKey"
  ADD COLUMN "baseUrl" TEXT;
