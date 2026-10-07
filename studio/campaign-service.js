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

/**
 * Estados em que o CONTEÚDO (só conteúdo) pode ser editado (B1/E1 — onda
 * 2026-09-29): `approved` e `scheduled` entram na 1.5 (o Pré-voo é
 * pós-aprove) e `running` na 3.3 (edição em voo do que ainda não saiu).
 * Metadados da campanha continuam nos EDITABLE_STATES de sempre (FR-006).
 */
const CONTENT_EDITABLE_STATES = ['draft', 'in_review', 'paused', 'approved', 'scheduled', 'running'];

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
  CONTENT_EDITABLE_STATES,
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

/** JSON estável (chaves ordenadas em todos os níveis) para diff de conteúdo. */
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().map((k) => `${k}:${canonicalJson(value[k])}`).join('|');
  }
  return JSON.stringify(value) ?? 'null';
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
  // Epic 3 (Story 3.2/D4): toda mudança de seleção passa por aqui — a fila
  // de execução sincroniza na mesma request (ninguém removido recebe).
  let queueSync = null;
  try {
    queueSync = await syncQueueWithAudience(
      prisma,
      campaign,
      members.filter((m) => m.included).map((m) => m.prospectId)
    );
  } catch (err) {
    console.error('[studio:sync] sincronização da fila falhou (materialização preservada):', err.stack || String(err));
  }
  return { snapshot, members, queueSync };
}

/**
 * Epic 3 (Story 3.2/D4): sincroniza a fila de execução com a seleção atual —
 * contatos matriculados que SAÍRAM da seleção são cancelados antes de enviar.
 *
 * Ledger íntegro (o débito acontece na LIBERAÇÃO do lote — channel-bridge
 * `enqueueBatch`): estorno unitário só para contato LIBERADO e SEM mensagem
 * própria; quando já há mensagem, o worker estorna por messageId ao ver o
 * contato CANCELLED (refId diferente — a unique (type, refId) do ledger
 * impede duplo estorno por caminho). Contato não liberado nunca foi debitado.
 * Falha de estorno é logada, não quebra a sincronização.
 */
async function syncQueueWithAudience(prisma, campaign, includedProspectIds) {
  const included = new Set(includedProspectIds || []);
  const reputation = require('./reputation');
  const UNSENT = ['SELECTED', 'QUEUED', 'GENERATING', 'SCHEDULED'];
  const contactModel = (prismaClient, channel) =>
    channel === 'email' ? prismaClient.outreachContact : bridge.waContactModel(prismaClient);
  const messageModel = (prismaClient, channel) =>
    channel === 'email' ? prismaClient.outreachMessage : prismaClient.whatsAppMessage;
  const out = {};
  const syncChannel = async ({ channel, contacts, releasedField, cancelUpdate, messageFilter }) => {
    const removed = contacts.filter((c) => !included.has(c.prospectId));
    if (removed.length === 0) return { cancelled: 0, refunded: 0 };
    let refunded = 0;
    for (const contact of removed) {
      // Review E3-H1: entre o findMany e a escrita o contato pode ter caído em
      // SENDING/SENT — quem mudou de estado NÃO é mexido nem estornado (o
      // motor cuida do que estava em voo; sync não reescreve história).
      const cancelled = await contactModel(prisma, channel).updateMany({
        where: { id: contact.id, status: { in: UNSENT } },
        data: cancelUpdate,
      });
      if (!cancelled.count) continue;
      const released = Boolean(contact[releasedField]);
      const hasOwnRefundPath = messageFilter
        ? Boolean(await messageModel(prisma, channel).findFirst({ where: messageFilter(contact), select: { id: true } }))
        : false;
      if (released && !hasOwnRefundPath) {
        try {
          await reputation.refundBatch(prisma, {
            orgId: campaign.orgId,
            channel,
            batchId: `sync:${campaign.id}:${channel}:${contact.id}`,
            units: 1,
            reason: 'contato saiu da seleção — sincronização da fila',
          });
          refunded += 1;
        } catch (err) {
          console.error(`[studio:sync] estorno do contato ${contact.id} falhou (fila segue sincronizada):`, err.stack || String(err));
        }
      }
    }
    return { cancelled: removed.length, refunded };
  };
  if (campaign.emailExecutionId) {
    out.email = await syncChannel({
      channel: 'email',
      contacts: await prisma.outreachContact.findMany({
        where: { campaignId: campaign.emailExecutionId, status: { in: UNSENT } },
      }),
      releasedField: 'scheduledAt',
      cancelUpdate: { status: 'CANCELLED', cancelReason: 'removido_da_selecao' },
      messageFilter: (contact) => ({ contactId: contact.id }),
    });
  }
  if (campaign.whatsappExecutionId) {
    out.whatsapp = await syncChannel({
      channel: 'whatsapp',
      contacts: await bridge.waContactModel(prisma).findMany({
        where: { campaignId: campaign.whatsappExecutionId, status: { in: UNSENT } },
      }),
      releasedField: 'nextSendAt',
      cancelUpdate: { status: 'CANCELLED', cancelReason: 'removido_da_selecao' },
      messageFilter: (contact) => ({ campaignContactId: contact.id }),
    });
  }
  return out;
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

  // Canais declarados SEM conteúdo base saem da campanha (QA 2026-10-07:
  // 'só por WhatsApp' com email declarado sem peça bloqueava a aprovação
  // INTEIRA — canal sem conteúdo é sobra, não bloqueio; quem não gerou
  // peça para um canal simplesmente não dispara por ele). Se sobrar NENHUM
  // canal com peça, a checagem de conteúdo abaixo bloqueia como antes.
  const baseContents = await prisma.studioContent.findMany({
    where: { campaignId: campaign.id, kind: 'base', stepIndex: 1 },
  });
  const withContent = new Set(baseContents.map((c) => c.channel));
  const channelsBefore = campaign.channels || [];
  const channelsAfter = channelsBefore.filter((ch) => ch === 'linkedin_text' || withContent.has(ch));
  let droppedChannels = [];
  if (channelsAfter.length < channelsBefore.length) {
    droppedChannels = channelsBefore.filter((ch) => !channelsAfter.includes(ch));
    if (channelsAfter.length > 0) {
      await prisma.studioCampaign.update({
        where: { id: campaign.id },
        data: { channels: channelsAfter },
      });
      campaign.channels = channelsAfter;
    }
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

  // Onda "criação sem bloqueios" (FR4/Story 1.5): aprovar NUNCA depende de
  // canal conectado. Campanha com canal de envio declarado (email/whatsapp)
  // e NENHUM canal conectado fica aprovada e visível como "pendente de
  // envio" (statusReason dedicado) — conectar o canal destrava o disparo na
  // mesma tela, sem refazer a criação. Com canal conectado, o motivo antigo
  // é limpo (re-aprovação conserta o estado).
  const sendable = (campaign.channels || []).filter((c) => c === 'email' || c === 'whatsapp');
  const effective = compiled.channels ? compiled.channels.effective : sendable;
  const statusReason = sendable.length > 0 && effective.length === 0 ? 'NO_CHANNEL_CONNECTED' : null;

  // A/B (US10): experimento em execução recebe a divisão determinística
  // (hash por lead — research D10) no momento do congelamento.
  const experiments = await prisma.studioExperiment.findMany({
    where: { campaignId: campaign.id, status: 'running' },
  });
  const updated = await prisma.studioCampaign.update({
    where: { id: campaign.id },
    data: {
      status: 'approved',
      statusReason,
      approvedById: userId,
      approvedAt: new Date(),
      approval,
      // Links reversos das execuções compiladas (fila/controle usam-nos).
      emailExecutionId: compiled.emailExecution?.id || null,
      whatsappExecutionId: compiled.whatsappExecution?.id || null,
    },
  });
  updated.droppedChannels = droppedChannels;
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
 *
 * T-UNLOCK (D5, onda "criação sem bloqueios"): com o gate a favor (canal
 * efetivo existe) e execuções nulas (aprovou sem canal), o compile roda NA
 * HORA — conectar o canal depois basta, sem refazer a criação. Os ids das
 * execuções compiladas são PERSISTIDOS: sem isso o scheduler liberaria de
 * execuções nulas para sempre ("Em voo" com fila vazia — known-bad G1).
 * Sem nenhum canal de fato: 409 explicável (NO_CHANNEL_CONNECTED) e a
 * campanha segue "pendente de envio" (statusReason preservado).
 */
async function runImmediateDispatch(prisma, { campaign, userId, overrides = {}, allowRunning = false, limit = null }) {
  // allowRunning (QA 2026-10-06): re-disparo em campanha já em voo é o
  // DELTA — recompila (matricula leads recém-consentidos/canal novo) e
  // reenfileira só quem ainda não foi alocado (filtro do enqueueBatch).
  if (!(allowRunning && campaign.status === 'running')) {
    assertTransition(campaign.status, 'running');
  }
  const snapshot = await activeSnapshot(prisma, campaign);
  if (!snapshot || snapshot.includedCount === 0) {
    throw httpErr('EMPTY_AUDIENCE', 409, 'Audiência vazia.');
  }
  const sendable = (campaign.channels || []).filter((c) => c === 'email' || c === 'whatsapp');
  const connected = await bridge.connectedSendChannels(prisma, campaign.orgId);
  // Sem canal DECLARÁVEL (channels vazio ou só linkedin_text) também é
  // "sem canal de fato": entrar em running criaria fila vazia para sempre.
  if (sendable.length === 0 || !sendable.some((c) => connected[c])) {
    throw httpErr(
      'NO_CHANNEL_CONNECTED',
      409,
      'A campanha está pronta — conecte um canal de envio (e-mail ou WhatsApp) para colocá-la em voo.'
    );
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
  // Links das execuções no objeto EM MEMÓRIA ANTES do dispatch: o
  // enqueueBatch lê campaign.emailExecutionId/whatsappExecutionId — no
  // T-UNLOCK (aprovou sem canal, conectou depois) os links estavam null e o
  // primeiro disparo saía CANAL_NAO_CONFIGURADO mesmo com execução
  // recém-compilada (QA 2026-10-06). O update final persiste os mesmos ids.
  if (compiled.emailExecution?.id) campaign.emailExecutionId = compiled.emailExecution.id;
  if (compiled.whatsappExecution?.id) campaign.whatsappExecutionId = compiled.whatsappExecution.id;

  const members = await prisma.studioAudienceMember.findMany({
    where: { snapshotId: snapshot.id, included: true },
  });
  let prospectIds = members.map((m) => m.prospectId);
  const audienceTotal = prospectIds.length;
  // Disparo PARCIAL (QA 2026-10-07: 'vamos mandar primeiro para 15 leads') —
  // corta na ordem da fila; o restante fica QUEUED para o próximo disparo.
  if (limit != null) {
    const n = Math.max(1, Math.min(audienceTotal, Math.round(Number(limit)) || audienceTotal));
    prospectIds = prospectIds.slice(0, n);
  }
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
    data: {
      status: 'running',
      statusReason: null, // saiu de "pendente de envio" — só com canal de fato (D5)
      // Links reversos das execuções (re)compiladas — destrava o tick (D5).
      emailExecutionId: compiled.emailExecution?.id || campaign.emailExecutionId || null,
      whatsappExecutionId: compiled.whatsappExecution?.id || campaign.whatsappExecutionId || null,
    },
  });
  // Diagnóstico para o card do disparo (QA 2026-10-06: "disparo feito" com a
  // fila vazia e NENHUMA explicação — leads fora do WhatsApp por consentimento
  // e canais pulados ficavam invisíveis).
  return {
    campaign: updated,
    dispatch: dispatchResult,
    audienceTotal,
    dispatched: prospectIds.length,
    compiled: {
      enrollment: compiled.enrollment,
      channels: compiled.channels,
    },
  };
}

/**
 * Story 3.3 (FR8)/D9 — serviço ÚNICO de edição de conteúdo, usado pelo PATCH
 * da UI e pela action aditiva `edit_content` do chat (AD-6). Editável em
 * CONTENT_EDITABLE_STATES (B1: `approved`/`scheduled`/`running` incluídos);
 * mensagens já enviadas são imutáveis (sync só toca steps sem envio —
 * `bridge.syncPendingTemplates`); `approval.contentEdits` registrado em voo
 * SOMENTE com mudança real (E8), com "a partir de quando vale" (UX-DR4).
 * Escopo de org: o conteúdo precisa pertencer à campanha da org (NFR2).
 */
async function updateContents(prisma, { campaign, contents, userId }) {
  if (!CONTENT_EDITABLE_STATES.includes(campaign.status)) {
    const err = new Error(
      'Conteúdo em voo já despachado não muda: pause a campanha para alterar o que ainda não saiu.'
    );
    err.code = 'CAMPAIGN_LOCKED';
    err.status = 409;
    throw err;
  }
  if (!Array.isArray(contents) || contents.length === 0) {
    throw httpErr('INVALID_CONTENTS', 400, 'Informe ao menos um conteúdo com id.');
  }
  const { validatePlaceholders } = require('./variables');
  const updated = [];
  let changed = 0;
  for (const input of contents) {
    if (!input || !input.id) {
      throw httpErr('INVALID_CONTENTS', 400, 'Cada conteúdo precisa de `id`.');
    }
    // Textos validados contra o catálogo (FR-033) — inclui o emailDoc (I/O:
    // "validação de placeholders" para PATCH de emailDoc).
    const texts = [
      input.subject,
      input.preheader,
      input.whatsappText,
      input.linkedinText,
      input.emailDoc != null ? JSON.stringify(input.emailDoc) : null,
    ];
    for (const text of texts) {
      const { ok, unknown } = validatePlaceholders(text || '');
      if (!ok) {
        throw httpErr('UNKNOWN_VARIABLE', 400, `Variáveis fora do catálogo: ${unknown.join(', ')}`);
      }
    }
    const row = await prisma.studioContent.findUnique({ where: { id: input.id } });
    if (!row || row.orgId !== campaign.orgId || row.campaignId !== campaign.id) {
      throw httpErr('NOT_FOUND', 404, 'Conteúdo não encontrado nesta campanha.');
    }
    const FIELDS = ['subject', 'preheader', 'whatsappText', 'linkedinText', 'ctaUrl', 'emailDoc'];
    const patch = {};
    for (const field of FIELDS) {
      if (input[field] == null) continue; // ausente OU null nunca apaga o campo
      if (canonicalJson(input[field]) === canonicalJson(row[field])) continue;
      patch[field] = input[field];
    }
    if (Object.keys(patch).length === 0) {
      updated.push(row); // sem mudança real: nada a persistir (E8)
      continue;
    }
    changed += 1;
    const saved = await prisma.studioContent.update({
      where: { id: row.id },
      data: {
        ...patch,
        editHistory: [
          ...(Array.isArray(row.editHistory) ? row.editHistory : []),
          { by: userId, at: new Date().toISOString(), summary: 'edição de conteúdo' },
        ],
      },
    });
    updated.push(saved);
  }

  // Em voo (aprovada/agendada/rodando): propaga aos templates do que ainda
  // não saiu — sem débito novo, enviados imutáveis (AD-13).
  let sync = null;
  if (campaign.emailExecutionId || campaign.whatsappExecutionId) {
    sync = await bridge.syncPendingTemplates(prisma, campaign);
  }

  // Monitor registra que houve edição e a partir de quando vale (B8) — só em
  // voo e só quando algo mudou de fato (nunca edição falsa, E8).
  let contentEditRecorded = false;
  if (changed > 0 && ['scheduled', 'running'].includes(campaign.status)) {
    const approval = {
      ...(campaign.approval || {}),
      contentEdits: [
        ...((campaign.approval && Array.isArray(campaign.approval.contentEdits)) ? campaign.approval.contentEdits : []),
        { at: new Date().toISOString(), by: userId, count: changed, appliesFrom: new Date().toISOString() },
      ],
    };
    await prisma.studioCampaign.update({ where: { id: campaign.id }, data: { approval } });
    campaign.approval = approval;
    contentEditRecorded = true;
  }
  return { contents: updated, sync, contentEditRecorded };
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
  updateContents,
  refundUnsentOnCancel,
  syncQueueWithAudience,
};
