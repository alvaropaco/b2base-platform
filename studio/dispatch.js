'use strict';

/**
 * studio/dispatch.js — disparo imediato de uma campanha Studio aprovada.
 *
 * specs/011 (AD-4/AD-14): o dispatch imediato passa pela primitiva única
 * `enqueueBatch` do bridge — o gate de reputação concede a fatia do lote que
 * o saldo cobre (fatiamento; FR-15) e a pausa global bloqueia (FR-19). Em
 * testes o router injeta `overrides.dispatchImmediate` — BullMQ não roda na
 * suíte. Contas de envio: auto-seleciona a primeira conta conectada da org
 * (padrão v1 para orgs single-account); o id usado fica auditado em
 * `campaign.approval.executionConfig`.
 */

const bridge = require('./channel-bridge');

async function autoSelectEmailAccount(prisma, orgId) {
  const account = await prisma.emailAccount.findFirst({
    where: { tenantId: orgId, status: 'connected' },
  });
  if (!account) {
    const err = new Error('Nenhuma conta de e-mail conectada na organização.');
    err.code = 'NO_EMAIL_ACCOUNT';
    err.status = 409;
    throw err;
  }
  return account;
}

async function autoSelectWhatsAppAccount(prisma, orgId) {
  const account = await prisma.whatsAppAccount.findFirst({
    where: { orgId, status: 'CONNECTED' },
  });
  if (!account) {
    const err = new Error('Nenhuma conta WhatsApp conectada na organização.');
    err.code = 'NO_WHATSAPP_ACCOUNT';
    err.status = 409;
    throw err;
  }
  return account;
}

/**
 * Dispara a campanha aprovada para os leads incluídos do snapshot, canal a
 * canal, SEMPRE via `enqueueBatch` (gate + fila). Cada canal reporta o que
 * entrou em voo e o que ficou bloqueado (saldo/pausa/certificado).
 * `overrides.startOutreachCampaign` / `overrides.startWhatsAppCampaign`
 * substituem os motores em teste.
 */
async function dispatchImmediate(prisma, { campaign, compiled, userId, overrides = {}, now = new Date() }) {
  const channels = campaign.channels || [];
  const snapshot = compiled.snapshot;
  const members = await prisma.studioAudienceMember.findMany({
    where: { snapshotId: snapshot.id, included: true },
  });
  const prospectIds = members.map((m) => m.prospectId);
  const result = { prospectIds, email: null, whatsapp: null, executionConfig: {}, blocked: {} };

  const prodEnqueue = (channel) => async (ch, ids) => {
    if (ch === 'email' && compiled.emailExecution) {
      const account = await autoSelectEmailAccount(prisma, campaign.orgId);
      const workers = require('../outreach-workers');
      await workers.startOutreachCampaign(prisma, compiled.emailExecution.id, ids, account.id, userId);
      return;
    }
    if (ch === 'whatsapp' && compiled.whatsappExecution) {
      const workers = require('../whatsapp-workers');
      await workers.startCampaign(prisma, {
        campaignId: compiled.whatsappExecution.id,
        prospectIds: ids,
        orgId: campaign.orgId,
      });
    }
    void channel;
  };

  if (channels.includes('email') && compiled.emailExecution) {
    const account = await autoSelectEmailAccount(prisma, campaign.orgId);
    result.executionConfig.emailAccountId = account.id;
    const start = overrides.startOutreachCampaign;
    const enqueue = start
      ? async (ch, ids) => {
          // Injetado (testes): assinatura igual ao motor real.
          await start(prisma, compiled.emailExecution.id, ids, account.id, userId);
        }
      : prodEnqueue('email');
    result.email = await bridge.enqueueBatch(prisma, {
      campaign,
      channel: 'email',
      prospectIds,
      now,
      enqueue,
    });
    if (result.email.blocked) result.blocked.email = result.email.blocked;
  }

  if (channels.includes('whatsapp') && compiled.whatsappExecution) {
    const account = await autoSelectWhatsAppAccount(prisma, campaign.orgId);
    result.executionConfig.whatsappAccountId = account.id;
    await prisma.whatsappCampaign.update({
      where: { id: compiled.whatsappExecution.id },
      data: { whatsappAccountId: account.id },
    });
    const start = overrides.startWhatsAppCampaign;
    const enqueue = start
      ? async (ch, ids) => {
          await start(prisma, {
            campaignId: compiled.whatsappExecution.id,
            prospectIds: ids,
            orgId: campaign.orgId,
          });
        }
      : prodEnqueue('whatsapp');
    result.whatsapp = await bridge.enqueueBatch(prisma, {
      campaign,
      channel: 'whatsapp',
      prospectIds,
      now,
      enqueue,
    });
    if (result.whatsapp.blocked) result.blocked.whatsapp = result.whatsapp.blocked;
  }

  return result;
}

module.exports = { dispatchImmediate, autoSelectEmailAccount, autoSelectWhatsAppAccount };
