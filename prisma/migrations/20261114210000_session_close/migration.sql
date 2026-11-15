-- Cierre de sesión idempotente y tarjetas con identidad estable.
--
-- sessionKey: el cierre se puede repetir (doble clic, reintento de red) y la
-- fila de resultado se reutiliza en vez de duplicarse. Nullable a propósito:
-- los resultados antiguos no tienen clave y no deben chocar con el índice.

ALTER TABLE "TutorSessionOutcome" ADD COLUMN "sessionKey" TEXT;

CREATE UNIQUE INDEX "TutorSessionOutcome_userId_sessionKey_key"
  ON "TutorSessionOutcome" ("userId", "sessionKey");

-- frontHash: huella del enunciado normalizado (minúsculas, sin espacios de
-- más). Sirve para reconocer la misma tarjeta cuando el texto llega con otro
-- maquetado. Nullable: no se rellena hacia atrás para no chocar con tarjetas
-- antiguas que solo se diferenciaban en mayúsculas.

ALTER TABLE "ReviewCard" ADD COLUMN "frontHash" TEXT;

CREATE INDEX "ReviewCard_userId_topicId_frontHash_idx"
  ON "ReviewCard" ("userId", "topicId", "frontHash");
