'use strict';

/**
 * studio/campaign-service.js — máquina de estados e serviço de campanha
 * (specs/010, T009). A spec manda: nenhuma campanha nasce disparável
 * (FR-002) e nada envia sem aprovação explícita (FR-003).
 *
 * Estados (data-model.md):
 *   draft → in_review → approved → scheduled → running ⇄ paused
 *   → completed | cancelled; in_review → retained (sanimento 007).
 *
 * FR-006: conteúdo em fila após o início não edita — pausar → in_review
 * (re-aprovação) → volta a rodar.
 */

const STUDIO_STATES = [
  'draft',
  'in_review',
  'approved',
  'scheduled',
  'running',
  'paused',
  'completed',
  'cancelled',
  'retained',
];

const TRANSITIONS = {
  draft: ['in_review', 'cancelled'],
  in_review: ['approved', 'cancelled', 'retained', 'draft'], // draft = devolver p/ edição
  approved: ['scheduled', 'running', 'cancelled', 'in_review'], // running = disparo imediato; in_review = exigir revisão
  scheduled: ['running', 'paused', 'cancelled', 'in_review'], // in_review = re-agendar após editar
  running: ['paused', 'completed', 'cancelled'],
  paused: ['running', 'in_review', 'cancelled'], // in_review = editar e re-aprovar (FR-006)
  completed: [],
  cancelled: [],
  retained: ['in_review', 'cancelled'], // re-derive → volta a revisão
};

/** Estados em que o conteúdo da campanha pode ser editado (FR-006). */
const EDITABLE_STATES = ['draft', 'in_review', 'paused'];

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/** Erro semântico 409 do contrato. */
function invalidTransition(from, to) {
  const err = new Error(`Transição de estado inválida: ${from} → ${to}`);
  err.code = 'INVALID_TRANSITION';
  err.status = 409;
  return err;
}

/** Lança INVALID_TRANSITION quando a transição não existe. */
function assertTransition(from, to) {
  if (!STUDIO_STATES.includes(from)) {
    throw invalidTransition(from, to);
  }
  if (!canTransition(from, to)) {
    throw invalidTransition(from, to);
  }
  return true;
}

/** Lança CAMPAIGN_LOCKED (409) quando o conteúdo não pode ser editado (FR-006). */
function assertEditable(campaign) {
  if (!EDITABLE_STATES.includes(campaign.status)) {
    const err = new Error(
      'Campanha com fila em execução: pause a campanha para alterar o conteúdo e re-aprove.'
    );
    err.code = 'CAMPAIGN_LOCKED';
    err.status = 409;
    throw err;
  }
  return true;
}

/** Aprovação exige transição in_review → approved (ou estado que permita). */
function assertApprovable(campaign) {
  if (campaign.status !== 'in_review') {
    throw invalidTransition(campaign.status, 'approved');
  }
  return true;
}

module.exports = {
  STUDIO_STATES,
  TRANSITIONS,
  EDITABLE_STATES,
  canTransition,
  assertTransition,
  assertEditable,
  assertApprovable,
  invalidTransition,
};

// ============================================================================
// Operações de fluxo (DB) — T015: congelamento de audiência e aprovação.
// ============================================================================

const compliance = require('./compliance-service');
const bridge = require('./channel-bridge');
const { dispatchImmediate } = require('./dispatch');

function httpErr(code, status, message) {
  const err = new Error(message || code);
  err.code = code;
  err.status = status;
  return err;
}

/**
 * Materializa a audiência declarada em snapshot com membros classificados
 * (FR-011/FR-012). Declarações posteriores supersedem a anterior — a
 * vigente é sempre única por campanha.
 */
async function materializeAudience(prisma, { campaign, prospectIds }) {
  const members = await compliance.classifyAudience(prisma, {
    orgId: campaign.orgId,
    prospectIds,
    channels: campaign.channels || [],
  });
  const includedCount = members.filter((m) => m.included).length;

  await prisma.studioAudienceSnapshot.updateMany({
    where: { campaignId: campaign.id, status: 'active' },
    data: { status: 'superseded' },
  });

  const snapshot = await prisma.studioAudienceSnapshot.create({
    data: {
      orgId: campaign.orgId,
      campaignId: campaign.id,
      criteriaVersion: { manual: true, prospectIds },
      totalCount: members.length,
      includedCount,
      excludedCount: members.length - includedCount,
      status: 'active',
    },
  });

  for (const member of members) {
    await prisma.studioAudienceMember.create({
      data: {
        snapshotId: snapshot.id,
        prospectId: member.prospectId,
        included: member.included,
        excludeReason: member.excludeReason || null,
      },
    });
  }
  return { snapshot, members };
}

/** Snapshot ativo da campanha (ou null). */
async function activeSnapshot(prisma, campaign) {
  const rows = await prisma.studioAudienceSnapshot.findMany({
    where: { campaignId: campaign.id, status: 'active' },
  });
  return rows[0] || null;
}

/**
 * Aprovação (FR-003): revalida exclusões, roda o Compliance Guard e
 * compila as execuções de canal. NÃO dispara — disparo é o schedule.
 */
async function approveCampaign(prisma, { campaign, userId }) {
  assertApprovable(campaign);

  const snapshot = await activeSnapshot(prisma, campaign);
  if (!snapshot || snapshot.includedCount === 0) {
    throw httpErr('EMPTY_AUDIENCE', 409, 'Audiência vazia: nenhum lead elegível após exclusões.');
  }

  // Defense in depth: revalida exclusões no momento da aprovação (opt-out
  // pode ter acontecido depois da declaração).
  const members = await prisma.studioAudienceMember.findMany({
    where: { snapshotId: snapshot.id, included: true },
  });
  let included = 0;
  for (const member of members) {
    const verdict = await compliance.classifyLead(prisma, {
      orgId: campaign.orgId,
      prospectId: member.prospectId,
      channels: campaign.channels || [],
    });
    if (!verdict.included) {
      await prisma.studioAudienceMember.update({
        where: { id: member.id },
        data: { included: false, excludeReason: verdict.excludeReason },
      });
      await prisma.studioAudienceSnapshot.update({
        where: { id: snapshot.id },
        data: {
          includedCount: { decrement: 1 },
          excludedCount: { increment: 1 },
        },
      });
    } else {
      included += 1;
    }
  }
  if (included === 0) {
    throw httpErr('EMPTY_AUDIENCE', 409, 'Audiência vazia após revalidação de exclusões.');
  }

  // Compliance Guard mínimo (US12 aprofunda): block impede aprovação.
  const checks = await compliance.runPreApprovalChecks(prisma, campaign);
  const approval = {
    ...((campaign.approval) || {}),
    complianceLevel: checks.level,
    complianceItems: checks.items,
  };
  if (checks.level === 'block') {
    await prisma.studioCampaign.update({
      where: { id: campaign.id },
      data: { approval },
    });
    const details = checks.items
      .filter((i) => i.level === 'block')
      .map((i) => i.detail)
      .join(' ');
    throw httpErr('COMPLIANCE_BLOCKED', 409, details || 'Parecer de conformidade em nível bloqueio.');
  }

  const contents = await prisma.studioContent.findMany({
    where: { campaignId: campaign.id, kind: 'base', stepIndex: 1 },
  });
  const compiled = await bridge.compile(prisma, {
    campaign,
    contents,
    snapshot: await activeSnapshot(prisma, campaign),
    channels: campaign.channels || [],
  });

  // A/B (US10): experimento em execução recebe a divisão determinística
  // (hash por lead — research D10) no momento do congelamento.
  const experiments = await prisma.studioExperiment.findMany({
    where: { campaignId: campaign.id, status: 'running' },
  });
  const updated = await prisma.studioCampaign.update({
    where: { id: campaign.id },
    data: {
      status: 'approved',
      approvedById: userId,
      approvedAt: new Date(),
      approval,
      // Links reversos das execuções compiladas (fila/controle usam-nos).
      emailExecutionId: compiled.emailExecution?.id || null,
      whatsappExecutionId: compiled.whatsappExecution?.id || null,
    },
  });
  if (experiments.length > 0) {
    const experimentService = require('./experiment-service');
    const freshSnapshot = await activeSnapshot(prisma, campaign);
    const members = await prisma.studioAudienceMember.findMany({
      where: { snapshotId: freshSnapshot.id, included: true },
    });
    for (const experiment of experiments) {
      for (const member of members) {
        const variantLabel = experimentService.assignVariant(
          campaign.id, member.prospectId, experiment.id, experiment.split || {}
        );
        await prisma.studioAudienceMember.update({
          where: { id: member.id },
          data: { variantLabel },
        });
      }
    }
  }
  return { campaign: updated, compiled };
}

/**
 * Disparo imediato (US1): exige `approved`, transita para `running` e
 * delega aos motores (override injetável em testes — sem BullMQ).
 */
async function runImmediateDispatch(prisma, { campaign, userId, overrides = {} }) {
  assertTransition(campaign.status, 'running');
  const snapshot = await activeSnapshot(prisma, campaign);
  if (!snapshot || snapshot.includedCount === 0) {
    throw httpErr('EMPTY_AUDIENCE', 409, 'Audiência vazia.');
  }
  const contents = await prisma.studioContent.findMany({
    where: { campaignId: campaign.id, kind: 'base', stepIndex: 1 },
  });
  const compiled = await bridge.compile(prisma, {
    campaign,
    contents,
    snapshot,
    channels: campaign.channels || [],
  });
  compiled.snapshot = snapshot;

  const members = await prisma.studioAudienceMember.findMany({
    where: { snapshotId: snapshot.id, included: true },
  });
  const prospectIds = members.map((m) => m.prospectId);
  const channels = campaign.channels || [];
  const channel = channels.includes('email') ? 'email' : channels.includes('whatsapp') ? 'whatsapp' : null;

  let dispatchResult;
  if (overrides.dispatchImmediate) {
    dispatchResult = await overrides.dispatchImmediate({
      campaign,
      compiled,
      prospectIds,
      channel,
      userId,
    });
  } else {
    dispatchResult = await dispatchImmediate(prisma, { campaign, compiled, userId });
  }

  const updated = await prisma.studioCampaign.update({
    where: { id: campaign.id },
    data: { status: 'running' },
  });
  return { campaign: updated, dispatch: dispatchResult };
}

/**
 * specs/011 (AD-13): cancelamento/retenção com lote não enviado → estorno do
 * restante EM BLOCO por canal (credit único, refId determinístico — nunca
 * duplo estorno). Falha ao estornar não quebra o cancelamento.
 */
async function refundUnsentOnCancel(prisma, campaign) {
  const reputation = require('./reputation');
  const out = {};
  try {
    if (campaign.emailExecutionId) {
      const pending = await prisma.outreachContact.count({
        where: { campaignId: campaign.emailExecutionId, status: 'QUEUED' },
      });
      if (pending > 0) {
        out.email = await reputation.refundBatch(prisma, {
          orgId: campaign.orgId,
          channel: 'email',
          batchId: `cancel:${campaign.id}:email`,
          units: pending,
          reason: 'lote restante estornado no cancelamento',
        });
      }
    }
    if (campaign.whatsappExecutionId) {
      const waContacts = bridge.waContactModel(prisma);
      const pendingWa = await waContacts.count({
        where: { campaignId: campaign.whatsappExecutionId, status: 'QUEUED' },
      });
      if (pendingWa > 0) {
        out.whatsapp = await reputation.refundBatch(prisma, {
          orgId: campaign.orgId,
          channel: 'whatsapp',
          batchId: `cancel:${campaign.id}:whatsapp`,
          units: pendingWa,
          reason: 'lote restante estornado no cancelamento',
        });
      }
    }
  } catch (err) {
    console.error('[studio:cancel] estorno do lote restante falhou (ignorado):', err.message);
  }
  return out;
}

module.exports.flow = {
  materializeAudience,
  activeSnapshot,
  approveCampaign,
  runImmediateDispatch,
  refundUnsentOnCancel,
};
