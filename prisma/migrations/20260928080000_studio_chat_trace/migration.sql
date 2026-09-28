-- CreateTable
CREATE TABLE "StudioChatTrace" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "turnIndex" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "llmDurationMs" INTEGER NOT NULL DEFAULT 0,
    "llmModel" TEXT,
    "llmPromptTokens" INTEGER,
    "llmCompletionTokens" INTEGER,
    "llmTotalTokens" INTEGER,
    "llmFallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "llmTruncated" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'succeeded',
    "errorCode" TEXT,
    "actionTypes" JSONB NOT NULL DEFAULT '[]',
    "actionDurationsMs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudioChatTrace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudioChatTrace_orgId_createdAt_idx" ON "StudioChatTrace"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "StudioChatTrace_campaignId_createdAt_idx" ON "StudioChatTrace"("campaignId", "createdAt");
