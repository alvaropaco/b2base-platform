/**
 * Outreach Worker Processors — Bull queue handlers for the 4 queues.
 *
 * Queue: outreach:prepare
 *   Loads lead → generates AI email → saves OutreachMessage → schedules send.
 *
 * Queue: outreach:message-send
 *   Checks rate limit → sends via Gmail API → updates status → schedules follow-up.
 *
 * Queue: outreach:gmail-sync
 *   Checks mailbox via History API → detects replies → updates contacts.
 *
 * NOTE: PrismaClient is NOT serializable. Workers re-create it from DATABASE_URL.
 */
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { createWorker, registerWorker } = require('./outreach-queues');
const { listHistory } = require('./gmail-api');
const emailProvider = require('./email-provider');
const { checkLimit, calculateDelay, getConfig: getRateConfig } = require('./outreach-rate-limiter');
const { renderTemplate, stripUnresolvedPlaceholders } = require('./whatsapp-utils');
const orgContext = require('./org-context');
const metrics = require('./metrics');

// Lazy singleton — workers share one connection pool
let _prisma = null;
function getPrisma() {
  if (!_prisma) {
    _prisma = new PrismaClient();
  }
  return _prisma;
}

// Injeção para testes (node --test sem Prisma/Redis real) — sufixo _ForTests.
function _setPrismaForTests(client) { _prisma = client; }
let _queueFactory = null;
function _setQueueFactoryForTests(fn) {
  _queueFactory = fn;
  _pauseQueue = null; // fila em cache pertence à factory anterior
}
function makeQueue(name, opts) {
  return _queueFactory ? _queueFactory(name, opts) : require('./outreach-queues').createQueue(name, opts);
}

// ─── Lightweight AI message generator ────────────────────────────
/**
 * Gera o email de outreach com os 3 pilares de contexto:
 *   1. Empresa da org (org-context.js: produto, modelo, diferenciais, site/CTA)
 *   2. Proposta da campanha (objetivo/oferta)
 *   3. Histórico de contato (follow-up referencia os toques anteriores)
 * O HTML (com pixel de tracking da PLATAFORMA, não da org) é montado
 * server-side — o modelo só devolve subject/body, para não vazar domínio
 * alheio no corpo.
 */
function buildOutreachPrompt({ lead, orgCtx, campaign, seq = 1, history = [] }) {
  const followup = seq > 1;
  const historyBlock = followup && history.length
    ? [
        '== HISTÓRICO DE CONTATO ==',
        `Este é o FOLLOW-UP #${seq} (até 4 toques no total). Toques anteriores:`,
        ...history.map((m, i) => `${i + 1}. Assunto: "${m.subject}"${m.status && /OPENED/.test(m.status) ? ' (aberto pelo lead)' : ''}`),
        'REGRA DE FOLLOW-UP: NÃO repita o mesmo conteúdo/ângulo dos toques anteriores;',
        'referencie de forma breve e natural que você já escreveu antes e traga um ângulo novo',
        '(outro benefício do contexto, caso de uso ou pergunta objetiva). Sem cobrança ou culpa.',
        '',
      ]
    : [];

  const campaignBlock = orgContext.renderCampaignBlock(campaign);

  return [
    `Você é um vendedor da ${orgContext.sellerIdentity(orgCtx)}. Escreva um email B2B em português brasileiro.`,
    '',
    '== CONTEXTO DA NOSSA EMPRESA ==',
    orgCtx.renderForPrompt(),
    '',
    ...(campaignBlock ? [campaignBlock, ''] : []),
    '== PROSPECTO ==',
    `- Empresa: ${lead.companyName}${lead.tradeName ? ` (${lead.tradeName})` : ''}`,
    `- Segmento: ${lead.industry || 'N/A'}`,
    `- Localização: ${lead.city ? [lead.city, lead.state].filter(Boolean).join('/') : 'N/A'}`,
    `- Colaboradores: ${lead.employees || 'N/A'}`,
    `- Faturamento estimado: R$ ${(lead.revenueEstimate || 0).toLocaleString('pt-BR')}`,
    '',
    ...historyBlock,
    'REGRAS:',
    '- Use apenas fatos presentes nos dados acima (empresa, campanha, histórico). Não invente informações, preços, prazos ou promessas.',
    '- Não cite nomes de plataformas/empresas que não estejam no contexto e não inclua links que não estejam nele.',
    '- Tom humano e direto, sem parecer template.',
    '- NÃO use placeholders como [Seu Nome] ou [Cargo] — assine como "Equipe ' + (orgCtx && orgCtx.nome ? orgCtx.nome : 'da empresa') + '".',
    '',
    'Retorne SOMENTE JSON válido:',
    '{',
    '  "subject": "Assunto curto (máx 60 caracteres)",',
    '  "body": "Corpo em texto plano",',
    '  "reasoning_facts": ["fato1", "fato2"]',
    '}',
  ].filter((l) => l !== undefined).join('\n');
}

/** Corpo texto plano → HTML mínimo (o pixel é injetado depois pelo prepare). */
function plainBodyToHtml(body) {
  return `<p>${String(body || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br/>')}</p>`;
}

async function generateOutreachMessage(prisma, { lead, seq = 1, campaign = null, orgCtx = null, history = [] }) {
  const litellmUrl = process.env.LITELLM_URL || 'http://localhost:4000';
  const litellmModel = process.env.LITELLM_MODEL || 'qwen/qwen2.5-7b-instruct';

  // Contexto da org (empresa do cliente) — pilar 1. Se o chamador já trouxe,
  // evita re-consulta (processPrepare reusa para o fallback).
  let ctx = orgCtx;
  if (!ctx) {
    try {
      ctx = await orgContext.loadOrgContext(prisma, lead.orgId);
    } catch (_) {
      ctx = orgContext.buildOrgContext({ orgName: null, settings: null });
    }
  }

  const prompt = buildOutreachPrompt({ lead, orgCtx: ctx, campaign, seq, history });

  try {
    const res = await fetch(`${litellmUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.LITELLM_API_KEY
          ? { Authorization: `Bearer ${process.env.LITELLM_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        model: litellmModel,
        messages: [
          {
            role: 'system',
            content: 'Você é um vendedor B2B brasileiro. Responda APENAS com JSON válido.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 1000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) throw new Error(`LiteLLM HTTP ${res.status}`);

    const json = await res.json();
    const content = json.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(content);

    const subject = parsed.subject || (seq > 1 ? `Retomando o contato: ${lead.companyName}` : `Uma oportunidade para ${lead.companyName}`);
    // Scrub determinístico: alguns modelos escrevem "[Seu Nome]" no corpo.
    // Placeholders de nome viram a assinatura da org (mais confiável que regra
    // de prompt). Qualquer outro placeholder de colchete é removido.
    const orgNome = orgContext.sellerIdentity(ctx);
    const body = String(parsed.body || '')
      .replace(/\[(?:seu nome|nome|nome aqui|seu nome aqui)\]/gi, `Equipe ${orgNome}`)
      .replace(/\s*\[[^\]]{1,30}\]/g, '')
      .trim();
    // Corpo vazio (JSON parcial/estranho do modelo) → email em branco nunca
    // pode ser agendado; retorna null e o prepare decide (base por perfil ou
    // skip — FR-005).
    if (!body) {
      console.warn('[outreach] AI retornou body vazio — sem geração de IA');
      return null;
    }
    return {
      subject,
      body,
      htmlBody: plainBodyToHtml(body),
      reasoningFacts: parsed.reasoning_facts || [],
    };
  } catch (err) {
    console.error('[outreach] AI generation failed:', err.message);
    return null;
  }
}


// ─── QUEUE: outreach:prepare ──────────────────────────────────────

/**
 * Decide se um job prepare deve ser ignorado:
 * - Lançamento (primeiro toque) com contato prévio nesta campanha → NUNCA
 *   reenrola. Antes o upsert resetava SENT/REPLIED para SCHEDULED e o check
 *   pós-upsert lia o status já sobrescrito (código morto) — relançar a
 *   campanha reenviava a mensagem pro mesmo lead. Falha tem retry próprio
 *   (/api/outreach/dispatches/retry reusa a própria mensagem).
 * - Follow-up cujo contato virou terminal DURANTE o delay (ex.: lead
 *   respondeu no intervalo) → cancela (o upsert clobberia REPLIED→SCHEDULED).
 * Retorna null para prosseguir, ou o motivo do skip.
 */
function _prepareSkipReason(existing, isFollowup, hasMessage = true) {
  if (!existing) return null;
  if (hasMessage && !isFollowup) return 'already_enrolled';
  if (!isFollowup) {
    // Matriculado mas NUNCA recebeu mensagem (pré-matrícula do compile ou
    // lote morto pelo skip antigo) → precisa do primeiro toque.
    if (['REPLIED', 'UNSUBSCRIBED', 'CANCELLED'].includes(existing.status)) return 'terminal_status';
    return null;
  }
  if (['REPLIED', 'UNSUBSCRIBED', 'CANCELLED'].includes(existing.status)) return 'terminal_status';
  return null;
}

async function processPrepare(job) {
  const { prospectId, campaignId, emailAccountId, tenantId, _isFollowup, followupSequence } = job.data;

  console.log(`[prepare] job ${job.id} — prospect ${prospectId}, seq ${followupSequence || 1}`);

  const prisma = getPrisma();

  // Load lead
  const lead = await prisma.prospect.findUnique({ where: { id: prospectId } });
  if (!lead) throw new Error(`Prospect ${prospectId} not found`);

  // Load existing contact (if any) so we can compute the next outreach
  // sequence without referencing the not-yet-assigned `contact` variable
  // (previously this upsert referenced `contact.outreachSequence` inside its
  // own `update` object, which is evaluated before the assignment completes
  // and threw "Cannot access 'contact' before initialization").
  const existing = await prisma.outreachContact.findUnique({
    where: {
      prospectId_campaignId: { prospectId, campaignId },
    },
    select: { id: true, outreachSequence: true, status: true },
  });

  // Idempotência de lançamento/follow-up: o lead nunca recebe dois primeiros
  // toques na mesma campanha. QA 2026-10-06: o skip passou a olhar MENSAGEM,
  // não só a matrícula — o Studio pré-matricula no compile e o contato
  // pré-matriculado SEM mensagem (morto pelo skip antigo de
  // startOutreachCampaign) precisa receber o primeiro toque aqui.
  const hasMessage = existing
    ? Boolean(
        await prisma.outreachMessage.findFirst({ where: { contactId: existing.id }, select: { id: true } })
      )
    : false;
  const skipReason = _prepareSkipReason(existing, Boolean(_isFollowup), hasMessage);
  if (skipReason) {
    console.log(`[prepare] prospect ${prospectId} em ${campaignId}: skip (${skipReason}, status ${existing.status})`);
    return { skipped: true, reason: skipReason, status: existing.status };
  }

  // Upsert outreach_contact. Chegando aqui: ou o contato é novo, ou é
  // follow-up de contato não-terminal (SENT → próxima sequência volta a
  // SCHEDULED, o fluxo normal da sequência).
  const nextSequence = Math.max(existing?.outreachSequence || 0, followupSequence || 1);
  let contact = await prisma.outreachContact.upsert({
    where: {
      prospectId_campaignId: { prospectId, campaignId },
    },
    create: {
      campaignId,
      prospectId,
      emailAccount_id: emailAccountId || null,
      status: 'SCHEDULED',
      outreachSequence: nextSequence,
      scheduledAt: new Date(Date.now() + 60 * 1000), // 1 min min
    },
    update: {
      status: 'SCHEDULED',
      outreachSequence: nextSequence,
      scheduledAt: new Date(Date.now() + 60 * 1000),
    },
  });

  // Conteúdo: template custom da campanha (suíte multicanal) quando
  // configurado; senão geração via IA com fallback de template. A IA recebe os
  // 3 pilares de contexto: empresa da org, proposta da campanha e histórico.
  const campaign = await prisma.outreachCampaign.findUnique({
    where: { id: campaignId },
  });
  const orgCtx = await orgContext.loadOrgContext(prisma, lead.orgId);
  const history = await prisma.outreachMessage.findMany({
    where: { contactId: contact.id },
    orderBy: { createdAt: 'desc' },
    take: 3,
  });
  let generated;
  // Origem da composição (FR-010): auditoria por mensagem enviada.
  let compositionOrigin;
  // Follow-up de campanha IA: o template semeado é a BASE do 1º toque — o
  // follow-up é gerado por IA sobre ela (T036), senão seria duplicado.
  const isAiFollowup = Boolean(_isFollowup) && campaign?.source === 'ai';
  const useTenantTemplate = campaign?.emailTemplateSubject
    && campaign?.emailTemplateBody
    && !isAiFollowup;
  if (useTenantTemplate) {
    // FR-001: template configurado pelo tenant (ou base aprovada no fluxo IA)
    // é a base em qualquer fluxo.
    generated = {
      subject: renderTemplate(campaign.emailTemplateSubject, lead),
      body: renderTemplate(campaign.emailTemplateBody, lead),
      htmlBody: `<p>${renderTemplate(campaign.emailTemplateBody, lead)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\n{2,}/g, '</p><p>')
        .replace(/\n/g, '<br/>')}</p>`,
      reasoningFacts: ['campaign_template'],
    };
    compositionOrigin = campaign.source === 'ai' ? 'profile_base' : 'tenant_template';
  } else {
    const ai = await generateOutreachMessage(prisma, {
      lead,
      seq: contact.outreachSequence,
      campaign,
      orgCtx,
      history,
    });
    if (ai) {
      // A IA lê a base/template do contexto e pode COPIAR placeholders
      // ({{firstName}} etc. — incidente de 2026-10). Renderiza com o lead
      // real: conhecidas viram dado, desconhecidas somem (SC-011).
      generated = {
        ...ai,
        subject: renderTemplate(ai.subject || '', lead),
        body: renderTemplate(ai.body || '', lead),
        htmlBody: plainBodyToHtml(renderTemplate(ai.body || '', lead)),
      };
      compositionOrigin = 'ai';
    } else {
      // FR-005/FR-006: sem IA e sem template do tenant, a base vem do perfil
      // comercial da org; SEM perfil configurado NADA genérico é enviado.
      const { composeEmailBaseFromProfile } = require('./ai-campaign');
      const base = composeEmailBaseFromProfile(orgCtx, { requireConfigured: true });
      if (!base) {
        await prisma.outreachContact.update({
          where: { id: contact.id },
          data: { status: 'CANCELLED', cancelReason: 'no_base_message' },
        });
        console.warn(`[prepare] prospect ${prospectId}: sem base de mensagem (template ausente + perfil não configurado) — envio cancelado`);
        return { skipped: true, reason: 'no_base_message' };
      }
      // A base do perfil contém placeholders ({{firstName}} — incidente de
      // 2026-10: saíram LITERAIS para 159 leads). Renderiza POR LEAD aqui.
      generated = {
        subject: renderTemplate(base.subject, lead),
        body: renderTemplate(base.body, lead),
        htmlBody: plainBodyToHtml(renderTemplate(base.body, lead)),
        reasoningFacts: ['profile_base'],
      };
      compositionOrigin = 'profile_base';
    }
  }

  // Campaign Studio (specs/010 FR-050/T078): intro personalizada por lead —
  // se houver override gerado/editado para este lead, ele abre a mensagem.
  // Aditivo e à prova de falha: sem Studio, comportamento idêntico ao atual.
  let studioIntro = null;
  try {
    if (campaign.studioCampaignId) {
      const contents = await prisma.studioContent.findMany({
        where: { campaignId: campaign.studioCampaignId, channel: 'email', kind: 'base', stepIndex: 1 },
      });
      const contentId = contents[0]?.id;
      if (contentId) {
        const persos = await prisma.studioPersonalization.findMany({
          where: { contentId, prospectId: contact.prospectId },
        });
        const perso = persos[0];
        if (perso && ['generated', 'edited'].includes(perso.status) && perso.overrides?.intro) {
          studioIntro = perso.overrides.intro;
        }
      }
    }
  } catch (err) {
    console.error('[studio:personalize] override indisponível (ignorado):', err.message);
  }

  // Add tracking pixel
  const trackingToken = crypto.randomUUID();
  const htmlWithPixel = generated.htmlBody.includes('{tracking-token}')
    ? generated.htmlBody.replace('{tracking-token}', trackingToken)
    : `${generated.htmlBody}<img src="https://b2base.net/t/o/${trackingToken}.gif" width="1" height="1" alt="" />`;

  // Create outreach_message (calculateDelay retorna segundos)
  const delaySeconds = calculateDelay(getRateConfig());
  const message = await prisma.outreachMessage.create({
    data: {
      contactId: contact.id,
      subject: generated.subject,
      body: studioIntro ? `${studioIntro}\n\n${generated.body}` : generated.body,
      htmlBody: htmlWithPixel,
      status: 'SCHEDULED',
      generatedAt: new Date(),
      scheduledFor: new Date(Date.now() + delaySeconds * 1000),
      trackingToken,
      aiReasoningFacts: generated.reasoningFacts,
      compositionOrigin,
    },
  });

  // Enfileira o envio respeitando o delay de rate-limit calculado
  const sendQueue = makeQueue('outreach:message-send', {
    redis: process.env.REDIS_URL?.replace('redis://', '') || 'localhost:6379',
  });
  await _enqueueSend(sendQueue, message.id, delaySeconds * 1000);

  metrics.incCompositionOrigin('email', compositionOrigin);

  // Create outreach_event
  await prisma.outreachEvent.create({
    data: {
      contactId: contact.id,
      messageId: message.id,
      type: 'email_scheduled',
      status: 'scheduled',
      details: {
        subject: generated.subject,
        sequence: contact.outreachSequence,
        scheduledFor: message.scheduledFor,
        campaignId: campaign ? campaign.id : campaignId,
        campaignName: campaign ? campaign.name : null,
        aiContext: {
          orgConfigured: orgCtx.configured,
          followup: contact.outreachSequence > 1,
          historyCount: history.length,
        },
      },
    },
  });

  console.log(`[prepare] ✓ message ${message.id} scheduled (token: ${trackingToken})`);
  return { messageId: message.id, contactId: contact.id };
}

// ─── QUEUE: outreach:message-send ─────────────────────────────────

/**
 * Enfileira envio com jobId = messageId (dedupe natural: se já existe job
 * vivo para a mensagem, add() devolve o existente em vez de duplicar). Jobs
 * mortos (failed/completed) com o mesmo id são removidos antes — sem isso o
 * add() é ignorado e a mensagem ficaria presa para sempre.
 *
 * `dedupe: false` (usado no reenvio pós-rate-limit DENTRO do próprio job):
 * o dedupe encontraria o job ATIVO em execução e adicionaria nada — o
 * "retrying in Xms" nunca era criado e a mensagem congelava em SCHEDULED
 * até o boot seguinte. Com dedupe off, o jobId é auto-gerado (novo job de
 * verdade); duplicatas inofensivas são cortadas pelo check de idempotência
 * (status SENT) no início do processador.
 */
async function _enqueueSend(sendQueue, messageId, delayMs = 0, { dedupe = true } = {}) {
  if (dedupe) {
    const existing = await sendQueue.getJob(messageId).catch(() => null);
    if (existing) {
      const state = await existing.getState().catch(() => null);
      if (['delayed', 'waiting', 'active', 'waiting-children', 'prioritized'].includes(state)) {
        return existing; // já está na fila — não duplica
      }
      await existing.remove().catch(() => {});
    }
  }
  return sendQueue.add(
    { messageId },
    {
      ...(dedupe ? { jobId: messageId } : {}),
      delay: delayMs,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60 * 1000 },
      removeOnComplete: true,
    }
  );
}

/**
 * Revitalização de mensagens órfãs no boot: SCHEDULED com scheduledFor já
 * vencido e sem job vivo na fila Bull. Acontece quando os workers ficam fora
 * do ar entre o agendamento e a hora do envio (ex.: CrashLoop de deploy) ou
 * quando o job esgota as tentativas — sem isto a linha fica "aguardando"
 * para sempre no histórico.
 */
async function requeueStuckScheduledMessages() {
  try {
    const prisma = getPrisma();
    const sendQueue = makeQueue('outreach:message-send', {
      redis: process.env.REDIS_URL?.replace('redis://', '') || 'localhost:6379',
    });

    const stuck = await prisma.outreachMessage.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledFor: { lt: new Date(Date.now() - 60 * 1000) },
      },
      select: { id: true },
      take: 500,
    });

    let requeued = 0;
    for (const m of stuck) {
      // dedupe OFF: o dedupe por jobId pode sofrer no-op silencioso contra
      // referências mortas do ciclo anterior (o log dizia "reenfileirada"
      // mas a mensagem ficava sem job). Duplicata inofensiva: o processador
      // aborta com already_sent se a mensagem já saiu de SCHEDULED.
      await _enqueueSend(sendQueue, m.id, 0, { dedupe: false });
      requeued += 1;
    }

    if (stuck.length > 0) {
      console.log(`[outreach] requeue: ${requeued}/${stuck.length} mensagem(ns) SCHEDULED vencida(s) reenfileirada(s) no boot`);
    }
    return requeued;
  } catch (err) {
    console.error('[outreach] requeue de SCHEDULED vencidas falhou:', err.message);
    return 0;
  }
}

// Fila de re-agendamento module-level: makeQueue uma única vez (não por
// chamada de pausa). Resetado quando a factory muda (testes).
let _pauseQueue = null;
function getSendQueue() {
  if (!_pauseQueue) {
    _pauseQueue = makeQueue('outreach:message-send', {
      redis: process.env.REDIS_URL?.replace('redis://', '') || 'localhost:6379',
    });
  }
  return _pauseQueue;
}

/**
 * specs/011 (AD-13): estorno idempotente do débito do gate quando uma
 * mensagem definivamente NÃO sai (unique (type, refId) no ledger impede
 * duplo estorno sob qualquer retry/requeue). Nunca quebra o worker.
 */
async function _refundForMessage(prisma, message, reason) {
  try {
    const orgId = message?.contact?.campaign?.tenantId;
    if (!orgId || !message?.id) return null;
    const reputation = require('./studio/reputation');
    return await reputation.refundSend(prisma, { orgId, channel: 'email', messageId: message.id, reason });
  } catch (err) {
    console.error('[send] estorno de saldo falhou (ignorado):', err.message);
    return null;
  }
}

/**
 * Epic 3 (review E3-M2): estorno de contato terminal. Quando o cancelamento
 * veio da SINCRONIZAÇÃO de fila (cancelReason 'removido_da_selecao'), usa o
 * MESMO refId determinístico do sync (`sync:{studioCampaignId}:email:{contactId}`),
 * fechando a corrida sync×worker pela unique (type, refId) do ledger. Demais
 * terminais seguem o padrão AD-13 por messageId.
 */
async function _refundForTerminalContact(prisma, message, reason) {
  const contact = message?.contact;
  const studioCampaignId = contact?.campaign?.studioCampaignId;
  if (contact?.status === 'CANCELLED' && contact?.cancelReason === 'removido_da_selecao' && studioCampaignId) {
    try {
      const orgId = contact?.campaign?.tenantId;
      if (!orgId) return null;
      const reputation = require('./studio/reputation');
      return await reputation.refundBatch(prisma, {
        orgId,
        channel: 'email',
        batchId: `sync:${studioCampaignId}:email:${contact.id}`,
        units: 1,
        reason,
      });
    } catch (err) {
      console.error('[send] estorno de contato sincronizado falhou (ignorado):', err.message);
      return null;
    }
  }
  return _refundForMessage(prisma, message, reason);
}

async function processSend(job) {
  const { messageId } = job.data;

  console.log(`[send] job ${job.id} — message ${messageId}`);

  const prisma = getPrisma();

  const message = await prisma.outreachMessage.findUnique({
    where: { id: messageId },
    include: {
      contact: {
        include: {
          // studioCampaignId: refId compartilhado com o sync de fila (Epic 3).
          campaign: { select: { tenantId: true, studioAttachments: true, studioCampaignId: true } },
        },
      },
    },
  });

  if (!message) {
    console.error(`[send] ✗ message ${messageId} not found`);
    throw new Error(`Message ${messageId} not found`);
  }

  // Idempotência PRIMEIRO: evita reenvio duplicado se o job for entregue mais
  // de uma vez — e impede estornar um envio que de fato ocorreu (AD-13).
  if (message.status === 'SENT') {
    return { already_sent: true };
  }

  // Check for terminal states on the contact
  if (message.contact.status === 'REPLIED' || message.contact.status === 'UNSUBSCRIBED' || message.contact.status === 'CANCELLED') {
    console.log(`[send] ✗ contact ${message.contactId} in terminal state ${message.contact.status}, cancelling`);
    // specs/011 (AD-13): falha definitiva antes do envio → estorno idempotente.
    // Epic 3 (review E3-M2): contato cancelado pela SINCRONIZAÇÃO de fila
    // compartilha o refId determinístico do sync — a unique (type, refId) do
    // ledger deduplica entre os dois caminhos (nunca 2 créditos por 1 débito).
    await _refundForTerminalContact(prisma, message, `contato em estado terminal (${message.contact.status})`);
    return { cancelled: true, reason: message.contact.status };
  }

  // specs/011 (AD-4/FR-19): pausa global da org e pausa da campanha checadas
  // ANTES de cada envio — nada envia até retomada explícita. Re-agenda com
  // delay (paridade com whatsapp-workers) em vez de queimar tentativas.
  // Sem o model `organization` (fakes legados) a flag não existe → sem pausa.
  // orgId AUSENTE → fail-closed: re-agenda em vez de enviar sem checar.
  const orgId = message.contact?.campaign?.tenantId;
  if (typeof prisma.organization?.findUnique === 'function') {
    if (!orgId) {
      console.warn('[send] ⊘ orgId indisponível — fail-closed, re-agendando em 60s');
      await _enqueueSend(getSendQueue(), messageId, 60 * 1000, { dedupe: false });
      return { paused: 'pause_check_failed' };
    }
    try {
      const org = await prisma.organization.findUnique({ where: { id: orgId } });
      if (org && org.studioSendPaused) {
        console.log(`[send] ⊘ pausa global da org ${orgId} — re-agendando em 60s`);
        await _enqueueSend(getSendQueue(), messageId, 60 * 1000, { dedupe: false });
        return { paused: 'org_paused' };
      }
    } catch (pauseErr) {
      // Fail-closed: erro ao checar pausa NÃO libera o envio — re-agenda.
      console.error('[send] checagem de pausa falhou (fail-closed):', pauseErr.message);
      await _enqueueSend(getSendQueue(), messageId, 60 * 1000, { dedupe: false });
      return { paused: 'pause_check_failed' };
    }
  }
  if (message.contact?.campaign && message.contact.campaign.status === 'paused') {
    console.log(`[send] ⊘ campanha pausada ${message.contact.campaignId} — re-agendando em 60s`);
    await _enqueueSend(getSendQueue(), messageId, 60 * 1000, { dedupe: false });
    return { paused: 'campaign_paused' };
  }

  // Check rate limit
  if (!message.contact.emailAccount_id) {
    throw new Error(`No email account configured for contact ${message.contactId}`);
  }

  const rateLimit = await checkLimit(
    prisma,
    message.contact.emailAccount_id,
    getRateConfig()
  );

  if (!rateLimit.allowed) {
    console.log(`[send] ⊘ rate limited, retrying in ${rateLimit.retryIn}ms`);
    metrics.incEmailRateLimited();
    const sendQueue = makeQueue('outreach:message-send', {
      redis: process.env.REDIS_URL?.replace('redis://', '') || 'localhost:6379',
    });
    // dedupe OFF: o job "atual" é este que está rodando — o dedupe padrão o
    // encontraria e descartaria o reagendamento (bug dos disparos travados
    // em "Agendado").
    await _enqueueSend(sendQueue, messageId, rateLimit.retryIn, { dedupe: false });
    return { retried: true, retryIn: rateLimit.retryIn };
  }

  // Determine recipient
  // `prospect` não é uma relation de OutreachContact no schema; buscamos o
  // email de contato do lead diretamente pelo prospectId do contact.
  const prospect = await prisma.prospect.findUnique({
    where: { id: message.contact.prospectId },
    select: { cnpjEmail: true },
  });
  const recipientEmail =
    prospect?.cnpjEmail ||
    message.body.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0];

  if (!recipientEmail) {
    metrics.incEmailFailed();
    await prisma.outreachMessage.update({
      where: { id: messageId },
      data: { status: 'FAILED', error: 'No recipient email found' },
    });
    // Falha PERMANENTE (lead sem e-mail): termina sem re-tentar — o throw
    // anterior gastava 3 retries do Bull para o mesmo erro determinístico.
    // specs/011 (AD-13): falha definitiva → estorno idempotente do débito.
    await _refundForMessage(prisma, message, 'lead sem e-mail de destino');
    return { failed: 'no_recipient_email', messageId };
  }

  // Build MIME and send (provider-agnostic: gmail OAuth, SMTP ou Resend)
  const messageIdHeader = crypto.randomUUID();
  // Anexos do Studio (D8): a execução guarda REFERÊNCIAS; os bytes são lidos
  // do storage AQUI, no send, com fail-safe — anexo ilegível/ausente sai da
  // mensagem com o fato registrado (nunca falha o envio, NFR5).
  const attachmentRefs = Array.isArray(message.contact?.campaign?.studioAttachments)
    ? message.contact.campaign.studioAttachments
    : [];
  const attachments = [];
  const attachmentsSkipped = [];
  for (const ref of attachmentRefs) {
    try {
      const buffer = require('./studio/storage').readBuffer(ref.fileName);
      attachments.push({
        fileName: ref.originalName || ref.fileName,
        content: buffer.toString('base64'),
        contentType: ref.mimeType || 'application/octet-stream',
      });
    } catch (attachErr) {
      attachmentsSkipped.push({ attachmentId: ref.attachmentId, fileName: ref.fileName, reason: `arquivo_ilegivel: ${attachErr.message}` });
    }
  }
  // SC-011 — ÚLTIMA linha de defesa no envio: NENHUMA placeholder crua sai
  // ao lead, venha o corpo de onde vier (incidente de 2026-10-06: base por
  // perfil com "{{firstName}}" literal em 159 mensagens SENT). Sanitiza,
  // persiste o que foi enviado e segue.
  const sanitized = {
    subject: stripUnresolvedPlaceholders(message.subject),
    body: stripUnresolvedPlaceholders(message.body),
    htmlBody: stripUnresolvedPlaceholders(message.htmlBody),
  };
  if (sanitized.subject !== message.subject || sanitized.body !== message.body || sanitized.htmlBody !== message.htmlBody) {
    console.warn(`[send] ⊘ placeholder não resolvida removida da mensagem ${messageId} (SC-011)`);
    Object.assign(message, sanitized);
    await prisma.outreachMessage.update({ where: { id: messageId }, data: sanitized }).catch(() => {});
  }

  let result;
  try {
    result = await emailProvider.sendEmailForAccount(prisma, message.contact.emailAccount_id, {
      to: recipientEmail,
      subject: message.subject,
      body: message.body,
      htmlBody: message.htmlBody,
      messageId: messageIdHeader,
      attachments,
    });
    if (Array.isArray(result?.attachmentsSkipped)) attachmentsSkipped.push(...result.attachmentsSkipped);
    if (attachmentsSkipped.length > 0) {
      // Fato registrado/explicável (E6/E7) — nunca falha o lote inteiro.
      console.warn(`[send] anexo(s) fora da mensagem ${messageId}: ${JSON.stringify(attachmentsSkipped)}`);
    }
  } catch (err) {
    const errorMsg = String(err?.message || err);
    console.error(`[send] ✗ failed to ${recipientEmail}:`, errorMsg);
    metrics.incEmailFailed();
    // Marca a mensagem/contacto como falha para ficar visível no histórico e
    // permitir retry manual. O job re-lança o erro para o Bull re-tentar com backoff.
    await prisma.outreachMessage.update({
      where: { id: messageId },
      data: { status: 'FAILED', error: errorMsg },
    }).catch(() => {});
    await prisma.outreachContact.update({
      where: { id: message.contactId },
      data: { status: 'FAILED' },
    }).catch(() => {});
    await prisma.outreachEvent.create({
      data: {
        contactId: message.contactId,
        messageId,
        type: 'email_failed',
        status: 'failed',
        details: { error: errorMsg },
      },
    }).catch(() => {});
    // specs/011 (AD-13): falha DEFINITIVA (última tentativa do Bull) →
    // estorno idempotente. Falha transitória re-tenta sem estornar.
    const attempts = Number(job.opts?.attempts) || 3;
    if (job.attemptsMade >= attempts - 1) {
      await _refundForMessage(prisma, message, `falha definitiva do provider: ${errorMsg}`);
    }
    throw err;
  }

  // Update message → SENT
  // (colunas gmailMessageId/gmailThreadId são históricas: guardam os ids
  // retornados pelo provider que enviou)
  await prisma.outreachMessage.update({
    where: { id: messageId },
    data: {
      status: 'SENT',
      gmailMessageId: result.messageId,
      gmailThreadId: result.threadId,
      messageHeaderId: messageIdHeader,
      sentAt: new Date(),
    },
  });
  metrics.incEmailSent();

  // Update contact → SENT
  await prisma.outreachContact.update({
    where: { id: message.contactId },
    data: {
      status: 'SENT',
      sentAt: new Date(),
    },
  });

  // Events: email_sent + email_delivered_inferred
  await prisma.outreachEvent.createMany({
    data: [
      {
        contactId: message.contactId,
        messageId,
        type: 'email_sent',
        status: 'sent',
        details: { providerMessageId: result.messageId, providerThreadId: result.threadId },
      },
      {
        contactId: message.contactId,
        messageId,
        type: 'email_delivered_inferred',
        status: 'delivered',
      },
    ],
  });

  // Schedule follow-up if appropriate
  await _scheduleFollowup(prisma, message.contactId);

  // Sinaliza o lead como contatado (canal email) — badge "Contatado" na UI
  const { markContacted } = require('./campaign-suite');
  await markContacted(prisma, message.contact.prospectId, 'email').catch(() => {});

  console.log(`[send] ✓ sent to ${recipientEmail} (provider msg: ${result.messageId})`);
  return { messageId: result.messageId, threadId: result.threadId };
}

// ─── QUEUE: outreach:gmail-sync ───────────────────────────────────
async function processSync(job) {
  const prisma = getPrisma();
  console.log('[gmail-sync] starting mailbox sync');

  // Reply-sync só existe para provider gmail (History API); SMTP/Resend
  // são send-only e são skipados aqui.
  const accounts = await prisma.emailAccount.findMany({
    where: { status: 'connected', provider: 'gmail' },
  });

  let totalReplies = 0;

  for (const account of accounts) {
    const { changes, newHistoryId } = await listHistory(prisma, account.id, account.lastHistoryId);

    for (const change of changes) {
      // Look for label updates (replies often get labels added)
      if (change.messages?.updated) {
        for (const updated of change.messages.updated) {
          const newLabels = updated.labelChanges?.filter((c) => c.labelsAdded) || [];
          const removedLabels = updated.labelChanges?.filter((c) => c.labelsRemoved) || [];

          // Any label change suggests a new message the user interacted with
          if (newLabels.length > 0 || removedLabels.length > 0) {
            const msgData = updated.message;
            const isReply = _isReply(msgData);
            if (isReply) {
              const handled = await _handleReply(prisma, msgData, account.id);
              totalReplies += handled;
            }
          }
        }
      }

      // Also check added messages for potential replies
      if (change.messages?.added) {
        for (const added of change.messages.added) {
          if (!added.message?.id) continue;
          const msgData = await _fetchGmailMessage(prisma, account.id, added.message.id);
          if (msgData && _isReply(msgData)) {
            const handled = await _handleReply(prisma, msgData, account.id);
            totalReplies += handled;
          }
        }
      }
    }

    // Persist last history ID
    if (newHistoryId && newHistoryId !== account.lastHistoryId) {
      await prisma.emailAccount.update({
        where: { id: account.id },
        data: { lastHistoryId: newHistoryId },
      });
    }
  }

  console.log(`[gmail-sync] ✓ processed ${accounts.length} accounts, ${totalReplies} replies found`);
  return { processed: accounts.length, replies: totalReplies };
}

/**
 * Lightweight Gmail message fetch (avoids full client init per call).
 */
async function _fetchGmailMessage(prisma, emailAccountId, messageId) {
  try {
    const { getMessage } = require('./gmail-api');
    return await getMessage(prisma, emailAccountId, messageId);
  } catch {
    return null;
  }
}

/**
 * Check if a Gmail message is a reply to our outreach.
 */
function _isReply(msgData) {
  if (!msgData?.payload?.headers) return false;
  const headers = msgData.payload.headers;
  const map = {};
  headers.forEach((h) => {
    map[(h.name || '').toLowerCase()] = h.value || '';
  });

  // Strong signal: In-Reply-To or References headers
  if (map['in-reply-to'] || map['references']) return true;

  // Medium signal: subject starts with "Re:" and differs from our emails
  const subject = map['subject'] || '';
  if (subject.startsWith('Re:') || subject.startsWith('res:')) return true;

  return false;
}

/**
 * When a reply is found: update contact, log event, cancel pending follow-ups.
 */
async function _handleReply(prisma, msgData, emailAccountId) {
  const headers = msgData?.payload?.headers || [];
  const headerMap = {};
  headers.forEach((h) => {
    headerMap[(h.name || '').toLowerCase()] = h.value || '';
  });

  const from = headerMap['from'] || '';
  const subject = headerMap['subject'] || '';
  const gmailMessageId = msgData?.id || '';
  const threadId = msgData?.threadId || '';

  // Find matching outreach_contact (by gmail thread or by prospect email match)
  const contact = await prisma.outreachContact.findFirst({
    where: {
      status: { notIn: ['REPLIED', 'UNSUBSCRIBED', 'CANCELLED'] },
      OR: [
        { messages: { some: { gmailThreadId: threadId } } },
        // Match by prospect email in Cc/Bcc if thread doesn't match
        { messages: { some: { status: 'SENT' } } },
      ],
    },
    // specs/010: tenantId da campanha para a classificação de respostas.
    include: { campaign: { select: { tenantId: true } } },
  });

  if (!contact) return 0;

  // Validate the reply is not from our own email account
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { email: true },
  });
  if (from.includes(emailAccount?.email || '')) {
    return 0; // self-email, skip
  }

  // Update contact
  await prisma.outreachContact.update({
    where: { id: contact.id },
    data: {
      status: 'REPLIED',
      lastReplyAt: new Date(),
      replyCount: { increment: 1 },
    },
  });

  // Campaign Studio (specs/010 FR-045): classifica a resposta por IA —
  // chamada aditiva e à prova de falha; nunca afeta o fluxo de sync.
  try {
    const classifier = require('./studio/ai/classify-reply').createReplyClassifier();
    classifier
      .classifyAndStore(prisma, {
        orgId: contact.campaign?.tenantId,
        prospectId: contact.prospectId,
        channel: 'email',
        sourceMessageId: gmailMessageId,
        text: subject,
      })
      .catch((err) => console.error('[studio:classify] falhou (ignorado):', err.message));
  } catch (err) {
    console.error('[studio:classify] indisponível (ignorado):', err.message);
  }

  // Attach gmail thread ID to the first SENT message
  const sentMsg = await prisma.outreachMessage.findFirst({
    where: { contactId: contact.id, status: 'SENT' },
  });
  if (sentMsg && threadId) {
    await prisma.outreachMessage.update({
      where: { id: sentMsg.id },
      data: { gmailThreadId: threadId },
    });
  }

  // Log event
  await prisma.outreachEvent.create({
    data: {
      contactId: contact.id,
      messageId: sentMsg?.id,
      type: 'email_replied',
      status: 'replied',
      details: { from, subject, gmailMessageId },
    },
  });

  // Cancel pending follow-ups for this contact
  await _cancelFollowups(prisma, contact.id);

  console.log(`[reply] ✓ contact ${contact.id} replied (seq ${contact.outreachSequence})`);
  return 1;
}

/**
 * Schedule a follow-up job (BullMQ delayed).
 */
async function _scheduleFollowup(prisma, contactId) {
  const contact = await prisma.outreachContact.findUnique({
    where: { id: contactId },
    include: { campaign: true },
  });

  if (!contact) return;

  // Terminal states → no follow-up
  if (contact.status === 'REPLIED' || contact.status === 'UNSUBSCRIBED' || contact.status === 'CANCELLED') {
    return;
  }

  // Sequência configurada pelo Studio (specs/010 FR-079) tem precedência:
  // cada passo define delay e término explícitos. Sem sequência configurada,
  // o comportamento legado é preservado (single-shot em template custom,
  // máx. 4 toques, D+3/5/7).
  const studioSequence = Array.isArray(contact.campaign?.sequence) ? contact.campaign.sequence : [];
  const scheduleService = require('./studio/schedule-service');
  const planned = scheduleService.nextFollowup(studioSequence, contact.outreachSequence);

  if (studioSequence.length > 0) {
    // Sequência do Studio: sem próximo passo configurado → sem follow-up.
    if (!planned) return;
  } else {
    // Legado: single-shot em template custom (exceto IA) + teto de 4 toques.
    if (contact.campaign?.emailTemplateBody && contact.campaign?.source !== 'ai') return;
    if (!planned) return;
  }

  const nextSeq = planned.stepIndex;
  const daysDelay = planned.delayDays;
  const delayMs = daysDelay * 24 * 60 * 60 * 1000;

  // Re-use prepare worker for follow-up
  const { createQueue } = require('./outreach-queues');
  const redisUrl = process.env.REDIS_URL?.replace('redis://', '') || 'localhost:6379';
  const queue = makeQueue('outreach:prepare', { redis: redisUrl });

  await queue.add(
    {
      prospectId: contact.prospectId,
      campaignId: contact.campaignId,
      emailAccountId: contact.emailAccount_id,
      tenantId: contact.campaign.tenantId,
      _isFollowup: true,
      followupSequence: nextSeq,
      contactId,
    },
    { delay: delayMs, attempts: 1 }
  );

  // Log event
  await prisma.outreachEvent.create({
    data: {
      contactId,
      type: 'followup_scheduled',
      status: 'scheduled',
      details: { sequence: nextSeq, delayDays: daysDelay, willRetryAt: new Date(Date.now() + delayMs).toISOString() },
    },
  });

  console.log(`[followup] scheduled seq ${nextSeq} in ${daysDelay} days`);
}

/**
 * Cancel pending follow-up jobs for a contact.
 */
async function _cancelFollowups(prisma, contactId) {
  const { createQueue } = require('./outreach-queues');
  const redisUrl = process.env.REDIS_URL?.replace('redis://', '') || 'localhost:6379';
  const queue = makeQueue('outreach:prepare', { redis: redisUrl });

  const pending = await queue.getJobs(['delayed']);
  const toRemove = pending.filter((j) => j.data.contactId === contactId);

  if (toRemove.length > 0) {
    await Promise.all(toRemove.map((j) => j.remove()));
    console.log(`[followup] cancelled ${toRemove.length} pending jobs for contact ${contactId}`);
  }

  // Also cancel in send queue
  const sendQueue = makeQueue('outreach:message-send', { redis: redisUrl });
  const sendPending = await sendQueue.getJobs(['delayed']);
  const sendToRemove = sendPending.filter((j) => j.data.messageId);

  await prisma.outreachContact.update({
    where: { id: contactId },
    data: { cancelReason: 'replied' },
  });
}

// ─── Worker registration ──────────────────────────────────────────
function registerAllWorkers() {
  const { registerProcessor, createQueue } = require('./outreach-queues');

  registerProcessor('outreach:prepare', processPrepare, 2);
  registerProcessor('outreach:message-send', processSend, 1);
  registerProcessor('outreach:gmail-sync', processSync, 1);

  // Revitaliza mensagens SCHEDULED vencidas cujo job morreu (workers fora do
  // ar no horário agendado, tentativas esgotadas) — sem isto ficam
  // "aguardando" para sempre no histórico.
  void requeueStuckScheduledMessages();

  // Reply-sync periódico (só provider gmail — SMTP/Resend são send-only).
  // Job repetitivo com jobId fixo para não duplicar em restart.
  try {
    const redisUrl = process.env.REDIS_URL?.replace('redis://', '') || 'localhost:6379';
    const syncQueue = makeQueue('outreach:gmail-sync', { redis: redisUrl });
    void syncQueue.add(
      { periodic: true },
      { repeat: { every: 5 * 60 * 1000 }, jobId: 'gmail-sync-periodic' }
    );
  } catch (err) {
    console.error('[outreach] falha ao agendar gmail-sync periódico:', err.message);
  }

  console.log('[outreach] ✓ all workers registered (3 processors)');
}

// ─── API: Start outreach campaign ─────────────────────────────────
async function startOutreachCampaign(prisma, campaignId, prospectIds, emailAccountId, userId) {
  const { createQueue } = require('./outreach-queues');

  const campaign = await prisma.outreachCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  if (emailAccountId) {
    const acct = await prisma.emailAccount.findUnique({ where: { id: emailAccountId } });
    if (!acct) throw new Error('Email account not found');
  }

  // Idempotência de mensagem MOVIDA para o processPrepare (hasMessage):
  // o fluxo do Studio PRÉ-MATRICULA os contatos (bridge.compile →
  // enrollAudience) ANTES do disparo — o skip "já inscrito" aqui zerava o
  // prepare e o lead ficava 'Na fila' para sempre sem mensagem (QA
  // 2026-10-06: 25 contatos alocados, 0 mensagens). O enfileiramento que
  // chega aqui já vem fatiado pelo gate (enqueueBatch filtra alocados);
  // quem tem mensagem não re-recebe (backstop no processPrepare).
  const queue = makeQueue('outreach:prepare');
  const jobIds = [];

  for (let i = 0; i < prospectIds.length; i++) {
    const job = await queue.add(
      {
        prospectId: prospectIds[i],
        campaignId,
        emailAccountId,
        tenantId: campaign.tenantId,
        userId,
      },
      { delay: i * 500, attempts: 2 }
    );
    jobIds.push(job.id);
  }

  await prisma.outreachCampaign.update({
    where: { id: campaignId },
    data: { status: 'active' },
  });

  return { campaignId, jobsQueued: jobIds.length, jobIds };
}

module.exports = {
  processPrepare,
  processSend,
  processSync,
  registerAllWorkers,
  requeueStuckScheduledMessages,
  startOutreachCampaign,
  generateOutreachMessage,
  buildOutreachPrompt,
  _scheduleFollowup,
  _enqueueSend,
  getPrisma,
  _setPrismaForTests,
  _setQueueFactoryForTests,
};
