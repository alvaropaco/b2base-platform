/**
 * whatsapp-workers.js — processadores Bull do canal WhatsApp.
 *
 * Filas (definidas em whatsapp-queues.js):
 *   whatsapp:sequence  — avança uma etapa da sequência de um contato de campanha
 *   whatsapp:send      — envia uma mensagem via WAHA (abstração WhatsAppProvider)
 *
 * Fluxo:
 *   Campaign → Eligible Leads → Sequence Engine → Bull → WhatsApp Worker → WAHA
 *
 * Idempotência: um (campaignContactId, stepIndex) produz no máximo uma mensagem;
 * reentregas/restarts não duplicam envios. O worker nunca processa um contato em
 * estado terminal (REPLIED/OPTED_OUT/CANCELLED/COMPLETED).
 */
const { PrismaClient } = require('@prisma/client');
const { getWhatsAppQueues } = require('./whatsapp-queues');
const { registerProcessor } = require('./outreach-queues');
const { WAHAWhatsAppProvider } = require('./waha-provider');
const { checkLimit, calculateDelay } = require('./whatsapp-rate-limiter');
const { toChatId, normalizePhone, usablePhone, renderTemplate, truncateForWhatsApp, BLOCKLIST } = require('./whatsapp-utils');
const llm = require('./llm-client');
// Stub injetável nos testes (gera JSON sem chamar o gateway real).
let llmClient = llm;
function _setLlmForTests(stub) { llmClient = stub; }
const orgContext = require('./org-context');
const {
  getOrCreateConversation,
  isContactable,
  CONTACT_STATUS,
  CAMPAIGN_STATUS,
  ACCOUNT_STATUS,
  reconcileSessionStatus,
} = require('./whatsapp-engine');
const whatsappNats = require('./whatsapp-nats');
const metrics = require('./metrics');

let _prisma = null;
function getPrisma() {
  if (!_prisma) _prisma = new PrismaClient();
  return _prisma;
}

// Injeção para testes (node --test sem Prisma/Redis real) — sufixo _ForTests.
function _setPrismaForTests(client) { _prisma = client; }

let _queuesOverride = null;
function _setQueuesForTests(queues) { _queuesOverride = queues; }
function queues() { return _queuesOverride || getWhatsAppQueues(); }

const wahaProvider = WAHAWhatsAppProvider;

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function loadCampaignContact(prisma, contactId) {
  return prisma.whatsAppCampaignContact.findUnique({
    where: { id: contactId },
    include: { campaign: true },
  });
}

async function loadSteps(prisma, campaignId) {
  return prisma.whatsAppSequenceStep.findMany({
    where: { campaignId },
    orderBy: { orderIndex: 'asc' },
  });
}

async function loadAccount(prisma, accountId) {
  if (!accountId) return null;
  return prisma.whatsAppAccount.findUnique({ where: { id: accountId } });
}

/**
 * Marca a campanha como COMPLETED se todos os contatos terminaram.
 */
async function maybeCompleteCampaign(prisma, campaignId) {
  const active = await prisma.whatsAppCampaignContact.count({
    where: { campaignId, status: { in: ['QUEUED', 'SENDING', 'SENT'] } },
  });
  if (active === 0) {
    await prisma.whatsAppCampaign.update({
      where: { id: campaignId },
      data: { status: CAMPAIGN_STATUS.COMPLETED, completedAt: new Date() },
    });
    await whatsappNats.publishEvent('whatsapp.campaigns.completed', { campaignId });
  }
}

// ─── Geração de mensagem única por lead (steps aiPersonalized) ───────────────
// Feature premium: campanhas criadas pelo gerador de IA (ai-campaign.js) usam
// steps com aiPersonalized=true. A mensagem é gerada por lead (org + campanha +
// prospect); QUALQUER falha cai no renderTemplate do step — a mensagem nunca
// deixa de sair por culpa do LLM. Org não-premium usa template direto (sem
// gasto de LLM após um downgrade no meio de uma campanha).

const STEP_MESSAGE_MAX_LEN = 600;

function buildStepMessagePrompt({ prospect, orgCtx, campaign }) {
  const campaignBlock = orgContext.renderCampaignBlock(campaign);
  return [
    `Você é um vendedor da ${orgContext.sellerIdentity(orgCtx)}. Escreva UMA mensagem`,
    'inicial de WhatsApp B2B em português brasileiro para o prospecto abaixo.',
    '',
    '== CONTEXTO DA NOSSA EMPRESA ==',
    orgCtx.renderForPrompt(),
    '',
    ...(campaignBlock ? [campaignBlock, ''] : []),
    '== PROSPECTO ==',
    `- Empresa: ${prospect.companyName}${prospect.tradeName ? ` (${prospect.tradeName})` : ''}`,
    `- Pessoa de contato: ${prospect.contactName || 'não informada (NÃO invente um nome; saude sem nome)'}`,
    `- Segmento: ${prospect.industry || 'N/A'}`,
    `- Localização: ${prospect.city ? [prospect.city, prospect.state].filter(Boolean).join('/') : 'N/A'}`,
    '',
    'REGRAS:',
    '- Use apenas fatos presentes nos dados acima. NÃO invente informações, preços, prazos ou promessas.',
    '- NÃO cite plataformas/empresas que não estejam no contexto e NÃO inclua links.',
    '- Mensagem CURTA (máx. 3 frases), humana e direta, sem parecer template.',
    '- Termine com uma pergunta leve que convide à resposta (CTA do contexto, se houver).',
    '- Responda APENAS com JSON válido: { "message": "texto da mensagem" }',
  ].join('\n');
}

/** Guard determinístico (mesma política do reengagement-agent). */
function stepMessageGuard(text) {
  const content = String(text || '').trim();
  if (!content) return { pass: false, reason: 'empty' };
  if (content.length > STEP_MESSAGE_MAX_LEN) return { pass: false, reason: 'too_long' };
  if (BLOCKLIST.test(content)) return { pass: false, reason: 'blocked_claim' };
  return { pass: true, content };
}

/**
 * Mensagem única para (contato, step). NUNCA lança e NUNCA retorna vazio:
 * fallback = renderTemplate(step.messageTemplate) — o template/base aprovada
 * do tenant (FR-005), nunca texto genérico da plataforma. Uma resposta
 * vazia/curta demais do modelo (JSON parcial) tem direito a 1 retry antes do
 * fallback.
 *
 * @returns {{ text: string, origin: 'ai'|'ai_fallback_template' }} origin
 *   alimenta WhatsAppMessage.compositionOrigin (auditoria FR-010).
 */
async function generateStepMessage(prisma, { prospect, campaign, step }) {
  const fallback = () => ({
    text: renderTemplate(step.messageTemplate, prospect),
    origin: 'ai_fallback_template',
  });
  try {
    const { isPremiumOrg } = require('./ai-campaign');
    if (!(await isPremiumOrg(prisma, campaign.orgId))) return fallback();

    const orgCtx = await orgContext.loadOrgContext(prisma, campaign.orgId);
    const prompt = buildStepMessagePrompt({ prospect, orgCtx, campaign });

    for (let attempt = 1; attempt <= 2; attempt++) {
      const { content } = await llmClient.callLlm({
        system: 'Você é um vendedor B2B brasileiro. Responda APENAS com JSON válido.',
        user: prompt,
        temperature: 0.7,
        maxTokens: 300,
        model: llm.premiumModel(),
        tag: 'whatsapp:step-ai',
      });
      const parsed = llmClient.parseJsonLoose(content);
      // FR-007: excesso de comprimento é truncado preservando frases ANTES do
      // guard — a personalização não é descartada por ultrapassar o canal.
      const candidate = truncateForWhatsApp(parsed && parsed.message);
      const guard = stepMessageGuard(candidate);
      if (guard.pass) return { text: guard.content, origin: 'ai' };
      if (guard.reason === 'empty' && attempt === 1) continue; // 1 retry p/ resposta vazia
      console.warn(`[whatsapp] step AI bloqueado (${guard.reason}), usando template do tenant como fallback`);
      return fallback();
    }
    return fallback();
  } catch (err) {
    console.error('[whatsapp] geração AI do step falhou, usando template do tenant como fallback:', err.message);
    return fallback();
  }
}

// ─── Telefones ───────────────────────────────────────────────────────────────
// Snapshot utilizável do cadastro do lead vem de whatsapp-utils.usablePhone
// (10-13 dígitos, DDI 55 quando presente — rejeita o lixo estrangeiro que o
// crawler antigo registrava, ex.: +91… da Índia). Garante que um número
// registrado no LEAD chegue ao CONTATO da campanha — a matrícula do Studio
// cria o contato sem snapshot e cancelar por no_phone com número no cadastro
// era o bug do caso MB (2026-10-09: enriquecimento cadastrou, disparo dizia
// "sem número").

// ─── Queue: whatsapp:sequence ────────────────────────────────────────────────
async function processSequence(job) {
  const { contactId, stepIndex } = job.data;
  const prisma = getPrisma();

  const contact = await loadCampaignContact(prisma, contactId);
  if (!contact) return { skipped: 'contact_not_found' };

  const campaign = contact.campaign;
  const prospectId = contact.prospectId;
  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } });
  if (!prospect) return { skipped: 'prospect_not_found' };

  // Guardas de estado.
  if (campaign.status === CAMPAIGN_STATUS.CANCELLED) {
    await prisma.whatsAppCampaignContact.update({
      where: { id: contactId },
      data: { status: CONTACT_STATUS.CANCELLED, cancelReason: 'cancelled' },
    });
    return { skipped: 'campaign_cancelled' };
  }
  if (campaign.status === CAMPAIGN_STATUS.PAUSED) {
    // Re-agenda e aguarda o resume.
    await queues().sequence.add(
      { contactId, stepIndex, prospectId, campaignId: campaign.id },
      { delay: 60 * 1000, attempts: 1000 }
    );
    return { paused: true };
  }
  // specs/011 (FR-19/AD-4): pausa GLOBAL da org (persistida) — paridade com
  // a pausa de campanha: re-agenda e aguarda retomada explícita. Sem o model
  // `organization` (fakes legados) a flag não existe → não há pausa.
  if (typeof prisma.organization?.findUnique === 'function') {
    try {
      const org = await prisma.organization.findUnique({ where: { id: campaign.orgId } });
      if (org && org.studioSendPaused) {
        await queues().sequence.add(
          { contactId, stepIndex, prospectId, campaignId: campaign.id },
          { delay: 60 * 1000, attempts: 1000 }
        );
        return { paused: 'org_paused' };
      }
    } catch (pauseErr) {
      // Fail-closed: sem confirmação de que a org não está pausada, re-agenda.
      console.error('[whatsapp] checagem de pausa global falhou (fail-closed):', pauseErr.message);
      await queues().sequence.add(
        { contactId, stepIndex, prospectId, campaignId: campaign.id },
        { delay: 60 * 1000, attempts: 1000 }
      );
      return { paused: 'pause_check_failed' };
    }
  }
  if (campaign.status !== CAMPAIGN_STATUS.RUNNING) {
    return { skipped: `campaign_${campaign.status}` };
  }
  if ([CONTACT_STATUS.REPLIED, CONTACT_STATUS.OPTED_OUT, CONTACT_STATUS.CANCELLED, CONTACT_STATUS.COMPLETED].includes(contact.status)) {
    return { skipped: `contact_${contact.status}` };
  }
  if (!(await isContactable(prisma, { orgId: campaign.orgId, prospectId }))) {
    await prisma.whatsAppCampaignContact.update({
      where: { id: contactId },
      data: { status: CONTACT_STATUS.CANCELLED, cancelReason: 'do_not_contact' },
    });
    return { skipped: 'do_not_contact' };
  }

  const account = await loadAccount(prisma, campaign.whatsappAccountId);
  if (!account || account.status !== ACCOUNT_STATUS.CONNECTED) {
    return { skipped: 'account_not_connected' };
  }

  const steps = await loadSteps(prisma, campaign.id);
  if (stepIndex >= steps.length) {
    await prisma.whatsAppCampaignContact.update({
      where: { id: contactId },
      data: { status: CONTACT_STATUS.COMPLETED },
    });
    await maybeCompleteCampaign(prisma, campaign.id);
    return { completed: true };
  }

  const step = steps[stepIndex];
  let phoneNumber = normalizePhone(contact.phoneNumber);
  if (!phoneNumber) {
    // Cura do snapshot no envio: contato sem telefone (matrícula do Studio ou
    // lead enriquecido DEPOIS do cancelamento) re-lê o cadastro ATUAL do
    // lead e persiste o número — as próximas etapas não repetem a cura.
    // Cancelar no_phone com número no cadastro devolvia o lead da IA para a
    // fila morta exatamente quando o usuário já tinha cadastrado o WhatsApp.
    phoneNumber = usablePhone(prospect.cnpjPhones);
    if (phoneNumber) {
      await prisma.whatsAppCampaignContact.update({
        where: { id: contactId },
        data: { phoneNumber },
      });
    }
  }
  if (!phoneNumber) {
    await prisma.whatsAppCampaignContact.update({
      where: { id: contactId },
      data: { status: CONTACT_STATUS.CANCELLED, cancelReason: 'no_phone' },
    });
    return { skipped: 'no_phone' };
  }

  // Idempotência por (campaignContactId, stepIndex): nunca re-envia a etapa.
  const existing = await prisma.whatsAppMessage.findUnique({
    where: { campaignContactId_stepIndex: { campaignContactId: contact.id, stepIndex } },
  });
  if (existing) return { skipped: 'already_exists' };

  // Rate limiting (conta + recipiente).
  const limit = await checkLimit(prisma, { whatsappAccountId: account.id, phoneNumber });
  if (!limit.allowed) {
    await queues().sequence.add(
      { contactId, stepIndex, prospectId, campaignId: campaign.id },
      { delay: limit.retryIn || calculateDelay(), attempts: 1000 }
    );
    return { rate_limited: true, retryIn: limit.retryIn };
  }

  // Campanha IA (step.aiPersonalized): mensagem única por lead, com o
  // renderTemplate do step como fallback garantido (origem registrada p/
  // auditoria — FR-010). Nenhum caminho introduz texto de plataforma.
  let content;
  let compositionOrigin;
  if (step.aiPersonalized) {
    const generated = await generateStepMessage(prisma, { prospect, campaign, step });
    // FR-007: excesso de comprimento é truncado preservando frases — a base
    // nunca é trocada por outro texto.
    content = truncateForWhatsApp(generated.text);
    compositionOrigin = generated.origin;
  } else {
    content = renderTemplate(step.messageTemplate, prospect);
    compositionOrigin = 'tenant_template';
  }
  if (!content) {
    await prisma.whatsAppCampaignContact.update({
      where: { id: contactId },
      data: { status: CONTACT_STATUS.CANCELLED, cancelReason: 'empty_template' },
    });
    return { skipped: 'empty_template' };
  }

  const conversation = await getOrCreateConversation(prisma, {
    orgId: campaign.orgId,
    whatsappAccountId: account.id,
    phoneNumber,
    prospectId,
  });

  const message = await prisma.whatsAppMessage.create({
    data: {
      conversationId: conversation.id,
      orgId: campaign.orgId,
      campaignContactId: contact.id,
      direction: 'OUTBOUND',
      type: 'TEXT',
      content,
      status: 'PENDING',
      source: 'CAMPAIGN',
      compositionOrigin,
      stepIndex,
    },
  });

  metrics.incCompositionOrigin('whatsapp', compositionOrigin);

  await prisma.whatsAppCampaignContact.update({
    where: { id: contactId },
    data: { status: CONTACT_STATUS.SENDING, currentStepIndex: stepIndex },
  });

  await queues().send.add({ messageId: message.id }, { attempts: 5, backoff: { type: 'exponential', delay: 5000 } });

  return { messageId: message.id, stepIndex };
}

// ─── Queue: whatsapp:send ────────────────────────────────────────────────────
async function processSend(job) {
  const { messageId } = job.data;
  const prisma = getPrisma();

  const message = await prisma.whatsAppMessage.findUnique({
    where: { id: messageId },
    include: { conversation: { include: { whatsappAccount: true } } },
  });
  if (!message) throw new Error(`Mensagem ${messageId} não encontrada`);
  if (message.status === 'SENT' || message.status === 'DELIVERED' || message.status === 'READ') {
    return { already_sent: true };
  }

  // Conversa pode estar ÓRFÃ de conta (criada antes do pareamento ou com a
  // conta recriada — caso MB maquinas, 09/10: whatsappAccountId null → o
  // disparo morria com "Conta WhatsApp não conectada" para sempre, mesmo com
  // a sessão CONNECTED). Resolve a conta CONECTADA da organização e RELINKA a
  // conversa; só falha de verdade se não houver conta conectada alguma.
  let account = message.conversation && message.conversation.whatsappAccount;
  if (!account) {
    account = await prisma.whatsAppAccount.findFirst({
      where: { orgId: message.orgId || campaign.orgId, status: ACCOUNT_STATUS.CONNECTED },
    });
    if (account && message.conversationId) {
      await prisma.whatsAppConversation
        .update({ where: { id: message.conversationId }, data: { whatsappAccountId: account.id } })
        .catch(() => {});
      if (message.conversation) message.conversation.whatsappAccountId = account.id;
    }
  }
  if (!account) {
    throw new Error('Nenhuma conta WhatsApp CONECTADA nesta organização — pareie o WhatsApp (QR no chat) para enviar.');
  }

  // Status no banco pode estar defasado (evento DISCONNECTED transitório do
  // WAHA): reconcilia antes de falhar o envio.
  if (account.status !== ACCOUNT_STATUS.CONNECTED) {
    await reconcileSessionStatus(getPrisma(), wahaProvider, account);
    account = await getPrisma().whatsAppAccount.findUnique({ where: { id: account.id } });
    if (!account || account.status !== ACCOUNT_STATUS.CONNECTED) {
      throw new Error('Conta WhatsApp não conectada');
    }
  }

  // Se o contato entrou em estado terminal, cancela o envio.
  if (message.campaignContactId) {
    const contact = await prisma.whatsAppCampaignContact.findUnique({
      where: { id: message.campaignContactId },
    });
    if (contact && [CONTACT_STATUS.REPLIED, CONTACT_STATUS.OPTED_OUT, CONTACT_STATUS.CANCELLED].includes(contact.status)) {
      await prisma.whatsAppMessage.update({
        where: { id: message.id },
        data: { status: 'FAILED', error: 'contact_terminal_state', failedAt: new Date() },
      });
      // specs/011 (AD-13): falha definitiva antes do envio → estorno.
      // Epic 3 (review E3-M2): cancelado pela SINCRONIZAÇÃO de fila → mesmo
      // refId determinístico do sync (unique (type, refId) deduplica entre os
      // caminhos); demais terminais seguem o padrão por messageId.
      if (contact.status === CONTACT_STATUS.CANCELLED && contact.cancelReason === 'removido_da_selecao') {
        await _refundForSyncedContact(prisma, message, contact, `contato em estado terminal (${contact.status})`);
      } else {
        await _refundForMessage(prisma, message, `contato em estado terminal (${contact.status})`);
      }
      return { cancelled: true, reason: contact.status };
    }
  }

  // specs/011 (FR-19/AD-4): pausa global da org checada antes de CADA envio.
  if (typeof prisma.organization?.findUnique === 'function') {
    try {
      const org = await prisma.organization.findUnique({ where: { id: message.orgId } });
      if (org && org.studioSendPaused) {
        console.log(`[whatsapp] ⊘ pausa global da org ${message.orgId} — re-agendando em 60s`);
        await queues().send.add({ messageId: message.id }, { delay: 60 * 1000, attempts: 5, backoff: { type: 'exponential', delay: 5000 } });
        return { paused: 'org_paused' };
      }
    } catch (pauseErr) {
      // Fail-closed: sem confirmação de que a org não está pausada, re-agenda.
      console.error('[whatsapp] checagem de pausa global falhou (fail-closed):', pauseErr.message);
      await queues().send.add({ messageId: message.id }, { delay: 60 * 1000, attempts: 5, backoff: { type: 'exponential', delay: 5000 } });
      return { paused: 'pause_check_failed' };
    }
  }

  // Prefere o JID original da conversa (chats LID/grupo não entregam se o
  // chatId for reconstruído como "<digits>@c.us").
  const chatId = message.conversation.chatId || toChatId(message.conversation.phoneNumber);

  // Mídia do Studio (D6/D8, Story 2.3): a execução guarda a REFERÊNCIA da
  // mídia determinística; os bytes são lidos do storage AQUI, no send —
  // SOMENTE no 1º toque (follow-ups nunca levam mídia: stepIndex 0-based do
  // motor; null = mensagens sem sequência). Falha de leitura é guardada e
  // vira throw DENTRO do try do envio — o catch de lá marca FAILED e estorna
  // idempotentemente (E11 — falha segura).
  let media = null;
  let mediaError = null;
  const isFirstTouch = message.stepIndex == null || message.stepIndex === 0;
  if (message.campaignContactId && isFirstTouch) {
    try {
      const campaignContact = await prisma.whatsAppCampaignContact.findUnique({
        where: { id: message.campaignContactId },
        select: { campaignId: true },
      });
      if (campaignContact) {
        const campaignModel = prisma.whatsAppCampaign || prisma.whatsappCampaign;
        const engine = campaignModel
          ? await campaignModel.findUnique({ where: { id: campaignContact.campaignId } })
          : null;
        const ref = Array.isArray(engine?.studioAttachments) ? engine.studioAttachments[0] : null;
        if (ref) {
          const buffer = require('./studio/storage').readBuffer(ref.fileName);
          const isImage = String(ref.mimeType || '').startsWith('image/');
          media = {
            kind: isImage ? 'image' : 'document',
            data: buffer.toString('base64'),
            mimetype: ref.mimeType || 'application/octet-stream',
            fileName: ref.originalName || ref.fileName,
            // Texto da peça como legenda — sem duplicar mensagem de texto.
            caption: message.content || undefined,
          };
        }
      }
    } catch (mediaErr) {
      console.error(`[whatsapp] mídia ilegível para mensagem ${message.id}:`, mediaErr.message);
      mediaError = mediaErr;
    }
  }

  try {
    if (mediaError) {
      throw new Error(`mídia ilegível: ${mediaError.message}`);
    }
    const result = media
      ? await wahaProvider.sendMedia(account.sessionName, chatId, media)
      : await wahaProvider.sendText(account.sessionName, chatId, message.content);
    const now = new Date();

    await prisma.whatsAppMessage.update({
      where: { id: message.id },
      data: {
        status: 'SENT',
        providerMessageId: result.providerMessageId,
        sentAt: now,
        error: null,
      },
    });
    metrics.incWhatsAppSent();

    await prisma.whatsAppConversation.update({
      where: { id: message.conversationId },
      data: { lastMessageAt: now },
    });

    if (message.campaignContactId) {
      const updated = await prisma.whatsAppCampaignContact.update({
        where: { id: message.campaignContactId },
        data: { status: CONTACT_STATUS.SENT, lastSentAt: now },
      });
      // Sinaliza o lead como contatado (canal whatsapp) — badge "Contatado"
      const { markContacted } = require('./campaign-suite');
      await markContacted(prisma, updated.prospectId, 'whatsapp').catch(() => {});
    }

    await whatsappNats.publishEvent(whatsappNats.SUBJECTS.MESSAGE_SENT, {
      orgId: message.orgId,
      whatsappAccountId: account.id,
      conversationId: message.conversationId,
      messageId: message.id,
      providerMessageId: result.providerMessageId,
    });

    // Agenda o próximo passo da sequência.
    await scheduleNextStep(prisma, message);

    return { providerMessageId: result.providerMessageId };
  } catch (err) {
    metrics.incWhatsAppFailed();
    await prisma.whatsAppMessage.update({
      where: { id: message.id },
      data: { status: 'FAILED', error: err.message, failedAt: new Date() },
    });
    await whatsappNats.publishEvent(whatsappNats.SUBJECTS.MESSAGE_FAILED, {
      orgId: message.orgId,
      whatsappAccountId: account.id,
      conversationId: message.conversationId,
      messageId: message.id,
      error: err.message,
    });
    // specs/011 (AD-13/FR-18): falha DEFINITIVA (última tentativa) → estorno
    // idempotente + penalização do saldo + Despertar (rejeição WhatsApp é
    // prioridade 1 na lista fechada). Falha transitória re-tenta sem estornar.
    const attempts = Number(job.opts?.attempts) || 5;
    if (job.attemptsMade >= attempts - 1) {
      await _refundForMessage(prisma, message, `falha definitiva do provider: ${err.message}`);
      await _penalizeForMessage(prisma, message, `mensagem rejeitada/bloqueada: ${err.message}`);
    }
    throw err; // Bull re-tenta com backoff
  }
}

/**
 * specs/011 (FR-18): rejeição/bloqueio de WhatsApp reduz o saldo
 * automaticamente e desperta (lista fechada FR-31). Nunca quebra o worker.
 */
async function _penalizeForMessage(prisma, message, reason) {
  try {
    if (!message?.orgId || !message?.id) return null;
    const reputation = require('./studio/reputation');
    const autonomy = require('./studio/autonomy');
    const result = await reputation.penalize(prisma, {
      orgId: message.orgId,
      channel: 'whatsapp',
      amount: 1,
      reason,
      refId: message.id,
    });
    await autonomy.report(prisma, {
      orgId: message.orgId,
      type: 'studio.whatsapp.rejected',
      campaignId: message.campaignContactId || null,
      details: { reason, messageId: message.id },
    });
    return result;
  } catch (err) {
    console.error('[whatsapp] penalização de saldo falhou (ignorado):', err.message);
    return null;
  }
}

/**
 * specs/011 (AD-13): estorno idempotente do débito do gate (unique
 * (type, refId) no ledger impede duplo estorno). Nunca quebra o worker.
 */
async function _refundForMessage(prisma, message, reason) {
  try {
    if (!message?.orgId || !message?.id) return null;
    const reputation = require('./studio/reputation');
    return await reputation.refundSend(prisma, { orgId: message.orgId, channel: 'whatsapp', messageId: message.id, reason });
  } catch (err) {
    console.error('[whatsapp] estorno de saldo falhou (ignorado):', err.message);
    return null;
  }
}

/**
 * Epic 3 (review E3-M2): estorno de contato cancelado pela sincronização de
 * fila com o MESMO refId determinístico do sync — a unique (type, refId) do
 * ledger fecha a corrida sync×worker (nunca 2 créditos por 1 débito).
 */
async function _refundForSyncedContact(prisma, message, contact, reason) {
  try {
    if (!message?.orgId || !contact?.id) return null;
    const campaign = await prisma.whatsAppCampaign.findUnique({
      where: { id: contact.campaignId },
      select: { studioCampaignId: true },
    });
    if (!campaign?.studioCampaignId) return _refundForMessage(prisma, message, reason);
    const reputation = require('./studio/reputation');
    return await reputation.refundBatch(prisma, {
      orgId: message.orgId,
      channel: 'whatsapp',
      batchId: `sync:${campaign.studioCampaignId}:whatsapp:${contact.id}`,
      units: 1,
      reason,
    });
  } catch (err) {
    console.error('[whatsapp] estorno de contato sincronizado falhou (ignorado):', err.message);
    return null;
  }
}

async function scheduleNextStep(prisma, message) {
  if (!message.campaignContactId || message.stepIndex == null) return;

  const contact = await loadCampaignContact(prisma, message.campaignContactId);
  if (!contact) return;

  const steps = await loadSteps(prisma, contact.campaignId);
  const nextIndex = message.stepIndex + 1;
  if (nextIndex >= steps.length) {
    await prisma.whatsAppCampaignContact.update({
      where: { id: contact.id },
      data: { status: CONTACT_STATUS.COMPLETED },
    });
    await maybeCompleteCampaign(prisma, contact.campaignId);
    return;
  }

  const delayMinutes = steps[nextIndex].delayMinutes || 0;
  await queues().sequence.add(
    {
      contactId: contact.id,
      stepIndex: nextIndex,
      prospectId: contact.prospectId,
      campaignId: contact.campaignId,
    },
    { delay: Math.max(1000, delayMinutes * 60 * 1000), attempts: 1000 }
  );
}

// ─── Campanha ────────────────────────────────────────────────────────────────
async function startCampaign(prisma, { campaignId, prospectIds, orgId }) {
  const campaign = await prisma.whatsAppCampaign.findFirst({
    where: { id: campaignId, orgId },
  });
  if (!campaign) throw new Error('Campanha não encontrada');

  const steps = await loadSteps(prisma, campaign.id);
  if (steps.length === 0) throw new Error('Campanha sem etapas de sequência');

  const account = await loadAccount(prisma, campaign.whatsappAccountId);
  if (!account) throw new Error('Campanha sem conta WhatsApp vinculada');
  if (account.status !== ACCOUNT_STATUS.CONNECTED) {
    throw new Error('Conta WhatsApp não está conectada');
  }

  const owned = await prisma.prospect.findMany({
    where: { id: { in: prospectIds }, orgId },
    select: { id: true, cnpjPhones: true },
  });
  const ownedMap = new Map(owned.map((p) => [p.id, p]));

  const queue = queues();
  let queued = 0;
  let skippedAlreadyEnrolled = 0;

  // RUNNING ANTES do enfileiramento: o primeiro job sai com delay 0 e o
  // processador confere o status da campanha — se o update vinha depois do
  // loop, o job 0 lia DRAFT e era descartado (lead #1 ficava QUEUED para
  // sempre, sem mensagem e sem erro).
  await prisma.whatsAppCampaign.update({
    where: { id: campaignId },
    data: { status: CAMPAIGN_STATUS.RUNNING, startedAt: new Date(), pausedAt: null, completedAt: null },
  });

  for (let i = 0; i < prospectIds.length; i++) {
    const prospectId = prospectIds[i];
    const prospect = ownedMap.get(prospectId);
    if (!prospect) continue;

    // Idempotência: lead já inscrito nesta campanha não é reenfileirado — o
    // upsert abaixo resetaria o contato para QUEUED/passos 0 e a sequência
    // inteira re-executaria (mensagens duplicadas pro mesmo lead). Exceção:
    // cancelado por 'no_phone' na época pode ser retentado quando o telefone
    // chega depois (ex.: enriquecimento completou após o lançamento).
    const prior = await prisma.whatsAppCampaignContact.findUnique({
      where: { campaignId_prospectId: { campaignId, prospectId } },
      select: { id: true, status: true, cancelReason: true, nextSendAt: true, phoneNumber: true },
    });
    const retryableNoPhone = prior?.status === 'CANCELLED' && prior.cancelReason === 'no_phone';
    if (prior && !retryableNoPhone) {
      // QA 2026-10-06: contato pré-matriculado ALOCADO pelo gate do Studio
      // (nextSendAt marcado por enqueueBatch) precisa do job da etapa — o
      // skip antigo o deixava 'Na fila' para sempre, sem remetente. Quem não
      // foi alocado continua aguardando o gate; quem já tem sequência em
      // curso (job idempotente pelo status do contato) não duplica.
      if (prior.status === CONTACT_STATUS.QUEUED && prior.nextSendAt) {
        // Backfill do snapshot: a matrícula do Studio cria o contato SEM
        // telefone — sem isto o worker cancelava no_phone na 1ª passada
        // mesmo com o número no cadastro do lead (caso MB, 2026-10-09).
        if (!normalizePhone(prior.phoneNumber)) {
          const healed = usablePhone(prospect.cnpjPhones);
          if (healed) {
            await prisma.whatsAppCampaignContact.update({
              where: { id: prior.id },
              data: { phoneNumber: healed },
            });
          }
        }
        await queue.sequence.add(
          { contactId: prior.id, stepIndex: 0, prospectId, campaignId },
          { delay: 0, attempts: 1000 }
        );
        queued++;
      } else {
        skippedAlreadyEnrolled++;
      }
      continue;
    }

    // Mesmo critério do worker de envio (10-13 dígitos): número curto/lixo no
    // cadastro não vira chatId inválido — fica no_phone para curar depois.
    const phoneNumber = usablePhone(prospect.cnpjPhones);

    const contactable = await isContactable(prisma, { orgId, prospectId });

    if (!phoneNumber || !contactable) {
      const cancelReason = !contactable ? 'do_not_contact' : 'no_phone';
      await prisma.whatsAppCampaignContact.upsert({
        where: { campaignId_prospectId: { campaignId, prospectId } },
        create: {
          campaignId,
          prospectId,
          phoneNumber,
          status: CONTACT_STATUS.CANCELLED,
          cancelReason,
        },
        update: {
          status: CONTACT_STATUS.CANCELLED,
          cancelReason,
        },
      });
      continue;
    }

    const contact = await prisma.whatsAppCampaignContact.upsert({
      where: { campaignId_prospectId: { campaignId, prospectId } },
      create: {
        campaignId,
        prospectId,
        phoneNumber,
        status: CONTACT_STATUS.QUEUED,
        currentStepIndex: 0,
      },
      update: {
        phoneNumber,
        status: CONTACT_STATUS.QUEUED,
        currentStepIndex: 0,
        cancelReason: null,
      },
    });

    await queue.sequence.add(
      { contactId: contact.id, stepIndex: 0, prospectId, campaignId },
      { delay: i * 1000, attempts: 1000 }
    );
    queued++;
  }

  await whatsappNats.publishEvent('whatsapp.campaigns.started', { campaignId, orgId, queued });

  if (skippedAlreadyEnrolled > 0) {
    console.log(`[whatsapp] lançamento ${campaignId}: ${skippedAlreadyEnrolled} lead(s) já inscrito(s) ignorado(s)`);
  }

  return { campaignId, jobsQueued: queued, skippedAlreadyEnrolled };
}

async function pauseCampaign(prisma, { campaignId, orgId }) {
  const campaign = await prisma.whatsAppCampaign.findFirst({ where: { id: campaignId, orgId } });
  if (!campaign) throw new Error('Campanha não encontrada');
  await prisma.whatsAppCampaign.update({
    where: { id: campaignId },
    data: { status: CAMPAIGN_STATUS.PAUSED, pausedAt: new Date() },
  });
  await whatsappNats.publishEvent('whatsapp.campaigns.paused', { campaignId, orgId });
  return { campaignId, status: CAMPAIGN_STATUS.PAUSED };
}

async function resumeCampaign(prisma, { campaignId, orgId }) {
  const campaign = await prisma.whatsAppCampaign.findFirst({ where: { id: campaignId, orgId } });
  if (!campaign) throw new Error('Campanha não encontrada');
  await prisma.whatsAppCampaign.update({
    where: { id: campaignId },
    data: { status: CAMPAIGN_STATUS.RUNNING, pausedAt: null },
  });
  await whatsappNats.publishEvent('whatsapp.campaigns.resumed', { campaignId, orgId });
  return { campaignId, status: CAMPAIGN_STATUS.RUNNING };
}

async function cancelCampaign(prisma, { campaignId, orgId }) {
  const campaign = await prisma.whatsAppCampaign.findFirst({ where: { id: campaignId, orgId } });
  if (!campaign) throw new Error('Campanha não encontrada');

  await prisma.whatsAppCampaignContact.updateMany({
    where: { campaignId, status: { in: ['QUEUED', 'SENDING', 'SENT'] } },
    data: { status: CONTACT_STATUS.CANCELLED, cancelReason: 'cancelled' },
  });
  await prisma.whatsAppCampaign.update({
    where: { id: campaignId },
    data: { status: CAMPAIGN_STATUS.CANCELLED, completedAt: new Date() },
  });
  await whatsappNats.publishEvent('whatsapp.campaigns.cancelled', { campaignId, orgId });
  return { campaignId, status: CAMPAIGN_STATUS.CANCELLED };
}

// ─── Registro dos workers ────────────────────────────────────────────────────
function registerAllWorkers() {
  registerProcessor('whatsapp:sequence', processSequence, 2);
  registerProcessor('whatsapp:send', processSend, 1);
  console.log('[whatsapp] ✓ workers registrados (sequence, send)');
}

module.exports = {
  getPrisma,
  processSequence,
  processSend,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  registerAllWorkers,
  generateStepMessage,
  buildStepMessagePrompt,
  _setPrismaForTests,
  _setQueuesForTests,
  _setLlmForTests,
  truncateForWhatsApp,
};
