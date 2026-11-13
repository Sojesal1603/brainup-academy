-- Paso 6: el plan conserva por qué se invalidó, para poder mostrarlo al
-- reconstruir. Columna opcional y aditiva.
ALTER TABLE "PlanState" ADD COLUMN "invalidationReason" TEXT;
