-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "studioPauseReason" TEXT,
ADD COLUMN     "studioPausedAt" TIMESTAMP(3),
ADD COLUMN     "studioPausedById" TEXT,
ADD COLUMN     "studioSendPaused" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "EmailAccount" ADD COLUMN     "domainAuthDetail" JSONB,
ADD COLUMN     "domainAuthStatus" TEXT,
ADD COLUMN     "domainAuthVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "sendingDomain" TEXT;

-- CreateTable
CREATE TABLE "StudioReputationAccount" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "floor" INTEGER NOT NULL DEFAULT 0,
    "ceiling" INTEGER NOT NULL DEFAULT 0,
    "rampStage" INTEGER NOT NULL DEFAULT 0,
    "domainAuthStatus" TEXT NOT NULL DEFAULT 'unverified',
    "domainAuthCheckedAt" TIMESTAMP(3),
    "domainAuthDetail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudioReputationAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudioReputationEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudioReputationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudioActionRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'succeeded',
    "result" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudioActionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudioLeadConsent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "source" TEXT NOT NULL,
    "grantedById" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudioLeadConsent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudioReputationAccount_orgId_idx" ON "StudioReputationAccount"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "StudioReputationAccount_orgId_channel_key" ON "StudioReputationAccount"("orgId", "channel");

-- CreateIndex
CREATE INDEX "StudioReputationEvent_orgId_channel_createdAt_idx" ON "StudioReputationEvent"("orgId", "channel", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StudioReputationEvent_type_refId_key" ON "StudioReputationEvent"("type", "refId");

-- CreateIndex
CREATE INDEX "StudioActionRun_orgId_campaignId_idx" ON "StudioActionRun"("orgId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "StudioActionRun_actionKey_key" ON "StudioActionRun"("actionKey");

-- CreateIndex
CREATE INDEX "StudioLeadConsent_orgId_idx" ON "StudioLeadConsent"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "StudioLeadConsent_orgId_prospectId_channel_key" ON "StudioLeadConsent"("orgId", "prospectId", "channel");

