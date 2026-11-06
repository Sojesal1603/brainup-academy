-- Fase 1 multiusuario (BrainUp Academy)
--
-- Qué hace, en orden:
--   1. Se asegura de que la cuenta que ya existe (`user_default`) está en
--      `UserProfile`. Sin esa fila, las claves foráneas de abajo fallarían.
--   2. Añade `userId` a todas las tablas de contenido con
--      `DEFAULT 'user_default'`: en PostgreSQL, `ADD COLUMN … DEFAULT` rellena
--      las filas existentes **en la misma operación** (sin reescribir la tabla
--      desde PG 11), así que este es el backfill: nada se queda huérfano ni se
--      pierde. No hay ningún `DELETE` ni `DROP TABLE` en esta migración.
--   3. Enlaza cada `userId` con `UserProfile.id` (borrado en cascada, igual que
--      ya ocurría entre materia y temas).
--   4. Sustituye los únicos globales por únicos compuestos con `userId`: dos
--      cuentas pueden tener la misma materia, el mismo curso de Moodle o el
--      mismo día de memoria sin chocar.
--   5. Añade los índices por cuenta que usarán las consultas de la Fase 2.
--
-- Reversible: ver el bloque comentado del final.

-- 1. La cuenta existente -----------------------------------------------------
INSERT INTO "UserProfile" ("id", "updatedAt")
VALUES ('user_default', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- 2. Columna de dueño en cada tabla (el DEFAULT es el backfill) ---------------
ALTER TABLE "Subject"         ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "Topic"           ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "Exam"            ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "StudyBlock"      ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "StudySession"    ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "ErrorLog"        ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "Habit"           ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "HabitLog"        ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "AiAgent"         ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "AiConversation"  ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "AiMessage"       ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "AiAttachment"    ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "PauExamSession"  ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "Note"            ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "ClassPeriod"     ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "MoodleTask"      ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "MoodleCourse"    ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "MoodleMaterial"  ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "SrsReview"       ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "WeeklyChallenge" ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "SystemIssue"     ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';
ALTER TABLE "AgentMemory"     ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'user_default';

-- Comprobación opcional antes de seguir (no modifica nada): no debe devolver
-- ninguna fila.
--   SELECT 'Subject' AS tabla, count(*) FROM "Subject" WHERE "userId" IS NULL OR "userId" <> 'user_default';

-- 3. Claves foráneas ---------------------------------------------------------
ALTER TABLE "Subject"         ADD CONSTRAINT "Subject_userId_fkey"         FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Topic"           ADD CONSTRAINT "Topic_userId_fkey"           FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Exam"            ADD CONSTRAINT "Exam_userId_fkey"            FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudyBlock"      ADD CONSTRAINT "StudyBlock_userId_fkey"      FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudySession"    ADD CONSTRAINT "StudySession_userId_fkey"    FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ErrorLog"        ADD CONSTRAINT "ErrorLog_userId_fkey"        FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Habit"           ADD CONSTRAINT "Habit_userId_fkey"           FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HabitLog"        ADD CONSTRAINT "HabitLog_userId_fkey"        FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiAgent"         ADD CONSTRAINT "AiAgent_userId_fkey"         FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiConversation"  ADD CONSTRAINT "AiConversation_userId_fkey"  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiMessage"       ADD CONSTRAINT "AiMessage_userId_fkey"       FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiAttachment"    ADD CONSTRAINT "AiAttachment_userId_fkey"    FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PauExamSession"  ADD CONSTRAINT "PauExamSession_userId_fkey"  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Note"            ADD CONSTRAINT "Note_userId_fkey"            FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClassPeriod"     ADD CONSTRAINT "ClassPeriod_userId_fkey"     FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MoodleTask"      ADD CONSTRAINT "MoodleTask_userId_fkey"      FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MoodleCourse"    ADD CONSTRAINT "MoodleCourse_userId_fkey"    FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MoodleMaterial"  ADD CONSTRAINT "MoodleMaterial_userId_fkey"  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SrsReview"       ADD CONSTRAINT "SrsReview_userId_fkey"       FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WeeklyChallenge" ADD CONSTRAINT "WeeklyChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SystemIssue"     ADD CONSTRAINT "SystemIssue_userId_fkey"     FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentMemory"     ADD CONSTRAINT "AgentMemory_userId_fkey"     FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Únicos globales → únicos por cuenta -------------------------------------
-- `AiAgent.subjectId` se queda único global a propósito: es el UUID de una
-- materia, no un id externo que dos cuentas puedan compartir.
DROP INDEX IF EXISTS "MoodleTask_externalId_key";
DROP INDEX IF EXISTS "MoodleTask_assignmentId_key";
CREATE UNIQUE INDEX "MoodleTask_userId_externalId_key" ON "MoodleTask"("userId", "externalId");
CREATE UNIQUE INDEX "MoodleTask_userId_assignmentId_key" ON "MoodleTask"("userId", "assignmentId");

DROP INDEX IF EXISTS "MoodleCourse_moodleId_key";
CREATE UNIQUE INDEX "MoodleCourse_userId_moodleId_key" ON "MoodleCourse"("userId", "moodleId");

DROP INDEX IF EXISTS "MoodleMaterial_externalId_key";
CREATE UNIQUE INDEX "MoodleMaterial_userId_externalId_key" ON "MoodleMaterial"("userId", "externalId");

DROP INDEX IF EXISTS "AgentMemory_scope_day_key";
CREATE UNIQUE INDEX "AgentMemory_userId_scope_day_key" ON "AgentMemory"("userId", "scope", "day");

-- 5. Índices por cuenta ------------------------------------------------------
CREATE INDEX "Subject_userId_idx"                    ON "Subject"("userId");
CREATE INDEX "Topic_userId_subjectId_idx"            ON "Topic"("userId", "subjectId");
CREATE INDEX "Exam_userId_examDate_idx"              ON "Exam"("userId", "examDate");
CREATE INDEX "StudyBlock_userId_date_idx"            ON "StudyBlock"("userId", "date");
CREATE INDEX "StudySession_userId_startedAt_idx"     ON "StudySession"("userId", "startedAt");
CREATE INDEX "ErrorLog_userId_isMastered_idx"        ON "ErrorLog"("userId", "isMastered");
CREATE INDEX "Habit_userId_idx"                      ON "Habit"("userId");
CREATE INDEX "HabitLog_userId_habitId_date_idx"      ON "HabitLog"("userId", "habitId", "date");
CREATE INDEX "AiAgent_userId_idx"                    ON "AiAgent"("userId");
CREATE INDEX "AiConversation_userId_createdAt_idx"   ON "AiConversation"("userId", "createdAt");
CREATE INDEX "AiMessage_userId_conversationId_idx"   ON "AiMessage"("userId", "conversationId");
CREATE INDEX "AiAttachment_userId_messageId_idx"     ON "AiAttachment"("userId", "messageId");
CREATE INDEX "PauExamSession_userId_createdAt_idx"   ON "PauExamSession"("userId", "createdAt");
CREATE INDEX "Note_userId_topicId_idx"               ON "Note"("userId", "topicId");
CREATE INDEX "ClassPeriod_userId_dayOfWeek_idx"      ON "ClassPeriod"("userId", "dayOfWeek");
CREATE INDEX "MoodleTask_userId_dueDate_idx"         ON "MoodleTask"("userId", "dueDate");
CREATE INDEX "MoodleMaterial_userId_courseId_idx"    ON "MoodleMaterial"("userId", "courseId");
CREATE INDEX "SrsReview_userId_reviewedAt_idx"       ON "SrsReview"("userId", "reviewedAt");

DROP INDEX IF EXISTS "WeeklyChallenge_weekKey_idx";
CREATE INDEX "WeeklyChallenge_userId_weekKey_idx"    ON "WeeklyChallenge"("userId", "weekKey");
CREATE INDEX "WeeklyChallenge_userId_status_idx"     ON "WeeklyChallenge"("userId", "status");

DROP INDEX IF EXISTS "SystemIssue_status_idx";
CREATE INDEX "SystemIssue_userId_status_idx"         ON "SystemIssue"("userId", "status");

DROP INDEX IF EXISTS "AgentMemory_scope_createdAt_idx";
CREATE INDEX "AgentMemory_userId_scope_createdAt_idx" ON "AgentMemory"("userId", "scope", "createdAt");

-- Cómo deshacerla (solo si hiciera falta; guarda una copia antes):
--   BEGIN;
--   -- …resto de índices compuestos…
--   ALTER TABLE "Subject" DROP CONSTRAINT "Subject_userId_fkey"; -- y las demás
--   ALTER TABLE "Subject" DROP COLUMN "userId";                    -- y las demás
--   COMMIT;
