'use strict';

/**
 * studio/ai/segment-nl.js — segmento por linguagem natural (FR-014, T091 —
 * antecipado para a fase US9 por dependência do agente).
 * LLM → MESMO documento de critérios fechado do segment-service (nunca SQL),
 * com explicação por condição. Validação pelo catálogo COM retry de reparo:
 * se o modelo inventar campo/op fora do catálogo, a 2ª chamada inclui o
 * erro e a resposta inválida (fix issue "Critérios inválidos: groups ausente").
 */

const { callLlmJson } = require('./json');
const segmentService = require('../segment-service');

function createSegmentNl({ callLlm } = {}) {
  const llm = callLlm || require('../../llm-client').callLlm;

  async function fromPrompt(prompt) {
    const fields = Object.entries(segmentService.FIELD_CATALOG)
      .map(([field, ops]) => `- ${field}: ${ops.join(', ')}`)
      .join('\n');

    const buildUser = (previousRaw) => {
      const base = [
        'Traduza o pedido abaixo para critérios de segmento. Campos/operadores PERMITIDOS (use somente estes):',
        fields,
        'Regiões do Brasil válidas para o campo "region": Norte, Nordeste, Centro-Oeste, Sudeste, Sul.',
        'Responda SOMENTE com JSON:',
        '{"criteria":{"version":1,"groups":[{"op":"AND","conditions":[{"field":"...","op":"...","value":"..."}]}]},"rationale":"por que estes critérios representam o pedido"}',
        'Pedido:',
        String(prompt || '').slice(0, 4000),
      ].join('\n');
      if (!previousRaw) return base;
      return [
        'Sua resposta anterior NÃO atendeu ao formato do catálogo.',
        'Use SOMENTE os campos/operadores listados e o formato JSON exato acima.',
        '--- RESPOSTA ANTERIOR (inválida) ---',
        String(previousRaw).slice(0, 1200),
        '',
        base,
      ].join('\n');
    };

    const parsed = await callLlmJson(llm, {
      system: 'Você traduz pedidos de público em critérios estruturados de segmento B2B, respondendo apenas com JSON válido.',
      buildUser,
      validate: (p) => {
        try {
          segmentService.validateCriteria(p.criteria);
          return null;
        } catch (err) {
          return `critérios fora do catálogo (${err.message})`;
        }
      },
      maxTokens: 2000,
      temperature: 0.3,
      tag: 'studio:segment-nl',
    });

    return {
      criteria: parsed.criteria,
      rationale: parsed.rationale || null,
    };
  }

  return { fromPrompt };
}

module.exports = { createSegmentNl };
