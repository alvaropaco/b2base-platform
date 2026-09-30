/**
 * UI mínima testável (I1 — onda "criação de campanha sem bloqueios"): os
 * pontos de DECISÃO da UI de Pré-voo e dos rótulos de estado, como funções
 * puras — sem DOM, sem dependência nova (constituição VI).
 *
 *  - primaryCtaFor (Story 3.1/B12/E15): draft/pausada/pendente de envio
 *    NUNCA rendem CTA de disparo (que daria 409 genérico); aprovada com
 *    canal rende "Colocar em voo".
 *  - displayStatusLabel (Story 1.5/UX-DR5): "Pendente de envio" aparece POR
 *    NOME na lista e no detalhe.
 */
import { describe, expect, it } from 'vitest';
import { primaryCtaFor } from './PreFlightView';
import { displayStatusLabel } from './CampaignsListView';

describe('CTA do Pré-voo por estado (Story 3.1/B12/E15)', () => {
  it('draft nunca dispara — volta ao chat', () => {
    const cta = primaryCtaFor('draft', false, null);
    expect(cta.kind).toBe('chat');
    expect(cta.label).not.toMatch(/voo|dispar/i);
  });

  it('pausada retoma — sem disparo genérico que daria 409', () => {
    const cta = primaryCtaFor('paused', false, null);
    expect(cta.kind).toBe('resume');
  });

  it('em revisão aprova', () => {
    expect(primaryCtaFor('in_review', true, null).kind).toBe('approve');
  });

  it('pendente de envio (approved sem canal) → CONECTAR canal, nunca disparar (UX-DR2/DR5)', () => {
    const cta = primaryCtaFor('approved', false, null);
    expect(cta.kind).toBe('connect');
    expect(cta.label).toMatch(/Conectar canal/i);
  });

  it('aprovada com canal → Colocar em voo', () => {
    const cta = primaryCtaFor('approved', true, null);
    expect(cta.kind).toBe('launch');
    expect(cta.label).toBe('Colocar em voo');
  });

  it('em voo (running) → Monitor', () => {
    expect(primaryCtaFor('running', true, null).kind).toBe('monitor');
  });
});

describe('rótulo do estado por nome (Story 1.5/UX-DR5)', () => {
  it('approved + NO_CHANNEL_CONNECTED → "Pendente de envio"', () => {
    expect(displayStatusLabel({ status: 'approved', statusReason: 'NO_CHANNEL_CONNECTED' })).toBe('Pendente de envio');
  });

  it('scheduled + NO_CHANNEL_CONNECTED também é "Pendente de envio" (agenda preserva o motivo — D5)', () => {
    expect(displayStatusLabel({ status: 'scheduled', statusReason: 'NO_CHANNEL_CONNECTED' })).toBe('Pendente de envio');
  });

  it('approved com canal segue "Aprovada"', () => {
    expect(displayStatusLabel({ status: 'approved', statusReason: null })).toBe('Aprovada');
  });

  it('demais estados mantêm o rótulo de sempre', () => {
    expect(displayStatusLabel({ status: 'running', statusReason: null })).toBe('Em execução');
  });
});
