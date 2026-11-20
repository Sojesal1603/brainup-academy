-- Etapas educativas (Paso 11, Commit 1).
--
-- Expand-only: no renombra, borra ni cambia el tipo de ninguna columna
-- existente. `modality` sigue guardando el curso exacto; `stage`, `gradeLevel`,
-- `trackKey` y `degreeName` son derivados y los rellena el backfill.
--
-- El default BACHILLERATO mantiene el comportamiento actual de todos los
-- perfiles hasta que se ejecute `scripts/backfill-education-stage.js --apply`.

CREATE TYPE "EducationStage" AS ENUM ('ESO', 'BACHILLERATO', 'UNIVERSIDAD');

ALTER TABLE "UserProfile"
  ADD COLUMN "stage" "EducationStage" NOT NULL DEFAULT 'BACHILLERATO',
  ADD COLUMN "gradeLevel" TEXT,
  ADD COLUMN "trackKey" TEXT,
  ADD COLUMN "degreeName" TEXT;
