'use strict';

/**
 * studio/actions/manifest.v1.js — contrato VERSIONADO das actions semânticas
 * do Cockpit (specs/011, AD-6; FR-9 do PRD).
 *
 * Chips são ações: toda action é idempotente por chave estável — re-executar
 * NÃO duplica segmentos/conteúdos. Breaking change → manifest.v2.js
 * side-by-side; v1 NUNCA muda de forma (automações externas consomem isto).
 *
 * Estratégias de idempotência:
 *   - 'client': o cliente manda `actionId` (duplo toque do usuário) — chave
 *     escopada em org+campanha; sem actionId, cai no hash de params.
 *   - 'params': hash determinístico de (orgId, campaignId, action, params) —
 *     repetir o MESMO pedido devolve o MESMO resultado sem re-executar.
 *   - 'none': idempotente por natureza (update de campo escalar — ex.
 *     set_schedule) — NUNCA repete por actionId; cada chamada é um pedido novo.
 *
 * A execução grava a run (status 'running') ANTES do handler e atualiza para
 * 'succeeded'/'failed' depois — resultado vazio/falho NUNCA é replay: a
 * próxima chamada com a mesma chave RE-EXECUTA.
 */

const crypto = require('crypto');

const ACTIONS_V1 = {
  set_objective: { version: 1, idempotency: 'none', description: 'Define objetivo/oferta da campanha' },
  set_audience: { version: 1, idempotency: 'params', description: 'Cria audiência a partir de descrição em linguagem natural (create-style)' },
  attach_url: { version: 1, idempotency: 'params', description: 'Anexa material por URL e extrai (create-style)' },
  confirm_material: { version: 1, idempotency: 'params', description: 'Confirma a extração do material' },
  generate_content: { version: 1, idempotency: 'params', description: 'Gera pacote de conteúdo (create-style)' },
  set_schedule: { version: 1, idempotency: 'none', description: 'Configura agenda/ritmo e transita para scheduled' },
  select_leads: { version: 1, idempotency: 'none', description: 'Ajusta a seleção manual de leads da audiência (set/add/remove por prospectId)' },
  show_balance: { version: 1, idempotency: 'none', description: 'Mostra o Orçamento de Reputação por canal com passo a passo de desbloqueio' },
  start_whatsapp_pairing: { version: 1, idempotency: 'none', description: 'Inicia/retoma o pareamento do WhatsApp (WAHA) e devolve o QR no chat' },
};

/**
 * Chave estável de idempotência (AD-6), SEMPRE escopada em org+campanha —
 * actionId de tenants/campanhas diferentes nunca colide.
 */
function actionKey({ orgId, campaignId, action, params = {}, actionId = null }) {
  const spec = ACTIONS_V1[action];
  const strategy = spec ? spec.idempotency : 'params';
  if (strategy === 'none') return null; // sem chave: cada chamada é um pedido novo
  const scope = `v1:${action}:${orgId || 'no-org'}:${campaignId || 'no-campaign'}`;
  if (actionId) return `${scope}:${actionId}`;
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ campaignId, action, params: sortDeep(params) }))
    .digest('hex')
    .slice(0, 40);
  return `${scope}:${hash}`;
}

/** JSON determinístico: chaves ordenadas em todos os níveis. */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortDeep(value[k]);
        return acc;
      }, {});
  }
  return value;
}

/** Validação de schema v1 (campos mínimos por action). Erro → httpError 400. */
function validate(action, params = {}) {
  const spec = ACTIONS_V1[action];
  if (!spec) {
    const err = new Error(`Action desconhecida: ${action}`);
    err.code = 'UNKNOWN_ACTION';
    err.status = 400;
    throw err;
  }
  switch (action) {
    case 'set_objective':
      return true; // objetivo/oferta opcionais (mantêm o atual quando ausentes)
    case 'set_audience':
      if (!params.description) {
        const err = new Error('set_audience exige `description`.');
        err.code = 'INVALID_ACTION_PARAMS';
        err.status = 400;
        throw err;
      }
      return true;
    case 'attach_url':
      if (!params.url || !/^https?:\/\//.test(String(params.url))) {
        const err = new Error('attach_url exige `url` http(s).');
        err.code = 'INVALID_ACTION_PARAMS';
        err.status = 400;
        throw err;
      }
      return true;
    case 'confirm_material':
      if (!params.materialId) {
        const err = new Error('confirm_material exige `materialId`.');
        err.code = 'INVALID_ACTION_PARAMS';
        err.status = 400;
        throw err;
      }
      return true;
    case 'generate_content':
      return true; // tones opcional (default no serviço)
    case 'set_schedule':
      return true; // validação de janelas vive no serviço (INVALID_WINDOW)
    case 'select_leads': {
      const lists = ['set', 'add', 'remove'];
      const hasAny = lists.some((k) => Array.isArray(params[k]) && params[k].length > 0);
      if (!hasAny) {
        const err = new Error('select_leads exige ao menos uma lista não vazia: set, add ou remove (prospectIds).');
        err.code = 'INVALID_ACTION_PARAMS';
        err.status = 400;
        throw err;
      }
      return true;
    }
    default:
      return true;
  }
}

async function findRun(prisma, key) {
  return prisma.studioActionRun.findFirst({ where: { actionKey: key } });
}

/**
 * Executa com idempotência via StudioActionRun (unique actionKey):
 *  - grava a run (status 'running') ANTES do handler;
 *  - succeeded → re-execução devolve o resultado da 1ª SEM tocar serviços;
 *  - 'failed'/'running' prévia → RE-EXECUTA (nunca replay com resultado vazio);
 *  - P2002 na criação (corrida) → replay só se o vencedor succeeded; caso
 *    contrário, re-executa.
 */
async function runIdempotent(prisma, { orgId, campaignId, action, params, actionId, run }) {
  const key = actionKey({ orgId, campaignId, action, params, actionId });
  const trackable = Boolean(key && prisma.studioActionRun);

  if (trackable) {
    const prior = await findRun(prisma, key);
    if (prior && prior.status === 'succeeded') {
      return { result: prior.result, replayed: true };
    }
    if (prior) {
      // failed/running: re-executa — reabre a run (nunca replay vazio).
      await prisma.studioActionRun.updateMany({
        where: { actionKey: key },
        data: { status: 'running', result: {} },
      });
    } else {
      try {
        await prisma.studioActionRun.create({
          data: { orgId, campaignId, action, actionKey: key, status: 'running', result: {} },
        });
      } catch (err) {
        if (err && err.code === 'P2002') {
          // Corrida: outra execução criou a run — replay só se succeeded.
          const winner = await findRun(prisma, key);
          if (winner && winner.status === 'succeeded') {
            return { result: winner.result, replayed: true };
          }
        } else {
          throw err;
        }
      }
    }
  }

  let result;
  try {
    result = await run();
  } catch (err) {
    if (trackable) {
      await prisma.studioActionRun
        .updateMany({
          where: { actionKey: key, status: 'running' },
          data: { status: 'failed', result: { error: String((err && err.message) || err) } },
        })
        .catch(() => {});
    }
    throw err;
  }

  if (trackable) {
    await prisma.studioActionRun
      .updateMany({
        where: { actionKey: key, status: 'running' },
        data: { status: 'succeeded', result },
      })
      .catch(() => {});
  }
  return { result, replayed: false };
}

module.exports = { ACTIONS_V1, actionKey, validate, runIdempotent, sortDeep };
