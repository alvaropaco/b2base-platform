/**
 * CampaignChat.export.test.ts — planilha de leads em PDF (export_leads,
 * 2026-10-15): o card do chat expõe o download autenticado do anexo como
 * FUNÇÃO PURA (padrão recovery.test.ts — vitest, sem DOM).
 */
import { describe, expect, it } from 'vitest';
import { enrichmentAudienceChip, exportDownloadHref, type ChatCard } from './CampaignChat';

describe('link de download da planilha de leads (export_leads)', () => {
  it('card com anexo + campanha → rota autenticada do arquivo', () => {
    const card: ChatCard = {
      type: 'leads_export',
      label: 'Planilha pronta — 42 lead(s)',
      attachmentId: 'att-1',
      campaignId: 'camp-9',
      fileName: 'leads-campanha-2026-10-15.pdf',
    };
    expect(exportDownloadHref(card)).toBe('/api/studio/campaigns/camp-9/attachments/att-1/file');
  });

  it('card sem anexo (trial/0 leads) → nenhum botão de download', () => {
    expect(exportDownloadHref({ type: 'leads_export', label: 'A planilha em PDF é do plano Premium', premiumRequired: true })).toBeNull();
    expect(exportDownloadHref({ type: 'leads_export', label: 'Nenhum lead para exportar', total: 0 })).toBeNull();
  });

  it('outros cards nunca ganham botão', () => {
    expect(exportDownloadHref({ type: 'audience', label: 'Audiência montada', campaignId: 'camp-9', attachmentId: 'att-1' } as ChatCard)).toBeNull();
  });
});

describe('chip "Colocar a base na audiência" do enriquecimento (audiência vazia)', () => {
  it('card enrichment_done com suggestedFilter → 1 clique select_leads com a base', () => {
    const card: ChatCard = {
      type: 'enrichment_done',
      label: 'Enriquecimento concluído — nada novo encontrado',
      suggestedFilter: {
        description: 'base da organização',
        prospectIds: ['lead-1', 'lead-2', 'lead-3'],
        matchedCount: 88,
      },
    };
    const chip = enrichmentAudienceChip(card);
    expect(chip).not.toBeNull();
    expect(chip!.label).toBe('Colocar a base na audiência (88 leads)');
    expect(chip!.action).toEqual({ type: 'select_leads', params: { set: ['lead-1', 'lead-2', 'lead-3'] } });
  });

  it('card sem suggestedFilter (audiência já tinha leads) → nenhum chip', () => {
    expect(enrichmentAudienceChip({ type: 'enrichment_done', label: 'Enriquecimento concluído' })).toBeNull();
    expect(enrichmentAudienceChip({ type: 'enrichment_done', label: 'x', suggestedFilter: { description: 'base', prospectIds: [] } })).toBeNull();
  });
});
