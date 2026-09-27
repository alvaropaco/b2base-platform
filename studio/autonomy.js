'use strict';

/**
 * studio/autonomy.js — Contrato de Autonomia em módulo único (specs/011,
 * AD-10; FR-31…FR-34 do PRD).
 *
 * Tabela FECHADA evento → wake|silent + prioridade. Nada fora da tabela
 * desperta (decisão silenciosa e registrada). Despertares passam pelo
 * orçamento diário por org (teto 5/dia) — excedente é agregado em resumo
 * único. A taxa por org/dia é a métrica de saúde do contrato (FR-34).
 */

const DAILY_WAKE_BUDGET = Number(process.env.STUDIO_WAKE_DAILY_BUDGET || 5);

// Lista fechada de Despertares obrigatórios (FR-31). Ordem = prioridade.
const WAKE_RULES = {
  'studio.campaign.first_batch': { wake: true, priority: 1, label: 'Primeiro lote aguardando sua aprovação' },
  'studio.anomaly.detected': { wake: true, priority: 1, label: 'Anomalia de entrega detectada — campanha pausada' },
  'studio.whatsapp.rejected': { wake: true, priority: 1, label: 'Rejeição/bloqueio no WhatsApp — saldo reduzido' },
  'studio.content.error': { wake: true, priority: 2, label: 'Erro em conteúdo agendado' },
  'studio.schedule.blocked_balance': { wake: true, priority: 2, label: 'Agendamento bloqueado por saldo' },
  'studio.domain.auth_failed': { wake: true, priority: 2, label: 'Autenticação do domínio falhou — saldo suspenso' },
  'studio.consent.missing': { wake: true, priority: 3, label: 'Leads sem consentimento WhatsApp foram bloqueados' },
  'studio.org.paused': { wake: true, priority: 3, label: 'Envios pausados nesta organização — agendamentos retidos' },
};

function startOfDay(now = new Date()) {
  const d = new Date(now.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Consulta a regra — pura. Fora da tabela: silencioso (FR-31). */
function decide(type) {
  const rule = WAKE_RULES[type];
  if (!rule || !rule.wake) {
    return { wake: false, result: 'silent', reason: rule ? 'regra silenciosa' : 'fora da lista fechada' };
  }
  return { wake: true, priority: rule.priority, label: rule.label };
}

/** Despertares da org hoje (para orçamento FR-33 e saúde FR-34). */
async function wakesToday(prisma, orgId, now = new Date()) {
  return prisma.opsNotification.count({
    where: { orgId, kind: 'wake', createdAt: { gte: startOfDay(now) } },
  });
}

/**
 * Registra um evento no contrato. Retorna a decisão:
 *   { wake: true }  → Despertar criado (respeitando orçamento diário)
 *   { wake: false, result: 'silent' }     → fora da lista fechada
 *   { wake: false, result: 'aggregated' } → dentro do teto, virou resumo
 * Notificação nunca quebra o fluxo principal (padrão studio/notify.js).
 */
async function report(prisma, { orgId, type, campaignId = null, details = {}, now = new Date() } = {}) {
  const decision = decide(type);
  try {
    if (!decision.wake) {
      const metrics = require('../metrics');
      metrics.incAutonomyWake(type, 'silent');
      console.log(`[studio:autonomy] silencioso: ${type} (${decision.reason}) — org ${orgId}`);
      return { ...decision, result: 'silent' };
    }

    const used = await wakesToday(prisma, orgId, now);
    if (used >= DAILY_WAKE_BUDGET) {
      // Excedente agrega em resumo único do dia (dedupe por org+dia — FR-33).
      const day = startOfDay(now).toISOString().slice(0, 10);
      const dedupKey = `studio:wake-digest:${orgId}:${day}`;
      const existing = await prisma.opsNotification.findFirst({ where: { dedupKey } });
      if (existing) {
        const payload = { ...(existing.payload || {}) };
        payload.aggregated = (Number(payload.aggregated) || 0) + 1;
        payload.lastType = type;
        await prisma.opsNotification.update({ where: { dedupKey }, data: { payload } });
      } else {
        await prisma.opsNotification.create({
          data: {
            dedupKey,
            kind: 'digest',
            severity: 'info',
            orgId,
            title: 'Resumo do dia: eventos além do seu orçamento de notificações',
            payload: { aggregated: 1, lastType: type, campaignId },
            channels: ['in_app'],
          },
        });
      }
      const metrics = require('../metrics');
      metrics.incAutonomyWake(type, 'aggregated');
      return { wake: false, result: 'aggregated', budget: DAILY_WAKE_BUDGET, used };
    }

    // dedupKey DETERMINÍSTICA (type + campaign + janela do dia): retry do
    // worker não duplica o mesmo Despertar no mesmo dia.
    const dedupKey = `studio:wake:${type}:${campaignId || 'none'}:${startOfDay(now).toISOString().slice(0, 10)}`;
    try {
      await prisma.opsNotification.create({
        data: {
          dedupKey,
          kind: 'wake',
          severity: decision.priority === 1 ? 'critical' : 'warning',
          orgId,
          title: decision.label,
          payload: { type, campaignId, priority: decision.priority, ...details },
          channels: ['in_app'],
          createdAt: now, // hora do evento (Prisma aceita explicitar o default)
        },
      });
    } catch (err) {
      if (err && err.code === 'P2002') {
        const metrics = require('../metrics');
        metrics.incAutonomyWake(type, 'deduped');
        return { wake: false, result: 'deduped', reason: 'mesmo despertar já enviado hoje' };
      }
      throw err;
    }
    const metrics = require('../metrics');
    metrics.incAutonomyWake(type, 'wake');
    return { wake: true, result: 'wake', priority: decision.priority, label: decision.label, budgetUsed: used + 1 };
  } catch (err) {
    console.error('[studio:autonomy] falha ao registrar evento (ignorado):', err.message);
    return { ...decision, result: decision.wake ? 'wake_failed' : 'silent' };
  }
}

/** Despertares PENDENTES da org (painel "Despertares" do Cockpit) — já
 *  reconhecidos (payload.acknowledgedAt) não voltam à lista. */
async function pendingWakes(prisma, orgId, { limit = 20 } = {}) {
  const rows = await prisma.opsNotification.findMany({
    where: { orgId, kind: { in: ['wake', 'digest'] } },
  });
  const pending = rows.filter((row) => !(row.payload && row.payload.acknowledgedAt));
  pending.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return pending.slice(0, limit);
}

module.exports = { WAKE_RULES, DAILY_WAKE_BUDGET, decide, report, pendingWakes, wakesToday };
