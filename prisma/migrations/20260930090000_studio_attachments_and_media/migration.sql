-- Onda "criação de campanha sem bloqueios" (Stories 2.1/2.2/2.4 — D6/D7/D8).
-- NOTA: gerada sem banco (Postgres dev offline) e ainda NÃO aplicada — rodar
-- `pnpm run db:migrate` (ou `db:deploy`) e validar contra Postgres real antes
-- de qualquer deploy que use anexos (ver frontmatter `deferred` do plano).

-- CreateTable StudioAttachment (anexo que sai na mensagem, por referência)
CREATE TABLE "StudioAttachment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT,
    "fileName" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "channels" TEXT NOT NULL DEFAULT 'both',
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudioAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable StudioMaterial.campaignId (D7 — material ganha campanha)
ALTER TABLE "StudioMaterial" ADD COLUMN     "campaignId" TEXT;

-- AlterTable execuções de canal: anexos por referência (D8)
ALTER TABLE "OutreachCampaign" ADD COLUMN     "studioAttachments" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "WhatsAppCampaign" ADD COLUMN     "studioAttachments" JSONB NOT NULL DEFAULT '[]';

-- CreateIndex
CREATE INDEX "StudioAttachment_orgId_idx" ON "StudioAttachment"("orgId");
CREATE INDEX "StudioAttachment_campaignId_idx" ON "StudioAttachment"("campaignId");
CREATE INDEX "StudioMaterial_campaignId_idx" ON "StudioMaterial"("campaignId");

-- AddForeignKey
ALTER TABLE "StudioAttachment" ADD CONSTRAINT "StudioAttachment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "StudioCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudioMaterial" ADD CONSTRAINT "StudioMaterial_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "StudioCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
