-- Cambios aditivos de la tríada EBAU / SM-2 / Focus & Lock.
-- Se usa `IF NOT EXISTS` para poder ejecutarlo sin miedo sobre una base que ya
-- tenga parte del esquema aplicado. No borra ni modifica datos existentes.

ALTER TABLE "UserProfile"
  ADD COLUMN IF NOT EXISTS "community" TEXT NOT NULL DEFAULT 'madrid';

ALTER TABLE "PauExamSession"
  ADD COLUMN IF NOT EXISTS "subjectId" TEXT;

ALTER TABLE "PauExamSession"
  ADD COLUMN IF NOT EXISTS "community" TEXT;

CREATE TABLE IF NOT EXISTS "ReviewCard" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL DEFAULT 'user_default',
  "topicId" TEXT NOT NULL,
  "noteId" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'flashcard',
  "front" TEXT NOT NULL,
  "back" TEXT NOT NULL,
  "source" TEXT,
  "repetition" INTEGER NOT NULL DEFAULT 0,
  "intervalDays" INTEGER NOT NULL DEFAULT 0,
  "efactor" DOUBLE PRECISION NOT NULL DEFAULT 2.5,
  "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastReviewedAt" TIMESTAMP(3),
  "lapses" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewCard_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ReviewCard_userId_topicId_front_key"
  ON "ReviewCard"("userId", "topicId", "front");

CREATE INDEX IF NOT EXISTS "ReviewCard_userId_dueAt_idx"
  ON "ReviewCard"("userId", "dueAt");

CREATE INDEX IF NOT EXISTS "ReviewCard_userId_topicId_idx"
  ON "ReviewCard"("userId", "topicId");

CREATE TABLE IF NOT EXISTS "FocusSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL DEFAULT 'user_default',
  "topicId" TEXT,
  "blockId" TEXT,
  "plannedMinutes" INTEGER NOT NULL DEFAULT 25,
  "focusedSeconds" INTEGER NOT NULL DEFAULT 0,
  "pausedSeconds" INTEGER NOT NULL DEFAULT 0,
  "tutorSeconds" INTEGER NOT NULL DEFAULT 0,
  "interruptions" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'running',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  "abandonReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FocusSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FocusSession_userId_startedAt_idx"
  ON "FocusSession"("userId", "startedAt");

CREATE INDEX IF NOT EXISTS "FocusSession_userId_status_idx"
  ON "FocusSession"("userId", "status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ReviewCard_userId_fkey') THEN
    ALTER TABLE "ReviewCard"
      ADD CONSTRAINT "ReviewCard_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "UserProfile"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ReviewCard_topicId_fkey') THEN
    ALTER TABLE "ReviewCard"
      ADD CONSTRAINT "ReviewCard_topicId_fkey"
      FOREIGN KEY ("topicId") REFERENCES "Topic"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ReviewCard_noteId_fkey') THEN
    ALTER TABLE "ReviewCard"
      ADD CONSTRAINT "ReviewCard_noteId_fkey"
      FOREIGN KEY ("noteId") REFERENCES "Note"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FocusSession_userId_fkey') THEN
    ALTER TABLE "FocusSession"
      ADD CONSTRAINT "FocusSession_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "UserProfile"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FocusSession_topicId_fkey') THEN
    ALTER TABLE "FocusSession"
      ADD CONSTRAINT "FocusSession_topicId_fkey"
      FOREIGN KEY ("topicId") REFERENCES "Topic"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
