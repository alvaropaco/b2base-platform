'use strict';

/**
 * studio/reputation.js — Orçamento de Reputação: WRITER ÚNICO do saldo
 * (specs/011, AD-3 da spine).
 *
 * Regras inegociáveis:
 *  - `balance` só muta NA MESMA transação que insere o evento correspondente
 *    no ledger append-only (StudioReputationEvent).
 *  - Nenhum outro módulo deriva, ajusta ou re-computa saldo/floor/unidade —
 *    consulta do painel lê a account; auditoria lê o ledger.
 *  - Estorno idempotente por refId (unique (type, refId)) — AD-13.
 *
 * Unidades: 1 unidade = 1 envio. Números de rampa (Deferred na spine) vivem
 * AQUI — nada fora deste módulo os conhece. WhatsApp é conservador (FR-18).
 *
 * `$transaction` do Prisma real é usado quando disponível; no fake-prisma dos
 * testes o módulo degrada para operações sequenciais (mesma semântica).
 */

const crypto = require('crypto');

const CHANNELS = ['email', 'whatsapp'];

// Rampa de warm-up por canal (FR-17/FR-18 — mecanismo; números calibráveis
// por env STUDIO_REP_*). WhatsApp: rampa e teto mais conservadores (FR-18).
// Piso base configurável (STUDIO_REP_FLOOR, default 10) — um piso fixo alto
// drenaria o fatiamento "saldo 30, lote 100 → 30 enfileiradas".
const BASE_FLOOR = Number(process.env.STUDIO_REP_FLOOR || 10);
const CHANNEL_POLICY = {
  email: {
    startBalance: Number(process.env.STUDIO_REP_EMAIL_START || 100),
    floor: Number(process.env.STUDIO_REP_EMAIL_FLOOR || BASE_FLOOR),
    rampStages: [100, 200, 400, 800], // teto por estágio (unidades/dia)
  },
  whatsapp: {
    startBalance: Number(process.env.STUDIO_REP_WA_START || 30),
    floor: Number(process.env.STUDIO_REP_WA_FLOOR || BASE_FLOOR),
    rampStages: [30, 50, 80], // conservador (FR-18)
  },
};

function channelPolicy(channel) {
  const policy = CHANNEL_POLICY[channel];
  if (!policy) {
    const err = new Error(`Canal de reputação não suportado: ${channel}`);
    err.code = 'CANAL_NAO_SUPORTADO';
    err.status = 400;
    throw err;
  }
  return policy;
}

/** Suporta Prisma real ($transaction) e fake-prisma (sequencial nos testes). */
async function withTx(prisma, fn) {
  if (typeof prisma.$transaction === 'function') {
    return prisma.$transaction(async (tx) => fn(tx));
  }
  return fn(prisma);
}

function nextRampStage(account) {
  const stages = channelPolicy(account.channel).rampStages;
  const idx = Math.min(Number(account.rampStage || 0), stages.length - 1);
  return { stage: idx, ceiling: stages[idx] };
}

/**
 * Floor EFETIVO (AD-3/FR-16): e-mail sem SPF+DKIM verificados tem saldo
 * efetivo zero — floor vira o saldo inteiro (nada parte), EXCETO quando a org
 * declarou domínio pré-aquecido ('prewarmed' — FR-17/FR-28, override sob
 * responsabilidade do cliente). WhatsApp segue o floor configurado.
 */
function effectiveFloor(account) {
  const eligible = ['verified', 'prewarmed'].includes(account.domainAuthStatus);
  if (account.channel === 'email' && !eligible) {
    return Math.max(account.balance, account.floor || 0);
  }
  return account.floor || 0;
}

/** Saldo disponível para débito (nunca negativo). */
function effectiveBalance(account) {
  return Math.max(0, account.balance - effectiveFloor(account));
}

/** Quando o próximo aporte de rampa libera (para explicar bloqueios — FR-15). */
function nextReplenishAt(now = new Date()) {
  const d = new Date(now.getTime());
  d.setUTCHours(24, 0, 0, 0); // virada do dia UTC
  return d;
}

/**
 * Hora da próxima reposição em linguagem (pt-BR, horário de Brasília) —
 * usada pelos textos de prontidão ("a reposição diária libera às HH:MM").
 * Retorna STRING VAZIA se o fuso não puder ser formatado — a copy omitirá
 * o horário em vez de inventar "00:00".
 */
function nextReplenishLabel(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    }).format(nextReplenishAt(now));
  } catch (_err) {
    return '';
  }
}

function dayKey(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Garante a account da org+canal com os defaults da rampa (idempotente).
 * Org nova começa com saldo conservador (FR-17).
 */
async function ensureAccount(prisma, orgId, channel) {
  const existing = await prisma.studioReputationAccount.findFirst({
    where: { orgId, channel },
  });
  if (existing) return existing;
  const policy = channelPolicy(channel);
  const { ceiling } = { ceiling: policy.rampStages[0] };
  try {
    return await prisma.studioReputationAccount.create({
      data: {
        orgId,
        channel,
        balance: policy.startBalance,
        floor: policy.floor,
        ceiling,
        rampStage: 0,
        domainAuthStatus: 'unverified',
      },
    });
  } catch (err) {
    if (err && err.code === 'P2002') {
      return prisma.studioReputationAccount.findFirst({ where: { orgId, channel } });
    }
    throw err;
  }
}

async function getAccount(prisma, orgId, channel) {
  return prisma.studioReputationAccount.findFirst({ where: { orgId, channel } });
}

/** Visão do painel de saldo (FR-20): valores efetivos + teto + rampa. */
async function getBalance(prisma, orgId, channel) {
  const account = await getAccount(prisma, orgId, channel);
  if (!account) return null;
  return {
    channel: account.channel,
    balance: account.balance,
    available: effectiveBalance(account),
    floor: effectiveFloor(account),
    ceiling: account.ceiling,
    rampStage: account.rampStage,
    domainAuthStatus: account.domainAuthStatus,
    domainAuthCheckedAt: account.domainAuthCheckedAt,
    updatedAt: account.updatedAt,
  };
}

async function listBalances(prisma, orgId) {
  const out = [];
  for (const channel of CHANNELS) {
    out.push(await getBalance(prisma, orgId, channel));
  }
  return out.filter(Boolean);
}

/** Auditoria do ledger (FR-20/FR-29). */
async function listEvents(prisma, orgId, { channel, limit = 50 } = {}) {
  const where = { orgId, ...(channel ? { channel } : {}) };
  const rows = await prisma.studioReputationEvent.findMany({ where });
  rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return rows.slice(0, limit);
}

/**
 * Insere o evento do ledger com idempotência por (type, refId) — AD-13.
 * Retorna { event, replayed } — replayed=true quando o refId já existia
 * (retry/requeue) e NENHUMA mutação nova aconteceu.
 */
async function insertEvent(prisma, data) {
  if (!data.refId) {
    // Sem refId (ex.: bloqueio avulso) — append puro, sem chave de replay.
    const event = await prisma.studioReputationEvent.create({ data });
    return { event, replayed: false };
  }
  const existing = await prisma.studioReputationEvent.findFirst({
    where: { type: data.type, refId: data.refId },
  });
  if (existing) return { event: existing, replayed: true };
  try {
    const event = await prisma.studioReputationEvent.create({ data });
    return { event, replayed: false };
  } catch (err) {
    if (err && err.code === 'P2002') {
      return { event: await prisma.studioReputationEvent.findFirst({ where: { type: data.type, refId: data.refId } }), replayed: true };
    }
    throw err;
  }
}

/**
 * Débito transacional — a AUTORIDADE DE ALOCAÇÃO (AD-4). `amount` é o
 * pedido; o banco concede a fatia que o saldo efetivo cobre
 * (partial grant: saldo 30 + lote 100 → granted 30, deficit 70). Nunca
 * deixa saldo negativo. Idempotente por refId (o mesmo lote nunca debita 2×).
 */
async function debit(prisma, { orgId, channel, amount, refType = 'batch', refId, reason, metadata = {} }) {
  const requested = Math.max(0, Math.floor(Number(amount) || 0));
  return withTx(prisma, async (tx) => {
    if (requested === 0) {
      const account = await ensureAccount(tx, orgId, channel);
      return { ok: true, granted: 0, balance: account.balance, replayed: false };
    }
    if (refId) {
      const prior = await tx.studioReputationEvent.findFirst({ where: { type: 'debit', refId } });
      if (prior) {
        const account = await tx.studioReputationAccount.findFirst({ where: { orgId, channel } });
        return { ok: true, granted: 0, balance: account ? account.balance : 0, replayed: true, event: prior };
      }
    }
    const account = await ensureAccount(tx, orgId, channel);
    const available = effectiveBalance(account);
    // Concede só a fatia coberta pelo saldo efetivo (floor respeitado).
    const grant = Math.min(requested, available);
    if (grant <= 0) {
      metrics.incGateBlock('SALDO_INSUFICIENTE');
      return {
        ok: false,
        granted: 0,
        balance: account.balance,
        available,
        requested,
        deficit: requested - available,
        availableAt: nextReplenishAt(),
        code: 'SALDO_INSUFICIENTE',
      };
    }
    // UPDATE condicional: a alocação é decisão do banco, não do caller (AD-4).
    const updated = await tx.studioReputationAccount.updateMany({
      where: { orgId, channel, balance: { gte: grant } },
      data: { balance: { decrement: grant } },
    });
    if (updated.count === 0) {
      // Corrida entre leitura e escrita: falha fechada (nunca negativo).
      metrics.incGateBlock('SALDO_INSUFICIENTE');
      return {
        ok: false,
        granted: 0,
        balance: account.balance,
        available,
        requested,
        deficit: requested,
        availableAt: nextReplenishAt(),
        code: 'SALDO_INSUFICIENTE',
      };
    }
    const after = await tx.studioReputationAccount.findFirst({ where: { orgId, channel } });
    const { event } = await insertEvent(tx, {
      orgId,
      channel,
      type: 'debit',
      amount: grant,
      balanceAfter: after.balance,
      reason: reason || null,
      refType,
      refId: refId || null,
      metadata,
    });
    metrics.incLedgerEvent('debit', channel);
    return {
      ok: true,
      granted: grant,
      requested,
      deficit: Math.max(0, requested - grant),
      availableAt: nextReplenishAt(),
      balance: after.balance,
      replayed: false,
      event,
    };
  });
}

/**
 * Crédito (reposição/estorno) idempotente por refId — AD-13. Estorno de
 * mensagem: refType='send', refId=messageId (unique impede duplo estorno).
 * O replay é detectado ANTES de mutar o saldo (nunca credita 2×).
 */
async function credit(prisma, { orgId, channel, amount, refType = 'ramp', refId, reason, metadata = {} }) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  return withTx(prisma, async (tx) => {
    if (n === 0) {
      const account = await getAccount(tx, orgId, channel);
      return { ok: true, credited: 0, balance: account ? account.balance : 0, replayed: false };
    }
    if (refId) {
      const prior = await tx.studioReputationEvent.findFirst({ where: { type: 'credit', refId } });
      if (prior) {
        const account = await tx.studioReputationAccount.findFirst({ where: { orgId, channel } });
        return { ok: true, credited: 0, balance: account ? account.balance : 0, replayed: true, event: prior };
      }
    }
    const account = await ensureAccount(tx, orgId, channel);
    const updated = await tx.studioReputationAccount.updateMany({
      where: { orgId, channel },
      data: { balance: { increment: n } },
    });
    if (updated.count === 0) {
      return { ok: false, credited: 0, balance: account.balance, code: 'CANAL_NAO_CONFIGURADO' };
    }
    const after = await tx.studioReputationAccount.findFirst({ where: { orgId, channel } });
    const { event, replayed } = await insertEvent(tx, {
      orgId,
      channel,
      type: 'credit',
      amount: n,
      balanceAfter: after.balance,
      reason: reason || null,
      refType,
      refId: refId || null,
      metadata,
    });
    if (replayed) {
      // Corrida: outra transação credentou o mesmo refId — desfaz o incremento.
      await tx.studioReputationAccount.updateMany({
        where: { orgId, channel },
        data: { balance: { decrement: n } },
      });
      return { ok: true, credited: 0, balance: after.balance - n, replayed: true, event };
    }
    metrics.incLedgerEvent('credit', channel);
    return { ok: true, credited: n, balance: after.balance, replayed: false, event };
  });
}

/** Estorno de envio definitivamente falho (AD-13) — idempotente por messageId. */
async function refundSend(prisma, { orgId, channel, messageId, reason }) {
  if (!messageId) return { ok: false, code: 'SEM_MESSAGE_ID' };
  const result = await credit(prisma, {
    orgId,
    channel,
    amount: 1,
    refType: 'send',
    refId: messageId,
    reason: reason || 'estorno de envio não realizado',
  });
  if (!result.replayed) metrics.incLedgerRefund(channel);
  return result;
}

/** Estorno de lote pausado/cancelado com fila restante (AD-13, refId=batchId). */
async function refundBatch(prisma, { orgId, channel, batchId, units, reason }) {
  return credit(prisma, {
    orgId,
    channel,
    amount: units,
    refType: 'batch',
    refId: batchId,
    reason: reason || 'estorno de lote não enviado',
  });
}

/** Reposição diária por warm-up (FR-17) — idempotente por dia (refId). */
async function applyDailyReplenishment(prisma, orgId, channel, now = new Date()) {
  const account = await ensureAccount(prisma, orgId, channel);
  const policy = channelPolicy(channel);
  const { stage, ceiling } = nextRampStage(account);
  const headroom = Math.max(0, ceiling - account.balance);
  const grant = Math.min(headroom, Math.max(1, Math.round(ceiling / 4)));
  if (grant <= 0) {
    // No teto: nada a repor (idempotente — o dia já está coberto).
    return { ok: true, credited: 0, replayed: false, ceiling, stage };
  }
  const result = await credit(prisma, {
    orgId,
    channel,
    amount: grant,
    refType: 'ramp',
    refId: `ramp:${orgId}:${channel}:${dayKey(now)}`,
    reason: `reposição diária de warm-up (estágio ${stage + 1}, teto ${ceiling})`,
  });
  return { ...result, ceiling, stage };
}

/** Sinal positivo (engajamento) sobe a rampa (FR-17) — estágio só avança. */
async function promoteRamp(prisma, orgId, channel) {
  const account = await ensureAccount(prisma, orgId, channel);
  const stages = channelPolicy(channel).rampStages;
  const nextStage = Math.min(Number(account.rampStage || 0) + 1, stages.length - 1);
  return prisma.studioReputationAccount.updateMany({
    where: { orgId, channel, rampStage: { lt: nextStage } },
    data: { rampStage: nextStage, ceiling: stages[nextStage] },
  });
}

/** Sinal negativo (rejeição/bloqueio WhatsApp, complaint) derruba o saldo (FR-18/FR-14). */
async function penalize(prisma, { orgId, channel, amount, reason, refId }) {
  const account = await ensureAccount(prisma, orgId, channel);
  const cut = Math.min(amount, Math.max(0, account.balance - 0));
  if (cut <= 0) return { ok: true, penalized: 0, balance: account.balance };
  return withTx(prisma, async (tx) => {
    const updated = await tx.studioReputationAccount.updateMany({
      where: { orgId, channel, balance: { gte: cut } },
      data: { balance: { decrement: cut } },
    });
    if (updated.count === 0) return { ok: true, penalized: 0, balance: account.balance };
    const after = await tx.studioReputationAccount.findFirst({ where: { orgId, channel } });
    const { event, replayed } = await insertEvent(tx, {
      orgId,
      channel,
      type: 'block',
      amount: cut,
      balanceAfter: after.balance,
      reason: reason || null,
      refType: 'complaint',
      refId: refId || null,
    });
    metrics.incLedgerEvent('block', channel);
    return { ok: true, penalized: replayed ? 0 : cut, balance: after.balance, event };
  });
}

/**
 * Registra o resultado de uma verificação DNS (AD-8) e/ou o histórico
 * declarado do domínio (FR-28). Estados: 'unverified' | 'verified' |
 * 'prewarmed' | 'failed'. Falha → floor efetivo zero (o gate bloqueia com
 * instrução); verificado/prewarmed → floor configurado volta a valer.
 * `history` ('novo' | 'pre-aquecido' | 'penalizado') responde o piso:
 * pré-aquecido eleva, penalizado derruba ao mínimo (Despertar no job).
 */
async function recordDomainAuth(prisma, orgId, { status, detail, checkedAt, history } = {}) {
  const policy = channelPolicy('email');
  const data = {
    domainAuthStatus: status,
    domainAuthCheckedAt: checkedAt || new Date(),
    domainAuthDetail: detail || {},
  };
  if (history) {
    if (history === 'penalizado') data.floor = 0; // piso mínimo + orientação
    else if (history === 'pre-aquecido') data.floor = policy.floor * 4; // FR-17 override
    else data.floor = policy.floor; // novo: piso padrão conservador
  }
  await ensureAccount(prisma, orgId, 'email');
  return prisma.studioReputationAccount.updateMany({
    where: { orgId, channel: 'email' },
    data,
  });
}

/** Chave de dedupe estável para metadados (hash determinístico). */
function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

// metrics é requerido lazy para não criar ciclo com o registry em testes.
let metrics = require('../metrics');

module.exports = {
  CHANNELS,
  CHANNEL_POLICY,
  channelPolicy,
  ensureAccount,
  getAccount,
  getBalance,
  listBalances,
  listEvents,
  debit,
  credit,
  refundSend,
  refundBatch,
  applyDailyReplenishment,
  promoteRamp,
  penalize,
  recordDomainAuth,
  effectiveBalance,
  effectiveFloor,
  nextReplenishAt,
  nextReplenishLabel,
  stableHash,
  _setMetricsForTests(mod) {
    metrics = mod;
  },
};
