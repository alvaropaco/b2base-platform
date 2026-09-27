'use strict';

/**
 * studio/ai/compose.js — pacote de campanha multicanal por tom (specs/010,
 * T047; FR-025/FR-026). Um chamado por tom/variante: e-mail (assunto,
 * pré-header, blocos), WhatsApp (curto, com CTA) e texto para LinkedIn —
 * cada canal adaptado, nunca cópia do mesmo texto. DI: callLlm injetável
 * (pesquisa D9); Brand Voice entra como diretriz quando configurada (US12).
 *
 * Confiabilidade (fix issue chat): 3 canais em uma resposta exige espaço —
 * maxTokens alto e retry de reparo quando a resposta truncar/quebrar
 * (callLlmJson; validação = ao menos um canal preenchido).
 */

const { callLlmJson } = require('./json');

function createComposer({ callLlm } = {}) {
  const llm = callLlm || require('../../llm-client').callLlm;

  /**
   * Compõe o pacote de UM tom. Retorna:
   * { title, email: {subject, preheader, blocks}, whatsapp: {text},
   *   linkedinText, timing }
   */
  async function composeForTone({ tone, sourceText, orgContext, objective, offer }) {
    const buildUser = (previousRaw) => {
      const prompt = [
        `Gere o pacote de campanha de prospecção no tom "${tone}".`,
        orgContext ? `Contexto da empresa vendedora: ${orgContext}` : '',
        objective ? `Objetivo da campanha: ${objective}` : '',
        offer ? `Oferta: ${offer}` : '',
        'Base do conteúdo (material/fonte confirmada):',
        String(sourceText || '').slice(0, 12_000),
        '',
        'Responda SOMENTE com JSON no formato:',
        '{"title":"...",',
        ' "email":{"subject":"... usa {{companyName}}","preheader":"...","blocks":[{"type":"text","text":"... usa {{firstName}}"},{"type":"button","label":"...","url":"https://..."}]},',
        ' "whatsapp":{"text":"mensagem curta com {{firstName}} e CTA"},',
        ' "linkedinText":"texto para contato manual",',
        ' "timing":"sugestão de dia/horário"}',
        'Regras: adapte REALMENTE o texto por canal (WhatsApp é curto e direto; e-mail é estruturado).',
        'Use apenas variáveis do catálogo: {{firstName}}, {{companyName}}, {{city}}, {{industry}}, {{state}}.',
        'Nunca invente números ou benefícios que não estejam na base.',
      ]
        .filter(Boolean)
        .join('\n');
      if (!previousRaw) return prompt;
      return [
        'Sua resposta anterior NÃO foi JSON utilizável (provavelmente truncada).',
        'Responda novamente com o JSON COMPLETO, sem texto fora do JSON, mantendo o mesmo tom.',
        '--- RESPOSTA ANTERIOR (inválida) ---',
        String(previousRaw).slice(0, 1200),
        '',
        prompt,
      ].join('\n');
    };

    return callLlmJson(llm, {
      system: 'Você é redator de campanhas B2B em português, respondendo apenas com JSON válido e completo.',
      buildUser,
      validate: (p) => (p.email || p.whatsapp || p.linkedinText ? null : 'pacote sem nenhum canal preenchido'),
      maxTokens: 4000,
      temperature: 0.7,
      tag: 'studio:compose',
    });
  }

  return { composeForTone };
}

module.exports = { createComposer };
