'use strict';

/**
 * studio/ai/classify-reply.js — classificação de respostas por IA (T065).
 *
 * Labels (FR-045): interested, not_interested, doubt, meeting_request,
 * opt_out, out_of_scope. Confiança baixa → fila de revisão humana.
 * Opt-out (FR-046): propaga para LeadChannelState + SuppressionList e
 * cancela toques futuros do lead em TODOS os canais — o scheduler e o
 * motor re-checam no envio (defense in depth).
 *
 * Falha do LLM nunca quebra o fluxo do reply: cai para `unclassified` com
 * revisão humana. DI: callLlm injetável (pesquisa D9).
 */

const { parseJsonLoose } = require('../../llm-client');

const VALID_LABELS = ['interested', 'not_interested', 'doubt', 'meeting_request', 'opt_out', 'out_of_scope'];
const CONFIDENCE_THRESHOLD = Number(process.env.STUDIO_CLASSIFY_CONFIDENCE || 0.7);

function createReplyClassifier({ callLlm } = {}) {
  const llm = callLlm || require('../../llm-client').callLlm;

  async function classifyText(text) {
    const result = await llm({
      system: 'Você classifica respostas de leads em português para um time de vendas B2B, respondendo apenas com JSON válido.',
      user: [
        'Classifique a resposta do lead em UMA das categorias:',
        '{"label":"interested|not_interested|doubt|meeting_request|opt_out|out_of_scope","confidence":0.0}',
        'Regras: pedido explícito de NÃO receber contato é SEMPRE opt_out (mesmo grosseiro).',
        'Proposta de reunião/call é meeting_request. Dúvida sobre produto/serviço é doubt.',
        '--- RESPOSTA ---',
        String(text || '').slice(0, 4000),
      ].join('\n'),
      jsonMode: true,
      temperature: 0.1,
      maxTokens: 200,
      tag: 'studio:classify',
    });
    const parsed = parseJsonLoose(result.content) || {};
    const label = VALID_LABELS.includes(parsed.label) ? parsed.label : 'unclassified';
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    return { label, confidence };
  }

  /**
   * Classifica e persiste; propaga opt-out. Nunca lança — falha vira
   * `unclassified` com revisão humana (o reply do lead é precioso).
   */
  async function classifyAndStore(prisma, { orgId, prospectId, channel, sourceMessageId, text }) {
    let label = 'unclassified';
    let confidence = 0;
    try {
      const verdict = await classifyText(text);
      label = verdict.label;
      confidence = verdict.confidence;
    } catch (err) {
      console.error('[studio:classify] LLM indisponível:', err.message);
    }
    const needsHumanReview = label === 'unclassified' || confidence < CONFIDENCE_THRESHOLD;

    const record = await prisma.studioReplyClassification.create({
      data: {
        orgId,
        prospectId,
        channel,
        sourceMessageId,
        label,
        confidence,
        needsHumanReview,
      },
    });

    if (label === 'opt_out') {
      await propagateOptOut(prisma, { orgId, prospectId, channel });
    }
    return { label, confidence, needsHumanReview, id: record.id };
  }

  /** FR-046: suspende TODOS os contatos futuros com o lead, todos os canais. */
  async function propagateOptOut(prisma, { orgId, prospectId, channel }) {
    // Estado por canal (o scheduler re-checa antes de cada envio).
    await prisma.leadChannelState.upsert({
      where: { prospectId_channel: { prospectId, channel } },
      create: { orgId, prospectId, channel, status: 'opted_out', reason: 'opt-out declarado em resposta' },
      update: { status: 'opted_out', reason: 'opt-out declarado em resposta' },
    });
    // Outros canais também param (spec: todos os canais).
    for (const other of ['email', 'whatsapp'].filter((c) => c !== channel)) {
      const existing = await prisma.leadChannelState.findMany({
        where: { orgId, prospectId, channel: other },
      });
      if (existing.length === 0) {
        await prisma.leadChannelState.create({
          data: { orgId, prospectId, channel: other, status: 'do_not_contact', reason: 'opt-out em outro canal' },
        });
      }
    }
    // Supressão de e-mail quando conhecida.
    const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } });
    if (prospect?.cnpjEmail) {
      await prisma.suppressionList.upsert({
        where: { tenantId_email: { tenantId: orgId, email: prospect.cnpjEmail } },
        create: { tenantId: orgId, email: prospect.cnpjEmail, reason: 'unsubscribed' },
        update: { reason: 'unsubscribed' },
      });
    }
    // Cancela toques futuros já inscritos nos motores.
    await prisma.outreachContact.updateMany({
      where: { prospectId, status: 'QUEUED' },
      data: { status: 'CANCELLED', cancelReason: 'unsubscribed' },
    });
    await prisma.whatsAppCampaignContact.updateMany({
      where: { prospectId, status: 'QUEUED' },
      data: { status: 'OPTED_OUT', cancelReason: 'opted_out' },
    });
  }

  return { classifyText, classifyAndStore };
}

module.exports = { createReplyClassifier, VALID_LABELS };
