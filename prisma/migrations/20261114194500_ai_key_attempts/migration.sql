-- Límite de intentos de clave de IA por cuenta.
-- Migración solo expand: tabla nueva, sin tocar filas existentes.

CREATE TABLE "AiKeyAttempt" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiKeyAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiKeyAttempt_userId_attemptedAt_idx"
  ON "AiKeyAttempt"("userId", "attemptedAt");

ALTER TABLE "AiKeyAttempt"
  ADD CONSTRAINT "AiKeyAttempt_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Misma postura que UserAiKey: RLS activa y cero privilegios para los roles
-- públicos de Supabase. La app entra con su rol de runtime (Prisma).
ALTER TABLE "AiKeyAttempt" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "AiKeyAttempt" FROM anon, authenticated;
