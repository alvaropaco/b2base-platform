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

const crypto = require('crypto');
const { httpError } = require('./errors');
const { createChatAgent, extractRenameTarget, extractCreateTarget, leadCaptureIntent, extractCaptureQuery, extractCaptureState, extractChannelIntent, testMessageIntent, launchLimitHint } = require('./ai/chat-agent');
const { createComposer } = require('./ai/compose');
const { createExtractor } = require('./ai/extract');
const { generateAndStorePackage, generateAndStoreWhatsApp } = require('./compose-service');
const variables = require('./variables');
const segmentService = require('./segment-service');
const campaignService = require('./campaign-service');
const { createMaterialService } = require('./material-service');
const scheduleService = require('./schedule-service');
const manifest = require('./actions/manifest.v1');
const { normalizeText } = require('../search-text');

const URL_RE = /(https?:\/\/[^\s,;)"]+)/g;

// Espera pelo QR do pareamento no chat (tests aceleram via STUDIO_QR_WAIT_MS).
const QR_WAIT_MS = Number(process.env.STUDIO_QR_WAIT_MS || 25000);

/** Params declarados da action (para hash de idempotência — AD-6). */
function actionParams(action) {
  switch (action.type) {
    case 'set_objective':
      return { objective: action.objective || null, offer: action.offer || null };
    case 'set_audience': {
      // Hash de idempotência COMPATÍVEL com o pré-deploy (AD-6): `criteria`
      // entra nos params SÓ quando veio (chips de recuperação, FR6) — sem
      // ele, a chave é a LEGADA ({description} apenas) e replays de rows
      // gravadas antes do deploy continuam sendo replay (não re-executam).
      const params = { description: action.description || null };
      if (action.criteria) params.criteria = action.criteria;
      return params;
    }
    case 'attach_url':
      return { url: action.url || null };
    case 'confirm_material':
      return { materialId: action.materialId || null };
    case 'generate_content': {
      // Mesma tática do `criteria` (AD-6): canal entra nos params SÓ quando
      // veio — chaves antigas continuam batendo replay.
      const params = { tones: action.tones || null };
      if (action.channel) params.channel = action.channel;
      return params;
    }
    case 'show_content':
      return action.channel ? { channel: action.channel } : {};
    case 'show_balance':
    case 'start_whatsapp_pairing':
    case 'list_campaigns':
    case 'show_replies':
    case 'show_dns_records':
    case 'show_capabilities':
      return {};
    // Paridade com o painel Outreach (2026-10-08): whitelist p/ hash AD-6.
    case 'show_suppression':
    case 'disconnect_email':
      return action.email ? { email: action.email } : {};
    case 'add_suppression':
      return { email: action.email || null, reason: action.reason || null };
    case 'remove_suppression':
      return { email: action.email || null };
    case 'enrich_whatsapp':
      return {}; // idempotency none — rodar de novo é intencional (base cresce)
    case 'create_campaign':
      return { name: action.name || null, channels: Array.isArray(action.channels) ? action.channels.map(String) : null };
    case 'rename_campaign':
    case 'delete_campaign':
    case 'approve_campaign':
    case 'launch_campaign':
      // campaignId opcional: default = campanha aberta (escopo org no handler).
      // limit opcional no launch (QA 2026-10-07: disparo parcial).
      return {
        name: action.name || null,
        campaignId: action.campaignId ? String(action.campaignId) : null,
        ...(action.type === 'launch_campaign' && action.limit != null
          ? { limit: Math.max(1, Math.min(500, Math.round(Number(action.limit)) || 0)) || undefined }
          : {}),
      };
    case 'send_test_message':
      return {
        phone: action.phone ? String(action.phone) : null,
        email: action.email ? String(action.email) : null,
        leads: Array.isArray(action.leads) ? action.leads.map(String).slice(0, 50) : null,
      };
    case 'grant_whatsapp_consent':
      return {
        prospectId: action.prospectId ? String(action.prospectId) : null,
        name: action.name ? String(action.name) : null,
      };
    case 'grant_whatsapp_consent_batch': {
      // all:true implícito quando o modelo não especifica nomes — "registra"
      // registra TODOS de uma vez (diretriz do dono: nada de 'continua').
      const params = { all: action.all === true || !((Array.isArray(action.names) && action.names.length > 0)) };
      if (Array.isArray(action.names) && action.names.length > 0) params.names = action.names.map(String).slice(0, 200);
      return params;
    }
    case 'select_content_variant':
      return {
        channel: action.channel ? String(action.channel) : null,
        tone: action.tone ? String(action.tone) : null,
      };
    case 'duplicate_campaign':
      return {
        campaignId: action.campaignId ? String(action.campaignId) : null,
        name: action.name || null,
      };
    case 'update_lead':
      return {
        prospectId: action.prospectId ? String(action.prospectId) : null,
        fields: action.fields && typeof action.fields === 'object' && !Array.isArray(action.fields) ? action.fields : null,
      };
    case 'connect_email':
      // Secret NUNCA entra no card nem no histórico de actions (só no hash
      // de idempotência, que é irreversível).
      return {
        email: action.email || null,
        provider: action.provider || null,
        password: typeof action.password === 'string' ? action.password : null,
        apiKey: typeof action.apiKey === 'string' ? action.apiKey : null,
        smtpHost: action.smtpHost || null,
        smtpPort: action.smtpPort ? Number(action.smtpPort) : null,
        smtpSecure: Boolean(action.smtpSecure),
        fromName: action.fromName || null,
      };
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
    case 'select_leads':
      return {
        set: Array.isArray(action.set) ? action.set.map(String) : null,
        add: Array.isArray(action.add) ? action.add.map(String) : null,
        remove: Array.isArray(action.remove) ? action.remove.map(String) : null,
      };
    case 'attach_files':
      // B18: ids ordenados — a chave de idempotência não depende da ordem.
      return { attachmentIds: (Array.isArray(action.attachmentIds) ? action.attachmentIds : []).map(String).sort() };
    case 'capture_leads':
      // Epic 2 (FR7): o pedido INTEIRO entra no hash de idempotência — repetir
      // a mesma captura devolve o MESMO card sem re-executar (AD-6). query só
      // passa quando é string: coerção aqui esconderia o typeof check do
      // manifest ("[object Object]" nunca vira busca).
      return {
        query: typeof action.query === 'string' ? action.query : null,
        state: typeof action.state === 'string' ? action.state : null,
        city: typeof action.city === 'string' ? action.city : null,
        cnae: typeof action.cnae === 'string' ? action.cnae : null,
        limit: Number(action.limit) || null,
      };
    case 'edit_content': {
      // Só os campos que REALMENTE vieram entram nos params (campo ausente
      // nunca vira null — null não pode apagar subject/emailDoc/ctaUrl) e a
      // lista é ordenada por id: a chave de idempotência não depende da
      // ordem (irmão do B18). Canal/texto (QA 2026-10-06) entram só quando
      // presentes — sem mudar a chave dos edits legados.
      const params = {
        contents: (Array.isArray(action.contents) ? action.contents : [])
          .filter((c) => c && c.id != null)
          .map((c) => {
            const fields = ['subject', 'preheader', 'whatsappText', 'linkedinText', 'ctaUrl', 'emailDoc'];
            const normalized = { id: String(c.id) };
            for (const field of fields) {
              if (c[field] !== undefined) normalized[field] = c[field];
            }
            return normalized;
          })
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
      if (action.channel) params.channel = action.channel;
      if (action.whatsappText != null) params.whatsappText = String(action.whatsappText);
      if (action.text != null) params.text = String(action.text);
      if (action.subject != null) params.subject = String(action.subject);
      return params;
    }
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
  const extras = {
    audienceCount: snapshotRows[0]?.includedCount ?? null,
    contentSummary: contents.map((c) => ({ channel: c.channel, tone: c.tone, subject: c.subject || c.whatsappText?.slice(0, 60) || null })),
    materials: materials.slice(0, 5).map((m) => ({
      id: m.id, kind: m.kind, status: m.extractionStatus, confirmed: Boolean(m.confirmedAt),
      product: m.extraction?.product || null,
    })),
  };

  // Onda "IA com a plataforma inteira" (QA 2026-10-02, bugs 1/2 do dono): o
  // agente enxerga a ORGANIZAÇÃO — as outras campanhas (nome/status) e o
  // tamanho da base — deixando de ficar preso à campanha aberta.
  try {
    const others = await prisma.studioCampaign.findMany({
      where: { orgId: campaign.orgId, id: { not: campaign.id } },
      select: { id: true, name: true, status: true },
      orderBy: { createdAt: 'desc' },
      take: 8,
    });
    extras.campanhas = [
      { id: campaign.id, name: campaign.name, status: campaign.status, atual: true },
      ...others.map((c) => ({ id: c.id, name: c.name, status: c.status })),
    ];
    extras.base = { totalLeads: await prisma.prospect.count({ where: { orgId: campaign.orgId } }) };
  } catch (_e) {
    console.error('[studio/chat] extras: contexto da organização indisponível:', _e);
  }

  // Memória de decisão (Epic 1, FR2): FATO ("audienciaDecidida") SOMENTE
  // quando o segmento MATERIALIZOU >0 (lastCount gravado no set_audience) E
  // ESTA campanha tem snapshot ativo — 0-match, segmento manual ou decisão
  // de outra campanha entram como "histórico recente", sem a regra de nunca
  // re-perguntar.
  try {
    const decided = await prisma.studioSegment.findFirst({
      where: { orgId: campaign.orgId, lastCount: { gt: 0 } },
      orderBy: { createdAt: 'desc' },
    });
    if (decided) {
      const decision = {
        pedido: decided.naturalLanguageInput || null,
        criterios: decided.criteria || null,
        decididoEm: decided.createdAt,
        leadsIncluidos: snapshotRows[0]?.includedCount ?? null,
      };
      if (snapshotRows[0]) extras.audienceCriteria = decision;
      else extras.audienceHistory = decision;
    } else {
      const anySegment = await prisma.studioSegment.findFirst({
        where: { orgId: campaign.orgId },
        orderBy: { createdAt: 'desc' },
      });
      if (anySegment) {
        extras.audienceHistory = {
          pedido: anySegment.naturalLanguageInput || null,
          criterios: anySegment.criteria || null,
          decididoEm: anySegment.createdAt,
          leadsIncluidos: snapshotRows[0]?.includedCount ?? null,
        };
      }
    }
  } catch (_e) {
    console.error('[studio/chat] extras: decisão de audiência indisponível:', _e);
  }

  // Amostra da seleção vigente: o agente cita e manipula leads por nome/id
  // (action select_leads) — mesma fonte do painel lateral de leads.
  try {
    let includedIds = [];
    if (snapshotRows[0]) {
      const members = await prisma.studioAudienceMember.findMany({
        where: { snapshotId: snapshotRows[0].id, included: true },
        take: 40,
      });
      includedIds = members.map((m) => m.prospectId);
      const prospects = includedIds.length
        ? await prisma.prospect.findMany({ where: { id: { in: includedIds } }, select: { id: true, companyName: true } })
        : [];
      const byId = new Map(prospects.map((p) => [p.id, p.companyName]));
      extras.audienceLeadSample = includedIds.map((id) => ({ id, empresa: byId.get(id) || 'lead' }));
    }
    // Leads na base FORA da seleção — INDEPENDENTE de snapshot existir: numa
    // campanha recém-criada (sem audiência) o agente precisava desses ids para
    // "quero exatamente os leads X e Y" e não tinha nenhum (QA E2E 2026-09-28).
    const foraDaSelecao = await prisma.prospect.findMany({
      where: { orgId: campaign.orgId, id: { notIn: includedIds } },
      select: { id: true, companyName: true },
      orderBy: { createdAt: 'desc' },
      take: 40,
    });
      extras.audienceAvailableSample = foraDaSelecao.map((p) => ({ id: p.id, empresa: p.companyName || 'lead' }));
  } catch (_e) {
    console.error('[studio/chat] extras: amostras de leads indisponíveis:', _e);
  }

  // Canais para o agente explicar limites/bloqueios com passo a passo:
  // SALDO ÚNICO (pool e-mail+WhatsApp) + uso do dia/teto diário por canal
  // + status da sessão WhatsApp + domínio do e-mail.
  try {
    const reputation = require('./reputation');
    const wallet = await reputation.getWallet(prisma, campaign.orgId);
    if (wallet) {
      extras.canais = {
        saldoUnico: {
          saldo: wallet.balance,
          disponivel: wallet.available,
          piso: wallet.floor,
          teto: wallet.ceiling,
          saldoBaixo: wallet.lowBalance,
        },
        email: { usoHoje: wallet.usedToday.email, tetoDiario: wallet.caps.email, dominio: wallet.domainAuthStatus },
        whatsapp: { usoHoje: wallet.usedToday.whatsapp, tetoDiario: wallet.caps.whatsapp },
      };
    } else {
      extras.canais = { saldoUnico: null };
    }
    let whatsapp = 'nao_conectado';
    try {
      const account = await prisma.whatsAppAccount.findFirst({ where: { orgId: campaign.orgId } });
      if (account) whatsapp = account.status;
    } catch (_e) { /* modelo ausente em alguns harnesses */ }
    extras.canais.whatsappSessao = whatsapp;
  } catch (_e) {
    console.error('[studio/chat] extras: saldo de canais indisponível:', _e);
  }

  // Respostas quentes recentes: o agente cita QUEM respondeu e rascunha a
  // próxima mensagem — o chip "mostre e responda" vira ação real, não promessa.
  try {
    const rows = await prisma.studioReplyClassification.findMany({ where: { orgId: campaign.orgId }, take: 200 });
    const hotLabels = ['interested', 'meeting_request'];
    const cutoff = Date.now() - 7 * 86_400_000;
    const hot = rows
      .filter((r) => hotLabels.includes(r.label) && Number(r.confidence) >= 0.7 && new Date(r.createdAt).getTime() >= cutoff)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 5);
    if (hot.length > 0) {
      const prospectIds = [...new Set(hot.map((r) => r.prospectId))];
      const prospects = await prisma.prospect.findMany({ where: { id: { in: prospectIds } } });
      const byId = new Map(prospects.map((p) => [p.id, p]));
      extras.respostasQuentes = hot.map((r) => {
        const p = byId.get(r.prospectId);
        return {
          empresa: p?.companyName || 'lead',
          contato: p?.firstName || p?.email || null,
          canal: r.channel,
          interesse: r.label,
          confianca: Math.round(Number(r.confidence) * 100) + '%',
          recebidaEm: r.createdAt,
        };
      });
    }
  } catch (_e) {
    console.error('[studio/chat] extras: respostas quentes indisponíveis:', _e);
  }

  // Marca: diretriz de voz + assets de contexto (txt/md lidos, limitados).
  try {
    const rows = await prisma.studioBrandProfile.findMany({ where: { orgId: campaign.orgId } });
    const profile = rows[0];
    if (profile) {
      const assets = (profile.kit?.assets || []).filter(Boolean);
      extras.marca = {
        tomDeVoz: profile.voice?.toneNotes || null,
        assets: assets.map((a) => ({ tipo: a.kind, nome: a.originalName || a.fileName })),
      };
      const storage = require('./storage');
      const contextText = assets
        .filter((a) => a.kind === 'context' && /\.(txt|md)$/i.test(String(a.fileName)))
        .slice(0, 3)
        .map((a) => {
          try { return storage.readBuffer(a.fileName).toString('utf8').slice(0, 1500); } catch (_e) { return ''; }
        })
        .filter(Boolean)
        .join('\n---\n');
      if (contextText) extras.marca.contexto = contextText.slice(0, 4000);
    }
  } catch (_e) {
    console.error('[studio/chat] extras: marca do workspace indisponível:', _e);
  }

  return extras;
}

function registerChatRoutes(router, context) {
  const { prisma, overrides = {} } = context;
  const aiDeps = overrides.aiDeps || {};
  const chatAgent = createChatAgent(aiDeps);
  const composer = createComposer(aiDeps);
  const materialService = createMaterialService(prisma, aiDeps);
  // Epic 2 (FR7/D1): captura híbrida — dependências injetáveis para os testes
  // (fake-prisma não suporta $queryRaw: `vectorSearch` real vive atrás dela).
  const captureService = require('./capture-service').createCaptureService(prisma, {
    embedTexts: overrides.embedTexts,
    vectorSearch: overrides.vectorSearch,
    mcp: overrides.mcpCnpj,
  });
  // Epic 3 (Story 3.1): estado/guard da jornada de criação.
  const journey = require('./journey');

  /**
   * Epic 1 (FR15/F2): resolve a referência do material DENTRO da org — id
   * exato, senão nome normalizado sobre `sourceRef` e `extraction.product`.
   * Determinístico: match único resolve; ambíguo NUNCA resolve sozinho
   * (vira card de desambiguação); nada casando devolve 'missing' (o handler
   * transforma em 404 explicável).
   */
  function materialRefLabel(material) {
    return material.extraction?.product || material.sourceRef || material.kind || material.id;
  }

  async function resolveMaterialRef(orgId, ref) {
    const raw = String(ref || '').trim();
    if (!raw) return { status: 'missing', ref: raw };
    const byId = await prisma.studioMaterial.findUnique({ where: { id: raw } }).catch(() => null);
    if (byId && byId.orgId === orgId) return { status: 'resolved', material: byId };
    const key = normalizeText(raw);
    const materials = await prisma.studioMaterial.findMany({ where: { orgId } });
    const matches = materials.filter((m) => {
      const refs = [m.sourceRef, m.extraction?.product].map((v) => normalizeText(v)).filter(Boolean);
      return refs.some(
        (v) => v === key || (v.length >= 4 && v.includes(key)) || (key.length >= 4 && key.includes(v))
      );
    });
    if (matches.length === 1) return { status: 'resolved', material: matches[0] };
    if (matches.length > 1) {
      return {
        status: 'ambiguous',
        ref: raw,
        candidates: matches.map((m) => ({ id: m.id, label: String(materialRefLabel(m)) })),
      };
    }
    return { status: 'missing', ref: raw };
  }

  /**
   * Executa uma action com IDEMPOTÊNCIA (specs/011, AD-6/FR-9): a primeira
   * execução roda o handler e registra o card em StudioActionRun (unique na
   * chave estável); re-execução (mesmo actionId/params) devolve o MESMO
   * resultado sem tocar serviços — duplo toque não duplica segmento/conteúdo.
   */
  async function runAction(action, { campaign, cards, orgId, userId }) {
    if (!action || !action.type || action.type === 'none') return null;
    if (!manifest.ACTIONS_V1[action.type]) return null;
    let params = actionParams(action);
    let effective = action;
    // F2 (FR15): nome em vez de id resolve ANTES do hash de idempotência —
    // a chave continua { materialId }, agora com o id RESOLVIDO (estável).
    // Ambiguidade vira card de desambiguação, nunca falha.
    if (action.type === 'confirm_material') {
      const resolution = await resolveMaterialRef(orgId, action.materialId || action.materialName);
      if (resolution.status === 'ambiguous') {
        return {
          type: 'material_ambiguous',
          label: 'Qual material você quer confirmar?',
          detail: `"${resolution.ref}" casa com mais de um material — me diga qual: ${resolution.candidates
            .map((c) => `"${c.label}"`)
            .join(', ')}.`,
          candidates: resolution.candidates,
        };
      }
      if (resolution.status === 'resolved') {
        effective = { ...action, materialId: resolution.material.id };
        params = { ...params, materialId: resolution.material.id };
      }
      if (resolution.status === 'missing' && !params.materialId && resolution.ref) {
        // Nome que não casou com nada: segue com a referência crua — o handler
        // vira 404 explicável ("Material não encontrado"), não 400 de schema.
        effective = { ...action, materialId: resolution.ref };
        params = { ...params, materialId: resolution.ref };
      }
    }
    manifest.validate(action.type, params);
    // Epic 3 (Story 3.1): guard da jornada — salto À FRENTE com pré-requisito
    // ausente vira card explicável (o que falta + próximo passo), NUNCA run
    // gravada (replay de bloqueio esconderia o avanço seguinte). Ações da
    // fase corrente/anterior nunca chegam aqui bloqueadas.
    const journeyGuard = journey.guardAction(action.type, await journey.guardState(prisma, campaign));
    if (!journeyGuard.ok) return journeyGuard.card;
    // Gate de confirmação (bug 5 do dono): alteração de artefato existente
    // pede licença ANTES de executar. Replay idempotente pula o gate (o que
    // já foi aprovado e executado devolve o mesmo card — duplo toque NUNCA
    // vira segunda pergunta). O selo `confirmed` vem do chip "Confirmar" ou
    // da aprovação textual detectada no runChatTurn — gesto explícito passa.
    // (Lido do ACTION, não dos params: actionParams é whitelist por tipo e
    // não carrega o selo.)
    if (!action.confirmed && !params.confirmed) {
      const key = manifest.actionKey({
        orgId,
        campaignId: campaign.id,
        action: action.type,
        params,
        actionId: action.actionId || null,
      });
      const prior = key && prisma.studioActionRun
        ? await prisma.studioActionRun.findFirst({ where: { actionKey: key } })
        : null;
      const replayHit = Boolean(prior && prior.status === 'succeeded');
      if (!replayHit) {
        const kind = await confirmRequired(action.type, { campaign, prisma, params });
        if (kind) return buildConfirmCard(action.type, params, kind);
      }
    }
    // Epic 2: recusa/limite/sem-resultado da captura NUNCA persistem replay —
    // gravar a recusa como run 'succeeded' faria a MESMA params devolver a
    // recusa velha para sempre (mesmo depois de configurar o token). Então a
    // captura executa FORA do runIdempotent e SÓ 'captured' grava run; replay
    // de captura feita continua valendo (chave params idêntica → card replayed).
    if (action.type === 'capture_leads') {
      const key = manifest.actionKey({ orgId, campaignId: campaign.id, action: action.type, params, actionId: action.actionId || null });
      const prior = key && prisma.studioActionRun
        ? await prisma.studioActionRun.findFirst({ where: { actionKey: key } })
        : null;
      if (prior && prior.status === 'succeeded' && prior.result && prior.result.status === 'captured') {
        return { ...prior.result, replayed: true };
      }
      const captureResult = await captureService.captureLeads({
        orgId,
        query: action.query,
        state: action.state,
        city: action.city,
        cnae: action.cnae,
        limit: action.limit,
      });
      const captureCard = buildCaptureCard(captureResult);
      if (captureResult.status === 'captured' && key && prisma.studioActionRun) {
        // Mesmo padrão do runIdempotent: run gravada succeeded com o card.
        if (prior) {
          await prisma.studioActionRun.updateMany({
            where: { actionKey: key },
            data: { status: 'succeeded', result: captureCard },
          });
        } else {
          try {
            await prisma.studioActionRun.create({
              data: { orgId, campaignId: campaign.id, action: action.type, actionKey: key, status: 'succeeded', result: captureCard },
            });
          } catch (err) {
            if (err && err.code === 'P2002') {
              // Corrida: outra execução criou a run — atualiza a do vencedor.
              await prisma.studioActionRun.updateMany({
                where: { actionKey: key },
                data: { status: 'succeeded', result: captureCard },
              }).catch(() => {});
            } else {
              throw err;
            }
          }
        }
      }
      return captureCard;
    }
    const { result, replayed } = await manifest.runIdempotent(prisma, {
      orgId,
      campaignId: campaign.id,
      action: action.type,
      params,
      actionId: action.actionId || null,
      run: () => executeAction(effective, { campaign, cards, orgId, userId }),
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
        // Epic 3 (review E3-L6): a fase corrente fica persistida desde o
        // primeiro passo (AC 3.1) — objetivo concluído entra no Json aqui.
        await journey.syncJourney(prisma, campaign, { mark: campaign.objective ? 'objetivo' : null });
        return { type: 'objective', label: 'Objetivo definido', detail: String(action.objective || '') };
      }

      case 'set_audience': {
        const segmentNl = require('./ai/segment-nl').createSegmentNl(aiDeps);
        let criteria;
        let rationale;
        if (action.criteria) {
          // Chip de recuperação (FR6): critério pronto, sem passar pelo LLM.
          criteria = action.criteria;
          segmentService.validateCriteria(criteria);
          rationale = criteriaDescription(criteria);
        } else {
          // FR5: tradução NL→critérios ancorada na base real — amostra dos
          // valores da org entra como few-shot no prompt do segment-nl.
          const { criteria: translated, rationale: why } = await segmentNl.fromPrompt(
            String(action.description || ''),
            { samples: await orgBaseSamples(prisma, orgId) }
          );
          criteria = translated;
          rationale = why;
        }
        const where = segmentService.buildWhere(orgId, criteria);
        const prospects = await prisma.prospect.findMany({ where });
        const baseCount = await prisma.prospect.count({ where: { orgId } });
        const { snapshot } = await campaignService.flow.materializeAudience(prisma, {
          campaign,
          prospectIds: prospects.map((p) => p.id),
        });
        // Epic 3 (Story 3.1): a DECISÃO FECHADA (FR2 — materialização com
        // contagem > 0) marca a fase de audiência como concluída.
        await journey.syncJourney(prisma, campaign, {
          mark: snapshot.includedCount > 0 ? 'audiencia' : null,
          audienceDecided: snapshot.includedCount > 0,
        });
        // O registro do segmento é auxiliar (o snapshot já materializou a
        // audiência): o nome é único por (orgId, nome) e inclui data +
        // descrição, então recriar a MESMA audiência no mesmo dia colide
        // (bug exposto pelo evaluator em 2026-09-28 — reprovava o turno
        // inteiro). Reaproveita o segmento existente e segue com o card.
        const segmentName = `Audiência ${new Date().toLocaleDateString('pt-BR')} — ${String(action.description || '').slice(0, 60)}`;
        const existingSegment = await prisma.studioSegment.findUnique({
          where: { orgId_name: { orgId, name: segmentName } },
        });
        if (!existingSegment) {
          await prisma.studioSegment.create({
            data: {
              orgId,
              name: segmentName,
              criteria,
              naturalLanguageInput: String(action.description || ''),
              // FR2: contagem materializada na decisão — o guard de memória
              // (lastCount > 0) separa FATO de 0-match/segmento manual.
              lastCount: snapshot.includedCount,
              lastCountAt: new Date(),
              createdBy: userId,
            },
          }).catch((err) => {
            if (err?.code === 'P2002') return null; // corrida: outro create venceu
            throw err;
          });
        }
        // Audiência vazia com base populada é o ponto cego nº 1 do chat (QA
        // 2026-09-28, F3): o card nomeia o problema e o total da base para o
        // usuário decidir entre ajustar o segmento ou importar leads.
        const card = buildAudienceCard({ snapshot, baseCount, rationaleText: rationale || criteriaDescription(criteria) });
        // FR6: 0-match NUNCA é beco sem saída — diagnóstico do porquê +
        // proposta materialmente diferente como ação de 1 clique no card.
        if (card.emptyMatch) {
          Object.assign(card, await buildZeroMatchRecovery(prisma, { orgId, criteria, baseCount }));
        }
        return card;
      }

      case 'select_leads': {
        // O agente ajusta a seleção manual de leads (painel lateral e chat
        // operam sobre a MESHA fonte: o snapshot ativo). set substitui;
        // add/remove partem da seleção corrente. Ids de fora da org caem fora.
        const snapshotRows = await prisma.studioAudienceSnapshot.findMany({
          where: { campaignId: campaign.id, status: 'active' },
        });
        const current = snapshotRows[0]
          ? (await prisma.studioAudienceMember.findMany({ where: { snapshotId: snapshotRows[0].id, included: true } })).map(
              (m) => m.prospectId
            )
          : [];
        const requested = new Set(
          Array.isArray(action.set) && action.set.length ? action.set : current
        );
        for (const id of Array.isArray(action.add) ? action.add : []) requested.add(id);
        for (const id of Array.isArray(action.remove) ? action.remove : []) requested.delete(id);
        const candidates = [...requested];
        const owned = candidates.length
          ? (await prisma.prospect.findMany({ where: { id: { in: candidates }, orgId }, select: { id: true } })).map((p) => p.id)
          : [];
        const baseCount = await prisma.prospect.count({ where: { orgId } });
        const { snapshot } = await campaignService.flow.materializeAudience(prisma, {
          campaign,
          prospectIds: owned,
        });
        // Epic 3: seleção explícita com leads também é decisão fechada.
        await journey.syncJourney(prisma, campaign, {
          mark: snapshot.includedCount > 0 ? 'audiencia' : null,
          audienceDecided: snapshot.includedCount > 0,
        });
        const removed = (Array.isArray(action.remove) ? action.remove : []).length;
        const added = (Array.isArray(action.add) ? action.add : []).length;
        const rationaleText = Array.isArray(action.set) && action.set.length
          ? 'seleção definida pelo usuário via chat'
          : `${added} lead(s) adicionado(s), ${removed} removido(s)`;
        return buildAudienceCard({ snapshot, baseCount, rationaleText, label: 'Seleção de leads atualizada' });
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
        // Canal pedido (action.channel vem do modelo OU da frase — injeção
        // determinística no runChatTurn). QA 2026-10-06: "mensagem para
        // whatsapp" tem que criar WhatsApp e NÃO mais e-mails.
        const requestedChannel = ['whatsapp', 'linkedin_text', 'email'].includes(action.channel) ? action.channel : null;
        // Pedido explícito entra nos CANAIS da campanha — sem isso o bridge
        // nunca compila a execução do canal no disparo.
        if (requestedChannel && requestedChannel !== 'email' && !(campaign.channels || []).includes(requestedChannel)) {
          const channels = [...(campaign.channels || []), requestedChannel];
          await prisma.studioCampaign.update({ where: { id: campaign.id }, data: { channels } });
          campaign.channels = channels;
        }
        const settings = await prisma.commercialSettings.findUnique({ where: { orgId } });
        // QA 2026-10-02 (bug 3 do dono): um tom falhando (LLM timeout/JSON
        // num pacote grande) derrubava o pacote INTEIRO — mesmo com o outro
        // tom já criado e salvo. Agora cada tom tem seu próprio orçamento:
        // o que der certo persiste e vira card; o que falhar é dito com
        // honestidade (e o pedido pode ser repetido só dele). Falha NÃO-LLM
        // (validação/DB) continua falhando na hora.
        const created = [];
        const failedTones = [];
        let lastError = null;
        for (const tone of tones) {
          try {
            // WhatsApp tem composer DEDICADO (uma chamada pequena): o caminho
            // multicanal truncava no deepseek e o WhatsApp (tratado como
            // bônus) nunca saía — QA 2026-10-06, 2º round.
            const storeFn = requestedChannel === 'whatsapp' ? generateAndStoreWhatsApp : generateAndStorePackage;
            const part = await storeFn(prisma, composer, {
              campaign,
              sourceText,
              tones: [tone],
              orgId,
              orgContext: settings ? `${settings.companyName || ''} vende ${settings.productDescription || '?'}` : null,
              onlyChannel: requestedChannel,
            });
            if (requestedChannel && requestedChannel !== 'email' && part.length === 0) {
              // O compose dos canais curtos é best-effort: o pack veio sem o
              // canal pedido — honesto, NÃO conta como criado (a IA nunca
              // mais diz "está feito" sem estar).
              failedTones.push(tone);
              lastError = Object.assign(new Error('pack sem o canal pedido'), { code: 'LLM_JSON_FAILED' });
              continue;
            }
            created.push(...part);
          } catch (err) {
            if (!['LLM_JSON_FAILED', 'LLM_TIMEOUT', 'LLM_HTTP_ERROR'].includes(err.code)) throw err;
            failedTones.push(tone);
            lastError = err;
          }
        }
        if (created.length === 0 && lastError) throw lastError;
        // Epic 3 (Story 3.1): conteúdo materializado conclui a fase de conteúdo.
        if (created.length > 0) await journey.syncJourney(prisma, campaign, { mark: 'conteudo' });
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
        const okTones = tones.filter((t) => !failedTones.includes(t));
        const failedNote = failedTones.length
          ? ` O tom ${failedTones.join(', ')} não conseguiu agora — me peça para gerar de novo só ele.`
          : '';
        const CHANNEL_NOUN = { whatsapp: 'mensagem de WhatsApp', linkedin_text: 'texto de LinkedIn', email: 'e-mail' };
        const channelNote = requestedChannel && requestedChannel !== 'email'
          ? `${CHANNEL_NOUN[requestedChannel]}(s) criada(s) — e o canal WhatsApp entrou nos canais da campanha.`
          : `${okTones.length} variação(ões) criada(s): ${okTones.join(', ')}.`;
        const peekLabel = requestedChannel === 'whatsapp' ? 'me mostra a mensagem do WhatsApp' : 'me mostra o e-mail';
        return {
          type: 'content',
          label: 'Conteúdo gerado (em revisão)',
          detail:
            `${channelNote}${failedNote} Me peça "${peekLabel}" para ler tudo aqui no chat.`,
          sources,
          failedTones,
          channel: requestedChannel || undefined,
        };
      }

      case 'show_content': {
        // QA 2026-10-02 (bug 5 do dono): "me manda o e-mail pra eu revisar"
        // virava troca de assunto — o agente não tinha como mostrar o texto
        // no chat (o estado só carrega um resumo de 60 caracteres). Card com
        // o conteúdo COMPLETO por canal; somente leitura, sem idempotência.
        // QA 2026-10-06: "revisa a mensagem de whatsapp" mostrava os E-MAILS
        // (não havia filtro) — o canal pedido (action.channel, do modelo ou
        // da frase) filtra; sem canal, mostra tudo como antes.
        const where = { campaignId: campaign.id, kind: 'base', stepIndex: 1 };
        const requestedChannel = ['whatsapp', 'linkedin_text', 'email'].includes(action.channel) ? action.channel : null;
        if (requestedChannel) where.channel = requestedChannel;
        const contents = await prisma.studioContent.findMany({ where });
        if (contents.length === 0) {
          return {
            type: 'content_empty',
            label: requestedChannel === 'whatsapp' ? 'Ainda não há mensagem de WhatsApp nesta campanha' : 'Ainda não há conteúdo gerado',
            detail:
              requestedChannel === 'whatsapp'
                ? 'Não gerei a mensagem de WhatsApp ainda (só existem e-mails). Me peça para gerar que eu crio aqui mesmo.'
                : 'Não gerei conteúdo para esta campanha ainda. Me peça para gerar que eu crio o e-mail e a mensagem do WhatsApp.',
          };
        }
        const parts = contents.map((c) => {
          if (c.channel === 'email') {
            const body = emailBlocksToText(c.emailDoc);
            return `✉️ E-mail (${c.tone || 'tom padrão'})\n**Assunto:** ${c.subject || '—'}${c.preheader ? `\n${c.preheader}` : ''}\n\n${body || '(corpo vazio)'}`;
          }
          if (c.channel === 'whatsapp') {
            return `📱 WhatsApp (${c.tone || 'tom padrão'})\n${c.whatsappText || '(texto vazio)'}`;
          }
          if (c.channel === 'linkedin_text') {
            return `💼 LinkedIn (${c.tone || 'tom padrão'})\n${c.linkedinText || '(texto vazio)'}`;
          }
          return `• ${c.channel} (${c.tone || 'tom padrão'})`;
        });
        const variantOffer = contents.length > 1
          ? `\n\nHá ${contents.length} variações — me diga "usar a ${contents[0].tone || 'primeira'}" (ou qual preferir) que o disparo segue SÓ com ela.`
          : '';
        return {
          type: 'content_review',
          label: `Seu conteúdo para revisar (${contents.length} item(ns))`,
          detail: parts.join('\n\n—\n\n') + variantOffer + '\n\nQuer ajustar algo? Me diga o que mudar que eu edito aqui mesmo.',
        };
      }

      case 'list_campaigns': {
        // A visão da ORGANIZAÇÃO (bug 1 do dono): todas as campanhas, com
        // audiência vigente — o frontend renderiza atalho para abrir cada uma.
        const campaigns = await prisma.studioCampaign.findMany({
          where: { orgId: campaign.orgId },
          orderBy: { createdAt: 'desc' },
          take: 10,
        });
        const snaps = await prisma.studioAudienceSnapshot.findMany({
          where: { orgId: campaign.orgId, status: 'active' },
        });
        const byCampaign = new Map(snaps.map((s) => [s.campaignId, s.includedCount]));
        return {
          type: 'campaign_list',
          label: `Campanhas da sua organização (${campaigns.length})`,
          detail:
            campaigns
              .map(
                (c) =>
                  `• **${c.name}**${c.id === campaign.id ? ' (aberta agora)' : ''} — ${c.status}` +
                  `${byCampaign.get(c.id) != null ? ` · ${byCampaign.get(c.id)} lead(s) na audiência` : ''}`
              )
              .join('\n') || 'Nenhuma campanha ainda.',
          campaigns: campaigns.map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            audienceCount: byCampaign.get(c.id) ?? null,
            current: c.id === campaign.id,
          })),
        };
      }

      case 'create_campaign': {
        // Mesmo formato do POST /campaigns (origin 'agent' — criação pelo
        // agente é rastreável). A conversa continua na campanha aberta; o
        // card traz o atalho para abrir a nova.
        const created = await prisma.studioCampaign.create({
          data: {
            orgId,
            name: String(action.name).trim().slice(0, 200),
            channels: Array.isArray(action.channels) && action.channels.length ? action.channels.map(String) : ['email'],
            funnelStage: 'middle',
            origin: 'agent',
            status: 'draft',
          },
        });
        return {
          type: 'campaign_created',
          label: `Campanha "${created.name}" criada`,
          detail:
            'Ela começa como rascunho. Abra pelo botão abaixo e me diga o objetivo lá — ou continue criando aqui e abra quando quiser.',
          campaignId: created.id,
          campaignName: created.name,
          channels: created.channels,
        };
      }

      case 'rename_campaign': {
        const target = action.campaignId
          ? await prisma.studioCampaign.findUnique({ where: { id: String(action.campaignId) } })
          : campaign;
        if (!target || target.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
        const oldName = target.name;
        const updated = await prisma.studioCampaign.update({
          where: { id: target.id },
          data: { name: String(action.name).trim().slice(0, 200) },
        });
        return {
          type: 'campaign_renamed',
          label: 'Campanha renomeada',
          detail: `"${oldName}" agora se chama **${updated.name}**.`,
        };
      }

      case 'duplicate_campaign': {
        const source = action.campaignId
          ? await prisma.studioCampaign.findUnique({ where: { id: String(action.campaignId) } })
          : campaign;
        if (!source || source.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Campanha de origem não encontrada');
        const copy = await prisma.studioCampaign.create({
          data: {
            orgId,
            name: String(action.name || `${source.name} (cópia)`).trim().slice(0, 200),
            channels: source.channels,
            objective: source.objective,
            offer: source.offer,
            funnelStage: source.funnelStage,
            origin: 'duplicate',
            sourceCampaignId: source.id,
            status: 'draft',
          },
        });
        return {
          type: 'campaign_created',
          label: `Cópia criada: "${copy.name}"`,
          detail: 'A cópia nasce como rascunho com objetivo/oferta da original (audiência e conteúdo começam do zero — nada reaproveitado por engano).',
          campaignId: copy.id,
          campaignName: copy.name,
          channels: copy.channels,
        };
      }

      case 'delete_campaign': {
        // Mesmas regras do DELETE /campaigns/:id (voo precisa pausar antes).
        const target = action.campaignId
          ? await prisma.studioCampaign.findUnique({ where: { id: String(action.campaignId) } })
          : campaign;
        if (!target || target.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
        if (['running', 'scheduled'].includes(target.status)) {
          throw httpError('CAMPAIGN_IN_FLIGHT', 409, 'Cancele ou pause a campanha antes de removê-la.');
        }
        await prisma.studioContent.deleteMany({ where: { campaignId: target.id } });
        await prisma.studioChatMessage.deleteMany({ where: { campaignId: target.id } });
        await prisma.studioAudienceSnapshot.deleteMany({ where: { campaignId: target.id } });
        await prisma.studioActionRun.deleteMany({ where: { campaignId: target.id } });
        await prisma.studioComplianceReview.deleteMany({ where: { campaignId: target.id } });
        await prisma.studioExperiment.deleteMany({ where: { campaignId: target.id } });
        await prisma.studioRecommendation.deleteMany({ where: { campaignId: target.id } });
        await prisma.studioJourney.deleteMany({ where: { campaignId: target.id } });
        await prisma.studioCampaign.deleteMany({ where: { id: target.id } });
        return {
          type: 'campaign_deleted',
          label: `Campanha "${target.name}" apagada`,
          detail: 'Conteúdos, conversa, audiência e histórico dela saíram junto. Nada enviado foi afetado.',
        };
      }

      case 'approve_campaign': {
        // MESMO fluxo do POST /campaigns/:id/approve (congela audiência +
        // compliance; recusas do serviço viram card explicável no chat).
        const target = action.campaignId
          ? await prisma.studioCampaign.findUnique({ where: { id: String(action.campaignId) } })
          : campaign;
        if (!target || target.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
        const result = await campaignService.flow.approveCampaign(prisma, { campaign: target, userId });
        const approved = result.campaign;
        const dropped = approved.droppedChannels || [];
        return {
          type: 'campaign_approved',
          label: `Campanha "${approved.name}" aprovada`,
          detail:
            'Audiência congelada e conformidade checada. ' +
            (dropped.length
              ? `⚠️ ${dropped.join(' e ')} saíram dos canais (sem conteúdo gerado) — o disparo segue só pelos canais com mensagem. `
              : '') +
            'Me diga **dispara** que eu coloco em voo AGORA (disparo único) — ou me diga quando agendar, se preferir programar.',
          campaignId: approved.id,
          campaignStatus: approved.status,
          droppedChannels: dropped,
        };
      }

      case 'launch_campaign': {
        // Disparo SEM fricção (QA 2026-10-06, pedido do dono): campanha
        // aprovada sai NA HORA — disparo único pelos canais conectados
        // (e-mail + WhatsApp), SEM perguntas de agenda. Agenda existe para
        // quem PEDIR (set_schedule continua intacto).
        const target = action.campaignId
          ? await prisma.studioCampaign.findUnique({ where: { id: String(action.campaignId) } })
          : campaign;
        if (!target || target.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
        await context.requirePremiumOrg(orgId);
        // Já em voo → DISPARO DELTA (QA 2026-10-06: o replay da idempotência
        // travava o re-disparo pós-consentimento; agora recompila, matricula
        // quem falta e reenfileira só os não alocados — nada duplica).
        const alreadyRunning = target.status === 'running';
        if (target.status === 'scheduled') {
          return {
            type: 'campaign_launched',
            label: `Campanha "${target.name}" já tem agenda`,
            detail: 'Ela dispara nas janelas configuradas. Se quiser sair AGORA, me peça para trocar para disparo único.',
            campaignId: target.id,
            campaignStatus: target.status,
          };
        }
        // Conteúdo pronto mas pendente: o pedido de disparo aprova pelo MESMO
        // fluxo do Pré-voo (congela audiência + compliance) — nada pula o gate.
        if (target.status === 'in_review') {
          await campaignService.flow.approveCampaign(prisma, { campaign: target, userId });
          target.status = 'approved';
        }
        if (target.status !== 'approved' && target.status !== 'running') {
          throw httpError('NOT_LAUNCHABLE', 409, 'Para disparar, a campanha primeiro precisa de audiência e conteúdo — me peça para montar isso.');
        }
        const result = await campaignService.flow.runImmediateDispatch(prisma, {
          campaign: target,
          userId,
          allowRunning: alreadyRunning,
          limit: action.limit != null ? Number(action.limit) : undefined,
          overrides: { dispatchImmediate: overrides.dispatchImmediate },
        });
        const launched = result.campaign;
        const d = result.dispatch || {};
        const parts = [];
        let queuedTotal = 0;
        const blockedNotes = [];
        for (const [channel, info] of [['e-mail', d.email], ['WhatsApp', d.whatsapp]]) {
          if (!info) continue;
          const n = Array.isArray(info.enqueued) ? info.enqueued.length : 0;
          queuedTotal += n;
          if (n > 0) parts.push(`${n} por ${channel}`);
          if (info.blocked) {
            blockedNotes.push(`${channel}: ${info.blocked.reason || info.blocked.code}`);
          }
        }
        const detail =
          (queuedTotal > 0
            ? `Disparo único em andamento${action.limit ? ` (primeiros ${queuedTotal} de ${result.audienceTotal || queuedTotal + 1}+)` : ''} — ${parts.join(' + ') || `${queuedTotal} lead(s)`} entrando na fila agora.`
            : 'A fila não começou ainda') +
          (blockedNotes.length
            ? ` ⚠️ ${blockedNotes.join(' · ')} — me peça "ver o saldo" que eu mostro o que falta para liberar.`
            : ' O ritmo é controlado pelo Orçamento de Reputação e você pode pausar quando quiser.');
        // Diagnóstico do PORQUÊ (QA 2026-10-06: card dizia "disparo feito" com
        // a fila vazia — leads sem consentimento WhatsApp e canais não
        // conectados eram invisíveis).
        const launchNotes = [];
        // no_phone (QA 2026-10-07: 14/15 leads capturados SEM telefone — a
        // base CNPJ não retornou celular; o WhatsApp é impossível para eles e
        // o card precisava dizer isso com nomes).
        if (campaign.whatsappExecutionId) {
          const waContacts = await prisma.whatsAppCampaignContact.findMany({
            where: { campaignId: campaign.whatsappExecutionId, status: 'CANCELLED', cancelReason: 'no_phone' },
            take: 200,
          });
          if (waContacts.length > 0) {
            const prospectIds = waContacts.map((c) => c.prospectId);
            const pros = await prisma.prospect.findMany({ where: { id: { in: prospectIds } }, select: { companyName: true, cnpjEmail: true } });
            const comEmail = pros.filter((p) => p.cnpjEmail).length;
            const nomes = pros.slice(0, 5).map((p) => p.companyName).join(', ');
            launchNotes.push(
              `⚠️ ${waContacts.length} lead(s) SEM TELEFONE no cadastro (a base não trouxe celular): ${nomes}` +
              `${pros.length > 5 ? '…' : ''}. WhatsApp é impossível sem número — ` +
              (comEmail > 0 ? `${comEmail} deles têm E-MAIL: me peça para gerar a mensagem de e-mail e disparar por lá, ou atualize os telefones no cadastro.` : 'atualize os telefones no cadastro.')
            );
          }
        }
        if (alreadyRunning) {
          launchNotes.push('Reforço de fila executado na campanha em voo — quem já estava alocado não duplica.');
        }
        const enrollment = result.compiled?.enrollment || {};
        if ((enrollment.whatsappSkippedNoConsent || 0) > 0) {
          launchNotes.push(
            `⚠️ ${enrollment.whatsappSkippedNoConsent} lead(s) ficaram FORA do WhatsApp sem consentimento registrado ` +
            '(regra anti-bloqueio/LGPD). Se o lead autorizou, me diga "<nome do lead> autorizou WhatsApp" que eu registro e sigo o disparo.'
          );
        }
        for (const sk of result.compiled?.channels?.skipped || []) {
          launchNotes.push(
            sk.channel === 'email'
              ? '⚠️ E-mail ficou de fora: nenhuma conta de disparo conectada — me peça para conectar seu e-mail.'
              : `⚠️ ${sk.channel} ficou de fora: canal não conectado.`
          );
        }
        // HONESTIDADE DO DISPARO (QA 2026-10-08, reclamação do dono: a IA
        // disse "disparo real em andamento" com 0 leads na fila — os 2 eram
        // sem telefone e 1 sem consentimento). Quando NADA entra na fila, o
        // rótulo grita a verdade para o modelo não romantizar o reply.
        const nadaSaiu = queuedTotal === 0;
        return {
          type: 'campaign_launched',
          label: nadaSaiu
            ? `Campanha "${launched.name}" em voo — mas NADA saiu ainda (0 leads na fila)`
            : `Campanha "${launched.name}" em voo`,
          detail: nadaSaiu
            ? `Nenhum lead entrou na fila agora — os motivos estão abaixo, um por um. ${detail} ${launchNotes.join(' ')}`.trim()
            : queuedTotal > 0
              ? detail
              : `${detail} ${launchNotes.join(' ')}`.trim(),
          notes: launchNotes,
          campaignId: launched.id,
          campaignStatus: launched.status,
          queuedTotal,
          nadaSaiu,
          blocked: d.blocked || null,
        };
      }

      case 'grant_whatsapp_consent': {
        // Caminho para consentir (FR-35) pelo chat: o DONO atesta que o lead
        // autorizou; o registro leva source/evidence para auditoria. Sem isso
        // a matrícula do WhatsApp pula o lead (regra anti-bloqueio/LGPD).
        let lead = null;
        if (action.prospectId) {
          lead = await prisma.prospect.findUnique({ where: { id: String(action.prospectId) } });
        } else if (action.name) {
          const term = String(action.name).trim();
          if (term.length < 3) throw httpError('INVALID_NAME', 400, 'Nome do lead muito curto — me diga a empresa (ou contato).');
          lead =
            (await prisma.prospect.findFirst({ where: { orgId, companyName: { contains: term } } })) ||
            (await prisma.prospect.findFirst({ where: { orgId, tradeName: { contains: term } } })) ||
            (await prisma.prospect.findFirst({ where: { orgId, contactName: { contains: term } } }));
        }
        if (!lead || lead.orgId !== orgId) {
          throw httpError('NOT_FOUND', 404, 'Lead não encontrado nesta organização — me diga o nome da empresa como está na lista.');
        }
        const certificate = require('./certificate');
        const { consent, replayed } = await certificate.grantConsent(prisma, {
          orgId,
          prospectId: lead.id,
          source: 'manual',
          grantedById: userId,
          evidence: { declaredBy: 'owner-chat', campaignId: campaign.id },
        });
        return {
          type: 'consent_granted',
          label: replayed ? `Consentimento de ${lead.companyName} já estava registrado` : `Consentimento WhatsApp registrado: ${lead.companyName}`,
          detail:
            (replayed ? 'Nada mudou — ' : 'Registrado em auditoria (fonte: atesto do dono pelo chat) — ') +
            'agora o lead entra na matrícula do WhatsApp. Me peça "dispara" que eu sigo o disparo.',
          prospectId: lead.id,
        };
      }

      case 'select_content_variant': {
        // Escolha de VARIANTE (QA 2026-10-07: o dono escolhia 'comercial' e
        // as duas variantes seguiam no pré-voo/disparo — duas mensagens pro
        // mesmo lead). A escolhida permanece base; as irmãs são ARQUIVADAS
        // (preservadas para re-seleção) e as execuções em voo ressincronizam.
        const channel = ['whatsapp', 'email', 'linkedin_text'].includes(String(action.channel || '').trim().toLowerCase())
          ? String(action.channel).trim().toLowerCase()
          : null;
        if (!channel) throw httpError('INVALID_CHANNEL', 400, 'Canal inválido — use whatsapp, email ou linkedin_text.');
        const tone = String(action.tone || '').trim().toLowerCase();
        const rows = await prisma.studioContent.findMany({
          where: { campaignId: campaign.id, kind: 'base', stepIndex: 1, channel },
        });
        if (rows.length === 0) throw httpError('NO_CONTENT', 409, 'A campanha não tem conteúdo desse canal — me peça para gerar.');
        const chosen =
          rows.find((r) => String(r.tone || '').toLowerCase() === tone) ||
          rows.find((r) => String(r.variantLabel || '').toLowerCase() === tone);
        if (!chosen) {
          throw httpError('TONE_NOT_FOUND', 404, `Variações disponíveis para ${channel}: ${rows.map((r) => r.tone || r.variantLabel).join(', ')}.`);
        }
        const archived = [];
        for (const row of rows) {
          if (row.id === chosen.id) continue;
          await prisma.studioContent.update({ where: { id: row.id }, data: { kind: 'archived' } });
          archived.push(row.tone || row.variantLabel || row.id);
        }
        // Sincroniza execuções em voo: O conteúdo do canal passa a ser a
        // escolhida (mesmo refresh do reconcile do bridge).
        const bridge = require('./channel-bridge');
        const { emailDocToText, unsubscribeHeaders, unsubscribeFooter, compileSteps } = bridge;
        if (channel === 'email' && campaign.emailExecutionId) {
          await prisma.outreachCampaign.update({
            where: { id: campaign.emailExecutionId },
            data: {
              emailTemplateSubject: chosen.subject || campaign.name,
              ...(chosen.emailDoc ? { emailTemplateBody: `${emailDocToText(chosen.emailDoc)}\n\n${unsubscribeFooter({ unsubscribeMailto: chosen.unsubscribeMailto })}` } : {}),
              emailHeaders: unsubscribeHeaders({ unsubscribeUrl: chosen.unsubscribeUrl, unsubscribeMailto: chosen.unsubscribeMailto }),
            },
          }).catch(() => {});
        }
        if (channel === 'whatsapp' && campaign.whatsappExecutionId) {
          const steps = compileSteps(chosen, []);
          await prisma.whatsAppSequenceStep.deleteMany({ where: { campaignId: campaign.whatsappExecutionId } }).catch(() => {});
          for (const step of steps) {
            await prisma.whatsAppSequenceStep.create({ data: { campaignId: campaign.whatsappExecutionId, ...step } }).catch(() => {});
          }
        }
        return {
          type: 'content_variant_selected',
          label: `Variante selecionada: ${channel} (${chosen.tone || chosen.variantLabel || 'padrão'})`,
          detail:
            (archived.length > 0
              ? `As outras variação(ões) (${archived.join(', ')}) foram arquivadas — o disparo segue SÓ com a escolhida. `
              : 'Ela é a única deste canal. ') +
            'Me peça "dispara" quando quiser colocar em voo.',
          channel,
          tone: chosen.tone,
          contentId: chosen.id,
        };
      }

      case 'grant_whatsapp_consent_batch': {
        // LOTE (QA 2026-10-07: o modelo emitia 1 action por lead — 50 actions
        // estouravam o turno com CHAT_FAILED). Modos:
        //   { all: true }            → TODOS os leads da audiência sem consent
        //   { names: ["A", "B"] }    → os citados
        // Sempre idempotente (quem já tem consentimento não é re-registrado).
        await context.requirePremiumOrg(orgId);
        const certificate = require('./certificate');
        let targets = [];
        const wantsAll = action.all === true || (!Array.isArray(action.names) || action.names.length === 0);
        if (wantsAll) {
          const snapshot = (
            await prisma.studioAudienceSnapshot.findMany({ where: { campaignId: campaign.id, status: 'active' } })
          )[0];
          if (!snapshot) throw httpError('NO_AUDIENCE', 409, 'A campanha não tem audiência montada ainda.');
          const members = await prisma.studioAudienceMember.findMany({ where: { snapshotId: snapshot.id, included: true } });
          const consented = new Set(
            (await prisma.studioLeadConsent.findMany({ where: { orgId, channel: 'whatsapp' } })).map((c) => c.prospectId)
          );
          targets = members.filter((m) => !consented.has(m.prospectId)).map((m) => m.prospectId);
          if (targets.length === 0) {
            return { type: 'consent_granted', label: 'Todos os leads da audiência já têm consentimento', detail: 'Nada a registrar — pode disparar.', granted: 0, replayed: true };
          }
        } else if (Array.isArray(action.names) && action.names.length) {
          for (const term of action.names.map(String).map((n) => n.trim()).filter(Boolean)) {
            const lead =
              (await prisma.prospect.findFirst({ where: { orgId, companyName: { contains: term } } })) ||
              (await prisma.prospect.findFirst({ where: { orgId, tradeName: { contains: term } } })) ||
              (await prisma.prospect.findFirst({ where: { orgId, contactName: { contains: term } } }));
            if (lead) targets.push(lead.id);
          }
        }
        if (targets.length === 0) {
          throw httpError('NO_TARGETS', 400, 'Nenhum lead para registrar — me diga os nomes ou peça "registra o consentimento de todos".');
        }
        let granted = 0;
        let already = 0;
        for (const prospectId of targets) {
          const { replayed } = await certificate.grantConsent(prisma, {
            orgId,
            prospectId,
            source: 'manual',
            grantedById: userId,
            evidence: { declaredBy: 'owner-chat', campaignId: campaign.id },
          });
          if (replayed) already += 1;
          else granted += 1;
        }
        return {
          type: 'consent_granted',
          label: `Consentimento WhatsApp registrado: ${granted} lead(s)${already ? ` (${already} já tinham)` : ''}`,
          detail:
            `${granted} lead(s) habilitado(s) para a matrícula do WhatsApp${already ? `, ${already} já tinham consentimento` : ''}. ` +
            'Me peça "dispara" que eu sigo o disparo.',
          granted,
          already,
        };
      }

      case 'send_test_message': {
        // TESTE antes do disparo (QA 2026-10-06, pedido do dono: novos
        // usuários precisam ver a mensagem antes de ir para todos os leads).
        // Mesma semântica do POST /api/outreach/campaigns/test do painel:
        // dados de exemplo, destino ÚNICO informado — nada toca a audiência,
        // a fila ou o saldo de reputação.
        const { renderTemplate, normalizePhone, toChatId } = require('../whatsapp-utils');
        const contents = await prisma.studioContent.findMany({
          where: { campaignId: campaign.id, kind: 'base', stepIndex: 1 },
        });
        if (contents.length === 0) {
          throw httpError('NO_CONTENT', 409, 'A campanha ainda não tem mensagem gerada — me peça para gerar antes do teste.');
        }
        // Exemplo com os DADOS DO DONO (QA 2026-10-06: o teste precisa
        // mostrar a variável de nome resolvendo com o nome do PRÓPRIO
        // usuário — persona fictícia "Mariana" confundia o teste).
        const [userRow, ownerSettings] = await Promise.all([
          prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } }),
          prisma.commercialSettings.findUnique({ where: { orgId }, select: { companyName: true } }),
        ]);
        const ownerName =
          userRow?.name ||
          (userRow?.email ? String(userRow.email.split('@')[0][0].toUpperCase() + userRow.email.split('@')[0].slice(1)) : null) ||
          'Mariana Silva';
        const SAMPLE = {
          // Shape que o buildTemplateVars lê (firstName deriva de contactName).
          contactName: ownerName,
          companyName: ownerSettings?.companyName || 'Transportes Alfa Ltda',
          city: 'Curitiba',
          industry: 'Transporte rodoviário de carga',
        };
        const parts = [];
        const crypto = require('crypto');
        const leadNames = (Array.isArray(action.leads) ? action.leads : []).map(String).filter((n) => n.trim());
        const previewMode = leadNames.length > 0; // leads + destino = PRÉVIA (dados do lead, entrega no destino)

        if (action.phone && !previewMode) {
          const phone = normalizePhone(String(action.phone));
          const chatId = toChatId(String(action.phone));
          if (!phone || phone.length < 10) {
            throw httpError('INVALID_PHONE', 400, 'Número inválido — informe com DDD (ex.: 12 99965-7200).');
          }
          const waContent = contents.find((c) => c.channel === 'whatsapp' && c.whatsappText);
          if (!waContent) throw httpError('NO_CONTENT', 409, 'A campanha não tem mensagem de WhatsApp gerada — me peça para gerar.');
          const account = await prisma.whatsAppAccount.findFirst({ where: { orgId, status: 'CONNECTED' } });
          if (!account) throw httpError('NO_CHANNEL', 409, 'O WhatsApp não está conectado — me peça para parear por QR.');
          const waha = require('../waha-provider');
          const renderedWa = renderTemplate(waContent.whatsappText, SAMPLE);
          const result = await waha.WAHAWhatsAppProvider.sendText(account.sessionName, chatId, renderedWa);
          if (!result?.providerMessageId) {
            throw httpError('WAHA_NO_ACK', 502, 'O WhatsApp não confirmou o envio — verifique se a sessão segue conectada.');
          }
          parts.push(`📱 WhatsApp para ${phone} — texto que saiu: "${String(renderedWa).slice(0, 180)}"`);
        }

        if (action.email && !previewMode) {
          const to = String(action.email).trim();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
            throw httpError('INVALID_EMAIL', 400, 'E-mail de teste inválido.');
          }
          const emailContent = contents.find((c) => c.channel === 'email');
          if (!emailContent) throw httpError('NO_CONTENT', 409, 'A campanha não tem e-mail gerado — me peça para gerar.');
          const account = await prisma.emailAccount.findFirst({
            // Mesma tolerância do painel: contas antigas (Gmail) gravam userId,
            // não tenantId — filtrar só por orgId escondia a conta.
            where: { OR: [{ tenantId: orgId }, { userId }], status: 'connected' },
          });
          if (!account) throw httpError('NO_CHANNEL', 409, 'Nenhuma conta de e-mail de disparo conectada — me peça para conectar.');
          const renderedBody = renderTemplate(emailBlocksToText(emailContent.emailDoc), SAMPLE);
          const emailProvider = require('../email-provider');
          await emailProvider.sendEmailForAccount(prisma, account.id, {
            to,
            subject: `[TESTE] ${renderTemplate(emailContent.subject || campaign.name, SAMPLE)}`,
            body: renderedBody,
            htmlBody: `<p>${renderedBody
              .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/\n{2,}/g, '</p><p>')
              .replace(/\n/g, '<br/>')}</p>`,
            messageId: `teste-${crypto.randomUUID()}`,
          });
          parts.push(`✉️ E-mail para ${to}`);
        }

        if (parts.length === 0 && leadNames.length === 0) {
          throw httpError('NO_DESTINATION', 400, 'Me diga para onde vai o teste — um número de WhatsApp, um e-mail ou o nome de um lead.');
        }
        // Leads REAIS pelo nome (QA 2026-10-06: "manda a mensagem para a
        // CONSTRUTORA ANGULAR") — a mensagem sai com os DADOS REAIS do lead
        // (nome/empresa/cidade do cadastro), fora da fila e sem saldo. Quantas
        // vezes e para quantos leads o usuário quiser.
        const leadReports = [];
        const previewPhone = previewMode && action.phone ? String(action.phone) : null;
        const previewEmail = previewMode && action.email ? String(action.email).trim() : null;
        for (const name of leadNames) {
          const term = String(name).trim();
          if (!term) continue;
          const lead =
            (await prisma.prospect.findFirst({ where: { orgId, companyName: { contains: term } } })) ||
            (await prisma.prospect.findFirst({ where: { orgId, tradeName: { contains: term } } })) ||
            (await prisma.prospect.findFirst({ where: { orgId, contactName: { contains: term } } }));
          if (!lead) {
            leadReports.push(`⚠️ ${term}: não encontrei na base da organização — confira o nome.`);
            continue;
          }
          const sentVia = [];
          let renderedLead = '';
          const waContentForLead = contents.find((c) => c.channel === 'whatsapp' && c.whatsappText);
          // Destino WhatsApp: PRÉVIA no número informado (dados do lead,
          // entrega no SEU número) ou, sem destino, o telefone do cadastro.
          const waTarget = previewPhone
            ? previewPhone
            : (Array.isArray(lead.cnpjPhones) ? lead.cnpjPhones.filter(Boolean)[0] : null);
          if (waContentForLead && waTarget) {
            const waAccount = await prisma.whatsAppAccount.findFirst({ where: { orgId, status: 'CONNECTED' } });
            if (waAccount) {
              const chatIdLead = toChatId(String(waTarget));
              const wahaLead = require('../waha-provider');
              renderedLead = renderTemplate(waContentForLead.whatsappText, lead);
              const resultLead = await wahaLead.WAHAWhatsAppProvider.sendText(waAccount.sessionName, chatIdLead, renderedLead);
              if (resultLead?.providerMessageId) sentVia.push('WhatsApp');
            }
          }
          const emailContentForLead = contents.find((c) => c.channel === 'email');
          const emailTarget = previewEmail || lead.cnpjEmail;
          if (emailContentForLead && emailTarget) {
            const emailAccountLead = await prisma.emailAccount.findFirst({
              where: { OR: [{ tenantId: orgId }, { userId }], status: 'connected' },
            });
            if (emailAccountLead) {
              const renderedLead = renderTemplate(emailBlocksToText(emailContentForLead.emailDoc), lead);
              const emailProviderLead = require('../email-provider');
              await emailProviderLead.sendEmailForAccount(prisma, emailAccountLead.id, {
                to: emailTarget,
                subject: renderTemplate(emailContentForLead.subject || campaign.name, lead),
                body: renderedLead,
                htmlBody: `<p>${renderedLead
                  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  .replace(/\n{2,}/g, '</p><p>')
                  .replace(/\n/g, '<br/>')}</p>`,
                messageId: `teste-${crypto.randomUUID()}`,
              });
              sentVia.push('e-mail');
            }
          }
          const renderedForReport = renderedLead || (emailContentForLead ? renderTemplate(emailBlocksToText(emailContentForLead.emailDoc), lead) : '');
          const destinoLabel = (previewPhone || previewEmail)
            ? `prévia com os DADOS DESTE LEAD entregue em ${[previewPhone ? `WhatsApp ${previewPhone}` : null, previewEmail ? `e-mail ${previewEmail}` : null].filter(Boolean).join(' e ')}`
            : 'nos contatos do cadastro dele';
          const semNomeNota = !lead.contactName
            ? ' · ℹ️ cadastro sem nome de contato: a saudação sai sem nome (me peça para atualizar o lead).'
            : '';
          leadReports.push(
            sentVia.length > 0
              ? `✅ ${lead.companyName}: teste por ${sentVia.join(' + ')} (${destinoLabel}) — "${String(renderedForReport).slice(0, 140)}"${semNomeNota}`
              : `⚠️ ${lead.companyName}: nada enviado — sem telefone/e-mail utilizáveis no cadastro ou canal não conectado.`
          );
        }
        const reportLines = [...parts.map((p) => `📱✉️ ${p}`), ...leadReports].filter(Boolean);
        return {
          type: 'test_message_sent',
          label: 'Mensagem de teste enviada',
          detail:
            (reportLines.length > 0 ? `${reportLines.join('\n')}\n\n` : '') +
            (parts.length > 0
              ? `Todo teste sai com a variável de nome resolvendo — para destino manual, com o SEU nome (${SAMPLE.contactName}); para leads, com o nome real deles. `
              : 'Fora da fila e sem gastar o saldo — só coloco em voo quando você pedir. Teste quantas vezes quiser: toda mensagem sai com a variável de nome resolvendo.'),
        };
      }

      case 'update_lead': {
        // Escopo duplo: o lead TEM que ser da organização (constituição IV).
        // Só os campos da lista branca saem — o resto é ignorado, nunca
        // sobrescrito por engano.
        const FIELDS = ['companyName', 'tradeName', 'contactName', 'city', 'state', 'industry', 'employees'];
        const lead = await prisma.prospect.findUnique({ where: { id: String(action.prospectId) } });
        if (!lead || lead.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Lead não encontrado nesta organização');
        const data = {};
        for (const f of FIELDS) {
          if (action.fields[f] === undefined || action.fields[f] === null) continue;
          data[f] = f === 'employees' ? Math.max(0, Math.round(Number(action.fields[f]) || 0)) : String(action.fields[f]).slice(0, 200);
        }
        // Telefone (QA 2026-10-07): leads cancelados 'no_phone' destravam o
        // WhatsApp quando o dono informa o número — normaliza e SUBSTITUI a
        // lista (o valor novo passa a ser a fonte da verdade).
        if (action.fields.cnpjPhones != null) {
          const { normalizePhone } = require('../whatsapp-utils');
          const raw = String(action.fields.cnpjPhones);
          const phones = raw.split(/[,;\/]+/).map((p) => normalizePhone(p)).filter(Boolean);
          if (phones.length === 0) {
            throw httpError('INVALID_PHONE', 400, 'Nenhum telefone válido em "' + raw.slice(0, 40) + '" — informe com DDD (ex.: 12 98873-9001).');
          }
          data.cnpjPhones = phones;
        }
        const updated = await prisma.prospect.update({ where: { id: lead.id }, data });
        return {
          type: 'lead_updated',
          label: `Lead atualizado: ${updated.companyName}`,
          detail: `Campos alterados: ${Object.keys(data).join(', ')}.`,
        };
      }

      case 'show_replies': {
        // A caixa de entrada do agente: respostas classificadas dos leads —
        // as quentes (interesse/reunião, 7 dias) em destaque + o que precisa
        // de revisão humana. Mesma fonte do bloco RESPOSTAS QUENTES.
        const rows = await prisma.studioReplyClassification.findMany({
          where: { orgId: campaign.orgId },
          take: 200,
        });
        if (rows.length === 0) {
          return {
            type: 'replies',
            label: 'Nenhuma resposta de lead ainda',
            detail: 'Quando seus leads responderem (e-mail ou WhatsApp), as classificações aparecem aqui — interessados, pedidos de reunião e opt-outs.',
          };
        }
        const cutoff = Date.now() - 7 * 86_400_000;
        const hot = rows
          .filter((r) => ['interested', 'meeting_request'].includes(r.label) && Number(r.confidence) >= 0.7 && new Date(r.createdAt).getTime() >= cutoff)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
          .slice(0, 5);
        const prospectIds = [...new Set(rows.map((r) => r.prospectId))];
        const prospects = prospectIds.length ? await prisma.prospect.findMany({ where: { id: { in: prospectIds } } }) : [];
        const byId = new Map(prospects.map((p) => [p.id, p]));
        const nameOf = (r) => byId.get(r.prospectId)?.companyName || 'lead';
        const needsReview = rows.filter((r) => r.needsHumanReview).length;
        const hotLines = hot.length
          ? hot.map((r) => `• **${nameOf(r)}** (${r.channel}) — ${r.label === 'meeting_request' ? 'pediu reunião' : 'interessado'} · ${Math.round(Number(r.confidence) * 100)}%`).join('\n')
          : 'Nenhuma resposta quente nos últimos 7 dias.';
        return {
          type: 'replies',
          label: `Respostas dos leads (${rows.length} no total)`,
          detail: `**Quentes (7 dias):**\n${hotLines}\n\n${needsReview > 0 ? `${needsReview} resposta(s) aguardam a sua confirmação no painel de respostas.` : 'Nada aguardando revisão humana.'}`,
          counts: rows.reduce((acc, r) => ({ ...acc, [r.label]: (acc[r.label] || 0) + 1 }), {}),
        };
      }

      case 'show_dns_records': {
        // A promessa do Certificado entregue: os registros do domínio de
        // envio, com o status REAL de cada um (mesma checagem do job diário).
        const dnsVerify = require('./dns-verify');
        const accounts = await prisma.emailAccount.findMany({
          where: { tenantId: orgId, status: 'connected' },
        });
        if (accounts.length === 0) {
          return {
            type: 'dns_records',
            label: 'Nenhum domínio de envio conectado ainda',
            detail: 'Me passe o e-mail de disparo com a API key do Resend (ou SMTP + senha de app) que eu conecto aqui mesmo pelo chat — e aí te mostro os registros DNS do domínio.',
          };
        }
        const domain = accounts[0].sendingDomain || dnsVerify.domainFromEmail(accounts[0].email);
        if (!domain) {
          return { type: 'dns_records', label: 'Domínio de envio desconhecido', detail: 'A conta de e-mail conectada não tem domínio identificável — me informe o endereço completo que eu reverifico.' };
        }
        const detail = await dnsVerify.checkDomain(domain);
        const mark = (ok) => (ok ? '✅' : '⬜');
        return {
          type: 'dns_records',
          label: `DNS do domínio ${domain}`,
          detail:
            `**SPF** ${mark(detail.spf)} — registro TXT na raiz do domínio com \`v=spf1 include:<seu-provedor> ~all\`\n` +
            `**DKIM** ${mark(detail.dkim)} — os registros \`<seletor>._domainkey.${domain}\` vêm do painel do seu provedor de e-mail (copie de lá)\n` +
            `**DMARC** ${mark(detail.dmarc)} — recomendado: TXT em \`_dmarc\` com \`v=DMARC1; p=none; rua=mailto:postmaster@${domain}\`\n\n` +
            (detail.verified
              ? '✅ SPF + DKIM verificados — seu domínio está liberado para disparar.'
              : 'Depois de publicar, me peça "verificar meu domínio de novo" (ou aguarde a revalidação diária).'),
          status: detail,
        };
      }

      case 'connect_email': {
        // MESMO serviço do POST /api/email/connect: valida as credenciais
        // (SMTP real / Resend API) ANTES de salvar; recusas viram card
        // explicável. Secret resolvido aqui — o Resend pode usar a key da
        // plataforma QUANDO ELA EXISTE (QA 2026-10-06: sem ela no ambiente a
        // falha crua "API key obrigatória." não diz o que fazer; o erro tem
        // que ser acionável e o modelo não pode prometer a chave).
        const emailProvider = overrides.emailProvider || require('../email-provider');
        const provider = action.provider === 'smtp' ? 'smtp' : 'resend';
        const secret = provider === 'smtp' ? action.password : (action.apiKey || process.env.RESEND_API_KEY);
        if (!secret) {
          throw httpError(
            'EMAIL_CREDENTIAL_REQUIRED',
            400,
            provider === 'smtp'
              ? 'Falta a senha de app do SMTP — me informe a App Password (e o host/porta, se não for Gmail).'
              : 'Este ambiente não tem a chave Resend da plataforma — me passe a SUA API key do Resend (começa com "re_") ou prefira conectar por SMTP com uma senha de app.'
          );
        }
        const account = await emailProvider.connectEmailAccount(prisma, {
          provider,
          email: String(action.email),
          secret,
          smtpHost: action.smtpHost || undefined,
          smtpPort: action.smtpPort ? Number(action.smtpPort) : undefined,
          smtpSecure: Boolean(action.smtpSecure),
          fromName: action.fromName || undefined,
          userId,
        });
        return {
          type: 'email_connected',
          label: 'E-mail de disparo conectado',
          detail:
            `**${account.email}** (${account.provider}) está pronto para enviar.` +
            (provider === 'resend'
              ? ' Domínio já verificado no Resend — pode disparar assim que o saldo liberar.'
              : ' Falta a autenticação de domínio: me peça "listar os registros DNS", publique no seu provedor e me avise que eu reverifico.'),
          email: account.email,
          provider: account.provider,
        };
      }

      case 'show_capabilities':
        return {
          type: 'capabilities',
          label: 'O que eu consigo fazer',
          detail:
            '**Campanhas** — criar, listar as da sua organização, renomear, duplicar e apagar (sempre confirmo antes de apagar).\n' +
            '**Jornada da campanha aberta** — objetivo, audiência por linguagem natural, ajuste fino de leads, captura de leads novos, conteúdo (gerar, editar e MOSTRAR aqui no chat) e agendamento.\n' +
            '**Aprovação e disparo** — aprovar a campanha pelo mesmo fluxo do Pré-voo, ENVIAR UMA MENSAGEM DE TESTE para o seu WhatsApp ou e-mail antes de valer, COLOCAR EM VOO na hora (disparo único, e-mail e WhatsApp — sem perguntas de agenda) e mostrar o que falta para poder disparar (saldo, certificado).\n' +
            '**Canais** — conectar a conta de e-mail de disparo (Resend com a sua API key ou SMTP com senha de app), DESCONECTAR a conta de envio (disconnect_email — sempre confirmo antes), mostrar os registros DNS (SPF/DKIM/DMARC) do seu domínio e parear o WhatsApp por QR.\n' +
            '**Leads** — consultar e editar dados de empresa/contato, ENRIQUECER a base procurando o WhatsApp das empresas na internet (enrich_whatsapp) e cadastrar nos leads, mostrar as respostas dos leads (interessados, reuniões, opt-outs) e gerenciar a lista de supressão: ver quem está bloqueado (show_suppression), bloquear um e-mail que não deve mais receber disparo (add_suppression) e reabilitar um contato (remove_suppression — sempre confirmo antes).\n\n' +
            'Não faço ainda: publicar os registros DNS no provedor do domínio (eu mostro, você publica) e ler a caixa de entrada inteira fora das respostas classificadas.',
        };

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
        // Epic 3 (Story 3.1): agenda configurada conclui a fase; voo marcado
        // (status scheduled) conclui também a certificação (Pré-voo verde).
        await journey.syncJourney(prisma, campaign, {
          mark: data.status === 'scheduled' ? ['agenda', 'certificado'] : 'agenda',
        });
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

      case 'show_balance':
        return await buildBalanceCard(prisma, orgId);

      case 'start_whatsapp_pairing': {
        // Pareamento WAHA dentro do chat: cria/retoma a sessão do workspace e
        // devolve o QR como card — o usuário nunca sai da conversa.
        const waha = require('../waha-provider');
        if (!waha.isConfigured()) {
          return {
            type: 'whatsapp_qr',
            label: 'WhatsApp indisponível neste ambiente',
            detail: 'O servidor WhatsApp (WAHA) não está configurado. Peça ao administrador para configurar WHATSAPP_WAHA_URL antes de parear.',
            status: 'unavailable',
            qrCode: null,
          };
        }
        const provider = waha.WAHAWhatsAppProvider;
        const sessionName = waha.deterministicSessionName(orgId);
        let account = await prisma.whatsAppAccount.findUnique({ where: { sessionName } });
        if (!account) {
          account = await prisma.whatsAppAccount.create({
            data: { orgId, userId, provider: 'waha', sessionName, status: 'CREATED' },
          });
        }
        try { await provider.createSession(sessionName); } catch (_e) { /* idempotente */ }
        let currentStatus = null;
        try { currentStatus = (await provider.getSessionStatus(sessionName))?.status; } catch (_e) { /* sessão subindo */ }
        if (currentStatus === 'FAILED') {
          try { await provider.restartSession(sessionName); } catch (_e) { /* o wait abaixo decide */ }
        } else if (!currentStatus || ['STOPPED', 'DISCONNECTED'].includes(currentStatus)) {
          await provider.startSession(sessionName);
        }
        await prisma.whatsAppAccount.update({ where: { sessionName }, data: { status: 'STARTING' } }).catch(() => {});
        // Ciclo HONESTO (QA 2026-10-08: sessão em ERROR → "subindo…" eterno e
        // QR nunca vinha): 1ª espera; se a sessão FALHOU (ou sumiu do WAHA),
        // restart + 2ª espera; se AINDA não subiu, card de FALHA explícito —
        // nunca fingir que o QR "está vindo".
        let wait = await waitForChatQr(provider, sessionName, QR_WAIT_MS);
        if (!wait.connected && !wait.qr) {
          let midStatus = null;
          try { midStatus = (await provider.getSessionStatus(sessionName))?.status || null; } catch (_e) { /* ausente */ }
          if (midStatus === 'FAILED' || !midStatus) {
            try { await provider.restartSession(sessionName); } catch (_e) { /* o wait abaixo decide */ }
            await prisma.whatsAppAccount.update({ where: { sessionName }, data: { status: 'STARTING' } }).catch(() => {});
            wait = await waitForChatQr(provider, sessionName, Math.round(QR_WAIT_MS * 0.6));
          }
        }
        if (wait.connected) {
          await prisma.whatsAppAccount.update({ where: { sessionName }, data: { status: 'CONNECTED' } }).catch(() => {});
          return {
            type: 'whatsapp_qr',
            label: 'WhatsApp já está conectado',
            detail: 'A sessão deste workspace está ativa — pode disparar por WhatsApp assim que o saldo permitir.',
            status: 'connected',
            qrCode: null,
          };
        }
        if (wait.qr && wait.qr.qrCode) {
          await prisma.whatsAppAccount.update({ where: { sessionName }, data: { status: 'QR_REQUIRED' } }).catch(() => {});
          return {
            type: 'whatsapp_qr',
            label: 'Pareamento do WhatsApp — escaneie o QR',
            detail: '1. Abra o WhatsApp no celular · 2. Toque em Aparelhos conectados → Conectar aparelho · 3. Aponte a câmera para o QR abaixo. Ele expira em ~1 minuto — se expirar, me peça "mostrar o QR de novo".',
            status: 'qr_required',
            qrCode: wait.qr.qrCode,
          };
        }
        // Não subiu nem com o restart: FALHA explícita (a sessão está ERROR ou
        // nem existe mais no WAHA) — "subindo…" eterno enganava o usuário.
        let lastKnown = null;
        try { lastKnown = (await provider.getSessionStatus(sessionName))?.status || null; } catch (_e) { /* sessão ausente no WAHA */ }
        if (lastKnown === 'FAILED' || !lastKnown) {
          await prisma.whatsAppAccount.update({ where: { sessionName }, data: { status: 'ERROR' } }).catch(() => {});
          return {
            type: 'whatsapp_qr',
            label: 'A sessão do WhatsApp falhou ao iniciar',
            detail:
              'O servidor do WhatsApp (WAHA) NÃO conseguiu subir a sessão desta organização — ela está com erro (ou nem existe mais lá). ' +
              'Me peça "mostrar o QR do WhatsApp" para eu tentar de novo; se falhar de novo, o administrador precisa olhar o servidor do WhatsApp.',
            status: 'failed',
            qrCode: null,
          };
        }
        return {
          type: 'whatsapp_qr',
          label: 'Sessão do WhatsApp ainda subindo…',
          detail: 'A sessão está viva no servidor, mas o QR ainda não apareceu. Me peça "mostrar o QR do WhatsApp" novamente em alguns segundos.',
          status: 'starting',
          qrCode: null,
        };
      }

      case 'attach_files': {
        // Story 2.1 (B14/B18): TODOS os ids precisam casar na org — sucesso
        // parcial silencioso não existe (404 com a lista); vincula à campanha.
        const requestedIds = (Array.isArray(action.attachmentIds) ? action.attachmentIds : []).map(String);
        const found = [];
        for (const id of requestedIds) {
          const attachment = await prisma.studioAttachment.findUnique({ where: { id } });
          if (!attachment || attachment.orgId !== orgId) {
            throw httpError('NOT_FOUND', 404, `Anexo não encontrado nesta organização: ${id}`);
          }
          if (attachment.campaignId && attachment.campaignId !== campaign.id) {
            throw httpError('ATTACHMENT_IN_OTHER_CAMPAIGN', 409, `Anexo "${attachment.originalName}" já pertence a outra campanha — remova-o de lá antes de reutilizar.`);
          }
          found.push(attachment);
        }
        for (const attachment of found) {
          if (attachment.campaignId !== campaign.id) {
            await prisma.studioAttachment.update({
              where: { id: attachment.id },
              data: { campaignId: campaign.id },
            });
          }
        }
        return {
          type: 'attachments',
          label: 'Anexo(s) vinculado(s) à campanha',
          detail: `${found.length} anexo(s) saem na mensagem (${found.map((a) => a.originalName).join(', ')}).`,
          attachmentIds: found.map((a) => a.id),
        };
      }

      case 'edit_content': {
        // Story 3.3/D9: a edição pelo chat REUSA o mesmo serviço do PATCH da
        // UI (validação, sync em voo, contentEdits — AD-6/AD-13).
        let contents = Array.isArray(action.contents) ? action.contents : [];
        // QA 2026-10-06: "troca a mensagem por <texto>" — o modelo NÃO tem o
        // id no estado; canal + texto resolve o conteúdo base AQUI.
        if (contents.length === 0 && action.channel && (action.whatsappText != null || action.text != null || action.subject != null)) {
          // Normaliza o canal (o modelo pode emitir "WhatsApp" — canais são
          // minúsculos no banco; sem isso viraria no-op silencioso).
          const channel = ['whatsapp', 'email', 'linkedin_text'].includes(String(action.channel).trim().toLowerCase())
            ? String(action.channel).trim().toLowerCase()
            : null;
          if (!channel) {
            throw httpError('INVALID_CHANNEL', 400, 'Canal de edição inválido — use whatsapp, email ou linkedin_text.');
          }
          const rows = await prisma.studioContent.findMany({
            where: { campaignId: campaign.id, kind: 'base', stepIndex: 1, channel },
          });
          if (rows.length === 0) {
            throw httpError('NO_CONTENT', 409, 'A campanha não tem conteúdo desse canal para editar — me peça para gerar primeiro.');
          }
          const text = action.whatsappText != null ? String(action.whatsappText) : action.text != null ? String(action.text) : null;
          // O usuário escreve variáveis em snake_case ({{first_name}}); o
          // catálogo é camelCase ({{firstName}}) — apelidos conhecidos são
          // normalizados aqui, senão a validação FR-033 rejeita o texto dele.
          const normalizeVars = (t) => String(t).replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (raw, name) => {
            if (variables.CATALOG[name]) return raw;
            const camel = name.replace(/_([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
            return variables.CATALOG[camel] ? `{{${camel}}}` : raw;
          });
          contents = rows.map((row) => {
            const patch = { id: row.id };
            if (row.channel === 'whatsapp' && text != null) patch.whatsappText = normalizeVars(text);
            if (row.channel === 'linkedin_text' && text != null) patch.linkedinText = normalizeVars(text);
            if (row.channel === 'email' && action.subject != null) patch.subject = normalizeVars(String(action.subject));
            if (row.channel === 'email' && text != null) {
              patch.emailDoc = { blocks: [{ type: 'text', text: normalizeVars(text) }] };
            }
            return patch;
          });
        }
        const result = await campaignService.flow.updateContents(prisma, {
          campaign,
          contents,
          userId,
        });
        const synced = result.sync ? [
          result.sync.email && result.sync.email.synced ? 'e-mail' : null,
          result.sync.whatsapp && result.sync.whatsapp.synced.length > 0 ? `WhatsApp (${result.sync.whatsapp.synced.length} passo(s))` : null,
        ].filter(Boolean) : [];
        return {
          type: 'content_edited',
          label: 'Conteúdo atualizado',
          detail: (result.contentEditRecorded
            ? `Vale a partir de agora para o que ainda não saiu${synced.length ? ` — sincronizado: ${synced.join(' e ')}` : ''}.`
            : 'Conteúdo salvo.') + ' O que já foi enviado não muda.',
          editedCount: result.contents.length,
        };
      }

      // ── Paridade com o painel Outreach (2026-10-08): supressão e conta ──
      // de e-mail pelo chat. Mesmos modelos/caminhos das rotas
      // /api/outreach/suppression e DELETE /api/gmail/accounts/:id.
      case 'show_suppression': {
        const take = 20;
        const [entries, total] = await Promise.all([
          prisma.suppressionList.findMany({ where: { tenantId: orgId }, orderBy: { addedAt: 'desc' }, take }),
          prisma.suppressionList.count({ where: { tenantId: orgId } }),
        ]);
        const shown = entries.length
          ? entries
              .map(
                (e) =>
                  `• **${e.email}** — ${e.reason || 'sem motivo'} · ${new Date(e.addedAt).toLocaleDateString('pt-BR')}`
              )
              .join('\n') + (total > take ? `\n\n…e mais ${total - take} contato(s). Me diga qual e-mail procurar.` : '')
          : 'Nenhum contato na supressão — toda a sua base pode receber mensagem.';
        return {
          type: 'suppression_list',
          label: `Lista de supressão (${total})`,
          detail: shown,
          total,
          entries: entries.map((e) => ({ id: e.id, email: e.email, reason: e.reason, addedAt: e.addedAt })),
        };
      }

      case 'add_suppression': {
        // Mesmo caminho do POST /api/outreach/suppression (upsert por
        // org+email). SEM gate de confirmação: é opt-out/proteção — bloquear
        // contato deve ter fricção zero (LGPD-friendly).
        const email = String(action.email).trim();
        const reason = action.reason ? String(action.reason).slice(0, 200) : 'manual';
        // findUnique+create/update (não upsert): a unique composta
        // tenantId_email funciona igual no Prisma real e no fake de testes.
        const existing = await prisma.suppressionList.findUnique({
          where: { tenantId_email: { tenantId: orgId, email } },
        });
        if (existing) {
          await prisma.suppressionList.update({ where: { id: existing.id }, data: { reason } });
        } else {
          await prisma.suppressionList
            .create({ data: { tenantId: orgId, email, reason } })
            .catch((err) => {
              if (err?.code !== 'P2002') throw err; // corrida: outro create venceu
              return null;
            });
        }
        return {
          type: 'suppression_added',
          label: existing ? `**${email}** já estava na supressão — motivo atualizado para "${reason}"` : `**${email}** entrou na lista de supressão`,
          detail: 'Esse contato não recebe mais disparo de e-mail da sua organização. Para reabilitar, me peça — eu confirmo antes de tirar.',
          email,
          reason,
        };
      }

      case 'remove_suppression': {
        // Mesmo caminho do DELETE /api/outreach/suppression/:id, resolvido
        // por e-mail (o modelo não tem o id). Entrada inexistente é resposta
        // honesta, não falha. Gate de confirmação no confirmRequired.
        const email = String(action.email).trim();
        const result = await prisma.suppressionList.deleteMany({ where: { tenantId: orgId, email } });
        if (result.count === 0) {
          return {
            type: 'suppression_removed',
            label: `**${email}** não está na supressão`,
            detail: 'Nada a fazer — esse contato já pode receber mensagem normalmente.',
            email,
          };
        }
        return {
          type: 'suppression_removed',
          label: `**${email}** reabilitado`,
          detail: 'Saiu da lista de supressão — volta a poder receber disparos de e-mail da sua organização.',
          email,
        };
      }

      case 'disconnect_email': {
        // Mesma semântica do DELETE /api/gmail/accounts/:id (status revoked +
        // segredos nulos), escopada na ORGANIZAÇÃO (o chat vê a org inteira).
        // Sem email e houver mais de uma conta ativa → card de desambiguação
        // (nunca desconecta tudo por engano).
        const where = { tenantId: orgId, status: 'connected', ...(action.email ? { email: String(action.email).trim() } : {}) };
        const accounts = await prisma.emailAccount.findMany({ where, select: { id: true, email: true, provider: true } });
        if (accounts.length === 0) {
          return {
            type: 'email_disconnected',
            label: 'Nenhuma conta de e-mail conectada',
            detail: `Não há conta de envio ativa${action.email ? ` para **${String(action.email).trim()}**` : ''} — nada a desconectar. Quando quiser, me peça para conectar uma (Resend ou SMTP).`,
          };
        }
        if (accounts.length > 1 && !action.email) {
          return {
            type: 'email_disconnected',
            label: 'Qual conta devo desconectar?',
            detail: `Você tem ${accounts.length} contas ativas: ${accounts.map((a) => `**${a.email}** (${a.provider})`).join(', ')}. Me diga qual.`,
            accounts: accounts.map((a) => ({ id: a.id, email: a.email, provider: a.provider })),
          };
        }
        await prisma.emailAccount.updateMany({
          where: { id: { in: accounts.map((a) => a.id) } },
          data: { status: 'revoked', encryptedRefreshToken: null, encryptedSecret: null },
        });
        return {
          type: 'email_disconnected',
          label: `Conta ${accounts.length > 1 ? 's' : ''} de e-mail desconectada${accounts.length > 1 ? 's' : ''}`,
          detail: `${accounts.map((a) => `**${a.email}**`).join(', ')} saiu${accounts.length > 1 ? 'ram' : ''} do ar — não dá mais para disparar por e-mail até conectar outra conta. Campanhas de WhatsApp não são afetadas.`,
          emails: accounts.map((a) => a.email),
        };
      }

      case 'enrich_whatsapp': {
        // Enriquecimento PELO CHAT (pedido do dono, 2026-10-08): procura o
        // WhatsApp das empresas NA INTERNET — o MESMO motor do worker
        // company.digital_presence (descoberta de domínio via SearXNG +
        // crawl do site + validação Twilio quando o registry existe) — e
        // cadastra o número na FRENTE do cnpjPhones (o disparo usa [0]),
        // destravando os leads no_phone.
        const digitalPresence = require('../workers/digital-presence');
        const limit = Math.min(20, Math.max(1, Number(action.limit) || 10));
        const semTelefone = (p) => !Array.isArray(p.cnpjPhones) || p.cnpjPhones.filter(Boolean).length === 0;

        // Escopo: nomes citados → audiência da campanha aberta → base da org.
        let candidates = [];
        if (Array.isArray(action.names) && action.names.length > 0) {
          for (const term of action.names.slice(0, limit)) {
            const t = String(term).trim();
            if (t.length < 3) continue;
            const lead = await prisma.prospect.findFirst({
              where: { orgId, OR: [{ companyName: { contains: t } }, { tradeName: { contains: t } }] },
            });
            if (lead && !candidates.some((c) => c.id === lead.id)) candidates.push(lead);
          }
        } else {
          let ids = null;
          const snap = (await prisma.studioAudienceSnapshot.findMany({ where: { campaignId: campaign.id, status: 'active' } }))[0];
          if (snap) {
            const members = await prisma.studioAudienceMember.findMany({ where: { snapshotId: snap.id, included: true } });
            ids = members.map((m) => m.prospectId);
          }
          candidates = ids && ids.length
            ? await prisma.prospect.findMany({ where: { orgId, id: { in: ids } }, orderBy: { createdAt: 'desc' } })
            : await prisma.prospect.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 200 });
        }
        const semNumero = candidates.filter(semTelefone);
        const restantes = Math.max(0, semNumero.length - limit);
        const lote = semNumero.slice(0, limit);

        const logger = { info() {}, warn() {}, error() {}, child() { return this; } };
        const found = [];
        const notFound = [];
        for (const lead of lote) {
          try {
            const outcome = await digitalPresence.executors['company.digital_presence'](
              {
                input: { companyName: String(lead.companyName || lead.tradeName || ''), domain: lead.domain || null },
                capability: 'company.digital_presence', timeoutMs: 30000,
              },
              { signal: AbortSignal.timeout(32000), logger }
            );
            const wa = outcome && outcome.data && outcome.data.digital_presence ? outcome.data.digital_presence.whatsapp : null;
            if (!wa) {
              notFound.push(String(lead.companyName || lead.tradeName || lead.id));
              continue;
            }
            const current = Array.isArray(lead.cnpjPhones) ? lead.cnpjPhones.filter(Boolean) : [];
            const digits = wa.replace(/\D/g, '');
            const already = current.some((p) => String(p).replace(/\D/g, '') === digits);
            if (!already) {
              await prisma.prospect.update({
                where: { id: lead.id },
                data: { cnpjPhones: [wa, ...current] },
              });
            }
            found.push({ prospectId: lead.id, companyName: String(lead.companyName || lead.tradeName || lead.id), whatsapp: wa });
          } catch (err) {
            notFound.push(String(lead.companyName || lead.tradeName || lead.id));
          }
        }

        const lines = [];
        if (found.length) {
          lines.push(found.map((f) => `• **${f.companyName}** — ${f.whatsapp} ✓ cadastrado na frente do cadastro`).join('\n'));
        }
        if (notFound.length) {
          lines.push(`⚠️ ${notFound.length} lead(s) SEM WhatsApp encontrado no site: ${notFound.slice(0, 5).join(', ')}${notFound.length > 5 ? '…' : ''}`);
        }
        if (restantes > 0) {
          lines.push(`Ainda há ${restantes} lead(s) sem telefone — me peça "continua o enriquecimento" para o próximo lote de ${limit}.`);
        }
        if (found.length) {
          lines.push('Agora pode disparar por WhatsApp — os números novos entram na fila na matrícula (e leads cancelados por no_phone voltam quando o telefone é atualizado).');
        } else {
          lines.push('Nada a comemorar ainda: sem número no site, o WhatsApp continua impossível para esses leads — me peça para atualizar os telefones manualmente ou capture leads novos.');
        }
        return {
          type: 'enrichment_done',
          label: found.length
            ? `Enriquecimento concluído — ${found.length} WhatsApp(s) cadastrado(s)`
            : 'Enriquecimento concluído — nenhum WhatsApp encontrado',
          detail: lines.join('\n'),
          found: found.map((f) => f.companyName),
          notFound,
          restantes,
        };
      }

      case 'none':
      default:
        return null;
    }
  }

/** emailDoc.blocks → texto plano do corpo para revisão no chat (show_content). */
function emailBlocksToText(emailDoc) {
  const blocks = emailDoc && Array.isArray(emailDoc.blocks) ? emailDoc.blocks : [];
  return blocks
    .map((b) => {
      if (!b || typeof b !== 'object') return null;
      if (b.type === 'button') return b.url ? `[${b.label || 'Ver mais'}](${b.url})` : b.label || null;
      return typeof b.text === 'string' && b.text.trim() ? b.text : null;
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Gate de confirmação do dono (QA 2026-10-02, bug 5): action que altera
 * artefato que JÁ EXISTE NÃO executa direto — volta como card "confirm_change"
 * e o usuário aprova com 1 clique (o chip reenvia a MESMA action com
 * `confirmed: true`). Criar algo que ainda não existe continua direto.
 * Retorna a "espécie" de alteração (chave do texto do card) ou null.
 */
async function confirmRequired(type, { campaign, prisma, params = {} }) {
  switch (type) {
    case 'edit_content':
      return 'conteudo';
    case 'delete_campaign':
      return 'campanha';
    case 'connect_email': {
      if (!params.email) return null;
      const existing = await prisma.emailAccount.findFirst({
        where: { tenantId: campaign.orgId, email: String(params.email) },
        select: { id: true },
      });
      return existing ? 'canal' : null;
    }
    // Paridade Outreach (2026-10-08): reabilitar contato e descontar conta de
    // envio são destrutivos → gate SEMPRE que houver o que perder. Na
    // desambiguação de disconnect (2+ contas, sem email) o gate NÃO roda —
    // primeiro o handler pergunta qual conta.
    case 'remove_suppression': {
      if (!params.email) return null;
      const entry = await prisma.suppressionList.findFirst({
        where: { tenantId: campaign.orgId, email: String(params.email) },
        select: { id: true },
      });
      return entry ? 'supressao' : null;
    }
    case 'disconnect_email': {
      const where = {
        tenantId: campaign.orgId,
        status: 'connected',
        ...(params.email ? { email: String(params.email) } : {}),
      };
      const accounts = await prisma.emailAccount.findMany({ where, select: { id: true } });
      return accounts.length === 1 || (accounts.length > 1 && params.email) ? 'desconexao' : null;
    }
    case 'generate_content': {
      const existing = await prisma.studioContent.count({
        where: { campaignId: campaign.id, kind: 'base', stepIndex: 1 },
      });
      return existing > 0 ? 'conteudo' : null;
    }
    case 'set_schedule':
      return campaign.schedule && campaign.schedule.mode ? 'agenda' : null;
    case 'set_audience':
    case 'select_leads': {
      const snap = (
        await prisma.studioAudienceSnapshot.findMany({ where: { campaignId: campaign.id, status: 'active' } })
      )[0];
      return snap && snap.includedCount > 0 ? 'audiencia' : null;
    }
    default:
      return null;
  }
}

/** O que a alteração faria, em linguagem de vendedor — por espécie. */
const CONFIRM_COPY = {
  conteudo: 'vou ALTERAR o conteúdo que já existe',
  campanha: 'vou APAGAR a campanha (não tem volta)',
  canal: 'vou SUBSTITUIR as credenciais de envio desse e-mail',
  agenda: 'vou RECONFIGURAR o agendamento atual',
  audiencia: 'vou SUBSTITUIR a audiência decidida — a fila sincroniza e o que já saiu não volta',
  supressao: 'vou REABILITAR esse contato — ele volta a poder receber disparos de e-mail',
  desconexao: 'vou DESCONECTAR a conta de envio — ela para de poder disparar até você conectar outra',
};

function buildConfirmCard(type, params, kind) {
  return {
    type: 'confirm_change',
    label: 'Posso fazer essa alteração?',
    detail: `Se eu seguir, ${CONFIRM_COPY[kind] || 'vou alterar dados atuais da campanha'}. Confira e toque em "Confirmar" — ou me diga o que mudar antes.`,
    kind,
    // O chip "Confirmar" reenvia a MESMA action com o selo de aprovação.
    action: { type, params: { ...params, confirmed: true } },
  };
}

/** Aprovação textual: resposta curta afirmativa depois de um confirm_change. */
const APPROVAL_RE = /^(sim|pode|podia|pode sim|confirmo|confirmado|beleza|ok|okay|aprovado|aprovo|manda|manda ver|faz|vai|claro|isso|perfeito|pode fazer)\b/i;

function criteriaDescription(criteria) {
  return (criteria?.groups || [])
    .flatMap((g) => g.conditions || [])
    .map((c) => `${c.field} ${c.op} ${Array.isArray(c.value) ? c.value.join('/') : c.value}`)
    .join(' E ');
  }

/**
 * Card único de audiência para set_audience e select_leads. Audiência vazia
 * com base populada é o ponto cego nº 1 do chat (QA 2026-09-28, F3): o card
 * nomeia o problema e o total da base para o usuário decidir entre ajustar o
 * segmento ou importar leads.
 */
function buildAudienceCard({ snapshot, baseCount, rationaleText, label = 'Audiência montada' }) {
  const emptyMatch = snapshot.includedCount === 0 && baseCount > 0;
  return {
    type: 'audience',
    label: emptyMatch ? `${label} — nenhum lead casou` : label,
    detail: emptyMatch
      ? `0 leads incluídos — sua base tem ${baseCount} lead(s) e nenhum casou com o filtro (${rationaleText}). Me peça para ajustar o segmento — ampliar setor, região ou porte — ou importar mais leads.`
      : `${snapshot.includedCount} leads incluídos (${snapshot.excludedCount} excluídos por segurança) — ${rationaleText}`,
    emptyMatch,
    baseCount,
  };
}

/**
 * Card de captura (Epic 2, FR7/FR9/UX-DR3): tom mordomo, contagem e
 * PROVENIÊNCIA POR LOTE ("da sua base" / "encontrado via CNPJ") — confiança
 * visível. Chip de 1 clique (padrão suggestedFilter do Epic 1) materializa a
 * audiência com os capturados. Recusas/limite são explicáveis com quando-libera.
 */
function buildCaptureCard(result) {
  const base = { type: 'capture' };
  // Zero-framing: MCP consultado mas nada virou lead (só duplicados/inválidos
  // ou base 0 + MCP 0) — card PRÓPRIO e honesto, nunca "Leads capturados" vazio.
  if (result.status === 'no_results') {
    return {
      ...base,
      status: 'no_results',
      label: 'Não encontrei leads novos agora',
      detail:
        `Não encontrei leads novos para "${result.query}" — o que veio já estava na sua base ou não tinha dados suficientes ` +
        `para virar lead. Tente outro termo (setor mais amplo ou outra palavra) ou me diga estado/cidade para eu variar a busca. ` +
        `Nada foi criado.`,
      mode: result.mode,
      duplicates: result.duplicates || 0,
      suggestedFilter: null,
    };
  }
  if (result.status === 'captured') {
    const lots = [];
    if (result.baseOwnCount > 0) lots.push(`${result.baseOwnCount} da sua base`);
    if (result.mcpCount > 0) lots.push(`${result.mcpCount} encontrado(s) via CNPJ`);
    const modeNote = result.mode === 'lexical-only'
      ? ' A busca por significado está indisponível agora — usei a busca por palavras, que já encontra pelo setor e pelo nome.'
      : '';
    const dupNote = result.duplicates > 0 ? ` ${result.duplicates} já estavam na sua base e não foram duplicados.` : '';
    return {
      ...base,
      status: 'captured',
      label: 'Leads capturados',
      detail: `${lots.join(' + ')}. Nada foi enviado — os leads ficam prontos para você usar.${dupNote}${modeNote}`,
      captureSource: result.source,
      mode: result.mode,
      baseOwnCount: result.baseOwnCount,
      mcpCount: result.mcpCount,
      duplicates: result.duplicates || 0,
      // Contador do dia TAL COMO a contagem DB reproduz (re-contagem do
      // capture-service) — o card nunca reporta número que o banco não confirma.
      capturedToday: result.capturedToday,
      dailyLimit: result.dailyLimit,
      suggestedFilter: Array.isArray(result.prospectIds) && result.prospectIds.length
        ? { description: 'audiência com os leads capturados agora', prospectIds: result.prospectIds, matchedCount: result.prospectIds.length }
        : null,
    };
  }
  if (result.status === 'limit_reached') {
    return {
      ...base,
      status: 'limit_reached',
      label: 'Limite do dia atingido — amanhã libera mais',
      detail:
        `Você capturou ${result.capturedToday} lead(s) novo(s) hoje e o limite diário é ${result.dailyLimit} — ` +
        `a meia-noite o contador zera e você pode capturar de novo. Nada foi criado além do que já estava pronto; ` +
        `enquanto isso, posso montar a audiência com quem você já tem — é só pedir.`,
      capturedToday: result.capturedToday,
      dailyLimit: result.dailyLimit,
    };
  }
  // Recusa explicável (FR9): sem token MCP (ou erro dele) — NENHUM lead criado,
  // e o card diz o que falta. Zero invenção: a base própria segue como está.
  // Copy NUNCA cita env interna (o vendedor não age sobre variável de ambiente).
  const why = result.reason === 'mcp_error'
    ? 'A consulta pública de CNPJ não respondeu agora.'
    : 'A busca fora da sua base ainda não está conectada neste workspace.';
  return {
    ...base,
    status: 'refused',
    label: 'Não consegui trazer leads novos agora',
    detail:
      `${why} Sua base tem ${result.ownCount} lead(s) parecido(s) com o que você pediu — abaixo do mínimo (${result.minOwn}) ` +
      `para um lote útil, então NENHUM lead foi criado. Peça ao administrador para configurar o acesso ao CNPJ e tente de novo ` +
      `— ou trabalhe com a sua base atual.`,
    reason: result.reason,
    mode: result.mode,
    ownCount: result.ownCount,
  };
}

// ── Epic 1 (FR6): recuperação determinística de audiência 0-match ───────────
// 0 leads com base populada não é beco sem saída: o card ganha diagnóstico do
// porquê (campo consultado × amostra real da org) e proposta de critério
// MATERIAMENTE diferente — "materialmente diferente" é computável (Design
// Notes): hash sha256 do `where` comparado a TODAS as tentativas anteriores;
// o mesmo `where` nunca volta 2× e guard-rails (saldo/consentimento) ficam
// intocados — a proposta só sugere, quem aplica é o vendedor em 1 clique.

function hashWhere(where) {
  return crypto.createHash('sha256').update(JSON.stringify(where)).digest('hex');
}

/** Amostra real da base da org — insumo do diagnóstico e das propostas. */
async function orgTextSample(prisma, orgId) {
  const rows = await prisma.prospect.findMany({
    where: { orgId },
    select: { industry: true, companyName: true, tradeName: true, searchText: true },
    orderBy: { createdAt: 'asc' }, // amostra ESTÁVEL: mesma base → mesmo diagnóstico
    take: 1000,
  });
  const industryCounts = new Map();
  const tokens = new Set();
  for (const row of rows) {
    const industry = String(row.industry || '').trim();
    if (industry) industryCounts.set(industry, (industryCounts.get(industry) || 0) + 1);
    const text =
      row.searchText || [row.industry, row.companyName, row.tradeName].filter(Boolean).join(' ');
    for (const token of normalizeText(text).split(/[^a-z0-9]+/)) {
      if (token.length >= 4) tokens.add(token);
    }
  }
  const ranked = [...industryCounts.entries()].sort((a, b) => b[1] - a[1]);
  return {
    total: rows.length,
    rankedIndustries: ranked.slice(0, 5),
    topIndustry: ranked[0] ? ranked[0][0] : null,
    tokens: [...tokens],
  };
}

/**
 * Amostra (≤30 valores) de `industry`/`companyName` da org — few-shot do
 * segment-nl (Epic 1, FR5): a tradução NL→critérios fica ancorada nos
 * valores reais da base, não em setores inventados.
 */
async function orgBaseSamples(prisma, orgId) {
  try {
    const rows = await prisma.prospect.findMany({
      where: { orgId },
      select: { industry: true, companyName: true },
      take: 300,
    });
    const industries = [...new Set(rows.map((r) => String(r.industry || '').trim()).filter(Boolean))].slice(0, 30);
    const companies = [...new Set(rows.map((r) => String(r.companyName || '').trim()).filter(Boolean))].slice(0, 30);
    return { industries, companies };
  } catch (_e) {
    console.error('[studio/chat] segment-nl: amostra da base indisponível:', _e);
    return { industries: [], companies: [] };
  }
}

/** Hashes dos `where` das tentativas anteriores (segmentos da org). */
async function previousWhereHashes(prisma, orgId) {
  const segments = await prisma.studioSegment.findMany({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const hashes = new Set();
  for (const segment of segments) {
    try {
      hashes.add(hashWhere(segmentService.buildWhere(orgId, segment.criteria)));
    } catch (_e) { /* critério legado fora do catálogo: ignora */ }
  }
  return hashes;
}

function isTextSearchField(field) {
  return segmentService.SEARCHTEXT_FIELDS.has(field);
}

/** Termos atômicos normalizados pedidos nas condições de texto do critério. */
function collectTerms(criteria) {
  const terms = new Set();
  for (const group of (criteria && criteria.groups) || []) {
    for (const condition of group.conditions || []) {
      if (isTextSearchField(condition.field) && condition.op === 'contains') {
        for (const term of segmentService.termVariants(condition.value)) terms.add(term);
      }
    }
  }
  return [...terms];
}

/** Critério sem as condições de texto (mantém região/porte/score/etc.). */
function stripTextConditions(criteria) {
  const groups = (criteria && criteria.groups) || [];
  const kept = groups
    .map((group) => ({
      ...group,
      conditions: (group.conditions || []).filter((c) => !isTextSearchField(c.field)),
    }))
    .filter((group) => group.conditions.length > 0);
  return { version: 1, groups: kept };
}

function sectorCriteria(value) {
  return {
    version: 1,
    groups: [
      {
        op: 'OR',
        conditions: [
          { field: 'industry', op: 'contains', value },
          { field: 'companyName', op: 'contains', value },
        ],
      },
    ],
  };
}

/** Tokens REAIS da base lexicalmente próximos dos termos buscados. */
function similarTokens(terms, baseTokens) {
  const out = [];
  for (const token of baseTokens) {
    for (const term of terms) {
      const size = Math.min(4, term.length, token.length);
      if (size >= 4 && (token.startsWith(term.slice(0, 4)) || term.startsWith(token.slice(0, 4)))) {
        out.push(token);
        break;
      }
    }
  }
  return out;
}

/** Propostas em ordem determinística: do mais próximo ao mais amplo. */
function zeroMatchProposals({ criteria, sample }) {
  const proposals = [];
  const terms = collectTerms(criteria);
  for (const token of similarTokens(terms, sample.tokens).slice(0, 2)) {
    proposals.push({
      description: `setor "${token}" — parecido com o que você buscou`,
      criteria: sectorCriteria(token),
    });
  }
  const structured = stripTextConditions(criteria);
  if (structured.groups.length > 0) {
    proposals.push({
      description: 'seus filtros sem o setor que não casou',
      criteria: structured,
    });
  }
  if (sample.topIndustry) {
    proposals.push({
      description: `o setor mais comum da sua base ("${sample.topIndustry}")`,
      criteria: sectorCriteria(sample.topIndustry),
    });
  }
  return proposals;
}

/**
 * Diagnóstico do porquê do 0-match + proposta de 1 clique (FR6). A proposta
 * só vale com hash de `where` distinto de todas as tentativas anteriores —
 * se a 2ª proposta também casar 0, a próxima sai diferente (sem loop).
 */
async function buildZeroMatchRecovery(prisma, { orgId, criteria, baseCount }) {
  let sample = { total: 0, rankedIndustries: [], topIndustry: null, tokens: [] };
  try {
    sample = await orgTextSample(prisma, orgId);
  } catch (_e) {
    console.error('[studio/chat] 0-match: amostra da base indisponível:', _e);
  }
  const terms = collectTerms(criteria);
  // Total REAL da base (baseCount do card), não o teto da amostra — copy honesta.
  const totalCopy = baseCount != null ? baseCount : sample.total;
  const diagnosis = [
    terms.length
      ? `Busquei os termos ${terms.map((t) => `"${t}"`).join(', ')} no setor e no nome das empresas.`
      : 'Nenhum lead da sua base casou com os filtros.',
    totalCopy > 0
      ? `Sua base tem ${totalCopy} lead(s)` +
        (sample.rankedIndustries.length
          ? ` e os setores mais comuns na amostra são ${sample.rankedIndustries.map(([name, n]) => `${name} (${n})`).join(', ')}.`
          : '.')
      : 'Sua base está sem leads para casar.',
  ].join(' ');

  let previous = new Set();
  try {
    previous = await previousWhereHashes(prisma, orgId);
  } catch (_e) {
    console.error('[studio/chat] 0-match: histórico de tentativas indisponível:', _e);
  }
  for (const proposal of zeroMatchProposals({ criteria, sample })) {
    let where;
    try {
      segmentService.validateCriteria(proposal.criteria);
      where = segmentService.buildWhere(orgId, proposal.criteria);
    } catch (_e) {
      continue; // proposta inválida nunca vai para o card
    }
    if (previous.has(hashWhere(where))) continue; // nunca repetir o where
    const matchedCount = await prisma.prospect.count({ where });
    if (matchedCount === 0) continue; // só proposta que CASA — "parecido" não basta
    return {
      diagnosis,
      suggestedFilter: {
        description: proposal.description,
        criteria: proposal.criteria,
        matchedCount,
      },
    };
  }
  return { diagnosis, suggestedFilter: null };
}

/**
 * Card do Orçamento de Reputação em linguagem clara (FR-20; onda 2026-09-29):
 * status por canal (PRONTO / PENDENTE / AGUARDANDO REPOSIÇÃO) + passo a passo
 * numerado. Zero jargão (UX-DR4): NUNCA fala "piso" (o sintoma "piso é 103"
 * morreu — pendência fala o que destrava e quando libera, nunca "bloqueado").
 */
async function buildBalanceCard(prisma, orgId) {
  const reputation = require('./reputation');
  const wallet = await reputation.getWallet(prisma, orgId);
  const replenishAt = reputation.nextReplenishLabel();
  if (!wallet) {
    return { type: 'balance', label: 'Saldo de envios', detail: 'Nenhuma carteira de envios ainda — conecte o e-mail ou o WhatsApp que eu crio a sua com o saldo inicial.' };
  }
  // Saldo ÚNICO (2026-10-08): e-mail e WhatsApp dividem o mesmo pool; cada
  // canal tem um teto diário de ritmo e requisitos próprios (DNS/pareamento).
  const lines = [];
  lines.push(
    `**Saldo único**: ${wallet.balance} envio(s) no pool compartilhado e-mail + WhatsApp (teto da carteira: ${wallet.ceiling})${wallet.lowBalance ? ' — **⚠ saldo acabando, compre mais no painel de saldo**' : ''}`
  );
  const dnsOk = ['verified', 'prewarmed'].includes(wallet.domainAuthStatus);
  lines.push(`**E-mail** — ${wallet.usedToday.email}/${wallet.caps.email} hoje${dnsOk ? ' · domínio ✓ autenticado' : ' · ⚠ domínio SEM SPF/DKIM verificados (bloqueia o canal até autenticar)'}`);
  lines.push(`**WhatsApp** — ${wallet.usedToday.whatsapp}/${wallet.caps.whatsapp} hoje · requer a sessão pareada (QR)`);
  const steps = [];
  if (!dnsOk) steps.push('Autenticar o domínio: publicar SPF, DKIM e DMARC no DNS (me peça "listar os registros DNS" que eu mostro cada um)');
  steps.push(`Comprar mais saldo: painel de saldo do Studio (Stripe) — a reposição diária também libera mais${replenishAt ? ` às ${replenishAt}` : ''}; enquanto isso, você já pode criar e aprovar campanhas`);
  steps.push('Manter o WhatsApp pareado — se a sessão cair, me peça "mostrar o QR do WhatsApp"');
  lines.push(steps.map((s, i) => `${i + 1}. ${s}`).join(' '));
  return { type: 'balance', label: 'Saldo de envios — e-mail e WhatsApp no mesmo pool', detail: lines.join('\n') };
}

/**
 * Espera o QR utilizável (espelha waitForWhatsAppQr do server-prod, com janela
 * menor para caber num turno de chat sem travar o stream).
 */
async function waitForChatQr(provider, sessionName, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let status = null;
    try { status = (await provider.getSessionStatus(sessionName))?.status; } catch (_e) { /* sessão pode não existir ainda */ }
    if (status === 'WORKING' || status === 'CONNECTED') return { connected: true, qr: null };
    if (status === 'SCAN_QR_CODE' || status === 'QRCODE') {
      const qr = await provider.getQRCode(sessionName).catch(() => null);
      if (qr && qr.qrCode) return { connected: false, qr };
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { connected: false, qr: null };
}

  // Rótulos das etapas em pt-BR — exibidos ao vivo no chat (status SSE).
  const ACTION_LABELS = {
    extract_intent: 'Entendendo sua mensagem…',
    set_objective: 'Definindo objetivo…',
    set_audience: 'Criando audiência…',
    select_leads: 'Ajustando os leads selecionados…',
    attach_url: 'Anexando e extraindo material…',
    confirm_material: 'Confirmando extração…',
    generate_content: 'Gerando conteúdo…',
    set_schedule: 'Configurando agendamento…',
    show_balance: 'Consultando o Orçamento de Reputação…',
    start_whatsapp_pairing: 'Preparando o pareamento do WhatsApp…',
    attach_files: 'Vinculando anexos à campanha…',
    edit_content: 'Atualizando o conteúdo…',
    show_content: 'Buscando seus conteúdos…',
    capture_leads: 'Capturando leads…',
    list_campaigns: 'Listando suas campanhas…',
    create_campaign: 'Criando a campanha…',
    rename_campaign: 'Renomeando…',
    duplicate_campaign: 'Duplicando a campanha…',
    delete_campaign: 'Apagando a campanha…',
    approve_campaign: 'Aprovando a campanha…',
    launch_campaign: 'Colocando em voo…',
    grant_whatsapp_consent: 'Registrando consentimento…',
    grant_whatsapp_consent_batch: 'Registrando consentimento em lote…',
    send_test_message: 'Enviando mensagem de teste…',
    update_lead: 'Atualizando o lead…',
    show_replies: 'Vendo as respostas dos leads…',
    show_dns_records: 'Conferindo o DNS do seu domínio…',
    connect_email: 'Conectando o e-mail de disparo…',
    enrich_whatsapp: 'Procurando WhatsApps das empresas na internet…',
    show_capabilities: 'Organizando o que eu sei fazer…',
  };

  async function persistChatTrace({ campaignId, orgId, turnIndex, startedAt, llmTelemetry, actionTypes, actionDurationsMs, status = 'succeeded', errorCode = null, errorStack = null }) {
    const llm = llmTelemetry[llmTelemetry.length - 1] || {};
    const usage = llm.usage || {};
    const trace = {
      orgId,
      campaignId,
      turnIndex,
      durationMs: Math.max(0, Date.now() - startedAt),
      llmDurationMs: llmTelemetry.reduce((sum, item) => sum + Number(item.durationMs || 0), 0),
      llmModel: llm.model || null,
      llmPromptTokens: usage.prompt_tokens ?? null,
      llmCompletionTokens: usage.completion_tokens ?? null,
      llmTotalTokens: usage.total_tokens ?? (
        usage.prompt_tokens != null || usage.completion_tokens != null
          ? Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0)
          : null
      ),
      llmFallbackUsed: Boolean(llm.fallbackUsed),
      llmTruncated: Boolean(llm.truncated),
      status,
      // FR3 (Epic 1): falha NUNCA é anônima — errorCode + stack do erro real
      // nos caminhos failed e degraded, consultável em GET .../traces.
      errorCode,
      errorStack,
      actionTypes,
      actionDurationsMs,
    };
    try {
      return await prisma.studioChatTrace.create({ data: trace });
    } catch (error) {
      console.warn('[studio/chat] trace persist failed:', error.message);
      return null;
    }
  }

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
    const startedAt = Date.now();
    const llmTelemetry = [];
    const actionTypes = [];
    const actionDurationsMs = {};
    const history = await prismaClient.studioChatMessage.findMany({
      where: { campaignId: campaign.id },
    });
    const turnIndex = history.filter((item) => item.role === 'user').length + 1;

    // URLs coladas viram materiais automaticamente (contexto dos agentes).
    const urls = [...message.matchAll(URL_RE)].map((m) => m[1]).slice(0, 3);
    const autoAttachCards = [];
    for (const url of urls) {
      emit({ type: 'status', label: ACTION_LABELS.attach_url });
      actionTypes.push('attach_url');
      const actionStartedAt = Date.now();
      try {
        const result = await runAction({ type: 'attach_url', url }, { campaign, cards: autoAttachCards, orgId, userId });
        if (result) {
          autoAttachCards.push(result);
          emit({ type: 'card', card: result });
        }
      } catch (err) {
        const errorCard = { type: 'error', label: 'Ação "attach_url" falhou', detail: err.message };
        autoAttachCards.push(errorCard);
        emit({ type: 'card_error', card: errorCard });
      } finally {
        actionDurationsMs.attach_url = (actionDurationsMs.attach_url || 0) + (Date.now() - actionStartedAt);
      }
    }

    emit({ type: 'status', phase: 'thinking' });
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
    // Epic 3 (Story 3.1): a fase da jornada entra no estado do orchestrate —
    // o modelo avança a próxima fase pendente (o guard server-side é a rede).
    extras.journey = journey.previewFromExtras(campaign, extras);
    const cards = [...autoAttachCards];

    // QA 2026-10-02 (bugs 1/2 do dono): mensagem rica de abertura re-perguntava
    // o que já fora dito — o orchestrate (uma chamada só: decidir + escrever)
    // deixava de emitir as actions. Extração PEQUENA e dedicada materializa
    // objetivo/oferta/audiência EXPLICITAMENTE presentes na mensagem ANTES do
    // orchestrate: os handlers reais rodam, os cards saem, e o modelo escreve
    // a resposta com o estado já atualizado (decisão fechada FR2 entra na
    // MESMA rodada). Falha aqui NUNCA derruba o turno.
    if (!campaign.objective) {
      emit({ type: 'status', label: ACTION_LABELS.extract_intent });
      actionTypes.push('extract_intent');
      const extractionStartedAt = Date.now();
      try {
        const intent = await chatAgent.extractIntent({
          userMessage: message,
          onLlmCall: (telemetry) => llmTelemetry.push(telemetry),
        });
        if (intent.objective) {
          emit({ type: 'status', label: ACTION_LABELS.set_objective });
          const objectiveCard = await runAction(
            { type: 'set_objective', objective: intent.objective, ...(intent.offer ? { offer: intent.offer } : {}) },
            { campaign, cards, orgId, userId }
          );
          if (objectiveCard) {
            cards.push(objectiveCard);
            emit({ type: 'card', card: objectiveCard });
          }
        }
        if (intent.audience) {
          emit({ type: 'status', label: ACTION_LABELS.set_audience });
          const audienceCard = await runAction(
            { type: 'set_audience', description: intent.audience },
            { campaign, cards, orgId, userId }
          );
          if (audienceCard) {
            cards.push(audienceCard);
            emit({ type: 'card', card: audienceCard });
          }
        }
        if (intent.objective || intent.audience) {
          // O orchestrate precisa do estado PÓS-ação: relê a campanha (o
          // objeto em memória está pré-ação) e recalcula os extras.
          const fresh = await prismaClient.studioCampaign.findUnique({ where: { id: campaign.id } });
          if (fresh) Object.assign(campaign, fresh);
          Object.assign(extras, await currentExtras(prismaClient, campaign));
          extras.journey = journey.previewFromExtras(campaign, extras);
        }
      } catch (err) {
        console.error('[studio/chat] pré-extração de intenção falhou (turno segue):', err.stack || String(err));
      } finally {
        actionDurationsMs.extract_intent = (actionDurationsMs.extract_intent || 0) + (Date.now() - extractionStartedAt);
      }
    }

    // Renomeação DETERMINÍSTICA (QA 2026-10-02: o modelo negava mesmo com o
    // hint — estocástico demais para ser gatekeeper). O servidor extrai o
    // nome novo da frase e executa rename_campaign sozinho; o modelo recebe
    // o estado JÁ atualizado e só confirma. Roda em qualquer turno,
    // independe do objetivo, e nunca derruba o turno.
    let serverExecuted = null;
    // Tipos já atendidos server-side neste turno — o modelo NÃO re-emite
    // (a captura determinística + a action do modelo seriam DOIS trabalhos).
    const serverActionsDone = new Set();
    const createTarget = typeof extractCreateTarget === 'function' ? extractCreateTarget(message) : null;
    const renameTarget = createTarget
      ? null
      : typeof extractRenameTarget === 'function'
        ? extractRenameTarget(message)
        : null;
    // Criação determinística (QA 2026-10-05): "cria uma campanha chamada X"
    // executa server-side — a conversa segue na campanha aberta, o card traz
    // o atalho para abrir a nova.
    if (createTarget) {
      emit({ type: 'status', label: ACTION_LABELS.create_campaign });
      actionTypes.push('create_campaign');
      const createStartedAt = Date.now();
      try {
        const createdCard = await runAction(
          { type: 'create_campaign', name: createTarget },
          { campaign, cards, orgId, userId }
        );
        if (createdCard) {
          cards.push(createdCard);
          emit({ type: 'card', card: createdCard });
        }
        Object.assign(extras, await currentExtras(prismaClient, campaign));
        extras.journey = journey.previewFromExtras(campaign, extras);
        serverExecuted = 'create_campaign';
        serverActionsDone.add('create_campaign');
      } catch (err) {
        console.error('[studio/chat] criação determinística falhou (turno segue):', err.stack || String(err));
      } finally {
        actionDurationsMs.create_campaign =
          (actionDurationsMs.create_campaign || 0) + (Date.now() - createStartedAt);
      }
    }
    if (renameTarget && renameTarget !== campaign.name) {
      emit({ type: 'status', label: ACTION_LABELS.rename_campaign });
      actionTypes.push('rename_campaign');
      const renameStartedAt = Date.now();
      try {
        const renameCard = await runAction(
          { type: 'rename_campaign', name: renameTarget },
          { campaign, cards, orgId, userId }
        );
        if (renameCard) {
          cards.push(renameCard);
          emit({ type: 'card', card: renameCard });
        }
        const fresh = await prismaClient.studioCampaign.findUnique({ where: { id: campaign.id } });
        if (fresh) Object.assign(campaign, fresh);
        Object.assign(extras, await currentExtras(prismaClient, campaign));
        extras.journey = journey.previewFromExtras(campaign, extras);
        serverExecuted = 'rename_campaign';
      } catch (err) {
        console.error('[studio/chat] renomeação determinística falhou (turno segue):', err.stack || String(err));
      } finally {
        actionDurationsMs.rename_campaign =
          (actionDurationsMs.rename_campaign || 0) + (Date.now() - renameStartedAt);
      }
    }

    // Captura DETERMINÍSTICA de leads (QA 2026-10-02, 5ª bateria: 'procura
    // potenciais leads' virava filtro 0-match + 'importa a base'). Pedido
    // explícito de ADICIONAR/PROCURAR leads → capture_leads roda server-side
    // com a query da frase ou, na falta, os termos do segmento vigente. Se o
    // pedido citou a CAMPANHA, os capturados já entram na audiência (a ordem
    // explícita do usuário é o consentimento — select_leads vai confirmado).
    const captureWanted = typeof leadCaptureIntent === 'function' ? leadCaptureIntent(message) : false;
    if (captureWanted) {
      let query = extractCaptureQuery(message);
      if (!query) {
        // Fallback: termos do segmento vigente (a audiência que o usuário já
        // definiu é a melhor aproximação de "leads como os meus").
        try {
          const seg = await prismaClient.studioSegment.findFirst({
            where: { orgId },
            orderBy: { createdAt: 'desc' },
          });
          const conds = (seg?.criteria?.groups || []).flatMap((g) => g.conditions || []);
          const vals = conds
            .filter((c) => ['industry', 'companyName', 'tradeName'].includes(c.field))
            .map((c) => (Array.isArray(c.value) ? c.value.join(' ') : c.value));
          if (vals.length) query = vals.join(' ').slice(0, 80);
        } catch (_e) { /* segue sem fallback */ }
      }
      if (query) {
        emit({ type: 'status', label: ACTION_LABELS.capture_leads });
        actionTypes.push('capture_leads');
        const captureStartedAt = Date.now();
        try {
          const state = typeof extractCaptureState === 'function' ? extractCaptureState(message) : null;
          const captureCard = await runAction(
            { type: 'capture_leads', query, ...(state ? { state } : {}) },
            { campaign, cards, orgId, userId }
          );
          if (captureCard) {
            cards.push(captureCard);
            emit({ type: 'card', card: captureCard });
          }
          serverExecuted = 'capture_leads';
          serverActionsDone.add('capture_leads');
          // "…para minha campanha" → capturados entram na audiência agora.
          const ids = captureCard && captureCard.suggestedFilter && Array.isArray(captureCard.suggestedFilter.prospectIds)
            ? captureCard.suggestedFilter.prospectIds
            : [];
          if (/campanha/i.test(message) && ids.length > 0) {
            emit({ type: 'status', label: ACTION_LABELS.select_leads });
            actionTypes.push('select_leads');
            const addCard = await runAction(
              { type: 'select_leads', add: ids, confirmed: true },
              { campaign, cards, orgId, userId }
            );
            if (addCard) {
              cards.push(addCard);
              emit({ type: 'card', card: addCard });
            }
            const freshAfterAdd = await prismaClient.studioCampaign.findUnique({ where: { id: campaign.id } });
            if (freshAfterAdd) Object.assign(campaign, freshAfterAdd);
            Object.assign(extras, await currentExtras(prismaClient, campaign));
            extras.journey = journey.previewFromExtras(campaign, extras);
          }
        } catch (err) {
          console.error('[studio/chat] captura determinística falhou (turno segue):', err.stack || String(err));
        } finally {
          actionDurationsMs.capture_leads =
            (actionDurationsMs.capture_leads || 0) + (Date.now() - captureStartedAt);
        }
      }
    }

    let reply;
    let actions;
    let degradation = null;
    try {
      const orchestrated = await chatAgent.orchestrate({
        campaign,
        history: [...history, userMessage],
        userMessage: message,
        extras,
        onLlmCall: (telemetry) => llmTelemetry.push(telemetry),
        // Streaming (bug 4 do dono): o reply começa a renderizar no chat no
        // primeiro token — o texto final autoritativo vem no evento `reply`.
        onReplyDelta: (text) => {
          if (text) emit({ type: 'reply_delta', text });
        },
        // Ação já executada server-side (ex.: rename determinístico): o hint
        // padrão é SUBSTITUÍDO — o modelo só confirma, nunca re-emite.
        hintOverride: serverExecuted
          ? `AÇÃO JÁ EXECUTADA PELO SERVIDOR NESTE TURNO: ${serverExecuted} (o card do resultado já está no thread). ` +
            'Apenas CONFIRME a mudança ao usuário com os dados novos do estado. NÃO emita nenhuma action de ' +
            'gerenciamento de campanha neste turno (seria duplicado) e NUNCA diga que não pode ou que precisa ' +
            'ser no painel.'
          : null,
      });
      reply = orchestrated.reply;
      actions = orchestrated.actions;
      // FR1 (Epic 1): esgotados os retries, o turno DEGRADA com resposta
      // honesta (o que NÃO foi alterado + próximo passo) — e o trace leva
      // errorCode+errorStack da causa real.
      if (orchestrated.degraded) {
        degradation = { errorCode: orchestrated.errorCode || null, errorStack: orchestrated.errorStack || null };
      }
    } catch (error) {
      console.error('[studio/chat] orchestrate threw:', error.stack || String(error));
      await persistChatTrace({
        campaignId: campaign.id,
        orgId,
        turnIndex,
        startedAt,
        llmTelemetry,
        actionTypes,
        actionDurationsMs,
        status: 'failed',
        errorCode: error.code || null,
        errorStack: String(error.stack || error),
      });
      throw error;
    }
    emit({ type: 'reply', text: reply });

    // Ordem canônica: set_audience REMATERIALIZA a seleção — se o modelo
    // emits select_leads antes e set_audience depois, o set apaga a seleção
    // que acabou de ser feita (regressão QA E2E 2026-09-28, estado-consistente).
    // Epic 2: capture_leads por ÚLTIMO (9) — a captura existe para os turnos
    // que pedem leads novos; nunca reordena as fases canônicas anteriores.
    const ACTION_ORDER = { set_objective: 0, set_audience: 1, attach_url: 2, confirm_material: 3, generate_content: 4, select_leads: 5, set_schedule: 6, attach_files: 7, edit_content: 8, show_content: 8, capture_leads: 9 };
    const orderedActions = [...actions].sort(
      (a, b) => (ACTION_ORDER[a?.type] ?? 9) - (ACTION_ORDER[b?.type] ?? 9)
    );
    // Aprovação textual do gate de confirmação (bug 5): se a última resposta
    // trouxe um card "confirm_change" e o usuário respondeu com um "pode/
    // sim/confirmo" curto, a action correspondente segue com o selo de
    // aprovação — sem exigir o toque no chip. Mensagem longa ≠ aprovação
    // (provavelmente muda o pedido).
    const lastAssistantCards = [...history].reverse().find((m) => m.role === 'assistant' && Array.isArray(m.cards) && m.cards.length > 0)?.cards || [];
    const pendingConfirm = lastAssistantCards.find((c) => c && c.type === 'confirm_change' && c.action);
    const textApproval = Boolean(
      pendingConfirm && message.length <= 60 && APPROVAL_RE.test(message.trim())
    );
    // set_audience + select_leads NA MESMA mensagem = um gesto só do usuário
    // (montou a audiência e já ajustou a seleção) — o ajuste não re-pergunta.
    const sameTurnAudience = orderedActions.some((a) => a && a.type === 'set_audience');
    for (const action of orderedActions) {
      // Já atendida server-side neste turno (rename/captura determinísticos):
      // o modelo re-emitiria = trabalho dobrado — pula sem executar.
      if (serverActionsDone.has(action.type)) continue;
      const effective =
        textApproval && pendingConfirm && action.type === pendingConfirm.action.type
          ? { ...action, confirmed: true }
          : sameTurnAudience && action.type === 'select_leads'
            ? { ...action, confirmed: true }
            : action;
      // QA 2026-10-06: a FRASE do usuário manda no canal ("mensagem para
      // enviar por whatsapp" gerava só e-mail e a revisão só mostrava
      // e-mails). Injeção determinística — o modelo não decide o canal.
      if ((effective.type === 'generate_content' || effective.type === 'show_content') && !effective.channel) {
        const channelIntent = extractChannelIntent(message);
        if (channelIntent) effective.channel = channelIntent;
      }
      // QA 2026-10-07: LIMITE do disparo extraído da frase ("vamos mandar
      // primeiro para 15 leads") — o modelo não lista leads na saída.
      if (effective.type === 'launch_campaign' && effective.limit == null) {
        const hint = launchLimitHint(message);
        if (hint) {
          const m = hint.match(/"limit":(\d+)/);
          if (m) effective.limit = parseInt(m[1], 10);
        }
      }
      // QA 2026-10-06: destino do TESTE extraído da PRÓPRIA frase ("envie uma
      // mensagem padrão para o número 12 99657-7200") — o modelo não decide.
      if (effective.type === 'send_test_message') {
        const t = testMessageIntent(message);
        if (t) {
          if (!effective.phone && t.phone) effective.phone = t.phone;
          if (!effective.email && t.email) effective.email = t.email;
        }
      }
      const label = ACTION_LABELS[effective.type];
      if (label) emit({ type: 'status', label });
      if (effective && effective.type && effective.type !== 'none') actionTypes.push(effective.type);
      const actionStartedAt = Date.now();
      try {
        const card = await runAction(effective, { campaign, cards, orgId, userId });
        if (card) {
          cards.push(card);
          emit({ type: 'card', card });
        }
      } catch (err) {
        // Ação falha não derruba a conversa. Erro visível (NFR4): a stack da
        // causa fica no log do servidor, nunca descartada.
        console.error(`[studio/chat] action "${action.type}" failed:`, err.stack || String(err));
        if (['LLM_JSON_FAILED', 'LLM_TIMEOUT', 'LLM_HTTP_ERROR'].includes(err.code)) {
          // Falha de LLM DENTRO da action (set_audience/generate_content):
          // zero jargão (UX-DR4) — card mordomo e o turno DEGRA no trace.
          const untouchedCopy = {
            set_audience: 'sua audiência não foi alterada ✓',
            generate_content: 'seus conteúdos continuam do mesmo jeito ✓',
          };
          const degradedCard = {
            type: 'degraded',
            label: 'Não deu para concluir agora',
            detail: `Não consegui processar isso agora — ${
              untouchedCopy[action.type] || 'nada foi alterado ✓'
            } · tenta de novo em 1 minuto.`,
          };
          cards.push(degradedCard);
          emit({ type: 'card', card: degradedCard });
          degradation = { errorCode: err.code, errorStack: String(err.stack || err) };
        } else {
          const errorCard = { type: 'error', label: `Ação "${action.type}" falhou`, detail: err.message };
          cards.push(errorCard);
          emit({ type: 'card_error', card: errorCard });
        }
      } finally {
        if (action && action.type && action.type !== 'none') {
          actionDurationsMs[action.type] = (actionDurationsMs[action.type] || 0) + (Date.now() - actionStartedAt);
        }
      }
    }

    // O reply do modelo saiu ANTES das ações rodarem e pode otimizar ("cai
    // como uma luva") justamente quando a audiência fecha em 0 leads (QA
    // 2026-09-28, F3). O aviso determinístico corrige o turno no fim — e o
    // reemit via SSE substitui o texto no frontend.
    // Usa o ÚLTIMO card de audiência: quando o turno tem set_audience (0
    // matches) seguido de select_leads (C1, QA E2E 2026-09-28), o aviso de
    // "0 leads" contradizia o resultado final do mesmo turno.
    const audienceCards = cards.filter((c) => c && c.type === 'audience');
    const finalAudienceCard = audienceCards[audienceCards.length - 1];
    if (finalAudienceCard && finalAudienceCard.emptyMatch) {
      reply +=
        `\n\n⚠️ **Atenção:** a audiência ficou com **0 leads** — sua base tem ${finalAudienceCard.baseCount} lead(s) ` +
        'e nenhum casou com o filtro. Quer que eu ajuste o segmento (ampliar setor, região ou porte) ou prefere importar leads?';
      emit({ type: 'reply', text: reply });
    }

    await prismaClient.studioChatMessage.create({
      data: { orgId, campaignId: campaign.id, role: 'assistant', text: reply, cards },
    });
    await persistChatTrace({
      campaignId: campaign.id,
      orgId,
      turnIndex,
      startedAt,
      llmTelemetry,
      actionTypes,
      actionDurationsMs,
      status: degradation ? 'degraded' : 'succeeded',
      errorCode: degradation ? degradation.errorCode : null,
      errorStack: degradation ? degradation.errorStack : null,
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
            } else if (event.type === 'reply_delta') {
              // Streaming: pedaço do reply renderizado em tempo real.
              send('reply_delta', { text: event.text });
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

  // GET /campaigns/:id/traces — telemetria operacional do chat, sem prompts/respostas.
  router.get('/campaigns/:id/traces', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await loadCampaign(prisma, orgId, req.params.id);
      const traces = await prisma.studioChatTrace.findMany({ where: { campaignId: campaign.id } });
      traces.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      res.json({
        success: true,
        data: traces.map((trace) => ({
          id: trace.id,
          turnIndex: trace.turnIndex,
          durationMs: trace.durationMs,
          llmDurationMs: trace.llmDurationMs,
          llmModel: trace.llmModel,
          llmPromptTokens: trace.llmPromptTokens,
          llmCompletionTokens: trace.llmCompletionTokens,
          llmTotalTokens: trace.llmTotalTokens,
          llmFallbackUsed: trace.llmFallbackUsed,
          llmTruncated: trace.llmTruncated,
          status: trace.status,
          errorCode: trace.errorCode,
          errorStack: trace.errorStack,
          actionTypes: trace.actionTypes,
          actionDurationsMs: trace.actionDurationsMs,
          createdAt: trace.createdAt,
        })),
      });
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
      // D2 (Epic 2): capture_leads E select_leads (o chip do card de captura
      // materializa a audiência — audiência é core, não premium) ficam FORA do
      // gate premium; as demais ações mantêm o gating de sempre.
      const actionType = String((req.body || {}).type || '');
      if (actionType !== 'capture_leads' && actionType !== 'select_leads') {
        await context.requirePremiumOrg(orgId);
      }
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
