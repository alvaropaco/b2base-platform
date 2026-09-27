'use strict';

/**
 * studio/chat-routes.js — conversa de criação de campanha (chat-first).
 *
 * POST /campaigns/:id/chat {message} → executa o orquestrador e as ações
 * nos serviços reais (segmento, compose, agenda, materiais), persiste a
 * conversa e devolve {reply, cards}. GET devolve o histórico.
 *
 * URLs coladas na mensagem viram materiais automaticamente (contexto para
 * os agentes). Anexos de arquivo usam POST /materials e o materialId é
 * referenciado na conversa.
 */

const { httpError } = require('./errors');
const { createChatAgent } = require('./ai/chat-agent');
const { createComposer } = require('./ai/compose');
const { createExtractor } = require('./ai/extract');
const { generateAndStorePackage } = require('./compose-service');
const segmentService = require('./segment-service');
const campaignService = require('./campaign-service');
const { createMaterialService } = require('./material-service');
const scheduleService = require('./schedule-service');
const manifest = require('./actions/manifest.v1');

const URL_RE = /(https?:\/\/[^\s,;)"]+)/g;

/** Params declarados da action (para hash de idempotência — AD-6). */
function actionParams(action) {
  switch (action.type) {
    case 'set_objective':
      return { objective: action.objective || null, offer: action.offer || null };
    case 'set_audience':
      return { description: action.description || null };
    case 'attach_url':
      return { url: action.url || null };
    case 'confirm_material':
      return { materialId: action.materialId || null };
    case 'generate_content':
      return { tones: action.tones || null };
    case 'set_schedule':
      return {
        mode: action.mode || null,
        startAt: action.startAt || null,
        windows: action.windows || null,
        hourlyLimit: action.hourlyLimit || null,
        dailyLimit: action.dailyLimit || null,
        timezone: action.timezone || null,
        useLeadTimezone: Boolean(action.useLeadTimezone),
      };
    default:
      return {};
  }
}

async function loadCampaign(prisma, orgId, id) {
  const campaign = await prisma.studioCampaign.findUnique({ where: { id } });
  if (!campaign || campaign.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
  return campaign;
}

async function currentExtras(prisma, campaign) {
  const snapshotRows = await prisma.studioAudienceSnapshot.findMany({
    where: { campaignId: campaign.id, status: 'active' },
  });
  const contents = await prisma.studioContent.findMany({
    where: { campaignId: campaign.id, kind: 'base', stepIndex: 1 },
  });
  const materials = await prisma.studioMaterial.findMany({
    where: { orgId: campaign.orgId },
  });
  return {
    audienceCount: snapshotRows[0]?.includedCount ?? null,
    contentSummary: contents.map((c) => ({ channel: c.channel, tone: c.tone, subject: c.subject || c.whatsappText?.slice(0, 60) || null })),
    materials: materials.slice(0, 5).map((m) => ({
      id: m.id, kind: m.kind, status: m.extractionStatus, confirmed: Boolean(m.confirmedAt),
      product: m.extraction?.product || null,
    })),
  };
}

function registerChatRoutes(router, context) {
  const { prisma, overrides = {} } = context;
  const aiDeps = overrides.aiDeps || {};
  const chatAgent = createChatAgent(aiDeps);
  const composer = createComposer(aiDeps);
  const materialService = createMaterialService(prisma, aiDeps);

  /**
   * Executa uma action com IDEMPOTÊNCIA (specs/011, AD-6/FR-9): a primeira
   * execução roda o handler e registra o card em StudioActionRun (unique na
   * chave estável); re-execução (mesmo actionId/params) devolve o MESMO
   * resultado sem tocar serviços — duplo toque não duplica segmento/conteúdo.
   */
  async function runAction(action, { campaign, cards, orgId, userId }) {
    if (!action || !action.type || action.type === 'none') return null;
    if (!manifest.ACTIONS_V1[action.type]) return null;
    const params = actionParams(action);
    manifest.validate(action.type, params);
    const { result, replayed } = await manifest.runIdempotent(prisma, {
      orgId,
      campaignId: campaign.id,
      action: action.type,
      params,
      actionId: action.actionId || null,
      run: () => executeAction(action, { campaign, cards, orgId, userId }),
    });
    if (replayed && result) return { ...result, replayed: true };
    return result;
  }

  /** Handler puro de cada action (efeitos reais nos serviços). */
  async function executeAction(action, { campaign, cards, orgId, userId }) {
    const label = { detail: '' };
    switch (action.type) {
      case 'set_objective': {
        await prisma.studioCampaign.update({
          where: { id: campaign.id },
          data: {
            objective: action.objective ? String(action.objective).slice(0, 2000) : campaign.objective,
            offer: action.offer ? String(action.offer).slice(0, 2000) : campaign.offer,
          },
        });
        campaign.objective = action.objective || campaign.objective;
        return { type: 'objective', label: 'Objetivo definido', detail: String(action.objective || '') };
      }

      case 'set_audience': {
        const segmentNl = require('./ai/segment-nl').createSegmentNl(aiDeps);
        const { criteria, rationale } = await segmentNl.fromPrompt(String(action.description || ''));
        const where = segmentService.buildWhere(orgId, criteria);
        const prospects = await prisma.prospect.findMany({ where });
        const { snapshot } = await campaignService.flow.materializeAudience(prisma, {
          campaign,
          prospectIds: prospects.map((p) => p.id),
        });
        await prisma.studioSegment.create({
          data: {
            orgId,
            name: `Audiência ${new Date().toLocaleDateString('pt-BR')} — ${String(action.description || '').slice(0, 60)}`,
            criteria,
            naturalLanguageInput: String(action.description || ''),
            createdBy: userId,
          },
        });
        return {
          type: 'audience',
          label: 'Audiência montada',
          detail: `${snapshot.includedCount} leads incluídos (${snapshot.excludedCount} excluídos por segurança) — ${rationale || criteriaDescription(criteria)}`,
        };
      }

      case 'attach_url': {
        const material = await materialService.createMaterial({ orgId, userId, url: String(action.url) });
        await materialService.runExtraction(material);
        const updated = await prisma.studioMaterial.findUnique({ where: { id: material.id } });
        const ex = updated.extraction || {};
        return {
          type: 'material',
          label: 'Material anexado e extraído',
          detail: `Produto: ${ex.product || '—'} · Oferta: ${ex.offer || '—'} · Público: ${ex.audience || '—'}. Confere? Posso gerar o conteúdo com isso.`,
          materialId: updated.id,
        };
      }

      case 'confirm_material': {
        const material = await prisma.studioMaterial.findUnique({ where: { id: String(action.materialId) } });
        if (!material || material.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Material não encontrado');
        await materialService.confirmExtraction(material, {});
        return { type: 'material_confirmed', label: 'Extração confirmada', detail: 'Material pronto como fonte de conteúdo.' };
      }

      case 'generate_content': {
        await context.requirePremiumOrg(orgId);
        // Fonte: material confirmado da conversa ou o objetivo/oferta da campanha.
        const materials = await prisma.studioMaterial.findMany({ where: { orgId } });
        const confirmed = materials.find((m) => m.confirmedAt && m.extractionStatus === 'extracted');
        const sourceText = confirmed
          ? JSON.stringify(confirmed.extraction)
          : [campaign.objective, campaign.offer].filter(Boolean).join(' — ') || campaign.name;
        const tones = (Array.isArray(action.tones) && action.tones.length ? action.tones : ['formal', 'comercial']).slice(0, 3);
        const settings = await prisma.commercialSettings.findUnique({ where: { orgId } });
        const created = await generateAndStorePackage(prisma, composer, {
          campaign,
          sourceText,
          tones,
          orgId,
          orgContext: settings ? `${settings.companyName || ''} vende ${settings.productDescription || '?'}` : null,
        });
        // FR-26: origem dos dados citada no card — o vendedor vê de onde veio
        // cada campo antes de aprovar. Derivado da fonte usada na geração.
        const sources = confirmed
          ? [
              confirmed.extraction?.product && `Produto: ${confirmed.extraction.product}`,
              confirmed.extraction?.offer && `Oferta: ${confirmed.extraction.offer}`,
              confirmed.extraction?.audience && `Público: ${confirmed.extraction.audience}`,
            ].filter(Boolean)
          : [campaign.objective && `Objetivo: ${campaign.objective}`, campaign.offer && `Oferta: ${campaign.offer}`].filter(
              Boolean
            );
        return {
          type: 'content',
          label: 'Conteúdo gerado (em revisão)',
          detail: `${created.length} variações criadas: ${tones.join(', ')} — revise na lista de conteúdos abaixo.`,
          sources,
        };
      }

      case 'set_schedule': {
        const windows = Array.isArray(action.windows) ? action.windows : [];
        for (const w of windows) {
          const daysOk = Array.isArray(w.days) && w.days.every((d) => d >= 1 && d <= 7);
          if (!daysOk || !(w.startHour >= 0 && w.startHour < 24 && w.endHour > w.startHour && w.endHour <= 24)) {
            throw httpError('INVALID_WINDOW', 400, 'Janela de envio inválida.');
          }
        }
        const schedule = {
          mode: action.mode === 'immediate' ? 'immediate' : 'scheduled',
          startAt: action.startAt || null,
          windows,
          hourlyLimit: Number(action.hourlyLimit) || 5,
          dailyLimit: Number(action.dailyLimit) || 30,
          timezone: action.timezone || 'America/Sao_Paulo',
          useLeadTimezone: Boolean(action.useLeadTimezone),
        };
        const data = { schedule };
        // Campanha aprovada + modo agendado → transita para "scheduled".
        if (campaign.status === 'approved' && schedule.mode === 'scheduled') {
          campaignService.assertTransition(campaign.status, 'scheduled');
          data.status = 'scheduled';
        }
        const updated = await prisma.studioCampaign.update({ where: { id: campaign.id }, data });
        Object.assign(campaign, updated);
        // Previsão de conclusão só faz sentido com audiência definida.
        const audienceCount = (await currentExtras(prisma, campaign)).audienceCount || 0;
        const forecast = audienceCount > 0 ? scheduleService.forecast(schedule, audienceCount) : null;
        return {
          type: 'schedule',
          label: 'Agendamento configurado',
          detail: `${schedule.hourlyLimit}/h · ${schedule.dailyLimit}/dia${
            schedule.windows.length ? ` · janelas ${schedule.windows.map((w) => `${w.startHour}h–${w.endHour}h`).join(', ')}` : ''
          }${
            forecast?.estimatedAt
              ? ` · conclusão prevista ${new Date(forecast.estimatedAt).toLocaleString('pt-BR')}`
              : ' · defina a audiência para ver a previsão de conclusão'
          }`,
        };
      }

      case 'none':
      default:
        return null;
    }
  }

  function criteriaDescription(criteria) {
    return (criteria?.groups || [])
      .flatMap((g) => g.conditions || [])
      .map((c) => `${c.field} ${c.op} ${Array.isArray(c.value) ? c.value.join('/') : c.value}`)
      .join(' E ');
  }

  // Rótulos das etapas em pt-BR — exibidos ao vivo no chat (status SSE).
  const ACTION_LABELS = {
    set_objective: 'Definindo objetivo…',
    set_audience: 'Criando audiência…',
    attach_url: 'Anexando e extraindo material…',
    confirm_material: 'Confirmando extração…',
    generate_content: 'Gerando conteúdo…',
    set_schedule: 'Configurando agendamento…',
  };

  /**
   * Um turno completo da conversa. `onEvent(event)` transmite o progresso ao
   * vivo (usado pelo SSE; o POST síncrono ignora). Eventos:
   *   {type:'status',  phase:'thinking'|label}
   *   {type:'reply',   text}
   *   {type:'status',  label}                  — antes de cada ação
   *   {type:'card',    card} | {type:'card_error', card}
   *   {type:'done',    cards, campaignStatus}
   */
  async function runChatTurn(prismaClient, { campaign, message, orgId, userId, onEvent = () => {} }) {
    const emit = (event) => onEvent(event);

    // URLs coladas viram materiais automaticamente (contexto dos agentes).
    const urls = [...message.matchAll(URL_RE)].map((m) => m[1]).slice(0, 3);
    const autoAttachCards = [];
    for (const url of urls) {
      emit({ type: 'status', label: ACTION_LABELS.attach_url });
      const result = await runAction({ type: 'attach_url', url }, { campaign, cards: autoAttachCards, orgId, userId });
      if (result) {
        autoAttachCards.push(result);
        emit({ type: 'card', card: result });
      }
    }

    emit({ type: 'status', phase: 'thinking' });
    const history = await prismaClient.studioChatMessage.findMany({
      where: { campaignId: campaign.id },
    });
    const userMessage = await prismaClient.studioChatMessage.create({
      data: {
        orgId,
        campaignId: campaign.id,
        role: 'user',
        text: message,
        attachments: urls.map((url) => ({ kind: 'url', url })),
      },
    });

    const extras = await currentExtras(prismaClient, campaign);
    const { reply, actions } = await chatAgent.orchestrate({
      campaign,
      history: [...history, userMessage],
      userMessage: message,
      extras,
    });
    emit({ type: 'reply', text: reply });

    const cards = [...autoAttachCards];
    for (const action of actions) {
      const label = ACTION_LABELS[action.type];
      if (label) emit({ type: 'status', label });
      try {
        const card = await runAction(action, { campaign, cards, orgId, userId });
        if (card) {
          cards.push(card);
          emit({ type: 'card', card });
        }
      } catch (err) {
        // Ação falha não derruba a conversa — vira card de erro.
        const errorCard = { type: 'error', label: `Ação "${action.type}" falhou`, detail: err.message };
        cards.push(errorCard);
        emit({ type: 'card_error', card: errorCard });
      }
    }

    await prismaClient.studioChatMessage.create({
      data: { orgId, campaignId: campaign.id, role: 'assistant', text: reply, cards },
    });
    emit({ type: 'done', cards, campaignStatus: campaign.status });
    return { reply, cards, campaignStatus: campaign.status };
  }

  // POST /campaigns/:id/chat — conversa síncrona (compatibilidade/testes).
  router.post('/campaigns/:id/chat', async (req, res, next) => {
    try {
      const { orgId, userId } = req.studio;
      const campaign = await loadCampaign(prisma, orgId, req.params.id);
      const message = String((req.body || {}).message || '').trim();
      if (!message) throw httpError('INVALID_MESSAGE', 400, 'Mensagem vazia.');
      const result = await runChatTurn(prisma, { campaign, message, orgId, userId });
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  // POST /campaigns/:id/chat/stream — SSE: progresso ao vivo do turno
  // (pensando → etapas → cards → done). Conexão unidirecional back→front.
  router.post('/campaigns/:id/chat/stream', async (req, res, next) => {
    try {
      const { orgId, userId } = req.studio;
      const campaign = await loadCampaign(prisma, orgId, req.params.id);
      const message = String((req.body || {}).message || '').trim();
      if (!message) throw httpError('INVALID_MESSAGE', 400, 'Mensagem vazia.');

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // nginx/ingress: não bufferizar o stream
      });
      const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      // Heartbeat: mantém proxies vivos durante chamadas longas de LLM.
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => clearInterval(heartbeat));

      try {
        send('status', { phase: 'thinking' });
        await runChatTurn(prisma, {
          campaign,
          message,
          orgId,
          userId,
          onEvent: (event) => {
            if (event.type === 'status') {
              if (event.phase) send('status', { phase: event.phase });
              else send('status', { label: event.label });
            } else if (event.type === 'reply') {
              send('reply', { text: event.text });
            } else if (event.type === 'card') {
              send('card', { card: event.card });
            } else if (event.type === 'card_error') {
              send('card_error', { card: event.card });
            }
          },
        });
        send('done', { campaignStatus: campaign.status });
      } catch (err) {
        send('error', { message: err.message });
      } finally {
        clearInterval(heartbeat);
        res.end();
      }
    } catch (err) {
      next(err);
    }
  });

  // GET /campaigns/:id/chat — histórico da conversa.
  router.get('/campaigns/:id/chat', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await loadCampaign(prisma, orgId, req.params.id);
      const data = await prisma.studioChatMessage.findMany({
        where: { campaignId: campaign.id },
      });
      data.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  });

  // GET /campaigns/:id/state — estado consolidado para o painel lateral.
  router.get('/campaigns/:id/state', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await loadCampaign(prisma, orgId, req.params.id);
      res.json({ success: true, data: { campaign, extras: await currentExtras(prisma, campaign) } });
    } catch (err) {
      next(err);
    }
  });

  // POST /campaigns/:id/actions — Chip-ação (specs/011, FR-9): tocar um chip
  // executa a action semântica de backend (idempotente por actionId). Body:
  // { type, params?, actionId? }. Turnos só entram no histórico na 1ª
  // execução — replay não duplica o thread (FR-4).
  router.post('/campaigns/:id/actions', async (req, res, next) => {
    try {
      const { orgId, userId } = req.studio;
      await context.requirePremiumOrg(orgId);
      const campaign = await loadCampaign(prisma, orgId, req.params.id);
      const body = req.body || {};
      const action = {
        type: String(body.type || ''),
        actionId: body.actionId ? String(body.actionId) : undefined,
        ...(body.params || {}),
      };
      const cards = [];
      const card = await runAction(action, { campaign, cards, orgId, userId });
      if (!card) throw httpError('UNKNOWN_ACTION', 400, `Ação desconhecida: ${action.type}`);
      if (!card.replayed) {
        // O turno fica no histórico: o Cockpit é o diário da campanha (FR-4).
        await prisma.studioChatMessage.create({
          data: {
            orgId,
            campaignId: campaign.id,
            role: 'user',
            text: card.label || action.type,
            attachments: [],
          },
        });
        await prisma.studioChatMessage.create({
          data: {
            orgId,
            campaignId: campaign.id,
            role: 'assistant',
            text: card.label || 'Feito.',
            cards: [{ ...card, detail: card.detail || '' }],
          },
        });
      }
      // Status pós-ação (re-lê a campanha — o objeto em memória está pré-ação).
      const updated = await prisma.studioCampaign.findUnique({ where: { id: campaign.id } });
      res.json({ success: true, data: { card, campaignStatus: updated ? updated.status : campaign.status } });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { registerChatRoutes };
