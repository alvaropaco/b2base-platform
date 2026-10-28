'use strict';

/**
 * studio/ai/extract.js — extração estruturada de materiais (specs/010, T045).
 * Material/URL → produto, oferta, benefícios, público e CTA (FR-024), sempre
 * apresentados para confirmação humana antes de compor a campanha.
 *
 * Confiabilidade (fix issue "às vezes falha"):
 *  - usa o modelo premium (AI_CAMPAIGN_LLM_MODEL) — extração é o passo
 *    frágil e a rota já é premium-gated;
 *  - parse tolerante (studio/ai/json.js): prosa em volta, cercas e texto
 *    residual não quebram;
 *  - retry com prompt de REPARO quando a saída não é JSON utilizável
 *    (inclui a resposta ruim e exige só o JSON completo).
 *
 * DI: callLlm injetável (padrão do repo, pesquisa D9).
 */

const { parseModelJson } = require('./json');
const { premiumModel } = require('../../llm-client');

function createExtractor({ callLlm } = {}) {
  const llm = callLlm || require('../../llm-client').callLlm;

  function buildPrompt(sourceText, sourceHint) {
    return [
      'Faça a extração estruturada do material comercial abaixo para uma campanha de prospecção.',
      'Responda SOMENTE com JSON no formato:',
      '{"product":"...","offer":"...","benefits":["..."],"audience":"...","industry":"...","visible_text":["..."],"cta":"...","contacts":["..."],"missing_information":["..."],"confidence":0.0}',
      'Regras: extraia APENAS o que está no material — nunca invente benefícios, preços ou números.',
      'visible_text = TODO texto que aparece LITERALMENTE no material (banner/imagem), sem interpretar;',
      'industry = setor/segmento de mercado mais provável; contacts = telefone/site/e-mail/contato visível;',
      'missing_information = campos comerciais importantes que o material NÃO traz (ex.: "oferta/preterço", "público");',
      'Diferencie TEXTO LIDO (visible_text) da interpretação comercial (product/offer/audience): o que não puder',
      'ser inferido com segurança fica null/[] e entra em missing_information — nunca inventado.',
      'confidence = sua confiança (0 a 1) de que a extração representa o material.',
      sourceHint ? `Fonte do material: ${sourceHint}.` : '',
      '--- MATERIAL ---',
      String(sourceText || '').slice(0, 12_000),
    ]
      .filter(Boolean)
      .join('\n');
  }

  function buildRepairPrompt(previousRaw) {
    return [
      'Sua resposta anterior NÃO foi JSON utilizável. Responda novamente.',
      'Responda SOMENTE com o JSON completo, sem nenhum texto antes ou depois, sem cercas de código:',
      '{"product":"...","offer":"...","benefits":["..."],"audience":"...","industry":"...","visible_text":["..."],"cta":"...","contacts":["..."],"missing_information":["..."],"confidence":0.0}',
      '--- SUA RESPOSTA ANTERIOR (inválida) ---',
      String(previousRaw || '').slice(0, 1200),
    ].join('\n');
  }

  function normalize(parsed) {
    const arr = (v, max) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, max) : []);
    return {
      product: parsed.product || null,
      offer: parsed.offer || null,
      benefits: arr(parsed.benefits, 10),
      audience: parsed.audience || null,
      // Campos comerciais completos (2026-10-27): texto LIDO da arte separado
      // da interpretação; ausências explícitas em missing_information.
      industry: parsed.industry || null,
      visible_text: arr(parsed.visible_text, 20),
      contacts: arr(parsed.contacts, 10),
      missing_information: arr(parsed.missing_information, 10),
      cta: parsed.cta || null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    };
  }

  /**
   * Texto do material → extração estruturada (com retry de reparo).
   * Retorna { product, offer, benefits, audience, cta, confidence }.
   */
  async function extractFromText(text, { sourceHint } = {}) {
    const sourceText = String(text || '').slice(0, 12_000);
    let lastRaw = null;
    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      let result;
      try {
        result = await llm({
          system: 'Você extrai estrutura de materiais comerciais em português, respondendo apenas com JSON válido.',
          user: attempt === 1 ? buildPrompt(sourceText, sourceHint) : buildRepairPrompt(lastRaw),
          jsonMode: true,
          temperature: attempt === 1 ? 0.2 : 0,
          maxTokens: 1200,
          model: premiumModel(),
          tag: 'studio:extract',
        });
      } catch (err) {
        lastError = err;
        console.error(`[studio:extract] chamada LLM falhou (tentativa ${attempt}):`, err.message);
        continue;
      }
      lastRaw = result.content;
      const parsed = parseModelJson(result.content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return normalize(parsed);
      }
      console.error(
        `[studio:extract] parse falhou (tentativa ${attempt}/2):`,
        String(result.content || '').slice(0, 200)
      );
    }

    const err = new Error(
      `Resposta de extração não é JSON utilizável após 2 tentativas${lastError ? ` (${lastError.message})` : ''}.`
    );
    err.code = 'EXTRACTION_PARSE_FAILED';
    err.status = 502;
    throw err;
  }

  return { extractFromText };
}

module.exports = { createExtractor };
