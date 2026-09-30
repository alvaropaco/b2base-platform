/**
 * CampaignChat.capture.test.ts — Epic 2 (FR7/UX-DR3): o chip "Materializar
 * audiência com os capturados" do card de captura existe de verdade na UI.
 * Decisão de render como FUNÇÃO PURA (padrão CampaignChat.recovery.test.ts —
 * vitest, sem DOM, sem dependência nova — constituição VI).
 */
import { describe, expect, it } from 'vitest';
import { captureLeadsChip, type ChatCard } from './CampaignChat';

describe('chip "Materializar audiência com os capturados" do card de captura (Epic 2)', () => {
  it('card de captura com lote capturado → chip que materializa a audiência via select_leads', () => {
    const card: ChatCard = {
      type: 'capture',
      status: 'captured',
      label: 'Leads capturados',
      detail: '2 da sua base + 3 encontrado(s) via CNPJ. Nada foi enviado — os leads ficam prontos para você usar.',
      suggestedFilter: {
        description: 'audiência com os leads capturados agora',
        prospectIds: ['p1', 'p2', 'p3'],
        matchedCount: 3,
      },
    };
    const chip = captureLeadsChip(card);
    expect(chip).not.toBeNull();
    expect(chip!.label).toContain('3');
    expect(chip!.label).toMatch(/materializar audi/i);
    expect(chip!.action.type).toBe('select_leads');
    expect(chip!.action.params).toEqual({ set: ['p1', 'p2', 'p3'] });
  });

  it('recusa e limite diário NUNCA ganham chip (nada foi capturado)', () => {
    expect(
      captureLeadsChip({ type: 'capture', status: 'refused', label: 'x' })
    ).toBeNull();
    expect(
      captureLeadsChip({ type: 'capture', status: 'limit_reached', label: 'x' })
    ).toBeNull();
  });

  it('captura sem leads no lote → nenhum chip', () => {
    expect(
      captureLeadsChip({
        type: 'capture',
        status: 'captured',
        label: 'x',
        suggestedFilter: { description: 'x', prospectIds: [], matchedCount: 0 },
      })
    ).toBeNull();
  });

  it('prospectIds não-array (payload inesperado) não quebra o render → nenhum chip', () => {
    expect(
      captureLeadsChip({
        type: 'capture',
        status: 'captured',
        label: 'x',
        suggestedFilter: { description: 'x', prospectIds: 'p1' as unknown as string[] },
      })
    ).toBeNull();
  });

  it('no_results e refused NUNCA ganham chip (status != captured)', () => {
    expect(captureLeadsChip({ type: 'capture', status: 'no_results', label: 'x' })).toBeNull();
  });

  it('outros cards não ganham o chip', () => {
    expect(captureLeadsChip({ type: 'audience', label: 'x' })).toBeNull();
    expect(captureLeadsChip({ type: 'balance', label: 'x' })).toBeNull();
  });
});
