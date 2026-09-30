/**
 * CampaignChat.recovery.test.ts — Epic 1 (FR6/FR15): a "ação de 1 clique" da
 * recuperação de 0-match e a desambiguação de material existem de verdade na
 * UI. Decisão de render como FUNÇÃO PURA (padrão preFlight.cta.test.ts —
 * vitest, sem DOM, sem dependência nova — constituição VI).
 */
import { describe, expect, it } from 'vitest';
import { ambiguousMaterialChips, zeroMatchFilterChip, type ChatCard } from './CampaignChat';

describe('chip "Usar este filtro" do card de 0-match (FR6)', () => {
  it('card de audiência com suggestedFilter → botão com a contagem que casa', () => {
    const card: ChatCard = {
      type: 'audience',
      label: 'Audiência montada — nenhum lead casou',
      emptyMatch: true,
      diagnosis: 'Busquei os termos "metalurgica" no setor e no nome das empresas.',
      suggestedFilter: {
        description: 'setor "metalurgia" — parecido com o que você buscou',
        criteria: { version: 1, groups: [] },
        matchedCount: 57,
      },
    } as ChatCard;
    const chip = zeroMatchFilterChip(card);
    expect(chip).not.toBeNull();
    expect(chip!.label).toContain('57');
    expect(chip!.label).toMatch(/usar este filtro/i);
    expect(chip!.action.type).toBe('set_audience');
    expect(chip!.action.params).toEqual({
      description: 'setor "metalurgia" — parecido com o que você buscou',
      criteria: { version: 1, groups: [] },
    });
  });

  it('audiência SEM suggestedFilter (esgotadas as propostas) → nenhum botão', () => {
    const card: ChatCard = {
      type: 'audience',
      label: 'Audiência montada — nenhum lead casou',
      suggestedFilter: null,
    };
    expect(zeroMatchFilterChip(card)).toBeNull();
  });

  it('outros cards de audiência (com leads) não ganham chip', () => {
    expect(zeroMatchFilterChip({ type: 'audience', label: 'Audiência montada' })).toBeNull();
  });
});

describe('chips de desambiguação de material (FR15/F2)', () => {
  it('material_ambiguous lista cada candidato como chip que confirma o id', () => {
    const card: ChatCard = {
      type: 'material_ambiguous',
      label: 'Qual material você quer confirmar?',
      candidates: [
        { id: 'mat-1', label: 'Proposta Comercial' },
        { id: 'mat-2', label: 'Proposta comercial' },
      ],
    };
    const chips = ambiguousMaterialChips(card);
    expect(chips.map((c) => c.label)).toEqual(['Proposta Comercial', 'Proposta comercial']);
    expect(chips.map((c) => c.action)).toEqual([
      { type: 'confirm_material', params: { materialId: 'mat-1' } },
      { type: 'confirm_material', params: { materialId: 'mat-2' } },
    ]);
  });

  it('sem candidatos (ou card de outro tipo) → nenhum chip', () => {
    expect(ambiguousMaterialChips({ type: 'material_ambiguous', label: 'x' })).toEqual([]);
    expect(ambiguousMaterialChips({ type: 'material', label: 'x', candidates: [] })).toEqual([]);
  });
});
