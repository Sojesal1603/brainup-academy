-- Paso 2: esquema expand del planificador determinista.
-- Solo crea tablas, índices y FKs nuevas; no altera columnas existentes.

CREATE TABLE "PlanState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "energy" DOUBLE PRECISION,
    "capacityMin" INTEGER,
    "decidedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlanConstraint" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanConstraint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TutorSessionOutcome" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT,
    "subjectId" TEXT,
    "topicId" TEXT,
    "workedOn" JSONB NOT NULL,
    "pending" JSONB NOT NULL,
    "nextPlan" JSONB,
    "errorsCreated" INTEGER NOT NULL DEFAULT 0,
    "reviewCardsCreated" INTEGER NOT NULL DEFAULT 0,
    "directSolutionCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TutorSessionOutcome_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlanState_userId_status_idx" ON "PlanState"("userId", "status");
CREATE UNIQUE INDEX "PlanState_userId_day_key" ON "PlanState"("userId", "day");
CREATE INDEX "PlanConstraint_userId_planId_idx" ON "PlanConstraint"("userId", "planId");
CREATE INDEX "TutorSessionOutcome_userId_createdAt_idx" ON "TutorSessionOutcome"("userId", "createdAt");
CREATE INDEX "TutorSessionOutcome_userId_topicId_idx" ON "TutorSessionOutcome"("userId", "topicId");
CREATE INDEX "TutorSessionOutcome_planId_idx" ON "TutorSessionOutcome"("planId");

ALTER TABLE "PlanState" ADD CONSTRAINT "PlanState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlanConstraint" ADD CONSTRAINT "PlanConstraint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlanConstraint" ADD CONSTRAINT "PlanConstraint_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PlanState"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TutorSessionOutcome" ADD CONSTRAINT "TutorSessionOutcome_userId_fkey" FOREIGN KEY ("userId") REFERENCES "UserProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TutorSessionOutcome" ADD CONSTRAINT "TutorSessionOutcome_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PlanState"("id") ON DELETE SET NULL ON UPDATE CASCADE;
