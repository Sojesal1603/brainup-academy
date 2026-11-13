-- Aviso diario del plan: hora elegida por el alumno + suscripciones push.
-- Aditivo: no toca filas existentes.

ALTER TABLE "UserProfile"
  ADD COLUMN "reminderEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reminderTime" TEXT;

CREATE TABLE "PushSubscription" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "userAgent" TEXT,
  "lastNotifiedDay" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

ALTER TABLE "PushSubscription"
  ADD CONSTRAINT "PushSubscription_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Misma postura que el resto de la Fase 0: sin políticas, RLS deniega a
-- cualquiera que no sea el propietario/BYPASSRLS. Prisma entra como `postgres`.
ALTER TABLE "PushSubscription" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "PushSubscription" FROM anon, authenticated;
