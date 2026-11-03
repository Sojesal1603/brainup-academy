-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL DEFAULT 'user_default',
    "name" TEXT NOT NULL DEFAULT 'Estudiante',
    "modality" TEXT NOT NULL DEFAULT '1º de Bachillerato (Ciencias y Tecnología)',
    "targetGradePau" DOUBLE PRECISION NOT NULL DEFAULT 13.5,
    "weeklyHoursCap" DOUBLE PRECISION NOT NULL DEFAULT 25.0,
    "weeklyHoursDeclared" BOOLEAN NOT NULL DEFAULT false,
    "setupCompletedAt" TIMESTAMP(3),
    "timetableComplete" BOOLEAN NOT NULL DEFAULT false,
    "studyMode" TEXT NOT NULL DEFAULT 'athlete',
    "streakCurrent" INTEGER NOT NULL DEFAULT 0,
    "streakBest" INTEGER NOT NULL DEFAULT 0,
    "challengeXp" INTEGER NOT NULL DEFAULT 0,
    "lastStudyDate" TIMESTAMP(3),
    "moodleFeedUrl" TEXT,
    "lastMoodleSync" TIMESTAMP(3),
    "moodleBaseUrl" TEXT,
    "moodleToken" TEXT,
    "moodleSiteName" TEXT,
    "moodleUserId" INTEGER,
    "moodleConnectedAt" TIMESTAMP(3),
    "moodleAuthMode" TEXT NOT NULL DEFAULT 'token',
    "moodleUsername" TEXT,
    "moodlePasswordSealed" TEXT,
    "moodleSessionAt" TIMESTAMP(3),
    "moodleTokenState" TEXT DEFAULT 'sin_comprobar',
    "moodleCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subject" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#10b981',
    "pauWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "isPhaseGeneral" BOOLEAN NOT NULL DEFAULT true,
    "currentGrade" DOUBLE PRECISION NOT NULL DEFAULT 7.0,
    "gradeSource" TEXT NOT NULL DEFAULT 'sin_medir',
    "targetGrade" DOUBLE PRECISION NOT NULL DEFAULT 9.5,
    "totalHoursSpent" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isTracked" BOOLEAN NOT NULL DEFAULT true,
    "syllabusComplete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Topic" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "unitNumber" INTEGER,
    "term" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pendiente',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "seenInClassAt" TIMESTAMP(3),
    "teacherMethod" TEXT,
    "difficulty" INTEGER NOT NULL DEFAULT 3,
    "masteryLevel" INTEGER NOT NULL DEFAULT 20,
    "masterySource" TEXT NOT NULL DEFAULT 'sin_medir',
    "estimatedHours" DOUBLE PRECISION NOT NULL DEFAULT 6.0,
    "completedHours" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "lastReviewedAt" TIMESTAMP(3),
    "srsIntervalDays" INTEGER NOT NULL DEFAULT 1,
    "srsEaseFactor" DOUBLE PRECISION NOT NULL DEFAULT 2.5,
    "srsStability" DOUBLE PRECISION,
    "srsDifficulty" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Exam" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "examDate" TIMESTAMP(3) NOT NULL,
    "weightPercent" DOUBLE PRECISION NOT NULL DEFAULT 30.0,
    "examType" TEXT NOT NULL DEFAULT 'parcial',
    "examFormat" TEXT NOT NULL DEFAULT 'test',
    "targetGrade" DOUBLE PRECISION NOT NULL DEFAULT 9.0,
    "achievedGrade" DOUBLE PRECISION,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Exam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudyBlock" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 25,
    "technique" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'athlete',
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "objective" TEXT,
    "reason" TEXT,
    "material" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'practica',
    "breakMinutes" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'pendiente',
    "spentMinutes" INTEGER NOT NULL DEFAULT 0,
    "priorityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "origin" TEXT NOT NULL DEFAULT 'plan',
    "resumedFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudyBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudySession" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "minutesSpent" INTEGER NOT NULL,
    "techniqueUsed" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "previousMastery" INTEGER NOT NULL,
    "newMastery" INTEGER NOT NULL,
    "notes" TEXT,

    CONSTRAINT "StudySession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErrorLog" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "questionPrompt" TEXT NOT NULL,
    "myAnswer" TEXT NOT NULL,
    "correctAnswer" TEXT NOT NULL,
    "rootCause" TEXT NOT NULL,
    "keyLesson" TEXT NOT NULL,
    "correctiveAction" TEXT NOT NULL,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "isMastered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErrorLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Habit" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Habit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HabitLog" (
    "id" TEXT NOT NULL,
    "habitId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "HabitLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAgent" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "specialty" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,

    CONSTRAINT "AiAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiConversation" (
    "id" TEXT NOT NULL,
    "agentId" TEXT,
    "title" TEXT NOT NULL DEFAULT 'Consulta de Estudio',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "stepStage" TEXT,
    "rawStepsJson" TEXT,
    "noteProposal" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "localPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PauExamSession" (
    "id" TEXT NOT NULL,
    "examId" TEXT,
    "subjectName" TEXT NOT NULL,
    "timedMinutes" INTEGER NOT NULL,
    "elapsedMinutes" INTEGER NOT NULL,
    "questionsJson" TEXT,
    "answersJson" TEXT,
    "finalScore" DOUBLE PRECISION,
    "weakTopicsJson" TEXT,
    "rubricFeedback" TEXT,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PauExamSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tags" TEXT DEFAULT 'apuntes,resumen',
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "author" TEXT NOT NULL DEFAULT 'alumno',
    "agentId" TEXT,
    "sourceConversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassPeriod" (
    "id" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "period" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "classroom" TEXT,

    CONSTRAINT "ClassPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoodleTask" (
    "id" TEXT NOT NULL,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "courseName" TEXT NOT NULL,
    "subjectId" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "moodleUrl" TEXT,
    "assignmentId" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'ical',
    "submitted" BOOLEAN,
    "graded" BOOLEAN NOT NULL DEFAULT false,
    "grade" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoodleTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoodleCourse" (
    "id" TEXT NOT NULL,
    "moodleId" INTEGER NOT NULL,
    "fullName" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "subjectId" TEXT,
    "sections" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoodleCourse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoodleMaterial" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "sectionName" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "moduleType" TEXT NOT NULL,
    "moduleName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "modifiedAt" TIMESTAMP(3),
    "downloadUrl" TEXT,
    "webUrl" TEXT,
    "localPath" TEXT,
    "fetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoodleMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SrsReview" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "subjectId" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rating" TEXT NOT NULL,
    "quality" INTEGER NOT NULL DEFAULT 3,
    "recalled" BOOLEAN NOT NULL DEFAULT true,
    "intervalBeforeDays" INTEGER NOT NULL DEFAULT 0,
    "intervalAfterDays" INTEGER NOT NULL DEFAULT 1,
    "easeAfter" DOUBLE PRECISION NOT NULL DEFAULT 2.5,
    "overdueDays" INTEGER NOT NULL DEFAULT 0,
    "minutesSpent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SrsReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyChallenge" (
    "id" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "target" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "subjectId" TEXT,
    "topicId" TEXT,
    "rewardXp" INTEGER NOT NULL DEFAULT 50,
    "status" TEXT NOT NULL DEFAULT 'active',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeeklyChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemIssue" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "contextJson" TEXT,
    "source" TEXT NOT NULL DEFAULT 'alumno',
    "status" TEXT NOT NULL DEFAULT 'abierto',
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMemory" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "factsJson" TEXT,
    "writtenBy" TEXT NOT NULL DEFAULT 'reglas',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiAgent_subjectId_key" ON "AiAgent"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "MoodleTask_externalId_key" ON "MoodleTask"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "MoodleTask_assignmentId_key" ON "MoodleTask"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "MoodleCourse_moodleId_key" ON "MoodleCourse"("moodleId");

-- CreateIndex
CREATE UNIQUE INDEX "MoodleMaterial_externalId_key" ON "MoodleMaterial"("externalId");

-- CreateIndex
CREATE INDEX "WeeklyChallenge_weekKey_idx" ON "WeeklyChallenge"("weekKey");

-- CreateIndex
CREATE INDEX "SystemIssue_status_idx" ON "SystemIssue"("status");

-- CreateIndex
CREATE INDEX "AgentMemory_scope_createdAt_idx" ON "AgentMemory"("scope", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentMemory_scope_day_key" ON "AgentMemory"("scope", "day");

-- AddForeignKey
ALTER TABLE "Topic" ADD CONSTRAINT "Topic_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudyBlock" ADD CONSTRAINT "StudyBlock_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudySession" ADD CONSTRAINT "StudySession_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrorLog" ADD CONSTRAINT "ErrorLog_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrorLog" ADD CONSTRAINT "ErrorLog_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HabitLog" ADD CONSTRAINT "HabitLog_habitId_fkey" FOREIGN KEY ("habitId") REFERENCES "Habit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAgent" ADD CONSTRAINT "AiAgent_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AiAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMessage" ADD CONSTRAINT "AiMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAttachment" ADD CONSTRAINT "AiAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "AiMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PauExamSession" ADD CONSTRAINT "PauExamSession_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AiAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassPeriod" ADD CONSTRAINT "ClassPeriod_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoodleTask" ADD CONSTRAINT "MoodleTask_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoodleCourse" ADD CONSTRAINT "MoodleCourse_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoodleMaterial" ADD CONSTRAINT "MoodleMaterial_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "MoodleCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SrsReview" ADD CONSTRAINT "SrsReview_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyChallenge" ADD CONSTRAINT "WeeklyChallenge_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyChallenge" ADD CONSTRAINT "WeeklyChallenge_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

