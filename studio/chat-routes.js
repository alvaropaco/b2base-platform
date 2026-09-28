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
    case 'show_balance':
    case 'start_whatsapp_pairing':
      return {};
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

  // Amostra da seleção vigente: o agente cita e manipula leads por nome/id
  // (action select_leads) — mesma fonte do painel lateral de leads.
  if (snapshotRows[0]) {
    try {
      const members = await prisma.studioAudienceMember.findMany({
        where: { snapshotId: snapshotRows[0].id, included: true },
        take: 40,
      });
      const ids = members.map((m) => m.prospectId);
      const prospects = ids.length
        ? await prisma.prospect.findMany({ where: { id: { in: ids } }, select: { id: true, companyName: true } })
        : [];
      const byId = new Map(prospects.map((p) => [p.id, p.companyName]));
      extras.audienceLeadSample = ids.map((id) => ({ id, empresa: byId.get(id) || 'lead' }));
      // Leads na base FORA da seleção: sem isso o agente não consegue ADICIONAR
      // de volta um lead removido ("traz a Repro de volta") — ele só via os
      // incluídos e pedia prospectId na mão (QA visual 2026-09-28).
      const foraDaSelecao = await prisma.prospect.findMany({
        where: { orgId: campaign.orgId, id: { notIn: ids } },
        select: { id: true, companyName: true },
        orderBy: { createdAt: 'desc' },
        take: 40,
      });
      extras.audienceAvailableSample = foraDaSelecao.map((p) => ({ id: p.id, empresa: p.companyName || 'lead' }));
    } catch (_e) { /* snapshot sem membros legíveis: segue sem amostra */ }
  }

  // Canais para o agente explicar limites/bloqueios com passo a passo:
  // saldo por canal + status da sessão WhatsApp + domínio do e-mail.
  try {
    const reputation = require('./reputation');
    const channels = {};
    for (const b of await reputation.listBalances(prisma, campaign.orgId)) {
      if (b) channels[b.channel] = { disponivel: b.available, piso: b.floor, teto: b.ceiling, dominio: b.domainAuthStatus };
    }
    let whatsapp = 'nao_conectado';
    try {
      const account = await prisma.whatsAppAccount.findFirst({ where: { orgId: campaign.orgId } });
      if (account) whatsapp = account.status;
    } catch (_e) { /* modelo ausente em alguns harnesses */ }
    extras.canais = { reputacao: channels, whatsapp };
  } catch (_e) { /* sem reputação configurada */ }

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
  } catch (_e) { /* sem classificações no workspace */ }

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
  } catch (_e) { /* sem marca configurada */ }

  return extras;
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
        const baseCount = await prisma.prospect.count({ where: { orgId } });
        const { snapshot } = await campaignService.flow.materializeAudience(prisma, {
          campaign,
          prospectIds: prospects.map((p) => p.id),
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
        return buildAudienceCard({ snapshot, baseCount, rationaleText: rationale || criteriaDescription(criteria) });
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
        const { connected, qr } = await waitForChatQr(provider, sessionName, 25_000);
        if (connected) {
          await prisma.whatsAppAccount.update({ where: { sessionName }, data: { status: 'CONNECTED' } }).catch(() => {});
          return {
            type: 'whatsapp_qr',
            label: 'WhatsApp já está conectado',
            detail: 'A sessão deste workspace está ativa — pode disparar por WhatsApp assim que o saldo permitir.',
            status: 'connected',
            qrCode: null,
          };
        }
        if (qr && qr.qrCode) {
          await prisma.whatsAppAccount.update({ where: { sessionName }, data: { status: 'QR_REQUIRED' } }).catch(() => {});
          return {
            type: 'whatsapp_qr',
            label: 'Pareamento do WhatsApp — escaneie o QR',
            detail: '1. Abra o WhatsApp no celular · 2. Toque em Aparelhos conectados → Conectar aparelho · 3. Aponte a câmera para o QR abaixo. Ele expira em ~1 minuto — se expirar, me peça "mostrar o QR de novo".',
            status: 'qr_required',
            qrCode: qr.qrCode,
          };
        }
        return {
          type: 'whatsapp_qr',
          label: 'Sessão do WhatsApp subindo…',
          detail: 'A sessão está iniciando no servidor. Me peça "mostrar o QR do WhatsApp" novamente em alguns segundos.',
          status: 'starting',
          qrCode: null,
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
 * Card do Orçamento de Reputação em linguagem clara (FR-20): status por canal
 * (PRONTO / PENDENTE / BLOQUEADO) + passo a passo numerado de desbloqueio.
 */
async function buildBalanceCard(prisma, orgId) {
  const reputation = require('./reputation');
  const balances = (await reputation.listBalances(prisma, orgId)).filter(Boolean);
  const lines = [];
  for (const b of balances) {
    const channelLabel = b.channel === 'email' ? 'E-mail' : 'WhatsApp';
    const pct = b.ceiling ? Math.round((b.available / b.ceiling) * 100) : null;
    const blocked = b.available <= b.floor;
    const pendingDomain = b.channel === 'email' && b.domainAuthStatus !== 'verified';
    const status = blocked ? 'BLOQUEADO' : pendingDomain ? 'PENDENTE — domínio não autenticado' : 'PRONTO';
    const steps = [];
    if (pendingDomain) {
      steps.push('Autenticar o domínio: publicar SPF, DKIM e DMARC no DNS (me peça "listar os registros DNS" que eu mostro cada um)');
    }
    if (blocked) {
      steps.push(`Recarregar o saldo: há ${b.available} disponíveis e o piso é ${b.floor} — disparos param abaixo do piso`);
    }
    if (b.channel === 'whatsapp') {
      steps.push('Manter o WhatsApp pareado — se a sessão cair, me peça "mostrar o QR do WhatsApp"');
    }
    if (steps.length === 0) steps.push('Nada a fazer — canal saudável e autorizado a disparar');
    lines.push(
      `**${channelLabel} — ${status}**: ${b.available} envios disponíveis de ${b.ceiling}${pct != null ? ` (${pct}%)` : ''}. ` +
        steps.map((s, i) => `${i + 1}. ${s}`).join(' ')
    );
  }
  if (lines.length === 0) lines.push('Nenhuma conta de canal configurada ainda.');
  return { type: 'balance', label: 'Orçamento de Reputação — como liberar seus disparos', detail: lines.join('\n') };
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
    set_objective: 'Definindo objetivo…',
    set_audience: 'Criando audiência…',
    select_leads: 'Ajustando os leads selecionados…',
    attach_url: 'Anexando e extraindo material…',
    confirm_material: 'Confirmando extração…',
    generate_content: 'Gerando conteúdo…',
    set_schedule: 'Configurando agendamento…',
    show_balance: 'Consultando o Orçamento de Reputação…',
    start_whatsapp_pairing: 'Preparando o pareamento do WhatsApp…',
  };

  async function persistChatTrace({ campaignId, orgId, turnIndex, startedAt, llmTelemetry, actionTypes, actionDurationsMs, status = 'succeeded', errorCode = null }) {
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
      errorCode,
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
    let reply;
    let actions;
    try {
      ({ reply, actions } = await chatAgent.orchestrate({
        campaign,
        history: [...history, userMessage],
        userMessage: message,
        extras,
        onLlmCall: (telemetry) => llmTelemetry.push(telemetry),
      }));
    } catch (error) {
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
      });
      throw error;
    }
    emit({ type: 'reply', text: reply });

    const cards = [...autoAttachCards];
    for (const action of actions) {
      const label = ACTION_LABELS[action.type];
      if (label) emit({ type: 'status', label });
      if (action && action.type && action.type !== 'none') actionTypes.push(action.type);
      const actionStartedAt = Date.now();
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
