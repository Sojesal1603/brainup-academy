-- Claves de IA propias por usuario, cifradas por la app.
-- Migración solo expand: crea una tabla nueva y no toca ninguna fila existente.

CREATE TABLE "UserAiKey" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'gemini',
  "ciphertext" TEXT NOT NULL,
  "last4" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'sin_comprobar',
  "lastCheckedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserAiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserAiKey_userId_provider_key" ON "UserAiKey"("userId", "provider");
CREATE INDEX "UserAiKey_userId_idx" ON "UserAiKey"("userId");

ALTER TABLE "UserAiKey"
  ADD CONSTRAINT "UserAiKey_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Misma postura que el resto de la Fase 0: sin políticas, RLS deniega a
-- cualquiera que no sea el propietario/BYPASSRLS (Prisma entra como postgres).
-- El estado se lee desde la app con la sesión del alumno, nunca con service_role.
ALTER TABLE "UserAiKey" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "UserAiKey" FROM anon, authenticated;
