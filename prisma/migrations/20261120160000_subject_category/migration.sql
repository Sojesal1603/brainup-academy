-- Categoría didáctica de materia (Paso 14, Commit 1).
--
-- Expand-only: crea un tipo nuevo y añade una columna NULLABLE. No renombra,
-- borra ni cambia el tipo de ninguna columna existente. No hace falta rellenar
-- las filas para desplegar: `subjectCategoryOf` infiere la categoría desde el
-- nombre cuando la columna es NULL. El backfill (`npm run backfill:materias` o
-- `node scripts/backfill-subject-category.js --apply`) es opcional.

CREATE TYPE "SubjectCategory" AS ENUM (
  'PROBLEMAS',
  'LABORATORIO',
  'COMENTARIO',
  'IDIOMA',
  'EXPOSICION',
  'TECNICA',
  'GENERAL'
);

ALTER TABLE "Subject"
  ADD COLUMN "category" "SubjectCategory";
