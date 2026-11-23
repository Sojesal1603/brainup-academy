-- Fase 16 · Bloque 1: fuentes persistentes, contrato de citas y apuntes modulares.
--
-- Qué crea:
--   · SourceDocument / DocumentChunk → el documento sale del disco efímero y se
--     trocea en filas citables.
--   · NoteSection / NoteBlock → el apunte deja de ser un string y pasa a ser un
--     árbol con bloques versionables y citas comprobables.
--   · StudyJob → cola durable para desarrollar un tema entero sin worker.
--
-- Qué NO hace: no toca datos existentes, no reescribe `Note.content` y no
-- elimina ninguna tabla. El backfill de apuntes antiguos es una decisión del
-- operador (una nota sin secciones se sigue leyendo por su `content`).
--
-- `embedding` se crea como `vector(768)` **si pgvector está disponible** y como
-- `double precision[]` si no. La columna existe siempre para que Prisma pueda
-- seleccionar la tabla; el índice HNSW solo se crea cuando la extensión está.
-- Así esta migración no bloquea el despliegue de un proyecto sin pgvector.

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('PDF', 'DOCX', 'PPTX', 'XLSX', 'ODT', 'IMAGE', 'TEXT', 'WEB', 'MOODLE', 'OTHER');

-- CreateEnum
CREATE TYPE "SourceStatus" AS ENUM ('UPLOADING', 'QUEUED', 'EXTRACTING', 'CHUNKING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "NoteSectionStatus" AS ENUM ('PENDING', 'GENERATING', 'COMPLETED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "NoteBlockType" AS ENUM ('TEXT', 'FORMULA', 'DEFINITION', 'EXAMPLE', 'EVIDENCE', 'QUESTION');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('NONE', 'VERIFIED', 'UNVERIFIED', 'ERROR');

-- CreateTable
CREATE TABLE "SourceDocument" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL DEFAULT 'OTHER',
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "chars" INTEGER NOT NULL DEFAULT 0,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "textKey" TEXT,
    "subjectId" TEXT,
    "topicId" TEXT,
    "status" "SourceStatus" NOT NULL DEFAULT 'QUEUED',
    "mode" TEXT NOT NULL DEFAULT 'texto',
    "notesJson" TEXT,
    "error" TEXT,
    "embeddingModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentChunk" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "pageFrom" INTEGER,
    "pageTo" INTEGER,
    "label" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "embeddingModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteSection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT '',
    "order" INTEGER NOT NULL DEFAULT 0,
    "status" "NoteSectionStatus" NOT NULL DEFAULT 'PENDING',
    "pageFrom" INTEGER,
    "pageTo" INTEGER,
    "coverage" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteBlock" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "parentId" TEXT,
    "type" "NoteBlockType" NOT NULL DEFAULT 'TEXT',
    "content" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isAiGenerated" BOOLEAN NOT NULL DEFAULT true,
    "isEdited" BOOLEAN NOT NULL DEFAULT false,
    "chunkId" TEXT,
    "quote" TEXT,
    "quoteStatus" "QuoteStatus" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudyJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "noteId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'note_sections',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "step" INTEGER NOT NULL DEFAULT 0,
    "totalSteps" INTEGER NOT NULL DEFAULT 0,
    "inputJson" TEXT,
    "resultJson" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudyJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SourceDocument_userId_subjectId_idx" ON "SourceDocument"("userId", "subjectId");

-- CreateIndex
CREATE INDEX "SourceDocument_userId_topicId_idx" ON "SourceDocument"("userId", "topicId");

-- CreateIndex
CREATE INDEX "SourceDocument_userId_status_idx" ON "SourceDocument"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SourceDocument_userId_sha256_key" ON "SourceDocument"("userId", "sha256");

-- CreateIndex
CREATE INDEX "DocumentChunk_userId_documentId_idx" ON "DocumentChunk"("userId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentChunk_documentId_order_key" ON "DocumentChunk"("documentId", "order");

-- CreateIndex
CREATE INDEX "NoteSection_userId_noteId_idx" ON "NoteSection"("userId", "noteId");

-- CreateIndex
CREATE UNIQUE INDEX "NoteSection_noteId_order_key" ON "NoteSection"("noteId", "order");

-- CreateIndex
CREATE INDEX "NoteBlock_userId_noteId_idx" ON "NoteBlock"("userId", "noteId");

-- CreateIndex
CREATE INDEX "NoteBlock_sectionId_order_idx" ON "NoteBlock"("sectionId", "order");

-- CreateIndex
CREATE INDEX "NoteBlock_parentId_idx" ON "NoteBlock"("parentId");

-- CreateIndex
CREATE INDEX "StudyJob_userId_createdAt_idx" ON "StudyJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "StudyJob_status_idx" ON "StudyJob"("status");

-- AddForeignKey
ALTER TABLE "SourceDocument" ADD CONSTRAINT "SourceDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "SourceDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteSection" ADD CONSTRAINT "NoteSection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteSection" ADD CONSTRAINT "NoteSection_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteBlock" ADD CONSTRAINT "NoteBlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteBlock" ADD CONSTRAINT "NoteBlock_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "NoteSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteBlock" ADD CONSTRAINT "NoteBlock_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "NoteBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudyJob" ADD CONSTRAINT "StudyJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Vector: columna e índice según lo que ofrezca el servidor.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_available_extensions WHERE name = 'vector'
  ) THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    EXECUTE 'ALTER TABLE "DocumentChunk" ADD COLUMN "embedding" vector(768)';
    EXECUTE 'CREATE INDEX "DocumentChunk_embedding_hnsw" ON "DocumentChunk" USING hnsw ("embedding" vector_cosine_ops)';
    RAISE NOTICE 'pgvector disponible: DocumentChunk.embedding es vector(768) con índice HNSW.';
  ELSE
    -- La app sigue funcionando en modo léxico; la fase de embeddings queda
    -- pendiente hasta que el proyecto tenga pgvector.
    EXECUTE 'ALTER TABLE "DocumentChunk" ADD COLUMN "embedding" double precision[]';
    RAISE NOTICE 'pgvector no disponible: DocumentChunk.embedding queda como double precision[].';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Aislamiento por cuenta.
--
-- La función `brainup_apply_app_rls()` recorre TODAS las tablas de `public`, así
-- que basta volver a ejecutarla después de crear las nuevas. Si esta migración
-- se aplica antes que el Paso 15 (la función aún no existe), se aplica aquí el
-- mismo mínimo para no dejar las tablas sin RLS: activarla, quitar anon y
-- authenticated y crear la política de `prisma_app` si el rol existe.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  relation record;
  has_prisma_app boolean;
  has_anon boolean;
  has_authenticated boolean;
  new_tables text[] := ARRAY['SourceDocument', 'DocumentChunk', 'NoteSection', 'NoteBlock', 'StudyJob'];
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prisma_app') INTO has_prisma_app;
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') INTO has_anon;
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') INTO has_authenticated;

  IF to_regprocedure('public.brainup_apply_app_rls()') IS NOT NULL THEN
    PERFORM public.brainup_apply_app_rls();
  ELSE
    FOR relation IN SELECT unnest(new_tables) AS table_name LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation.table_name);

      IF has_anon THEN
        EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon', relation.table_name);
      END IF;
      IF has_authenticated THEN
        EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM authenticated', relation.table_name);
      END IF;

      IF has_prisma_app THEN
        EXECUTE format('DROP POLICY IF EXISTS brainup_app_runtime ON public.%I', relation.table_name);
        EXECUTE format($fmt$
          CREATE POLICY brainup_app_runtime ON public.%I
          FOR ALL TO prisma_app
          USING (
            coalesce(current_setting('app.user_id', true), '') = ''
            OR "userId"::text = current_setting('app.user_id', true)
          )
          WITH CHECK (
            coalesce(current_setting('app.user_id', true), '') = ''
            OR "userId"::text = current_setting('app.user_id', true)
          )
        $fmt$, relation.table_name);
      END IF;
    END LOOP;
  END IF;

  -- Comprobación final: si algo no ha quedado aislado, la migración falla en
  -- vez de dejar una tabla legible por cualquiera.
  FOR relation IN SELECT unnest(new_tables) AS table_name LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = relation.table_name AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'RLS no activa en %.', relation.table_name;
    END IF;
  END LOOP;

  IF has_prisma_app THEN
    FOR relation IN SELECT unnest(new_tables) AS table_name LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = relation.table_name
          AND policyname = 'brainup_app_runtime'
      ) THEN
        RAISE EXCEPTION 'Falta la política brainup_app_runtime en %.', relation.table_name;
      END IF;
    END LOOP;
  END IF;
END $$;
