'use strict';

/**
 * studio/reputation.js — Saldo ÚNICO de envios: WRITER ÚNICO do saldo
 * (specs/011, AD-3 da spine; unificação e-mail+WhatsApp decidida pelo dono
 * em 2026-10-08).
 *
 * Modelo (decisão de produto):
 *  - UMA conta por org (channel='unified') — e-mail e WhatsApp dividem o
 *    MESMO pool. Comprar saldo via Stripe credita o pool; disparar por
 *    qualquer canal debita o mesmo pool.
 *  - Tetos DIÁRIOS por canal continuam como camada de ritmo (proteção de
 *    reputação): emailSentToday/whatsappSentToday contam o dia e o cap vem
 *    do estágio de rampa (CHANNEL_CAP_RAMPS). Saldo comprado NÃO compra
 *    ritmo no dia 1 — o estágio sobe 1x/dia no cron.
 *  - Elegibilidade do e-mail (DNS verificado) é GATE (reputation-gate), não
 *    matemática de saldo.
 *
 * Regras inegociáveis:
 *  - `balance` só muta NA MESMA transação que insere o evento correspondente
 *    no ledger append-only (StudioReputationEvent).
 *  - Nenhum outro módulo deriva, ajusta ou re-computa saldo/floor/unidade —
 *    consulta do painel lê a account; auditoria lê o ledger.
 *  - Estorno idempotente por refId (unique (type, refId)) — AD-13.
 *  - Alocação é decisão do BANCO (UPDATE condicional, AD-4) — partial grant
 *    por saldo E por cap do canal.
 *
 * Unidades: 1 unidade = 1 envio. Números de rampa vivem AQUI.
 *
 * `$transaction` do Prisma real é usado quando disponível; no fake-prisma dos
 * testes o módulo degrada para operações sequenciais (mesma semântica).
 */

const crypto = require('crypto');

/** Canais de DISPARO (rótulo de ledger + cap diário). A conta é única. */
const SEND_CHANNELS = ['email', 'whatsapp'];
const UNIFIED_CHANNEL = 'unified';

// Rampa única da CARTEIRA (teto de reposição diária — env-tunable via
// STUDIO_REP_*). Piso: reserva mínima do pool (não drena o fatiamento
// "saldo 30, lote 100 → 30 enfileiradas").
const WALLET_POLICY = {
  startBalance: Number(process.env.STUDIO_REP_START || process.env.STUDIO_REP_EMAIL_START || 100),
  floor: Number(process.env.STUDIO_REP_FLOOR || 10),
  rampStages: [100, 200, 400, 800],
};

// Tetos DIÁRIOS por canal por estágio de rampa (WhatsApp conservador — FR-18).
// Avançam JUNTOS com o estágio da carteira (1 estágio/dia no cron).
const CHANNEL_CAP_RAMPS = {
  email: [Number(process.env.STUDIO_REP_EMAIL_START || 100), 200, 400, 800],
  whatsapp: [Number(process.env.STUDIO_REP_WA_START || 30), 50, 80],
};

// % do teto que dispara o aviso de "saldo acabando" (pop-up do Studio).
const LOW_BALANCE_PCT = Math.min(100, Math.max(1, Number(process.env.STUDIO_LOW_BALANCE_PCT || 25)));

const CAP_FIELD = { email: 'emailSentToday', whatsapp: 'whatsappSentToday' };

function channelPolicy() {
  return WALLET_POLICY;
}

/** Teto diário do canal no estágio de rampa atual. */
function capFor(channel, rampStage) {
  const ramp = CHANNEL_CAP_RAMPS[channel];
  if (!ramp) {
    const err = new Error(`Canal de disparo não suportado: ${channel}`);
    err.code = 'CANAL_NAO_SUPORTADO';
    err.status = 400;
    throw err;
  }
  const idx = Math.min(Math.max(0, Number(rampStage) || 0), ramp.length - 1);
  return ramp[idx];
}

/** Contador do canal já usado hoje (0 quando o dia mudou — reset lazy). */
function usedToday(account, channel, now = new Date()) {
  if (account.usageDay !== dayKey(now)) return 0;
  return Math.max(0, Number(account[CAP_FIELD[channel]] || 0));
}

/** Suporta Prisma real ($transaction) e fake-prisma (sequencial nos testes). */
async function withTx(prisma, fn) {
  if (typeof prisma.$transaction === 'function') {
    return prisma.$transaction(async (tx) => fn(tx));
  }
  return fn(prisma);
}

function nextRampStage(account) {
  const stages = WALLET_POLICY.rampStages;
  const idx = Math.min(Number(account.rampStage || 0), stages.length - 1);
  return { stage: idx, ceiling: stages[idx] };
}

/** Saldo disponível para débito (respeita o piso do pool; nunca negativo). */
function effectiveBalance(account) {
  return Math.max(0, account.balance - (account.floor || 0));
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
 * Garante a conta ÚNICA da org com os defaults da rampa (idempotente).
 * Org nova começa com saldo conservador (FR-17).
 */
async function ensureAccount(prisma, orgId) {
  const existing = await prisma.studioReputationAccount.findFirst({
    where: { orgId, channel: UNIFIED_CHANNEL },
  });
  if (existing) return existing;
  const policy = channelPolicy();
  try {
    return await prisma.studioReputationAccount.create({
      data: {
        orgId,
        channel: UNIFIED_CHANNEL,
        balance: policy.startBalance,
        floor: policy.floor,
        ceiling: policy.rampStages[0],
        rampStage: 0,
        domainAuthStatus: 'unverified',
      },
    });
  } catch (err) {
    if (err && err.code === 'P2002') {
      return prisma.studioReputationAccount.findFirst({ where: { orgId, channel: UNIFIED_CHANNEL } });
    }
    throw err;
  }
}

/**
 * Account da org (row unified). `channel` é ACEITO e IGNORADO — callers
 * legados (certificate/suggestions) passam o canal do disparo.
 */
async function getAccount(prisma, orgId, _channel = null) {
  return prisma.studioReputationAccount.findFirst({ where: { orgId, channel: UNIFIED_CHANNEL } });
}

/**
 * Visão completa da carteira (painel/chat/pop-up): pool único + ritmo por
 * canal + sinal de saldo baixo (≤ LOW_BALANCE_PCT% do teto).
 */
async function getWallet(prisma, orgId, now = new Date()) {
  const account = await getAccount(prisma, orgId);
  if (!account) return null;
  const { stage, ceiling } = nextRampStage(account);
  const threshold = Math.ceil((LOW_BALANCE_PCT / 100) * ceiling);
  return {
    channel: UNIFIED_CHANNEL,
    balance: account.balance,
    available: effectiveBalance(account),
    floor: account.floor || 0,
    ceiling,
    rampStage: stage,
    caps: {
      email: capFor('email', stage),
      whatsapp: capFor('whatsapp', stage),
    },
    usedToday: {
      email: usedToday(account, 'email', now),
      whatsapp: usedToday(account, 'whatsapp', now),
    },
    domainAuthStatus: account.domainAuthStatus,
    domainAuthCheckedAt: account.domainAuthCheckedAt,
    lowBalance: account.balance <= threshold,
    threshold,
    updatedAt: account.updatedAt,
  };
}

/**
 * COMPAT: a leitura antiga devolvia uma conta POR CANAL; hoje existe uma só.
 * Devolve [wallet] para consumidores que iteram a lista (cockpit home,
 * suggestions) sem quebrar a forma do payload.
 */
async function listBalances(prisma, orgId, now = new Date()) {
  const wallet = await getWallet(prisma, orgId, now);
  return wallet ? [wallet] : [];
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
 * pedido; o banco concede a fatia que o SALDO ÚNICO e o CAP DIÁRIO DO CANAL
 * cobrem (partial grant nos dois eixos). Nunca deixa saldo negativo nem
 * estoura o cap. Idempotente por refId (o mesmo lote nunca debita 2×).
 * `channel` é o canal do DISPARO (rótulo do ledger + cap de ritmo).
 */
async function debit(prisma, { orgId, channel, amount, refType = 'batch', refId, reason, metadata = {}, now = new Date() }) {
  const requested = Math.max(0, Math.floor(Number(amount) || 0));
  const capField = CAP_FIELD[channel];
  if (!capField) {
    const err = new Error(`Canal de disparo não suportado: ${channel}`);
    err.code = 'CANAL_NAO_SUPORTADO';
    err.status = 400;
    throw err;
  }
  return withTx(prisma, async (tx) => {
    if (requested === 0) {
      const account = await ensureAccount(tx, orgId);
      return { ok: true, granted: 0, balance: account.balance, replayed: false };
    }
    if (refId) {
      const prior = await tx.studioReputationEvent.findFirst({ where: { type: 'debit', refId } });
      if (prior) {
        const account = await tx.studioReputationAccount.findFirst({ where: { orgId, channel: UNIFIED_CHANNEL } });
        return { ok: true, granted: 0, balance: account ? account.balance : 0, replayed: true, event: prior };
      }
    }
    const account = await ensureAccount(tx, orgId);
    const available = effectiveBalance(account);
    const cap = capFor(channel, account.rampStage);
    const used = usedToday(account, channel, now);
    const capHeadroom = Math.max(0, cap - used);
    // Concede só a fatia coberta pelo saldo efetivo E pelo cap do canal.
    const grant = Math.min(requested, available, capHeadroom);
    const availableAt = nextReplenishAt(now);
    if (grant <= 0) {
      const semSaldo = available <= 0;
      const code = semSaldo ? 'SALDO_INSUFICIENTE' : 'LIMITE_DIARIO_CANAL';
      metrics.incGateBlock(code);
      return {
        ok: false,
        granted: 0,
        balance: account.balance,
        available,
        requested,
        deficit: requested - grant,
        cap,
        capUsed: used,
        availableAt,
        code,
      };
    }
    // UPDATE condicional: a alocação é decisão do banco, não do caller (AD-4).
    // Reset lazy do contador quando o dia virou (usageDay ≠ hoje).
    const stale = account.usageDay !== dayKey(now);
    const updated = await tx.studioReputationAccount.updateMany({
      where: { orgId, channel: UNIFIED_CHANNEL, balance: { gte: grant } },
      data: {
        balance: { decrement: grant },
        usageDay: dayKey(now),
        [capField]: stale ? grant : { increment: grant },
      },
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
        cap,
        capUsed: used,
        availableAt,
        code: 'SALDO_INSUFICIENTE',
      };
    }
    const after = await tx.studioReputationAccount.findFirst({ where: { orgId, channel: UNIFIED_CHANNEL } });
    const { event } = await insertEvent(tx, {
      orgId,
      channel, // rótulo do canal do disparo (auditoria) — o pool é único
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
      availableAt,
      balance: after.balance,
      cap,
      capUsed: used + grant,
      // O que limitou o grant no eixo que sobrou (explicável no gate/card).
      limitBinding: requested - grant > 0 ? (capHeadroom <= available ? 'cap' : 'balance') : null,
      replayed: false,
      event,
    };
  });
}

/**
 * Crédito (reposição/estorno/compra) idempotente por refId — AD-13. Credita
 * o POOL ÚNICO; `channel` é só rótulo de auditoria. Estorno de mensagem:
 * refType='send', refId=messageId (unique impede duplo estorno). O replay é
 * detectado ANTES de mutar o saldo (nunca credita 2×).
 */
async function credit(prisma, { orgId, channel, amount, refType = 'ramp', refId, reason, metadata = {} }) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  return withTx(prisma, async (tx) => {
    if (n === 0) {
      const account = await getAccount(tx, orgId);
      return { ok: true, credited: 0, balance: account ? account.balance : 0, replayed: false };
    }
    if (refId) {
      const prior = await tx.studioReputationEvent.findFirst({ where: { type: 'credit', refId } });
      if (prior) {
        const account = await tx.studioReputationAccount.findFirst({ where: { orgId, channel: UNIFIED_CHANNEL } });
        return { ok: true, credited: 0, balance: account ? account.balance : 0, replayed: true, event: prior };
      }
    }
    const account = await ensureAccount(tx, orgId);
    const updated = await tx.studioReputationAccount.updateMany({
      where: { orgId, channel: UNIFIED_CHANNEL },
      data: { balance: { increment: n } },
    });
    if (updated.count === 0) {
      return { ok: false, credited: 0, balance: account.balance, code: 'CANAL_NAO_CONFIGURADO' };
    }
    const after = await tx.studioReputationAccount.findFirst({ where: { orgId, channel: UNIFIED_CHANNEL } });
    const { event, replayed } = await insertEvent(tx, {
      orgId,
      channel: SEND_CHANNELS.includes(channel) ? channel : UNIFIED_CHANNEL,
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
        where: { orgId, channel: UNIFIED_CHANNEL },
        data: { balance: { decrement: n } },
      });
      return { ok: true, credited: 0, balance: after.balance - n, replayed: true, event };
    }
    metrics.incLedgerEvent('credit', SEND_CHANNELS.includes(channel) ? channel : UNIFIED_CHANNEL);
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

/**
 * Reposição diária da CARTEIRA (FR-17) — idempotente por dia (refId sem
 * canal). Os contadores de uso do dia são zerados LAZILMENTE no débito
 * (usageDay); a reposição credita até o teto do estágio atual.
 */
async function applyDailyReplenishment(prisma, orgId, now = new Date()) {
  const account = await ensureAccount(prisma, orgId);
  const { stage, ceiling } = nextRampStage(account);
  const headroom = Math.max(0, ceiling - account.balance);
  const grant = Math.min(headroom, Math.max(1, Math.round(ceiling / 4)));
  if (grant <= 0) {
    // No teto: nada a repor (idempotente — o dia já está coberto).
    return { ok: true, credited: 0, replayed: false, ceiling, stage };
  }
  const result = await credit(prisma, {
    orgId,
    channel: UNIFIED_CHANNEL,
    amount: grant,
    refType: 'ramp',
    refId: `ramp:${orgId}:${dayKey(now)}`,
    reason: `reposição diária de warm-up (estágio ${stage + 1}, teto ${ceiling})`,
  });
  return { ...result, ceiling, stage };
}

/** Sinal positivo (engajamento) sobe a rampa (FR-17) — estágio só avança.
 *  O estágio define o teto da carteira E os caps diários por canal. */
async function promoteRamp(prisma, orgId) {
  const account = await ensureAccount(prisma, orgId);
  const stages = WALLET_POLICY.rampStages;
  const nextStage = Math.min(Number(account.rampStage || 0) + 1, stages.length - 1);
  return prisma.studioReputationAccount.updateMany({
    where: { orgId, channel: UNIFIED_CHANNEL, rampStage: { lt: nextStage } },
    data: { rampStage: nextStage, ceiling: stages[nextStage] },
  });
}

/** Sinal negativo (rejeição/bloqueio WhatsApp, complaint) drenagem do POOL (FR-18/FR-14). */
async function penalize(prisma, { orgId, channel, amount, reason, refId }) {
  const account = await ensureAccount(prisma, orgId);
  const cut = Math.min(amount, Math.max(0, account.balance - 0));
  if (cut <= 0) return { ok: true, penalized: 0, balance: account.balance };
  return withTx(prisma, async (tx) => {
    const updated = await tx.studioReputationAccount.updateMany({
      where: { orgId, channel: UNIFIED_CHANNEL, balance: { gte: cut } },
      data: { balance: { decrement: cut } },
    });
    if (updated.count === 0) return { ok: true, penalized: 0, balance: account.balance };
    const after = await tx.studioReputationAccount.findFirst({ where: { orgId, channel: UNIFIED_CHANNEL } });
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
 * 'prewarmed' | 'failed'. A elegibilidade do E-MAIL vive aqui e o GATE
 * bloqueia com instrução (não é mais matemática de piso). `history`
 * ('novo' | 'pre-aquecido' | 'penalizado') responde o PISO DO POOL:
 * pré-aquecido eleva, penalizado derruba ao mínimo.
 */
async function recordDomainAuth(prisma, orgId, { status, detail, checkedAt, history } = {}) {
  const policy = channelPolicy();
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
  await ensureAccount(prisma, orgId);
  return prisma.studioReputationAccount.updateMany({
    where: { orgId, channel: UNIFIED_CHANNEL },
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
  SEND_CHANNELS,
  UNIFIED_CHANNEL,
  WALLET_POLICY,
  CHANNEL_CAP_RAMPS,
  LOW_BALANCE_PCT,
  capFor,
  usedToday,
  channelPolicy,
  ensureAccount,
  getAccount,
  getWallet,
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
  nextReplenishAt,
  nextReplenishLabel,
  stableHash,
  _setMetricsForTests(mod) {
    metrics = mod;
  },
};
