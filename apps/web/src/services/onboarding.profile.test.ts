/**
 * Testes do sync de perfil (feature 009): mapeamento determinístico das
 * respostas do onboarding para o perfil comercial, com merge que preserva os
 * campos que a conversa não cobre (quickstart Cenários 1–2).
 */

import { describe, it, expect, vi } from 'vitest';
import { buildCommercialProfilePayload } from './onboarding';
import type { BusinessContext, OnboardingResult, QuestionId } from '@/types/onboarding';
import type { CommercialProfile } from '@/types';

const CONTEXT: BusinessContext = {
  products: [{ name: 'Lawyer Agent', description: 'Contratos com IA' }],
  valueProposition: 'Contratos em minutos',
  businessModel: 'SaaS B2B',
  differentiators: ['Integração com tribunais'],
  targetMarket: 'Escritórios de advocacia',
  sources: ['site'],
  warnings: [],
};

function answer(
  questionId: QuestionId,
  value: string | string[] | null,
  via: 'text' | 'chip' | 'prefilled' | 'skipped' = 'chip',
  answeredAt = 1
) {
  return { questionId, value, via, answeredAt };
}

function makeResult(overrides: Partial<OnboardingResult> = {}): OnboardingResult {
  return {
    companyName: 'LawyerAgent',
    userName: 'Ana',
    userEmail: 'ana@lawyeragent.com',
    crm: { name: 'Pipedrive', connected: true },
    mercadoAlvo: ['Pequenas empresas'],
    businessContext: CONTEXT,
    answers: {
      nome: answer('nome', 'Ana', 'text'),
      empresa: answer('empresa', 'LawyerAgent', 'text'),
      cargo: answer('cargo', null, 'skipped'),
      setor: answer('setor', 'Serviços jurídicos'),
      tamanhoTime: answer('tamanhoTime', '2–5'),
      objetivo: answer('objetivo', 'Fechar mais vendas'),
      crm: answer('crm', 'Pipedrive'),
      mercadoAlvo: answer('mercadoAlvo', ['Pequenas empresas']),
      regioesInteresse: answer('regioesInteresse', ['Sudeste', 'Sul']),
      email: answer('email', 'ana@lawyeragent.com', 'text'),
      siteInstitucional: answer('siteInstitucional', 'https://lawyeragent.com', 'text'),
      materiais: answer('materiais', null, 'skipped'),
      catalogo: answer('catalogo', 'nao'),
    },
    ...overrides,
  };
}

function makeCurrent(): CommercialProfile {
  return {
    onboardingCompleted: false,
    onboardingStep: 2,
    companyName: '',
    salesTeamSize: '',
    targetSegments: [],
    targetCnaes: ['6201-2/00'],
    targetLocations: ['Interior de SP'],
    companyStatuses: ['active', 'new'],
    targetSizes: [],
    ageRanges: ['growing'],
    averageTicket: 5000,
    salesCycle: '30 a 90 dias',
    valueProposition: '',
    productDescription: '',
    businessModel: '',
    differentiators: [],
    websiteUrl: '',
    ctaGoal: 'Agendar demo',
    toneNotes: 'Formal',
    crmName: null,
    onboardingAnswers: null,
  };
}

describe('US1 — mapeamento respostas → perfil (FR-002)', () => {
  it('mapeia todas as respostas cobertas e preserva o que a conversa não cobre', () => {
    const payload = buildCommercialProfilePayload(makeResult(), makeCurrent());

    expect(payload.companyName).toBe('LawyerAgent');
    expect(payload.targetSegments).toEqual(['Serviços jurídicos']);
    expect(payload.salesTeamSize).toBe('2–5');
    expect(payload.targetSizes).toEqual(['small']);
    expect(payload.targetLocations).toEqual(['Sudeste', 'Sul']);
    expect(payload.websiteUrl).toBe('https://lawyeragent.com');
    expect(payload.crmName).toBe('Pipedrive');
    expect(payload.onboardingCompleted).toBe(true);

    // Contexto de negócio extraído (FR-002/FR-024).
    expect(payload.productDescription).toContain('Lawyer Agent');
    expect(payload.productDescription).toContain('Contratos com IA');
    expect(payload.valueProposition).toBe('Contratos em minutos');
    expect(payload.businessModel).toBe('SaaS B2B');
    expect(payload.differentiators).toEqual(['Integração com tribunais']);

    // Merge preserva campos que a conversa NÃO cobre (invariante I2 / FR-011).
    expect(payload.targetCnaes).toEqual(['6201-2/00']);
    expect(payload.averageTicket).toBe(5000);
    expect(payload.companyStatuses).toEqual(['active', 'new']);
    expect(payload.ageRanges).toEqual(['growing']);
    expect(payload.salesCycle).toBe('30 a 90 dias');
    expect(payload.ctaGoal).toBe('Agendar demo');
    expect(payload.toneNotes).toBe('Formal');
    // onboardingStep atual do perfil é preservado.
    expect(payload.onboardingStep).toBe(2);
  });

  it('registro completo das respostas: 13 perguntas, incluindo puladas', () => {
    const payload = buildCommercialProfilePayload(makeResult(), makeCurrent());
    const record = payload.onboardingAnswers as {
      completedAt: string;
      answers: Record<string, { value: unknown; via: string; answeredAt: number }>;
    };
    expect(Object.keys(record.answers)).toHaveLength(13);
    expect(record.answers.cargo).toMatchObject({ value: null, via: 'skipped' });
    expect(record.answers.materiais).toMatchObject({ value: null, via: 'skipped' });
    expect(record.answers.regioesInteresse).toMatchObject({ value: ['Sudeste', 'Sul'] });
    expect(typeof record.completedAt).toBe('string');
  });

  it('mesma entrada produz o mesmo payload (idempotência — I3)', () => {
    // completedAt é carimbo de runtime (new Date().toISOString()) — sem o
    // relógio travado o teste floppa quando o milissegundo vira entre as
    // duas chamadas (flake observado em 2026-10-02).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    try {
      const a = buildCommercialProfilePayload(makeResult(), makeCurrent());
      const b = buildCommercialProfilePayload(makeResult(), makeCurrent());
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('US1 — bordas do mapeamento', () => {
  it('CRM "Ainda não uso" → crmName null e connected false', () => {
    const payload = buildCommercialProfilePayload(
      makeResult({ crm: { name: null, connected: false } }),
      makeCurrent()
    );
    expect(payload.crmName).toBeNull();
  });

  it('mercado-alvo sem empresas (só B2C) → targetSizes herda o perfil atual', () => {
    const payload = buildCommercialProfilePayload(
      makeResult({ mercadoAlvo: ['Consumidor final (B2C)'] }),
      makeCurrent()
    );
    expect(payload.targetSizes).toEqual([]);
  });

  it('contexto de negócio ausente → campos de contexto herdam o perfil atual', () => {
    const current = { ...makeCurrent(), productDescription: 'Já vendíamos X', valueProposition: 'VP atual' };
    const payload = buildCommercialProfilePayload(makeResult({ businessContext: null }), current);
    expect(payload.productDescription).toBe('Já vendíamos X');
    expect(payload.valueProposition).toBe('VP atual');
  });

  it('"Todo o Brasil" (exclusiva) → localizações-alvo com o rótulo nacional', () => {
    const payload = buildCommercialProfilePayload(
      makeResult({
        answers: {
          ...makeResult().answers,
          regioesInteresse: answer('regioesInteresse', ['todo-brasil']),
        },
      }),
      makeCurrent()
    );
    expect(payload.targetLocations).toEqual(['Todo o Brasil']);
  });
});
