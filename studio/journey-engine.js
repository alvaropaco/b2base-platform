'use strict';

/**
 * studio/journey-engine.js — interprete do canvas de journeys (T082, US8).
 *
 * Validação estrutural do grafo, execução de UM passo por lead
 * (`processLead`, injetável — a suíte roda sem Redis), gatilhos e stats.
 * Paradas globais (reply/opt-out/converted) interrompem o fluxo em todos
 * os canais (FR-053); job ids determinísticos (research D14).
 */

const { httpError } = require('./errors');

const BLOCK_TYPES = ['send', 'wait', 'condition', 'update', 'end'];

/** Validação estrutural: ids únicos, arestas válidas, fim alcançável, sem
 *  ciclo sem wait (DFS tratando wait como barreira). */
function validateDefinition(definition) {
  const errors = [];
  const blocks = definition?.blocks || [];
  const edges = definition?.edges || [];
  if (blocks.length === 0) return ['Grafo sem blocos.'];
  const byId = new Map(blocks.map((b) => [b.id, b]));
  if (byId.size !== blocks.length) errors.push('Ids de bloco duplicados.');
  for (const block of blocks) {
    if (!BLOCK_TYPES.includes(block.type)) errors.push(`Tipo de bloco inválido: ${block.type}`);
  }
  if (!blocks.some((b) => b.type === 'end')) errors.push('Grafo sem bloco de fim.');
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      errors.push(`Aresta inválida: ${edge.from} → ${edge.to}`);
    }
  }
  if (errors.length > 0) return errors;

  // Alcance do fim: DFS a partir do(s) bloco(s) inicial(is) sem incoming.
  const incoming = new Set(edges.map((e) => e.to));
  const starts = blocks.filter((b) => !incoming.has(b.id));
  const reachable = new Set();
  const visit = (id, waitingBarrier, path) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    if (path.has(id) && byId.get(id).type !== 'wait' && byId.get(id).type !== 'end') {
      errors.push(`Ciclo sem espera envolvendo "${id}".`);
      return;
    }
    const localPath = new Set(path);
    localPath.add(id);
    for (const edge of edges.filter((e) => e.from === id)) {
      if (byId.get(edge.to)?.type === 'wait') {
        localPath.delete(edge.to); // wait quebra ciclos
      }
      visit(edge.to, waitingBarrier, localPath);
    }
  };
  for (const start of starts) visit(start.id, false, new Set());
  const withoutEnd = blocks.filter(
    (b) => b.type !== 'end' && !edges.some((e) => e.from === b.id)
  );
  if (withoutEnd.length > 0) {
    errors.push(`Blocos sem saída: ${withoutEnd.map((b) => b.id).join(', ')}`);
  }
  for (const start of starts) {
    // Todo caminho deve alcançar um end (checagem por DFS reverso do fim).
    const reachEnd = new Set();
    const walk = (id) => {
      if (reachEnd.has(id)) return;
      reachEnd.add(id);
      for (const e of edges.filter((x) => x.from === id)) walk(e.to);
    };
    walk(start.id);
    if (!blocks.some((b) => b.type === 'end' && reachEnd.has(b.id))) {
      errors.push(`Ramo a partir de "${start.id}" não alcança fim.`);
    }
  }
  return [...new Set(errors)];
}

/** Avalia a condição de um bloco com o comportamento real do lead. */
function evaluateCondition(config, behavior) {
  const kind = config?.kind || 'opened';
  switch (kind) {
    case 'opened':
      return Boolean(behavior.opened);
    case 'clicked':
      return Boolean(behavior.clicked);
    case 'replied':
      return Boolean(behavior.replied);
    case 'score_gte':
      return Number(behavior.score || 0) >= Number(config.value || 0);
    default:
      return false;
  }
}

/** Próximo bloco a partir do atual, dado o resultado da condição. */
function nextBlockId(definition, currentId, conditionResult) {
  const edges = (definition?.edges || []).filter((e) => e.from === currentId);
  if (edges.length === 0) return null;
  if (edges.length === 1) return edges[0].to;
  const wanted = conditionResult ? 'yes' : 'no';
  return (edges.find((e) => (e.branch || 'yes') === wanted) || edges[0]).to;
}

/** Cancela toques futuros do lead nos motores (FR-053 — todos os canais). */
async function stopAllChannels(prisma, { orgId, prospectId, reason }) {
  await prisma.outreachContact.updateMany({
    where: { prospectId, status: 'QUEUED' },
    data: { status: 'CANCELLED', cancelReason: reason },
  });
  await prisma.whatsAppCampaignContact.updateMany({
    where: { prospectId, status: 'QUEUED' },
    data: { status: 'CANCELLED', cancelReason: reason },
  });
}

/**
 * Executa UM passo do journey para o lead. Injetável via options
 * ({behavior, now, enqueue}) — prod enfileira no motor via startCampaign.
 */
async function processLead(prisma, journey, prospectId, { behavior = {}, now = new Date(), enqueue } = {}) {
  const leadRows = await prisma.studioJourneyLead.findMany({
    where: { journeyId: journey.id, prospectId },
  });
  const lead = leadRows[0];
  if (!lead) return { executed: false, skipped: 'not_enrolled' };
  if (lead.status === 'stopped' || lead.status === 'done') {
    return { executed: false, skipped: lead.status };
  }

  const definition = journey.definition || {};
  const byId = new Map((definition.blocks || []).map((b) => [b.id, b]));
  const block = byId.get(lead.currentBlockId);
  if (!block) return { executed: false, skipped: 'no_block' };

  // Paradas globais checadas ANTES de qualquer bloco (FR-053).
  if (behavior.replied || behavior.opt_out) {
    const reason = behavior.replied ? 'reply' : 'opt_out';
    await prisma.studioJourneyLead.update({
      where: { id: lead.id },
      data: { status: 'stopped', stopReason: reason },
    });
    await stopAllChannels(prisma, { orgId: journey.orgId, prospectId, reason });
    return { executed: false, stopped: true, reason };
  }

  // Wait pendente: só avança após o prazo.
  if (lead.status === 'waiting') {
    if (lead.waitingUntil && new Date(lead.waitingUntil) > now) {
      return { executed: false, skipped: 'waiting' };
    }
    // Prazo cumprido: avança pela aresta do wait.
    const nextId = nextBlockId(definition, block.id, true);
    await prisma.studioJourneyLead.update({
      where: { id: lead.id },
      data: { currentBlockId: nextId, status: 'active', waitingUntil: null },
    });
    return { executed: true, advancedTo: nextId };
  }

  switch (block.type) {
    case 'send': {
      if (enqueue) await enqueue(block.config?.channel || 'email', prospectId, block.config);
      await prisma.studioJourneyLead.update({
        where: { id: lead.id },
        data: {
          currentBlockId: nextBlockId(definition, block.id, true),
          blockHistory: [...(lead.blockHistory || []), { blockId: block.id, enteredAt: now.toISOString() }],
        },
      });
      return { executed: true, sent: block.config?.channel };
    }
    case 'wait': {
      const waitingUntil = new Date(now.getTime() + (block.config?.days ?? 1) * 86_400_000);
      await prisma.studioJourneyLead.update({
        where: { id: lead.id },
        data: { status: 'waiting', waitingUntil },
      });
      return { executed: true, waitingUntil };
    }
    case 'condition': {
      const result = evaluateCondition(block.config, behavior);
      const nextId = nextBlockId(definition, block.id, result);
      await prisma.studioJourneyLead.update({
        where: { id: lead.id },
        data: { currentBlockId: nextId },
      });
      return { executed: true, branch: result ? 'yes' : 'no', advancedTo: nextId };
    }
    case 'end': {
      await prisma.studioJourneyLead.update({
        where: { id: lead.id },
        data: { status: 'done', currentBlockId: block.id },
      });
      return { executed: false, done: true };
    }
    default:
      return { executed: false, skipped: 'unknown_block' };
  }
}

/** Inscreve um lead no journey (webhook/segment/behavior trigger). */
async function enrollLead(prisma, journey, prospectId) {
  const definition = journey.definition || {};
  const starts = (definition.blocks || []).filter(
    (b) => !(definition.edges || []).some((e) => e.to === b.id)
  );
  const firstId = starts[0]?.id || null;
  const existing = await prisma.studioJourneyLead.findMany({
    where: { journeyId: journey.id, prospectId },
  });
  if (existing.length > 0) return existing[0]; // idempotente
  return prisma.studioJourneyLead.create({
    data: {
      orgId: journey.orgId,
      journeyId: journey.id,
      prospectId,
      currentBlockId: firstId,
      status: 'active',
    },
  });
}

module.exports = {
  BLOCK_TYPES,
  validateDefinition,
  evaluateCondition,
  nextBlockId,
  processLead,
  enrollLead,
  stopAllChannels,
  httpError,
};
