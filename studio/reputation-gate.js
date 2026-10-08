'use strict';

/**
 * studio/reputation-gate.js — ÚNICO ponto de decisão "pode disparir?"
 * (specs/011, AD-4 da spine).
 *
 * Sequência do gate (fail-closed — qualquer erro bloqueia com motivo técnico):
 *   1. pausa global da org (estado PERSISTIDO — Organization.studioSendPaused)
 *   2. canal configurado na org (conta de envio existe)
 *   3. certificado vigente re-avaliado (quando a campanha tem selo — AD-7)
 *   4. saldo ≥ unidades pedidas (floor efetivo do writer único)
 *
 * `consume` é a AUTORIDADE DE ALOCAÇÃO: UPDATE condicional no banco que
 * devolve a fatia concedida — callers nunca leem saldo e fatiam por fora.
 */

const reputation = require('./reputation');

const { httpError } = require('./errors');

const BLOCK_CODES = {
  ORG_PAUSED: 'ORG_PAUSA_GLOBAL',
  CHANNEL_MISSING: 'CANAL_NAO_CONFIGURADO',
  BALANCE: 'SALDO_INSUFICIENTE',
  DAILY_CAP: 'LIMITE_DIARIO_CANAL',
  DOMAIN: 'DOMINIO_NAO_VERIFICADO',
  CERTIFICATE: 'CERTIFICADO_REPROVADO',
  TECHNICAL: 'GATE_ERRO_TECNICO',
  NO_CONSENT: 'SEM_CONSENTIMENTO',
};

/** Rótulo pt-BR do canal (copies explicáveis). */
function channelLabel(channel) {
  return channel === 'whatsapp' ? 'WhatsApp' : 'e-mail';
}

/** A pausa global da org está ativa? (persistido — nunca só em memória) */
async function isOrgPaused(prisma, orgId) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  return Boolean(org && org.studioSendPaused);
}

/** Pausa global 1-clique (FR-19) com registro de quem/por quê. */
async function setOrgPaused(prisma, orgId, { paused, userId = null, reason = null } = {}) {
  const data = paused
    ? { studioSendPaused: true, studioPausedAt: new Date(), studioPausedById: userId, studioPauseReason: reason }
    : { studioSendPaused: false, studioPausedAt: null, studioPausedById: null, studioPauseReason: null };
  const updated = await prisma.organization.updateMany({ where: { id: orgId }, data });
  if (updated.count === 0) {
    // Org inexistente: fail-closed explícito.
    throw httpError('NOT_FOUND', 404, 'Organização não encontrada');
  }
  return { orgId, paused: Boolean(paused) };
}

/**
 * Verifica se o canal tem conta de envio configurada na org (pré-condição
 * do painel de saldo — Saldo só existe quando o Canal está configurado).
 */
async function isChannelConfigured(prisma, orgId, channel) {
  if (channel === 'email') {
    const account = await prisma.emailAccount.findFirst({
      where: { tenantId: orgId, status: 'connected' },
    });
    return Boolean(account);
  }
  if (channel === 'whatsapp') {
    const account = await prisma.whatsAppAccount.findFirst({
      where: { orgId, status: 'CONNECTED' },
    });
    return Boolean(account);
  }
  return false;
}

/** Checagens 1–3 do gate (pausa → canal → certificado). Sem saldo. */
async function precheck(prisma, { orgId, channel, campaign = null, now = new Date() }) {
  // 1) Pausa global persistida — antes de tudo (AD-4).
  if (await isOrgPaused(prisma, orgId)) {
    return {
      allow: false,
      code: BLOCK_CODES.ORG_PAUSED,
      reason: 'Envios pausados globalmente nesta organização — retomada exige ação explícita.',
    };
  }

  // 2) Canal configurado (conta de envio existe).
  if (!(await isChannelConfigured(prisma, orgId, channel))) {
    return {
      allow: false,
      code: BLOCK_CODES.CHANNEL_MISSING,
      reason:
        channel === 'email'
          ? 'Nenhuma conta de e-mail conectada — conecte o canal antes de disparar.'
          : 'Nenhuma conta WhatsApp conectada — conecte o canal antes de disparar.',
    };
  }

  // 2.5) Elegibilidade do E-MAIL: domínio com SPF+DKIM verificados (AD-8).
  //     Desde o saldo único (2026-10-08) isso é GATE explícito — o saldo do
  //     pool não é mais refém do domínio; bloqueia com instrução acionável.
  if (channel === 'email') {
    const account = await reputation.ensureAccount(prisma, orgId);
    const eligible = ['verified', 'prewarmed'].includes(account.domainAuthStatus);
    if (!eligible) {
      return {
        allow: false,
        code: BLOCK_CODES.DOMAIN,
        reason:
          'Domínio de envio sem SPF/DKIM verificados — o e-mail fica bloqueado até autenticar. ' +
          'Me peça "mostrar os registros DNS" que eu listo cada um para publicar no seu provedor.',
      };
    }
  }

  // 3) Certificado vigente re-avaliado (só para campanhas com selo — AD-7).
  //    Onda "criação sem bloqueios" (2026-09-29): a re-avaliação é em modo
  //    DISPARO (`forDispatch`) — a liberdade é na CRIAÇÃO; aqui itens
  //    'block' continuam bloqueando (fail-closed, AD-4). Pendências
  //    ('pending') e avisos ('warning') nunca bloqueiam o gate.
  if (campaign && campaign.approval && campaign.approval.certificate) {
    const certificate = require('./certificate');
    const verdict = await certificate.evaluate(prisma, campaign, { now, skipPersist: true, forDispatch: true });
    const blocked = verdict.items.filter((i) => i.level === 'block');
    if (blocked.length > 0) {
      return {
        allow: false,
        code: BLOCK_CODES.CERTIFICATE,
        reason: `Certificado reprovado: ${blocked.map((i) => i.label).join('; ')}.`,
        items: verdict.items,
      };
    }
  }
  return { allow: true };
}

/**
 * Avalia o gate SEM mutar saldo (uso: agendamento, UI). Fail-closed: erro em
 * qualquer checagem → block com motivo técnico (nunca allow por omissão).
 *
 * `campaign` é opcional; quando informado e a campanha tem certificado
 * persistido, o gate RE-AVALIA (AD-7) — selo vencido/reprovado bloqueia.
 */
async function evaluate(prisma, { orgId, channel, units, campaign = null, now = new Date() }) {
  const requested = Math.max(1, Math.floor(Number(units) || 1));
  try {
    const pre = await precheck(prisma, { orgId, channel, campaign, now });
    if (!pre.allow) return pre;

    // 4) Saldo ÚNICO ≥ unidades E cap diário do canal com folga.
    const account = await reputation.ensureAccount(prisma, orgId);
    const available = reputation.effectiveBalance(account);
    const cap = reputation.capFor(channel, account.rampStage);
    const used = reputation.usedToday(account, channel, now);
    if (available < requested) {
      return {
        allow: false,
        code: BLOCK_CODES.BALANCE,
        reason: `Saldo único insuficiente: ${available} envio(s) disponível(is) no pool, ${requested} necessária(s) — compre mais saldo no painel ou aguarde a reposição diária.`,
        available,
        requested,
        deficit: requested - available,
        availableAt: reputation.nextReplenishAt(now),
      };
    }
    if (used + requested > cap) {
      return {
        allow: false,
        code: BLOCK_CODES.DAILY_CAP,
        reason: `Teto diário do ${channelLabel(channel)} atingido: ${used}/${cap} hoje — o ritmo do canal volta amanhã (o saldo único ainda tem ${available}).`,
        available,
        requested,
        cap,
        used,
        availableAt: reputation.nextReplenishAt(now),
      };
    }

    return { allow: true, available, requested, cap, used };
  } catch (err) {
    // Fail-closed é lei (AD-4): erro/timeout → bloqueia com motivo técnico.
    console.error('[studio:gate] falha na avaliação (fail-closed):', err.message);
    return {
      allow: false,
      code: BLOCK_CODES.TECHNICAL,
      reason: `Verificação de reputação indisponível: ${err.message}`,
      technical: true,
    };
  }
}

/**
 * Consume: decide E debita (AD-4) — a autoridade de alocação. O débito
 * concede a fatia que o saldo cobre (partial grant — `saldo 30, lote 100`
 * concede 30 e o restante volta bloqueado e explicável). Callers nunca leem
 * saldo e fatiam por fora.
 */
async function consume(prisma, { orgId, channel, units, campaign = null, refType = 'batch', refId, reason, metadata = {}, now = new Date() }) {
  try {
    // Checagens 1–3 (pausa → canal → certificado); o saldo decide no débito.
    const pre = await precheck(prisma, { orgId, channel, campaign, now });
    if (!pre.allow) {
      return { granted: 0, blocked: pre };
    }
    const result = await reputation.debit(prisma, {
      orgId,
      channel,
      amount: Math.max(1, Math.floor(Number(units) || 1)),
      refType,
      refId,
      reason,
      metadata,
      now, // o dia do cap/contador é o do CALLER (scheduler usa tempo determinístico)
    });
    if (!result.ok) {
      const capBlock = result.code === BLOCK_CODES.DAILY_CAP;
      return {
        granted: 0,
        blocked: {
          allow: false,
          code: result.code || BLOCK_CODES.BALANCE,
          reason: capBlock
            ? `Teto diário do ${channelLabel(channel)} atingido (${result.capUsed}/${result.cap} hoje) — o ritmo do canal volta amanhã (o saldo único ainda tem ${result.available}).`
            : `Saldo único insuficiente: ${result.available} envio(s) disponível(is) de ${result.requested} pedida(s). Faltam ${result.deficit} — libera em ${result.availableAt.toISOString()} ou compre mais saldo no painel.`,
          available: result.available,
          requested: result.requested,
          deficit: result.deficit,
          cap: result.cap,
          capUsed: result.capUsed,
          availableAt: result.availableAt,
        },
      };
    }
    if (!result.replayed) {
      const metrics = require('../metrics');
      metrics.incGateEvaluation('allow');
      metrics.incGateConsumed(channel, result.granted);
    }
    const nextReplenish = reputation.nextReplenishAt(now);
    return {
      granted: result.granted,
      requested: result.requested,
      deficit: result.deficit || 0,
      balance: result.balance,
      cap: result.cap,
      capUsed: result.capUsed,
      replayed: result.replayed,
      // Debitou uma fatia e o restante ficou sem cobertura: bloqueio explicável
      // pelo eixo que limitou (saldo único ou teto diário do canal).
      blocked: (result.deficit || 0) > 0
        ? {
            allow: false,
            code: result.limitBinding === 'cap' ? BLOCK_CODES.DAILY_CAP : BLOCK_CODES.BALANCE,
            reason:
              result.limitBinding === 'cap'
                ? `O teto diário do ${channelLabel(channel)} cobriu ${result.granted} de ${result.requested} (${result.capUsed}/${result.cap} hoje) — o restante volta amanhã.`
                : `O saldo único cobriu ${result.granted} de ${result.requested} envio(s). Faltam ${result.deficit} — libera em ${nextReplenish.toISOString()} ou compre mais saldo no painel.`,
            available: result.balance,
            requested: result.requested,
            deficit: result.deficit,
            cap: result.cap,
            capUsed: result.capUsed,
            availableAt: nextReplenish,
          }
        : null,
    };
  } catch (err) {
    // Fail-closed: erro no consume bloqueia com motivo técnico.
    console.error('[studio:gate] falha no consume (fail-closed):', err.message);
    return {
      granted: 0,
      blocked: {
        allow: false,
        code: BLOCK_CODES.TECHNICAL,
        reason: `Verificação de reputação indisponível: ${err.message}`,
        technical: true,
      },
    };
  }
}

/** Conveniência para rotas: lança httpError semântico quando bloqueia. */
function blockToHttpError(block) {
  const err = httpError(block.code || BLOCK_CODES.TECHNICAL, block.code === BLOCK_CODES.TECHNICAL ? 503 : 409, block.reason);
  if (block.deficit != null) err.deficit = block.deficit;
  if (block.availableAt) err.availableAt = block.availableAt;
  if (block.items) err.items = block.items;
  return err;
}

module.exports = {
  BLOCK_CODES,
  isOrgPaused,
  setOrgPaused,
  isChannelConfigured,
  precheck,
  evaluate,
  consume,
  blockToHttpError,
};
