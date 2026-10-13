'use strict';

/**
 * studio/enrich-worker.js — processador do enriquecimento de base em
 * BACKGROUND (fila `studio:enrich`). Nasce do caso 2026-10-13: enriquecer a
 * base inteira dentro da requisição do chat estourava o timeout do ingress e
 * o usuário via "Falha ao enviar mensagem" com o motor ainda trabalhando.
 *
 * Fluxo: o chat enfileira { orgId, campaignId, prospectIds } → este
 * processador roda os lotes (enrich-base-service) e ESCREVE O RESULTADO COMO
 * MENSAGEM da conversa — o usuário vê o card ao voltar/recarregar.
 * Isolamento: prospects sempre recarregados com orgId do job.
 */

function registerStudioEnrich(prisma, { deps = {} } = {}) {
  const { createQueue } = require('../outreach-queues');
  const queue = createQueue('studio:enrich');
  queue.process('enrich', 1, async (job) => {
    const { enrichLeads, buildEnrichmentCard } = require('./enrich-base-service');
    const { orgId, campaignId, prospectIds } = job.data || {};
    let text;
    let cards;
    try {
      if (!orgId || !campaignId || !Array.isArray(prospectIds) || prospectIds.length === 0) {
        throw new Error('job inválido: orgId/campaignId/prospectIds ausentes');
      }
      const prospects = await prisma.prospect.findMany({
        where: { orgId, id: { in: prospectIds } },
        orderBy: { createdAt: 'desc' },
      });
      const res = await enrichLeads(prisma, { orgId, campaignId, leads: prospects });
      const cadastrados = [...res.found, ...res.promoted];
      cards = [
        buildEnrichmentCard({
          found: res.found,
          promoted: res.promoted,
          notFound: res.notFound,
          semNovo: res.semNovo,
          buscaMorta: res.buscaMorta,
          escopoTotal: prospects.length,
          semNumeroCount: res.semNumero.length,
          comNumeroCount: res.comNumero.length,
          loteSize: prospects.length,
          restantes: 0,
        }),
      ];
      text = cadastrados.length
        ? `Pronto — enriquecimento da base concluído: ${cadastrados.length} WhatsApp(s) cadastrado(s) em ${prospects.length} lead(s). Os detalhes estão no card abaixo.`
        : `Pronto — enriquecimento da base concluído: nenhum WhatsApp novo encontrado em ${prospects.length} lead(s). Os detalhes estão no card abaixo.`;
    } catch (err) {
      console.error('[studio:enrich] falhou:', err.stack || err.message);
      text = 'O enriquecimento em background falhou no meio — pode me pedir para rodar de novo que eu refaço.';
      cards = [{
        type: 'error',
        label: 'Enriquecimento falhou',
        detail: `Erro no motor de enriquecimento: ${String((err && err.message) || err).slice(0, 200)}. Me peça para tentar de novo.`,
      }];
    }
    await prisma.studioChatMessage.create({
      data: { orgId, campaignId, role: 'assistant', text, cards },
    });
  });
  return queue;
}

module.exports = { registerStudioEnrich };
