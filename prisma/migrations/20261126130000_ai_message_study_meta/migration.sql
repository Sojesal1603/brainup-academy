-- Fase 4.1: la cobertura verificada del tutor deja de vivir solo en memoria.
--
-- Expand-only: una columna nullable. Los mensajes anteriores no tienen franja
-- que reconstruir y se leen como null; el resto del chat sigue funcionando
-- aunque esta migración aún no se haya aplicado (el despliegue la aplica antes
-- de arrancar la versión nueva).
ALTER TABLE "AiMessage"
  ADD COLUMN "studyMetaJson" TEXT;
