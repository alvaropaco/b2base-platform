/**
 * whatsapp-engine.js — lógica de domínio do canal WhatsApp.
 *
 * Responsabilidades:
 *   - processar eventos inbound do WAHA (mensagem, ack, session.status);
 *   - opt-out (STOP/SAIR/...) e do-not-contact manual;
 *   - human handoff (inbound após outbound → interrompe automação);
 *   - idempotência (dedup por providerMessageId / campaignContactId+stepIndex);
 *   - isolamento multi-tenant (toda operação escopada por orgId);
 *   - reativação/resume de sessões (conexão durável após reinício).
 *
 * Este módulo NÃO faz chamadas HTTP ao WAHA diretamente: usa o `wahaProvider`
 * injetado (abstração `waha-provider.js`).
 */
const { WAHAWhatsAppProvider } = require('./waha-provider');
const {
  phoneFromChatId,
  normalizePhone,
  renderTemplate,
  isOptOutMessage,
} = require('./whatsapp-utils');
const whatsappNats = require('./whatsapp-nats');
const reengagementReply = require('./reengagement-reply');

// ─── Constantes de estado ────────────────────────────────────────────────────
const ACCOUNT_STATUS = Object.freeze({
  CREATED: 'CREATED',
  STARTING: 'STARTING',
  QR_REQUIRED: 'QR_REQUIRED',
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED',
  STOPPED: 'STOPPED',
  ERROR: 'ERROR',
});

const CONVERSATION_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  HUMAN_HANDOFF: 'HUMAN_HANDOFF',
  CLOSED: 'CLOSED',
  OPTED_OUT: 'OPTED_OUT',
});

const CONTACT_STATUS = Object.freeze({
  QUEUED: 'QUEUED',
  SENDING: 'SENDING',
  SENT: 'SENT',
  REPLIED: 'REPLIED',
  OPTED_OUT: 'OPTED_OUT',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
});

const CAMPAIGN_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  SCHEDULED: 'SCHEDULED',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
});

// Mapeia o status da sessão WAHA → status interno da conta.
function mapWahaSessionStatus(raw) {
  const s = String(raw || '').toUpperCase();
  if (s === 'WORKING' || s === 'CONNECTED') return ACCOUNT_STATUS.CONNECTED;
  if (s === 'STARTING') return ACCOUNT_STATUS.STARTING;
  if (s === 'SCAN_QR_CODE' || s === 'QRCODE' || s === 'QR_REQUIRED') return ACCOUNT_STATUS.QR_REQUIRED;
  if (s === 'STOPPED') return ACCOUNT_STATUS.STOPPED;
  if (s === 'DISCONNECTED') return ACCOUNT_STATUS.DISCONNECTED;
  if (s === 'FAILED' || s === 'ERROR') return ACCOUNT_STATUS.ERROR;
  return null;
}

function mapMediaType(type) {
  const t = String(type || '').toUpperCase();
  if (t === 'IMAGE') return 'IMAGE';
  if (t === 'DOCUMENT' || t === 'FILE') return 'DOCUMENT';
  if (t === 'AUDIO' || t === 'PTT' || t === 'VOICE') return 'AUDIO';
  if (t === 'VIDEO') return 'VIDEO';
  if (t === 'LOCATION') return 'LOCATION';
  return 'TEXT';
}

// ─── Helpers multi-tenant ────────────────────────────────────────────────────
async function resolveAccountBySession(prisma, sessionName) {
  if (!sessionName) return null;
  return prisma.whatsAppAccount.findUnique({ where: { sessionName } });
}

async function findProspectIdForPhone(prisma, orgId, phoneNumber) {
  const normalized = normalizePhone(phoneNumber);
  if (!normalized) return null;

  const existing = await prisma.whatsAppConversation.findFirst({
    where: { orgId, phoneNumber: normalized, prospectId: { not: null } },
    select: { prospectId: true },
  });
  if (existing) return existing.prospectId;

  const contact = await prisma.whatsAppCampaignContact.findFirst({
    where: { phoneNumber: normalized },
    select: { prospectId: true },
  });
  if (contact) return contact.prospectId;

  // Melhor esforço: procura nos telefones enriquecidos dos prospects do org.
  const prospects = await prisma.prospect.findMany({
    where: { orgId },
    select: { id: true, cnpjPhones: true },
  });
  const found = prospects.find((p) =>
    Array.isArray(p.cnpjPhones) && p.cnpjPhones.some((ph) => normalizePhone(ph) === normalized)
  );
  return found ? found.id : null;
}

async function getOrCreateConversation(prisma, { orgId, whatsappAccountId, phoneNumber, prospectId, chatId }) {
  const normalized = normalizePhone(phoneNumber);
  if (!normalized) throw new Error('Telefone inválido');

  const existing = await prisma.whatsAppConversation.findUnique({
    where: { orgId_phoneNumber: { orgId, phoneNumber: normalized } },
  });

  if (existing) {
    if ((prospectId && !existing.prospectId) || (chatId && existing.chatId !== chatId)) {
      return prisma.whatsAppConversation.update({
        where: { id: existing.id },
        data: {
          ...(prospectId && !existing.prospectId ? { prospectId } : {}),
          ...(chatId && existing.chatId !== chatId ? { chatId } : {}),
          whatsappAccountId: existing.whatsappAccountId || whatsappAccountId,
        },
      });
    }
    return existing;
  }

  return prisma.whatsAppConversation.create({
    data: {
      orgId,
      whatsappAccountId: whatsappAccountId || null,
      phoneNumber: normalized,
      ...(chatId ? { chatId } : {}),
      prospectId: prospectId || null,
      status: CONVERSATION_STATUS.ACTIVE,
    },
  });
}

/**
 * Verifica se o lead pode ser contatado pelo canal WhatsApp.
 * `do_not_contact` e `opted_out` bloqueiam qualquer envio.
 */
async function isContactable(prisma, { orgId, prospectId }) {
  const state = await prisma.leadChannelState.findUnique({
    where: { prospectId_channel: { prospectId, channel: 'whatsapp' } },
  });
  if (!state) return true;
  return state.status === 'active';
}

async function setChannelState(prisma, { orgId, prospectId, phoneNumber, status, reason }) {
  return prisma.leadChannelState.upsert({
    where: { prospectId_channel: { prospectId, channel: 'whatsapp' } },
    create: { orgId, prospectId, channel: 'whatsapp', status, phoneNumber, reason },
    update: { status, phoneNumber, reason },
  });
}

/**
 * Marca um lead como opt-out (via keyword ou manual) e interrompe automação.
 */
async function applyOptOut(prisma, { orgId, phoneNumber, prospectId, reason = 'keyword' }) {
  const normalized = normalizePhone(phoneNumber);
  const resolvedProspectId =
    prospectId || (normalized ? await findProspectIdForPhone(prisma, orgId, normalized) : null);

  if (resolvedProspectId) {
    await setChannelState(prisma, {
      orgId,
      prospectId: resolvedProspectId,
      phoneNumber: normalized,
      status: 'opted_out',
      reason,
    });
  }

  // Marca a conversa como OPTED_OUT.
  if (normalized) {
    const conv = await prisma.whatsAppConversation.findUnique({
      where: { orgId_phoneNumber: { orgId, phoneNumber: normalized } },
    });
    if (conv) {
      await prisma.whatsAppConversation.update({
        where: { id: conv.id },
        data: { status: CONVERSATION_STATUS.OPTED_OUT },
      });
    }
  }

  // Cancela qualquer contato de campanha ativo para esse número.
  if (normalized) {
    await prisma.whatsAppCampaignContact.updateMany({
      where: { phoneNumber: normalized, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      data: { status: 'OPTED_OUT', cancelReason: 'opted_out' },
    });
  } else if (resolvedProspectId) {
    await prisma.whatsAppCampaignContact.updateMany({
      where: { prospectId: resolvedProspectId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      data: { status: 'OPTED_OUT', cancelReason: 'opted_out' },
    });
  }

  return { orgId, phoneNumber: normalized, prospectId: resolvedProspectId, reason };
}

async function markDoNotContact(prisma, { orgId, prospectId, reason = 'manual' }) {
  await setChannelState(prisma, {
    orgId,
    prospectId,
    phoneNumber: null,
    status: 'do_not_contact',
    reason,
  });
  await prisma.whatsAppCampaignContact.updateMany({
    where: { prospectId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
    data: { status: 'CANCELLED', cancelReason: 'do_not_contact' },
  });
  return { prospectId, status: 'do_not_contact' };
}

// ─── Processamento de eventos WAHA ───────────────────────────────────────────

async function handleSessionStatusEvent(prisma, wahaProvider, event) {
  const sessionName = event.session;
  const account = await resolveAccountBySession(prisma, sessionName);
  if (!account) return null;

  const payload = event.payload || {};
  const rawStatus = payload.status || payload.state;
  const mapped = mapWahaSessionStatus(rawStatus);
  if (!mapped) return null;

  const phoneNumber = (payload.me && payload.me.id) ? phoneFromChatId(payload.me.id) : null;

  const updated = await prisma.whatsAppAccount.update({
    where: { id: account.id },
    data: {
      status: mapped,
      ...(phoneNumber ? { phoneNumber } : {}),
      metadata: { ...(account.metadata || {}), lastSessionStatus: rawStatus, at: new Date().toISOString() },
    },
  });

  if (mapped === ACCOUNT_STATUS.CONNECTED) {
    await whatsappNats.publishEvent(whatsappNats.SUBJECTS.SESSION_CONNECTED, {
      orgId: account.orgId,
      whatsappAccountId: account.id,
      sessionName,
    });
  } else if (mapped === ACCOUNT_STATUS.DISCONNECTED || mapped === ACCOUNT_STATUS.STOPPED) {
    await whatsappNats.publishEvent(whatsappNats.SUBJECTS.SESSION_DISCONNECTED, {
      orgId: account.orgId,
      whatsappAccountId: account.id,
      sessionName,
      status: mapped,
    });
  }

  return updated;
}

/**
 * Marca uma mensagem outbound como enviada quando o WAHA ecoa o envio (fromMe).
 * Idempotente: só atualiza se ainda estiver PENDING.
 */
async function markOutboundSent(prisma, account, providerMessageId) {
  if (!providerMessageId) return null;
  const message = await prisma.whatsAppMessage.findFirst({
    where: { orgId: account.orgId, providerMessageId, direction: 'OUTBOUND' },
  });
  if (!message) return null;
  if (message.status !== 'SENT') {
    await prisma.whatsAppMessage.update({
      where: { id: message.id },
      data: { status: 'SENT', sentAt: message.sentAt || new Date() },
    });
  }
  return message;
}

async function handleAckEvent(prisma, event) {
  const account = await resolveAccountBySession(prisma, event.session);
  if (!account) return null;
  const payload = event.payload || {};
  const providerMessageId = payload.id || (payload.key && payload.key.id);
  if (!providerMessageId) return null;

  const ack = Number(payload.ack);
  // 1 = servidor recebeu, 2 = entregue, 3 = lido.
  const message = await prisma.whatsAppMessage.findFirst({
    where: { orgId: account.orgId, providerMessageId },
  });
  if (!message) return null;

  const data = {};
  if (ack >= 1) data.status = 'SENT';
  if (ack >= 2) data.status = 'DELIVERED';
  if (ack >= 3) data.status = 'READ';
  if (ack >= 1 && !message.sentAt) data.sentAt = new Date();
  if (ack >= 2 && !message.deliveredAt) data.deliveredAt = new Date();
  if (ack >= 3 && !message.readAt) data.readAt = new Date();

  if (Object.keys(data).length === 0) return message;
  return prisma.whatsAppMessage.update({ where: { id: message.id }, data });
}

/**
 * Processa uma mensagem inbound (ou o eco de uma outbound). Esta é a função que
 * interrompe sequências, aplica opt-out e promove handoff humano.
 */
async function handleMessageEvent(prisma, wahaProvider, event) {
  const sessionName = event.session;
  const account = await resolveAccountBySession(prisma, sessionName);
  if (!account) {
    console.warn(`[whatsapp] sessão desconhecida ignorada: ${sessionName}`);
    return null;
  }

  const payload = event.payload || {};
  const fromMe = Boolean(payload.fromMe);
  const chatId = payload.from || payload.chatId || (payload.key && payload.key.remoteJid);
  const providerMessageId = payload.id || (payload.key && payload.key.id) || null;

  if (!chatId) return null;
  const phoneNumber = normalizePhone(phoneFromChatId(chatId));
  if (!phoneNumber) return null;

  // Eco do nosso próprio envio → atualiza status da outbound.
  if (fromMe) {
    return markOutboundSent(prisma, account, providerMessageId);
  }

  const body = typeof payload.body === 'string' ? payload.body : '';
  const type = mapMediaType(payload.type);
  const prospectId = await findProspectIdForPhone(prisma, account.orgId, phoneNumber);
  const isOptOut = isOptOutMessage(body);

  // Opt-out: interrompe tudo e registra, sem responder.
  if (isOptOut) {
    await applyOptOut(prisma, {
      orgId: account.orgId,
      phoneNumber,
      prospectId,
      reason: 'keyword',
    });
    await whatsappNats.publishEvent(whatsappNats.SUBJECTS.OPTOUT, {
      orgId: account.orgId,
      whatsappAccountId: account.id,
      phoneNumber,
      prospectId,
      source: 'keyword',
    });
  }

  // Conversa + mensagem (dedup por providerMessageId).
  const conversation = await getOrCreateConversation(prisma, {
    orgId: account.orgId,
    whatsappAccountId: account.id,
    phoneNumber,
    prospectId,
    chatId,
  });

  const now = new Date();
  let message = null;
  if (providerMessageId) {
    message = await prisma.whatsAppMessage.findFirst({
      where: { conversationId: conversation.id, providerMessageId },
    });
  }
  if (!message) {
    message = await prisma.whatsAppMessage.create({
      data: {
        conversationId: conversation.id,
        orgId: account.orgId,
        direction: 'INBOUND',
        type,
        content: body || null,
        providerMessageId,
        status: 'DELIVERED',
      },
    });
  }

  // Human handoff: inbound após outbound → interrompe automação.
  const hadOutbound = await prisma.whatsAppMessage.findFirst({
    where: { conversationId: conversation.id, direction: 'OUTBOUND' },
    select: { id: true },
  });

  // Prioridade de estado: opt-out > handoff > reabertura de conversa fechada.
  let nextStatus;
  if (isOptOut) {
    nextStatus = CONVERSATION_STATUS.OPTED_OUT;
  } else if (hadOutbound && prospectId) {
    nextStatus = CONVERSATION_STATUS.HUMAN_HANDOFF;
  } else if (conversation.status === CONVERSATION_STATUS.CLOSED) {
    nextStatus = CONVERSATION_STATUS.ACTIVE;
  }

  await prisma.whatsAppConversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: now,
      lastInboundMessageAt: now,
      // Reengajamento: resposta do lead recomeça o ciclo (nova rodada de
      // tentativas só depois que esta conversa esfriar de novo).
      ...(conversation.reengageAttempts > 0 ? { reengageAttempts: 0 } : {}),
      ...(nextStatus ? { status: nextStatus } : {}),
    },
  });

  if (nextStatus === CONVERSATION_STATUS.HUMAN_HANDOFF && prospectId) {
    await stopAutomationForProspect(prisma, prospectId, 'replied');
    await whatsappNats.publishEvent(whatsappNats.SUBJECTS.HUMAN_HANDOFF, {
      orgId: account.orgId,
      whatsappAccountId: account.id,
      conversationId: conversation.id,
      prospectId,
      phoneNumber,
    });
  }

  // Continuação automática: se a conversa está sendo conduzida por automação,
  // responde o lead em segundos. Dois gatilhos:
  //   1. Conversa do agente de reengajamento (reengageTotal > 0, setado no envio).
  //   2. Com REENGAGE_REPLY_INCLUDE_CAMPAIGN=true: lead respondeu a uma mensagem
  //      de CAMPAIGN (sequência de disparo) — a IA continua com a proposta da
  //      campanha (guarda dura no processador valida fonte/estado atuais).
  // As guardas duras (opt-out, pause, DNC, tetos, "humano já respondeu?") rodam
  // no processador — aqui só um pré-filtro barato para não enfileirar à toa.
  let replyEligible = conversation.reengageTotal > 0;
  if (!replyEligible && !isOptOut && body && reengagementReply.CONFIG.includeCampaign) {
    const lastOutbound = await prisma.whatsAppMessage.findFirst({
      where: { conversationId: conversation.id, direction: 'OUTBOUND' },
      orderBy: { createdAt: 'desc' },
      select: { source: true },
    });
    replyEligible = Boolean(lastOutbound && lastOutbound.source === reengagementReply.CAMPAIGN_SOURCE);
  }
  if (!isOptOut && body && replyEligible) {
    try {
      await reengagementReply.enqueueReply(prisma, {
        conversationId: conversation.id,
        inboundMessageId: message.id,
      });
    } catch (err) {
      console.error('[whatsapp] falha ao enfileirar resposta automática:', err.message);
    }
  }

  await whatsappNats.publishEvent(whatsappNats.SUBJECTS.MESSAGE_RECEIVED, {
    orgId: account.orgId,
    whatsappAccountId: account.id,
    conversationId: conversation.id,
    prospectId,
    messageId: message.id,
    providerMessageId,
  });

  return { messageId: message.id, conversationId: conversation.id, prospectId };
}

/**
 * Interrompe a automação de um prospect (handoff / opt-out).
 *
 * A fonte da verdade é o banco: os workers (`whatsapp-workers.js`) verificam o
 * status do contato antes de enviar, então marcar REPLIED/OPTED_OUT/CANCELLED
 * aqui já impede novos envios — inclusive de jobs delayed já enfileirados, que
 * viram no-op ao executar.
 */
async function stopAutomationForProspect(prisma, prospectId, reason = 'replied') {
  await prisma.whatsAppCampaignContact.updateMany({
    where: { prospectId, status: { in: ['QUEUED', 'SENDING', 'SENT'] } },
    data: { status: 'REPLIED', cancelReason: reason },
  });
  return { prospectId, stopped: true };
}

/**
 * Roteador de eventos usados pelo consumidor NATS (e fallback do webhook).
 */
async function handleEvent(prisma, wahaProvider, { subject, payload }) {
  const event = payload && payload.event ? payload : { event: subject, ...(payload || {}) };
  const type = event.event;

  if (type === 'message' || subject === whatsappNats.SUBJECTS.MESSAGE_RECEIVED) {
    return handleMessageEvent(prisma, wahaProvider, event);
  }
  if (type === 'message.ack' || (type === 'message' && event.payload && event.payload.ack != null)) {
    return handleAckEvent(prisma, event);
  }
  if (type === 'session.status') {
    return handleSessionStatusEvent(prisma, wahaProvider, event);
  }
  return null;
}

// ─── Reconexão / durabilidade ────────────────────────────────────────────────

/**
 * Reconcilia o status de uma conta consultando o WAHA (status da sessão).
 */
async function reconcileSessionStatus(prisma, wahaProvider, account) {
  try {
    const info = await wahaProvider.getSessionStatus(account.sessionName);
    const mapped = mapWahaSessionStatus(info && info.status);
    if (mapped && mapped !== account.status) {
      await prisma.whatsAppAccount.update({
        where: { id: account.id },
        data: { status: mapped },
      });
    }
    return mapped;
  } catch (err) {
    return account.status;
  }
}

/**
 * Reativa as sessões de contas CONNECTED/STARTING/QR_REQUIRED no boot para
 * manter a conexão durável após reinício do servidor. O `startSession` do WAHA
 * é idempotente — mas é um no-op quando a sessão está travada em FAILED
 * ("Session is already running"), então nesse caso reiniciamos de verdade.
 */
async function resumeSessions(prisma, wahaProvider) {
  const accounts = await prisma.whatsAppAccount.findMany({
    where: { status: { in: [ACCOUNT_STATUS.CONNECTED, ACCOUNT_STATUS.STARTING, ACCOUNT_STATUS.QR_REQUIRED] } },
  });

  for (const account of accounts) {
    try {
      let wahaStatus = null;
      try {
        wahaStatus = (await wahaProvider.getSessionStatus(account.sessionName))?.status;
      } catch (_e) { /* sessão pode não existir mais no WAHA */ }

      if (wahaStatus === 'FAILED') {
        await wahaProvider.restartSession(account.sessionName);
        console.log(`[whatsapp] sessão FAILED reiniciada no boot: ${account.sessionName}`);
      } else {
        await wahaProvider.startSession(account.sessionName);
        console.log(`[whatsapp] sessão retomada: ${account.sessionName}`);
      }
    } catch (err) {
      // Auto-cura (2026-10-19): erro de rede/timeout no boot NÃO envenena o
      // status — o UPDATE para DISCONNECTED derrubava contas saudáveis à toa
      // (o gate bloqueava disparos com a sessão viva no WAHA). Só loga; o
      // sweep periódico reconcilia quando o WAHA responder.
      console.error(`[whatsapp] falha ao retomar ${account.sessionName}: ${err.message}`);
    }
  }
  return accounts.length;
}

/**
 * AUTO-CURA da sessão (2026-10-19): varre as contas ELEGÍVEIS (exclui
 * STOPPED — desconexão DELIBERADA do dono não tem cura nem reescrita — e
 * CREATED, nunca pareada) reconciliando o status do banco com o status
 * AUTENTICADO do WAHA — verdade no painel e no gate — e aplica a cura que
 * existe: FAILED → restartSession (sessão travada só volta por restart),
 * STOPPED/DISCONNECTED → startSession (religa, idempotente). QR_REQUIRED é
 * intocado: re-pareamento é do dono. WAHA inalcançável/LENTO NUNCA muda
 * status (o fetch do provider não tem timeout — consulta presa estoura o
 * teto de 30s e vira "inalcançável"; a próxima varredura re-tenta).
 * Transições de/para CONNECTED despertam o dono (FR-31), mas ruído NÃO
 * desperta: 1º pareamento (→ CONNECTED vindo de CREATED/QR_REQUIRED/STARTING)
 * e blip transitório CONNECTED → STARTING são silenciosos. Nunca lança:
 * falha por conta é isolada e logada.
 */
const RECONCILE_LOOKUP_TIMEOUT_MS = 30000;

async function reconcileAllSessions(prisma, wahaProvider) {
  const autonomy = require('./studio/autonomy');
  const accounts = await prisma.whatsAppAccount.findMany({
    where: { status: { notIn: [ACCOUNT_STATUS.STOPPED, ACCOUNT_STATUS.CREATED] } },
  });
  const stats = {
    checked: accounts.length, updated: 0, restarted: 0, started: 0,
    lost: 0, recovered: 0, unreachable: 0,
  };
  for (const account of accounts) {
    let info = null;
    try {
      // Consulta com teto duro: provider preso (fetch sem timeout) não pode
      // travar a cura permanentemente — estoura como "inalcançável".
      let timer;
      info = await Promise.race([
        wahaProvider.getSessionStatus(account.sessionName),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`consulta ao WAHA excedeu ${RECONCILE_LOOKUP_TIMEOUT_MS}ms`)),
            RECONCILE_LOOKUP_TIMEOUT_MS
          );
        }),
      ]).finally(() => clearTimeout(timer));
    } catch (_err) {
      // Rede/timeout/5xx do WAHA: inalcançabilidade não é verdade sobre a
      // sessão — status PRESERVADO.
      stats.unreachable += 1;
      continue;
    }
    const mapped = mapWahaSessionStatus(info && info.status);
    if (!mapped) continue; // status bruto desconhecido — nada autenticado

    const was = account.status;
    // Cinto-e-suspensório (o findMany já exclui STOPPED): desconexão
    // DELIBERADA do dono (botão Desconectar grava STOPPED) não é reescrita
    // nem curada — em paridade com o resumeSessions.
    if (was === ACCOUNT_STATUS.STOPPED) continue;

    if (mapped !== was) {
      try {
        // UPDATE condicional: outro writer (evento session.status, rota de
        // pareamento) pode ter mudado o status desde a leitura — quem ganha
        // escreve; quem perde pula cura e relatório nesta rodada.
        const updated = await prisma.whatsAppAccount.updateMany({
          where: { id: account.id, status: was },
          data: { status: mapped },
        });
        if (!updated || updated.count === 0) continue;
      } catch (err) {
        console.error(`[whatsapp] sweep: falha ao persistir status de ${account.sessionName}: ${err.message}`);
        continue; // sem escrita autenticada, sem cura/relatório desta rodada
      }
      account.status = mapped;
      stats.updated += 1;
    }

    // Cura — chave no status AUTENTICADO do WAHA (independe de divergência:
    // "conta em qualquer status, WAHA responde FAILED → restartSession").
    try {
      if (mapped === ACCOUNT_STATUS.ERROR) {
        await wahaProvider.restartSession(account.sessionName);
        stats.restarted += 1;
        console.log(`[whatsapp] sweep: sessão FAILED reiniciada: ${account.sessionName}`);
      } else if (mapped === ACCOUNT_STATUS.STOPPED || mapped === ACCOUNT_STATUS.DISCONNECTED) {
        await wahaProvider.startSession(account.sessionName);
        stats.started += 1;
        console.log(`[whatsapp] sweep: sessão ${mapped} religada: ${account.sessionName}`);
      }
      // QR_REQUIRED: nada automático (re-pareamento é do dono).
    } catch (err) {
      console.error(`[whatsapp] sweep: cura de ${account.sessionName} falhou (próxima varredura re-tenta): ${err.message}`);
    }

    // Transição de/para CONNECTED desperta o dono (report nunca quebra o sweep).
    // Ruído NÃO desperta: recovered só de queda real (DISCONNECTED/ERROR);
    // lost só quando a sessão não é blip transitório de STARTING.
    if (mapped !== was) {
      if (was === ACCOUNT_STATUS.CONNECTED && mapped !== ACCOUNT_STATUS.STARTING) {
        await autonomy.report(prisma, {
          orgId: account.orgId,
          type: 'studio.whatsapp.session_lost',
          details: { whatsappAccountId: account.id, sessionName: account.sessionName, status: mapped },
        });
        stats.lost += 1;
      } else if (
        mapped === ACCOUNT_STATUS.CONNECTED &&
        (was === ACCOUNT_STATUS.DISCONNECTED || was === ACCOUNT_STATUS.ERROR)
      ) {
        await autonomy.report(prisma, {
          orgId: account.orgId,
          type: 'studio.whatsapp.session_recovered',
          details: { whatsappAccountId: account.id, sessionName: account.sessionName },
        });
        stats.recovered += 1;
      }
    }
  }
  if (stats.unreachable > 0) {
    console.warn(`[whatsapp] sweep: WAHA inalcançável para ${stats.unreachable} conta(s) — status preservado`);
  }
  return stats;
}

module.exports = {
  ACCOUNT_STATUS,
  CONVERSATION_STATUS,
  CONTACT_STATUS,
  CAMPAIGN_STATUS,
  mapWahaSessionStatus,
  mapMediaType,
  resolveAccountBySession,
  findProspectIdForPhone,
  getOrCreateConversation,
  isContactable,
  setChannelState,
  applyOptOut,
  markDoNotContact,
  handleEvent,
  handleMessageEvent,
  handleSessionStatusEvent,
  handleAckEvent,
  markOutboundSent,
  stopAutomationForProspect,
  reconcileSessionStatus,
  reconcileAllSessions,
  resumeSessions,
  renderTemplate,
};
