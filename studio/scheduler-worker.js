'use strict';

/**
 * studio/scheduler-worker.js — coração do agendamento do Studio (T034).
 *
 * Repeat job BullMQ (60s): varre campanhas `scheduled|running` e libera
 * lotes para os motores DENTRO da janela de envio e do ritmo configurado
 * (FR-017/FR-018), respeitando startAt futuro (FR-016) e o guard-rails da
 * automação opt-in (clarify Q1). Contas de envio: rate limiters globais
 * existentes continuam como última barreira (FR-019, pesquisa D5).
 *
 * specs/011 (AD-5): `tickAll` inclui campanhas `scheduled` com startAt
 * vencido, transitando para `running` VIA GATE (pausa/canal/certificado);
 * toda liberação de lote passa pela primitiva `enqueueBatch` do bridge
 * (AD-14) — pausa global e saldo vigem a montante de todo envio.
 *
 * `tickCampaign` é injetável (enqueue capturado) — a suíte roda sem Redis.
 */

const scheduleService = require('./schedule-service');
const guardrails = require('./guardrails');
const bridge = require('./channel-bridge');
const reputationGate = require('./reputation-gate');
const { autoSelectEmailAccount } = require('./dispatch');
const metrics = require('../metrics');

/**
 * Canal PRIMÁRIO EFETIVO (onda 2026-09-29, AD-2): primeiro canal declarado
 * que está CONECTADO na org. Canais conectados moldam O QUE dispara — uma
 * campanha com e-mail declarado mas só WhatsApp conectado transita para
 * `running` e dispara WhatsApp (o gate vigia o canal avaliado).
 */
async function effectivePrimaryChannel(prisma, campaign) {
  const declared = campaign.channels || [];
  const connected = await bridge.connectedSendChannels(prisma, campaign.orgId);
  if (declared.includes('email') && connected.email) return 'email';
  if (declared.includes('whatsapp') && connected.whatsapp) return 'whatsapp';
  return null;
}

/**
 * Um tick de uma campanha. Retorna `{ released, skipped?, reason? }`.
 * `enqueue(channel, prospectIds, batchId)` é injetado (prod: enfileira nos
 * motores via bridge; testes: captura).
 */
async function tickCampaign(prisma, campaign, { now = new Date(), enqueue, overrides = {} } = {}) {
  const schedule = campaign.schedule || {};

  // 1) Agendamento futuro: nada antes do startAt (FR-016).
  if (schedule.startAt && new Date(schedule.startAt) > now) {
    return { released: 0, skipped: 'not_started' };
  }

  // 2) Guard-rails da automação opt-in: 1º lote exige aprovação (clarify Q1).
  if (await guardrails.hasPendingFirstBatch(prisma, campaign)) {
    return { released: 0, skipped: 'first_batch_pending' };
  }

  // 2.5) specs/011 (AD-5): campanha `scheduled` com startAt vencido transita
  // para `running` VIA GATE — pausa, canal, certificado e saldo decidem.
  // O canal avaliado é o EFETIVO (declarado ∩ conectado — onda 2026-09-29).
  if (campaign.status === 'scheduled') {
    const channel = await effectivePrimaryChannel(prisma, campaign);
    if (!channel) {
      return { released: 0, skipped: 'no_channel' };
    }
    const connected = await bridge.connectedSendChannels(prisma, campaign.orgId);
    const verdict = await reputationGate.evaluate(prisma, {
      orgId: campaign.orgId,
      channel,
      units: 1,
      campaign,
      now,
    });
    if (!verdict.allow) {
      metrics.incGateEvaluation('block', verdict.code || 'GATE');
      // Bloqueios despertam com o tipo PRÓPRIO do motivo (lista fechada FR-31).
      if (verdict.code === reputationGate.BLOCK_CODES.BALANCE || verdict.code === reputationGate.BLOCK_CODES.ORG_PAUSED) {
        const autonomy = require('./autonomy');
        await autonomy.report(prisma, {
          orgId: campaign.orgId,
          type: verdict.code === reputationGate.BLOCK_CODES.ORG_PAUSED ? 'studio.org.paused' : 'studio.schedule.blocked_balance',
          campaignId: campaign.id,
          details: { reason: verdict.reason },
          now,
        }).catch(() => {});
      }
      return { released: 0, skipped: 'gate_blocked', reason: verdict.reason, code: verdict.code };
    }
    // T-UNLOCK (D5): gate passou e falta execução de um canal DECLARADO E
    // CONECTADO (aprovou/agendou sem canal, OU o 2º canal foi conectado
    // depois do voo) → compile NA HORA antes de liberar — `ensure*Execution`
    // é idempotente por execução existente. Sem isso o tick liberaria de
    // execuções nulas para sempre ("Em voo" com fila vazia — known-bad G1).
    // Canal declarado mas NÃO conectado não precisa de compile (o compile o
    // pularia; o tick abaixo o compila quando for conectado). statusReason
    // só é limpo com canal de fato (o gate acima já exigiu o canal efetivo).
    const declaredSendable = (campaign.channels || []).filter((c) => c === 'email' || c === 'whatsapp');
    const missingExecution = declaredSendable.some((c) => {
      if (c === 'email') return connected.email && !campaign.emailExecutionId;
      return connected.whatsapp && !campaign.whatsappExecutionId;
    });
    if (missingExecution) {
      const snapshot = (
        await prisma.studioAudienceSnapshot.findMany({
          where: { campaignId: campaign.id, status: 'active' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        })
      )[0];
      // Sem snapshot não há o que matricular: nada transita (nunca "Em voo"
      // com execuções nulas).
      if (!snapshot) {
        return { released: 0, skipped: 'no_snapshot' };
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
      campaign.emailExecutionId = compiled.emailExecution?.id || campaign.emailExecutionId || null;
      campaign.whatsappExecutionId = compiled.whatsappExecution?.id || campaign.whatsappExecutionId || null;
      await prisma.studioCampaign.update({
        where: { id: campaign.id },
        data: {
          emailExecutionId: campaign.emailExecutionId,
          whatsappExecutionId: campaign.whatsappExecutionId,
          ...(campaign.statusReason === 'NO_CHANNEL_CONNECTED' ? { statusReason: null } : {}),
        },
      });
    }
    await prisma.studioCampaign.update({
      where: { id: campaign.id },
      data: { status: 'running', ...(campaign.statusReason === 'NO_CHANNEL_CONNECTED' ? { statusReason: null } : {}) },
    });
    campaign.status = 'running';
    metrics.incStudioSchedulerTick('scheduled_running');
  }

  // 3) Janela de envio (fuso da org ou do lead — FR-017/FR-022).
  if (!scheduleService.inWindow(schedule, now)) {
    return { released: 0, skipped: 'outside_window' };
  }

  // 4) Ritmo: cotas por hora/dia (FR-018). Contagens a partir dos envios
  // reais registrados nas execuções de canal.
  const hourStart = new Date(Math.floor(now.getTime() / 3600_000) * 3600_000);
  void hourStart;
  const dayStart = scheduleService.startOfDayInTz(now, schedule.timezone || scheduleService.DEFAULT_TZ);
  let quota = schedule.hourlyLimit != null ? schedule.hourlyLimit : null;
  if (schedule.dailyLimit != null && campaign.emailExecutionId) {
    const sentToday = await prisma.outreachContact.count({
      where: { campaignId: campaign.emailExecutionId, sentAt: { gte: dayStart } },
    });
    quota = quota == null ? schedule.dailyLimit - sentToday : Math.min(quota, schedule.dailyLimit - sentToday);
  }
  if (quota != null && quota <= 0) {
    return { released: 0, skipped: 'daily_or_hourly_quota' };
  }

  let released = 0;

  // Política de fadiga (FR-063): leads com N toques na janela saem do lote.
  async function applyFatigueFilter(candidates) {
    const policy = (campaign.fallbackPolicy || {}).fatigue;
    if (!policy?.maxTouches || !policy?.windowDays) return candidates;
    const windowStart = new Date(now.getTime() - policy.windowDays * 86_400_000);
    const recent = await prisma.outreachContact.findMany({
      where: { prospectId: { in: candidates.map((c) => c.prospectId) }, sentAt: { gte: windowStart } },
    });
    const counts = new Map();
    for (const row of recent) {
      counts.set(row.prospectId, (counts.get(row.prospectId) || 0) + 1);
    }
    return candidates.filter((c) => {
      const touches = counts.get(c.prospectId) || 0;
      if (touches >= policy.maxTouches) return false; // adiado para próximo tick
      return true;
    });
  }

  // Libera um lote pela primitiva única do bridge (gate + fila — AD-14).
  const release = (channel, candidates) =>
    bridge.enqueueBatch(prisma, {
      campaign,
      channel,
      prospectIds: candidates.map((c) => c.prospectId),
      now,
      enqueue,
    });

  // 5) E-mail: libera lote da fila (QUEUED e ainda não liberado).
  if (campaign.emailExecutionId) {
    const pendingRaw = await prisma.outreachContact.findMany({
      where: { campaignId: campaign.emailExecutionId, status: 'QUEUED', scheduledAt: null },
    });
    const pending = await applyFatigueFilter(pendingRaw);
    const batch = quota == null ? pending.slice(0, 50) : pending.slice(0, quota);
    if (batch.length > 0) {
      const result = await release('email', batch);
      released += result.enqueued.length;
      if (quota != null) quota -= result.enqueued.length;
    }
  }

  // 6) WhatsApp: mesma lógica, marcador `nextSendAt`. (fake-prisma expõe
  // `whatsappCampaignContact`; o client real Prisma, `whatsAppCampaignContact`.)
  const waContacts = bridge.waContactModel(prisma);
  if (campaign.whatsappExecutionId && (quota == null || quota > 0)) {
    const pending = await waContacts.findMany({
      where: { campaignId: campaign.whatsappExecutionId, status: 'QUEUED', nextSendAt: null },
    });
    const batch = quota == null ? pending.slice(0, 50) : pending.slice(0, quota);
    if (batch.length > 0) {
      const result = await release('whatsapp', batch);
      released += result.enqueued.length;
    }
  }

  // 7) Guard-rails pós-lote: anomalia pausa com motivo (clarify Q1).
  const verdict = await guardrails.evaluateAnomaly(prisma, campaign);
  if (verdict.paused) {
    metrics.incStudioGuardrailPause('anomaly');
    return { released, anomalyPaused: true, reason: verdict.reason };
  }

  return { released, skipped: released === 0 ? 'empty_queue' : undefined };
}

/**
 * Liberação real (produção): enfileira nos motores existentes com a conta
 * auto-selecionada da org (padrão v1 — ver studio/dispatch.js).
 */
function makeProdEnqueue(prisma, campaign, userId) {
  return async function enqueue(channel, prospectIds, batchId) {
    void batchId;
    if (channel === 'email' && campaign.emailExecutionId) {
      const account = await autoSelectEmailAccount(prisma, campaign.orgId);
      const workers = require('../outreach-workers');
      await workers.startOutreachCampaign(prisma, campaign.emailExecutionId, prospectIds, account.id, userId);
      return;
    }
    if (channel === 'whatsapp' && campaign.whatsappExecutionId) {
      const workers = require('../whatsapp-workers');
      await workers.startCampaign(prisma, {
        campaignId: campaign.whatsappExecutionId,
        prospectIds,
        orgId: campaign.orgId,
      });
    }
  };
}

/**
 * Tick global: varre campanhas elegíveis (usado pelo repeat job de 60s).
 * specs/011 (AD-5): inclui `scheduled` (transição gated no tickCampaign).
 * `overrides.enqueueFactory(campaign)` injeta a liberação (testes).
 */
async function tickAll(prisma, { now = new Date(), userId, overrides = {} } = {}) {
  const campaigns = await prisma.studioCampaign.findMany({
    where: { status: { in: ['running', 'scheduled'] } },
  });
  const results = [];
  for (const campaign of campaigns) {
    try {
      const enqueue = overrides.enqueueFactory
        ? overrides.enqueueFactory(campaign)
        : makeProdEnqueue(prisma, campaign, userId);
      const result = await tickCampaign(prisma, campaign, { now, enqueue });
      results.push({ campaignId: campaign.id, ...result });
    } catch (err) {
      console.error('[studio:scheduler] falha no tick da campanha', campaign.id, err.message);
      results.push({ campaignId: campaign.id, error: err.message });
    }
  }
  return results;
}

/**
 * Registro do repeat job de 60s (produção). Sem Redis/BullMQ nos testes —
 * a suíte chama `tickCampaign`/`tickAll` diretamente.
 */
function registerStudioScheduler(prisma) {
  try {
    const { createQueue } = require('../outreach-queues');
    const queue = createQueue('studio:scheduler');
    const Worker = require('bull').Worker || null; // Bull v4: process no queue
    void Worker;
    queue
      .add('tick', {}, { repeat: { every: 60_000 }, jobId: 'studio-scheduler-tick' })
      .then(() => console.log('[studio:scheduler] ✓ repeat job registrado (60s)'))
      .catch((err) => console.error('[studio:scheduler] falha ao registrar repeat job', err.message));

    queue.process(async () => {
      const result = await tickAll(prisma, { userId: null });
      const released = result.reduce((sum, r) => sum + (r.released || 0), 0);
      if (released > 0) console.log(`[studio:scheduler] ${released} lead(s) liberado(s)`);
      return result;
    });
    return queue;
  } catch (err) {
    console.error('[studio:scheduler] registro indisponível:', err.message);
    return null;
  }
}

module.exports = { tickCampaign, tickAll, registerStudioScheduler, makeProdEnqueue };
