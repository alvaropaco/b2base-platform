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
  // Onda "criação sem bloqueios" (2026-09-29) — ADITIVAS (AD-6), sem tocar
  // forma/idempotência/chaves das 9 originais:
  attach_files: { version: 1, idempotency: 'params', description: 'Vincula anexos de mensagem (StudioAttachment) à campanha — ids ordenados na chave de idempotência' },
  edit_content: { version: 1, idempotency: 'params', description: 'Edita conteúdo da campanha (assunto/texto/emailDoc) pelo serviço único do PATCH — editável em voo no que ainda não saiu' },
  // Epic 2 (FR7, D1/D2; 2026-09-30) — ADITIVA (AD-6): captura híbrida de
  // leads (base própria + fallback MCP CNPJ). Idempotente por params: repetir
  // o MESMO pedido devolve o MESMO card sem re-executar (FR8/AD-6). Disponível
  // para trial e premium (D2) — o handler NUNCA chama requirePremiumOrg.
  capture_leads: { version: 1, idempotency: 'params', description: 'Captura leads por busca híbrida na base própria e, se não bastar, via MCP CNPJ — com proveniência e limite diário' },
  // QA 2026-10-02 (bug 5 do dono) — ADITIVA (AD-6), somente leitura: o texto
  // COMPLETO dos conteúdos gerados aparece no chat para revisão — o agente
  // nunca mais "troca de assunto" quando pedem para ver o e-mail.
  show_content: { version: 1, idempotency: 'none', description: 'Mostra no chat os conteúdos gerados (assunto + texto completo por canal) para revisão' },
  // Onda "IA com a plataforma inteira" (QA 2026-10-02, bugs 1/2/6 do dono) —
  // TODAS ADITIVAS (AD-6): o agente enxerga a org inteira e executa pelo chat
  // o que hoje só existe no painel. Somente leitura: list_campaigns,
  // show_replies, show_dns_records, show_capabilities. Mutadoras com o gate
  // de confirmação do dono (chat-routes): create/rename/duplicate/delete/
  // approve/update_lead.
  list_campaigns: { version: 1, idempotency: 'none', description: 'Lista todas as campanhas da organização (nome, status, audiência) com atalho para abrir' },
  create_campaign: { version: 1, idempotency: 'params', description: 'Cria uma nova campanha (nome + canais) a partir do chat' },
  rename_campaign: { version: 1, idempotency: 'none', description: 'Renomeia a campanha (atual ou indicada por campaignId)' },
  duplicate_campaign: { version: 1, idempotency: 'params', description: 'Duplica uma campanha da organização como rascunho' },
  delete_campaign: { version: 1, idempotency: 'none', description: 'Apaga uma campanha da organização — SEMPRE passa pelo card de confirmação' },
  approve_campaign: { version: 1, idempotency: 'params', description: 'Aprova a campanha (in_review → approved) pelo mesmo fluxo do Pré-voo' },
  // QA 2026-10-06 (dono): disparo SEM fricção — pedido de disparo de campanha
  // aprovada sai NA HORA (disparo único, e-mail + WhatsApp), sem perguntas de
  // agenda; agenda continua existindo para quem PEDIR (set_schedule).
  launch_campaign: { version: 1, idempotency: 'params', description: 'Coloca a campanha em voo AGORA — disparo único imediato pelos canais conectados, sem agenda' },
  update_lead: { version: 1, idempotency: 'none', description: 'Edita dados de um lead (empresa, contato, localidade, porte, setor) com escopo de organização' },
  show_replies: { version: 1, idempotency: 'none', description: 'Mostra as respostas classificadas dos leads (interessados, reuniões, opt-outs) — a caixa de entrada do agente' },
  show_dns_records: { version: 1, idempotency: 'none', description: 'Mostra os registros DNS (SPF/DKIM/DMARC) do domínio de envio e o status de cada um' },
  show_capabilities: { version: 1, idempotency: 'none', description: 'Lista o que o assistente consegue fazer — a resposta canônica para "o que você faz?"' },
  // QA 2026-10-05 (bateria do dono) — ADITIVA (AD-6): cadastrar o e-mail de
  // disparo PELO CHAT (SMTP com App Password ou Resend). Reusa o MESMO
  // serviço do POST /api/email/connect (credenciais validadas antes de
  // salvar). Substituir uma conta existente passa pelo gate de confirmação.
  connect_email: { version: 1, idempotency: 'params', description: 'Conecta a conta de e-mail de disparo (SMTP com App Password ou Resend) — valida as credenciais antes de salvar' },
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
    case 'show_content': {
      // channel é OPCIONAL e fechado (QA 2026-10-06): sem ele o comportamento
      // legado (pacote completo / todos os conteúdos) permanece idêntico.
      if (params.channel && !['email', 'whatsapp', 'linkedin_text'].includes(params.channel)) {
        const err = new Error('channel deve ser "email", "whatsapp" ou "linkedin_text".');
        err.code = 'INVALID_ACTION_PARAMS';
        err.status = 400;
        throw err;
      }
      return true; // tones opcional (default no serviço)
    }
    case 'create_campaign':
    case 'duplicate_campaign': {
      const isDup = action === 'duplicate_campaign';
      if (isDup && !params.campaignId && !params.name) {
        const err = new Error('duplicate_campaign exige `campaignId` (campanha de origem) ou `name`.');
        err.code = 'INVALID_ACTION_PARAMS';
        err.status = 400;
        throw err;
      }
      if (!isDup && !params.name) {
        const err = new Error('create_campaign exige `name`.');
        err.code = 'INVALID_ACTION_PARAMS';
        err.status = 400;
        throw err;
      }
      return true;
    }
    case 'rename_campaign':
    case 'delete_campaign': {
      if (action === 'rename_campaign' && !params.name) {
        const err = new Error('rename_campaign exige `name`.');
        err.code = 'INVALID_ACTION_PARAMS';
        err.status = 400;
        throw err;
      }
      return true; // campaignId opcional (default = campanha aberta)
    }
    case 'approve_campaign':
    case 'launch_campaign':
      // campaignId opcional em ambas: default = campanha aberta no handler.
      return true;
    case 'update_lead': {
      const FIELDS = ['companyName', 'tradeName', 'contactName', 'city', 'state', 'industry', 'employees'];
      const fields = params.fields;
      const hasField =
        fields && typeof fields === 'object' && !Array.isArray(fields) &&
        FIELDS.some((f) => fields[f] !== undefined);
      if (!params.prospectId || typeof params.prospectId !== 'string' || !hasField) {
        const err = new Error(
          `update_lead exige \`prospectId\` e \`fields\` com ao menos um de: ${FIELDS.join(', ')}.`
        );
        err.code = 'INVALID_ACTION_PARAMS';
        err.status = 400;
        throw err;
      }
      return true;
    }
    case 'connect_email': {
      if (!params.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(params.email))) {
        const err = new Error('connect_email exige `email` válido.');
        err.code = 'INVALID_ACTION_PARAMS';
        err.status = 400;
        throw err;
      }
      if (params.provider && !['smtp', 'resend'].includes(params.provider)) {
        const err = new Error('connect_email: provider deve ser "smtp" ou "resend".');
        err.code = 'INVALID_ACTION_PARAMS';
        err.status = 400;
        throw err;
      }
      return true;
    }
    case 'show_replies':
    case 'show_dns_records':
    case 'show_capabilities':
    case 'list_campaigns':
      return true;
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
    case 'attach_files': {
      if (!Array.isArray(params.attachmentIds) || params.attachmentIds.length === 0) {
        const err = new Error('attach_files exige `attachmentIds` (lista não vazia).');
        err.code = 'INVALID_ACTION_PARAMS';
        err.status = 400;
        throw err;
      }
      return true;
    }
    case 'edit_content': {
      const ok = Array.isArray(params.contents) &&
        params.contents.length > 0 &&
        params.contents.every((c) => c && typeof c.id === 'string' && c.id);
      if (!ok) {
        const err = new Error('edit_content exige `contents` (lista não vazia de { id, ...campos }).');
        err.code = 'INVALID_ACTION_PARAMS';
        err.status = 400;
        throw err;
      }
      return true;
    }
    case 'capture_leads':
      // typeof string EXIGIDO: objeto/number viraria String() do handler
      // ("[object Object]" como busca). Trim não vazio corta espaços.
      if (typeof params.query !== 'string' || !params.query.trim()) {
        const err = new Error('capture_leads exige `query` (texto do setor, ex.: "equipamentos agrícolas").');
        err.code = 'INVALID_ACTION_PARAMS';
        err.status = 400;
        throw err;
      }
      return true;
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
