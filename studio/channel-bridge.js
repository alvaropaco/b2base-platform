'use strict';

/**
 * studio/channel-bridge.js — compila uma StudioCampaign em execuções de
 * canal nos motores existentes (specs/010, T011; pesquisa D1).
 *
 * O Studio NÃO envia: cria/atualiza `OutreachCampaign` (e-mail) e/ou
 * `WhatsAppCampaign` (WhatsApp) apontadas por `studioCampaignId`, inscreve a
 * audiência congelada nos motores e deixa o envio/tracking/reply para os
 * workers atuais (outreach-workers.js / whatsapp-workers.js).
 *
 * specs/011 (AD-14): `enqueueBatch` é a PRIMITIVA ÚNICA de fila do Studio —
 * filtra inscritos, passa pelo gate de reputação (débito → messageIds) e
 * enfileira. Scheduler, dispatch imediato e Cockpit usam APENAS esta
 * primitiva; nenhuma rota nova fala com os workers diretamente.
 */

const crypto = require('crypto');
const reputationGate = require('./reputation-gate');
const storage = require('./storage');

/**
 * Teto TOTAL de anexos por mensagem de e-mail, lido POR CHAMADA (nunca
 * congelado em constante de módulo — testes e ajuste de ambiente valem no
 * próximo lote).
 */
function emailAttachmentCapBytes() {
  const n = Number(process.env.STUDIO_EMAIL_ATTACHMENT_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 10 * 1024 * 1024; // 10MB default
}

/** Referência imutável de anexo para a execução (D8 — nada de base64 em JSONB). */
function attachmentRef(row) {
  return {
    attachmentId: row.id,
    fileName: row.fileName,
    originalName: row.originalName,
    mimeType: row.mimeType || null,
    sizeBytes: row.sizeBytes || 0,
  };
}

/**
 * D6 — anexo resolve NA LIBERAÇÃO do lote (nunca congelado no approve):
 * e-mail leva múltiplos anexos DENTRO do teto total, com ordem estável
 * (createdAt asc — B10); excedentes e arquivos ausentes ficam fora com
 * `skipped` registrado (E6/E7) — nunca falha o lote (NFR5).
 */
async function resolveEmailAttachments(prisma, campaign) {
  const rows = await prisma.studioAttachment.findMany({
    where: { orgId: campaign.orgId, campaignId: campaign.id, channels: { in: ['email', 'both'] } },
  });
  rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()); // ordem estável
  const cap = emailAttachmentCapBytes();
  const included = [];
  const skipped = [];
  let total = 0;
  for (const row of rows) {
    if (!storage.fileExists(row.fileName)) {
      skipped.push({ attachmentId: row.id, fileName: row.fileName, reason: 'arquivo_ilegivel' });
      continue;
    }
    const size = Number(row.sizeBytes) || 0;
    if (total + size > cap) {
      skipped.push({ attachmentId: row.id, fileName: row.fileName, reason: 'excede_teto_total' });
      continue;
    }
    total += size;
    included.push(attachmentRef(row));
  }
  return { included, skipped, capBytes: cap };
}

/**
 * D6 — WhatsApp leva 1 mídia por mensagem: a determinística é a MAIS ANTIGA
 * por createdAt; excedentes entram em `skipped` (explicável).
 */
async function resolveWhatsAppAttachment(prisma, campaign) {
  const rows = await prisma.studioAttachment.findMany({
    where: { orgId: campaign.orgId, campaignId: campaign.id, channels: { in: ['whatsapp', 'both'] } },
  });
  rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  if (rows.length === 0) return { included: [], skipped: [] };
  const chosen = rows[0];
  const included = storage.fileExists(chosen.fileName) ? [attachmentRef(chosen)] : [];
  const skipped = [];
  if (included.length === 0) skipped.push({ attachmentId: chosen.id, fileName: chosen.fileName, reason: 'arquivo_ilegivel' });
  for (const row of rows.slice(1)) {
    skipped.push({ attachmentId: row.id, fileName: row.fileName, reason: 'whatsapp_aceita_uma_midia_por_mensagem' });
  }
  return { included, skipped };
}

/**
 * Persiste as REFERÊNCIAS resolvidas na execução de canal (D8: a execução
 * guarda metadados + fileName; os BYTES são lidos do storage no send, com o
 * mesmo fail-safe). Idempotente por lote: re-resolver substitui a resolução
 * anterior — anexo criado no Pré-voo sai no lote seguinte.
 */
async function persistResolvedAttachments(prisma, { campaign, channel, resolution }) {
  if (channel === 'email' && campaign.emailExecutionId) {
    await prisma.outreachCampaign.update({
      where: { id: campaign.emailExecutionId },
      data: { studioAttachments: resolution.included },
    }).catch((err) => console.error('[studio:bridge] falha ao persistir anexos de e-mail:', err.message));
  }
  if (channel === 'whatsapp' && campaign.whatsappExecutionId) {
    await prisma.whatsAppCampaign.update({
      where: { id: campaign.whatsappExecutionId },
      data: { studioAttachments: resolution.included },
    }).catch((err) => console.error('[studio:bridge] falha ao persistir mídia de WhatsApp:', err.message));
  }
  return resolution;
}

/**
 * Client do model `WhatsAppCampaignContact` (casing canônico do schema — o
 * fake-prisma aliasa para o mesmo store).
 */
function waContactModel(prisma) {
  return prisma.whatsAppCampaignContact;
}

/**
 * Extrai texto plano de um documento de blocos do editor (naive).
 * US5 substitui pelo renderer MJML — aqui só precisamos de insumo de texto
 * para o template do motor de e-mail.
 */
function emailDocToText(emailDoc) {
  if (!emailDoc) return '';
  const blocks = Array.isArray(emailDoc.blocks) ? emailDoc.blocks : [];
  const out = [];
  for (const block of blocks) {
    if (typeof block === 'string') {
      out.push(block);
      continue;
    }
    if (block.text) out.push(block.text);
    else if (block.html) out.push(String(block.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    else if (block.type === 'button' && block.label) out.push(block.label + (block.url ? `: ${block.url}` : ''));
  }
  return out.filter(Boolean).join('\n\n');
}

function contentOriginToEngineSource(contentOrigin) {
  return contentOrigin && String(contentOrigin).startsWith('ai') ? 'ai' : 'manual';
}

/**
 * FR-37 (RFC 8058) — headers de descadastro do canal e-mail, definidos no
 * compile (AD-2: nunca nascem nos workers). Sem URL pública de opt-out na
 * v1, o mecanismo existente da plataforma é o mailto de resposta; quando
 * houver URL, ela entra junto com o one-click (List-Unsubscribe-Post).
 */
function unsubscribeHeaders({ unsubscribeUrl = null, unsubscribeMailto = null } = {}) {
  const mailto = unsubscribeMailto || process.env.STUDIO_UNSUBSCRIBE_MAILTO || 'mailto:unsubscribe@b2base.net?subject=unsubscribe';
  const headers = { 'List-Unsubscribe': unsubscribeUrl ? `<${unsubscribeUrl}>, <${mailto}>` : `<${mailto}>` };
  if (unsubscribeUrl) {
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return headers;
}

function unsubscribeFooter({ unsubscribeMailto = null } = {}) {
  const mailto = unsubscribeMailto || process.env.STUDIO_UNSUBSCRIBE_MAILTO || 'mailto:unsubscribe@b2base.net?subject=unsubscribe';
  return [
    '—',
    `Não quer mais receber? Responda "sair" ou use o link: ${mailto}`,
  ].join('\n');
}

/**
 * Cria (ou reusa) a execução de e-mail da campanha Studio.
 * Idempotente por studioCampaignId: aprovar 2× não duplica execuções.
 */
async function ensureEmailExecution(prisma, campaign, content) {
  const existing = campaign.emailExecutionId
    ? await prisma.outreachCampaign.findUnique({ where: { id: campaign.emailExecutionId } })
    : null;
  if (existing) return existing;

  // Reconcilia pela unique `studioCampaignId` (QA 2026-10-06: um approve que
  // falhou DEPOIS de criar a execução deixava a row órfã e todo re-approve
  // morria em P2002 — o erro de unique mascarava a causa original). Reusa e
  // ATUALIZA o template: aprovar → editar conteúdo → reaprovar segue correto.
  const byStudio = await prisma.outreachCampaign.findUnique({ where: { studioCampaignId: campaign.id } });
  if (byStudio) {
    const subject = content?.subject || campaign.name;
    const rawBody = content?.emailDoc ? emailDocToText(content.emailDoc) : null;
    const bodyText = rawBody != null ? `${rawBody}\n\n${unsubscribeFooter({ unsubscribeMailto: content?.unsubscribeMailto })}` : null;
    return prisma.outreachCampaign.update({
      where: { id: byStudio.id },
      data: {
        emailTemplateSubject: subject,
        ...(bodyText != null ? { emailTemplateBody: bodyText } : {}),
        emailHeaders: unsubscribeHeaders({ unsubscribeUrl: content?.unsubscribeUrl, unsubscribeMailto: content?.unsubscribeMailto }),
      },
    });
  }

  const subject = content?.subject || campaign.name;
  // D8/V7 (alinhado ao syncPendingTemplates): corpo derivado SOMENTE de
  // emailDoc — sem fallback whatsappText/offer (peça de WhatsApp nunca vira
  // corpo de e-mail; sem emailDoc o template de corpo fica ausente).
  const rawBody = content?.emailDoc ? emailDocToText(content.emailDoc) : null;
  // FR-37: TODO e-mail compilado carrega rodapé de descadastro acessível e
  // os headers List-Unsubscribe/List-Unsubscribe-Post na execução (AD-2).
  const bodyText = rawBody != null ? `${rawBody}\n\n${unsubscribeFooter({ unsubscribeMailto: content?.unsubscribeMailto })}` : null;

  return prisma.outreachCampaign.create({
    data: {
      tenantId: campaign.orgId,
      name: `[Studio] ${campaign.name}`,
      description: campaign.description || null,
      objective: campaign.objective || null,
      offer: campaign.offer || null,
      status: 'draft',
      source: contentOriginToEngineSource(content?.origin),
      channels: ['email'],
      autoActive: false,
      emailTemplateSubject: subject,
      emailTemplateBody: bodyText,
      emailHeaders: unsubscribeHeaders({ unsubscribeUrl: content?.unsubscribeUrl, unsubscribeMailto: content?.unsubscribeMailto }),
      studioCampaignId: campaign.id,
    },
  });
}

/**
 * Sequência completa do Studio → steps do motor (T067, FR-043/FR-079):
 * toque 1 (base) + followups ordenados por stepIndex, delayDays → minutos.
 */
function compileSteps(baseContent, followupContents = []) {
  const steps = [];
  if (baseContent?.whatsappText) {
    steps.push({
      orderIndex: 1,
      messageTemplate: baseContent.whatsappText,
      aiPersonalized: false,
      delayMinutes: 0,
    });
  }
  const ordered = [...followupContents]
    .filter((c) => c.channel === 'whatsapp' && c.kind === 'followup' && c.whatsappText)
    .sort((a, b) => a.stepIndex - b.stepIndex);
  for (const followup of ordered) {
    steps.push({
      orderIndex: followup.stepIndex,
      messageTemplate: followup.whatsappText,
      aiPersonalized: false,
      delayMinutes: (followup.delayDays ?? 3) * 1440,
    });
  }
  return steps;
}

/**
 * Cria (ou reusa) a execução de WhatsApp da campanha Studio, compilando o
 * toque principal + followups configurados como steps do motor.
 */
async function ensureWhatsAppExecution(prisma, campaign, content, followupContents = []) {
  const existing = campaign.whatsappExecutionId
    ? await prisma.whatsAppCampaign.findUnique({ where: { id: campaign.whatsappExecutionId } })
    : null;
  if (existing) return existing;

  // Mesma reconciliação da unique (ver ensureEmailExecution): re-aprovação
  // reusa a execução e RECOMPILA os steps com o conteúdo atual.
  const byStudio = await prisma.whatsAppCampaign.findUnique({ where: { studioCampaignId: campaign.id } });
  if (byStudio) {
    const steps = compileSteps(content, followupContents);
    if (typeof prisma.whatsAppSequenceStep.deleteMany === 'function') {
      await prisma.whatsAppSequenceStep.deleteMany({ where: { campaignId: byStudio.id } });
    }
    for (const step of steps) {
      await prisma.whatsAppSequenceStep.create({
        data: { campaignId: byStudio.id, ...step },
      });
    }
    return byStudio;
  }

  const created = await prisma.whatsAppCampaign.create({
    data: {
      orgId: campaign.orgId,
      name: `[Studio] ${campaign.name}`,
      objective: campaign.objective || null,
      offer: campaign.offer || null,
      ctaUrl: content?.ctaUrl || null,
      status: 'DRAFT',
      source: contentOriginToEngineSource(content?.origin),
      studioCampaignId: campaign.id,
    },
  });

  for (const step of compileSteps(content, followupContents)) {
    await prisma.whatsAppSequenceStep.create({
      data: { campaignId: created.id, ...step },
    });
  }
  return created;
}

/**
 * Inscreve a audiência congelada (membros `included`) nas execuções de canal.
 * Idempotente: re-inscrever o mesmo lead na mesma execução é no-op.
 *
 * Consentimento WhatsApp (FR5/FR-35/LGPD): leads SEM consentimento registrado
 * ficam FORA da matrícula do WhatsApp (recebem só e-mail) — a garantia vive
 * no compile (AD-2), nunca dependendo do worker; `StudioLeadConsent` segue
 * auditável por lead.
 */
async function enrollAudience(prisma, { snapshot, emailExecution, whatsappExecution }) {
  const members = await prisma.studioAudienceMember.findMany({
    where: { snapshotId: snapshot.id, included: true },
  });
  let consented = null;
  if (whatsappExecution) {
    const certificate = require('./certificate');
    consented = await certificate.whatsappConsentedSet(
      prisma,
      snapshot.orgId,
      members.map((m) => m.prospectId)
    );
  }
  let enrolled = 0;
  let whatsappSkippedNoConsent = 0;
  for (const member of members) {
    if (emailExecution) {
      const exists = await prisma.outreachContact.findFirst({
        where: { campaignId: emailExecution.id, prospectId: member.prospectId },
      });
      if (!exists) {
        await prisma.outreachContact.create({
          data: { campaignId: emailExecution.id, prospectId: member.prospectId, status: 'QUEUED' },
        });
        enrolled += 1;
      }
    }
    if (whatsappExecution) {
      if (consented && !consented.has(member.prospectId)) {
        whatsappSkippedNoConsent += 1; // fora do WhatsApp — regra `no_consent`
        continue;
      }
      const exists = await prisma.whatsAppCampaignContact.findFirst({
        where: { campaignId: whatsappExecution.id, prospectId: member.prospectId },
      });
      if (!exists) {
        await prisma.whatsAppCampaignContact.create({
          data: { campaignId: whatsappExecution.id, prospectId: member.prospectId, status: 'QUEUED' },
        });
        enrolled += 1;
      }
    }
  }
  return { members: members.length, enrolled, whatsappSkippedNoConsent };
}

/**
 * Canais de envio CONECTADOS na org neste momento (conta de envio existe).
 * Fonte única da interseção "canais efetivos = canais da campanha ∩ canais
 * conectados" (onda 2026-09-29, AD-2): quem está conectado molda O QUE
 * dispara, nunca SE a campanha existe.
 */
async function connectedSendChannels(prisma, orgId) {
  const email = await prisma.emailAccount.findFirst({
    where: { tenantId: orgId, status: 'connected' },
  });
  const whatsapp = await prisma.whatsAppAccount.findFirst({
    where: { orgId, status: 'CONNECTED' },
  });
  return { email: Boolean(email), whatsapp: Boolean(whatsapp) };
}

/**
 * Compila a campanha Studio completa em execuções de canal e inscreve a
 * audiência. Usado pelo fluxo de aprovação (US1) e pelo disparo imediato.
 *
 * Canais efetivos (AD-2): só compila execução para canal DECLARADO na
 * campanha E CONECTADO na org. Canal declarado sem conta conectada é
 * simplesmente pulado (peças permanecem salvas como rascunho no
 * StudioContent — nada se perde); conectar o canal depois e disparar
 * recompila do zero, sem refazer a criação.
 */
async function compile(prisma, { campaign, contents, snapshot, channels }) {
  const declared = channels || campaign.channels || [];
  const connected = await connectedSendChannels(prisma, campaign.orgId);
  const effective = declared.filter((c) => (c === 'email' || c === 'whatsapp') && connected[c]);
  const skipped = declared
    .filter((c) => (c === 'email' || c === 'whatsapp') && !connected[c])
    .map((c) => ({ channel: c, code: 'CANAL_NAO_CONECTADO' }));
  const byChannel = new Map((contents || []).map((c) => [c.channel, c]));
  const result = {
    emailExecution: null,
    whatsappExecution: null,
    enrollment: null,
    channels: { declared, effective, skipped },
  };

  if (effective.includes('email')) {
    result.emailExecution = await ensureEmailExecution(prisma, campaign, byChannel.get('email'));
  }
  if (effective.includes('whatsapp')) {
    result.whatsappExecution = await ensureWhatsAppExecution(prisma, campaign, byChannel.get('whatsapp'));
  }
  result.enrollment = await enrollAudience(prisma, {
    snapshot,
    emailExecution: result.emailExecution,
    whatsappExecution: result.whatsappExecution,
  });
  return result;
}

/**
 * Primitiva ÚNICA de fila do Studio (specs/011, AD-14):
 *   1. filtra só leads INSCRITOS na execução de canal e ainda não liberados
 *      (preserva o filtro first-touch do motor);
 *   2. passa pelo gate de reputação (`consume` — débito materializa a fatia);
 *   3. marca a alocação (`scheduledAt`/`nextSendAt`) e enfileira com os ids;
 *   4. devolve o que entrou em voo e o que ficou bloqueado (explicável).
 *
 * `enqueue(channel, prospectIds)` é injetável (prod: motores; testes: captura).
 */
async function enqueueBatch(prisma, { campaign, channel, prospectIds, now = new Date(), enqueue }) {
  const requestedIds = [...new Set(prospectIds || [])];
  const emailExecutionId = campaign.emailExecutionId;
  const whatsappExecutionId = campaign.whatsappExecutionId;

  // 0) Cura de órfãs (QA 2026-10-06): contatos ALOCADOS (scheduledAt marcado)
  // cuja mensagem JAMAIS nasceu — mortos pelo skip 'already_enrolled' do
  // prepare antigo. Voltam à fila; quem tem mensagem (em voo/entregue)
  // permanece intocado.
  if (channel === 'email' && emailExecutionId) {
    const allocated = await prisma.outreachContact.findMany({
      where: { campaignId: emailExecutionId, scheduledAt: { not: null } },
      select: { id: true },
    }).catch(() => []);
    if (allocated.length > 0) {
      const withMessage = new Set(
        (await prisma.outreachMessage.findMany({
          where: { contactId: { in: allocated.map((c) => c.id) } },
          select: { contactId: true },
        }).catch(() => [])).map((m) => m.contactId)
      );
      const orphans = allocated.filter((c) => !withMessage.has(c.id)).map((c) => c.id);
      if (orphans.length > 0) {
        await prisma.outreachContact
          .updateMany({ where: { id: { in: orphans } }, data: { scheduledAt: null } })
          .catch(() => {});
        console.warn(`[studio:bridge] ${orphans.length} contato(s) órfão(s) devolvido(s) à fila do e-mail (alocados sem mensagem)`);
      }
    }
    // Ressuscita CANCELLED por 'removido_da_selecao' SEM mensagem nenhuma
    // (QA 2026-10-07: o sync cancelou 25 contatos com a audiência antiga
    // ativa; a audiência atual voltou a incluí-los e o enroll pulava quem já
    // tinha row). Cancelado que JÁ recebeu mensagem continua descartado.
    const cancelled = await prisma.outreachContact.findMany({
      where: { campaignId: emailExecutionId, status: 'CANCELLED', cancelReason: 'removido_da_selecao' },
      select: { id: true },
    }).catch(() => []);
    if (cancelled.length > 0) {
      const withMessage = new Set(
        (await prisma.outreachMessage.findMany({
          where: { contactId: { in: cancelled.map((c) => c.id) } },
          select: { contactId: true },
        }).catch(() => [])).map((m) => m.contactId)
      );
      const resurrect = cancelled.filter((c) => !withMessage.has(c.id)).map((c) => c.id);
      if (resurrect.length > 0) {
        await prisma.outreachContact
          .updateMany({
            where: { id: { in: resurrect } },
            data: { status: 'QUEUED', cancelReason: null, scheduledAt: null },
          })
          .catch(() => {});
        console.warn(`[studio:bridge] ${resurrect.length} contato(s) CANCELADO(s) sem mensagem ressuscitado(s) para QUEUED (removido_da_selecao)`);
      }
    }
  }

  // 1) Filtro first-touch: só inscritos, ainda QUEUED e não liberados.
  let enrolled = [];
  if (channel === 'email' && emailExecutionId) {
    enrolled = await prisma.outreachContact.findMany({
      where: { campaignId: emailExecutionId, prospectId: { in: requestedIds }, status: 'QUEUED', scheduledAt: null },
    });
  } else if (channel === 'whatsapp' && whatsappExecutionId) {
    // Cura de órfãs WA (QA 2026-10-07): alocados (nextSendAt marcado) cujo
    // job JAMAIS foi enfileirado voltam ao filtro — o startCampaign (fix
    // 75c1fc1e) enfileira a etapa de alocados; quem tem mensagem não toca.
    const allocatedWa = await waContactModel(prisma).findMany({
      where: { campaignId: whatsappExecutionId, status: 'QUEUED', nextSendAt: { not: null } },
      select: { id: true },
    }).catch(() => []);
    if (allocatedWa.length > 0) {
      const withMsg = new Set(
        (await prisma.whatsAppMessage.findMany({
          where: { campaignContactId: { in: allocatedWa.map((c) => c.id) } },
          select: { campaignContactId: true },
        }).catch(() => [])).map((m) => m.campaignContactId)
      );
      const orphansWa = allocatedWa.filter((c) => !withMsg.has(c.id)).map((c) => c.id);
      if (orphansWa.length > 0) {
        await waContactModel(prisma)
          .updateMany({ where: { id: { in: orphansWa } }, data: { nextSendAt: null } })
          .catch(() => {});
        console.warn(`[studio:bridge] ${orphansWa.length} contato(s) WA órfão(s) devolvido(s) à fila (alocados sem mensagem)`);
      }
    }
    // Cura de no_phone (2026-10-08, caso do dono: lead GANHOU telefone no
    // cadastro depois do lançamento, mas o contato CANCELLED por no_phone
    // nunca voltava — a ressurreição antiga só cobria removido_da_selecao).
    // Volta à fila quando o lead TEM número utilizável AGORA E segue com
    // consentimento WhatsApp (LGPD); do_not_contact permanece morto.
    const cancelledNoPhone = await waContactModel(prisma)
      .findMany({
        where: {
          campaignId: whatsappExecutionId,
          status: 'CANCELLED',
          cancelReason: 'no_phone',
          prospectId: { in: requestedIds },
        },
        select: { id: true, prospectId: true },
      })
      .catch(() => []);
    if (cancelledNoPhone.length > 0) {
      const { normalizePhone } = require('../whatsapp-utils');
      const prospects = await prisma.prospect
        .findMany({
          where: { id: { in: cancelledNoPhone.map((c) => c.prospectId) }, orgId: campaign.orgId },
          select: { id: true, cnpjPhones: true },
        })
        .catch(() => []);
      const phoneByProspect = new Map(
        prospects
          .map((p) => [p.id, normalizePhone((p.cnpjPhones || [])[0])])
          .filter(([, phone]) => Boolean(phone))
      );
      let consented = new Set();
      try {
        consented = await require('./certificate').whatsappConsentedSet(
          prisma,
          campaign.orgId,
          cancelledNoPhone.map((c) => c.prospectId)
        );
      } catch (_e) { /* sem o módulo em alguns harnesses: não ressuscita */ }
      const revives = cancelledNoPhone
        .filter((c) => phoneByProspect.has(c.prospectId) && consented.has(c.prospectId))
        .map((c) => ({ id: c.id, phoneNumber: phoneByProspect.get(c.prospectId) }));
      if (revives.length > 0) {
        // O telefone vai DENTRO do contato: o worker normaliza o snapshot
        // (contact.phoneNumber) no envio — ressuscitar sem ele devolvia o
        // lead para CANCELLED/no_phone na primeira passada (caso do dono,
        // 09/10: nextSendAt marcado e re-cancelado 291ms depois).
        for (const rev of revives) {
          await waContactModel(prisma)
            .update({
              where: { id: rev.id },
              data: { status: 'QUEUED', cancelReason: null, nextSendAt: null, phoneNumber: rev.phoneNumber },
            })
            .catch(() => {});
        }
        console.warn(`[studio:bridge] ${revives.length} contato(s) CANCELADO(s) por no_phone ressuscitado(s) com telefone — o lead agora tem número e consentimento`);
      }
    }
    // Cura de SENDING presos (2026-10-09: 46 acumulados em produção — o job
    // morre entre marcar SENDING e o resultado; >24h parado é lixo: com
    // mensagem já enviada → COMPLETED, sem mensagem → volta a QUEUED).
    const stuckSending = await waContactModel(prisma)
      .findMany({
        where: {
          campaignId: whatsappExecutionId,
          status: 'SENDING',
          updatedAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) },
        },
        select: { id: true },
      })
      .catch(() => []);
    if (stuckSending.length > 0) {
      const withMsg = new Set(
        (await prisma.whatsAppMessage.findMany({
          where: { campaignContactId: { in: stuckSending.map((c) => c.id) } },
          select: { campaignContactId: true },
        }).catch(() => [])).map((m) => m.campaignContactId)
      );
      for (const c of stuckSending) {
        await waContactModel(prisma)
          .update({
            where: { id: c.id },
            data: withMsg.has(c.id) ? { status: 'COMPLETED' } : { status: 'QUEUED', nextSendAt: null },
          })
          .catch(() => {});
      }
      console.warn(`[studio:bridge] ${stuckSending.length} contato(s) SENDING preso(s) >24h reconciliado(s)`);
    }
    enrolled = await waContactModel(prisma).findMany({
      where: { campaignId: whatsappExecutionId, prospectId: { in: requestedIds }, status: 'QUEUED', nextSendAt: null },
    });
  } else {
    return {
      enqueued: [],
      blocked: { code: 'CANAL_NAO_CONFIGURADO', reason: 'A campanha não tem execução deste canal compilada.' },
    };
  }
  if (enrolled.length === 0) return { enqueued: [], blocked: null };

  // 2) Gate: pausa → canal → certificado → débito (fatia concedida).
  const batchId = `batch-${crypto.randomUUID()}`;
  const { granted, blocked, deficit } = await reputationGate.consume(prisma, {
    orgId: campaign.orgId,
    channel,
    units: enrolled.length,
    campaign,
    refType: 'batch',
    refId: batchId,
    reason: `lote da campanha "${campaign.name}"`,
    metadata: { campaignId: campaign.id, channel, requested: enrolled.length },
    now,
  });
  if (granted <= 0) {
    return { enqueued: [], granted: 0, batchId, blocked: blocked || { code: 'SALDO_INSUFICIENTE', reason: 'Gate não concedeu unidades.' } };
  }

  // 3) Fatia concedida: anexos re-resolvidos NA LIBERAÇÃO (D6) e alocação
  //    marcada antes de enfileirar nos motores. Resolução com fail-safe:
  //    erro ali NUNCA falha o lote — segue sem anexo, com o fato logado.
  let attachments = { included: [], skipped: [] };
  try {
    if (channel === 'email') {
      attachments = await persistResolvedAttachments(prisma, {
        campaign,
        channel,
        resolution: await resolveEmailAttachments(prisma, campaign),
      });
    } else {
      attachments = await persistResolvedAttachments(prisma, {
        campaign,
        channel,
        resolution: await resolveWhatsAppAttachment(prisma, campaign),
      });
    }
    if (attachments.skipped.length > 0) {
      // Fato registrado/explicável (E6/E7) — nunca falha o lote (NFR5).
      console.warn(`[studio:bridge] anexo(s) fora da mensagem: ${JSON.stringify(attachments.skipped)}`);
    }
  } catch (attachErr) {
    console.error(`[studio:bridge] resolução de anexos falhou — lote segue SEM anexo:`, attachErr.message);
  }
  const slice = enrolled.slice(0, granted);
  const contacts = waContactModel(prisma);
  for (const contact of slice) {
    if (channel === 'email') {
      await prisma.outreachContact.update({ where: { id: contact.id }, data: { scheduledAt: now } });
    } else {
      await contacts.update({ where: { id: contact.id }, data: { nextSendAt: now } });
    }
  }
  const ids = slice.map((c) => c.prospectId);
  if (typeof enqueue === 'function') {
    await enqueue(channel, ids, batchId);
  } else {
    throw new Error('enqueueBatch requer enqueue de produção (makeProdEnqueue) ou injetado.');
  }

  const metrics = require('../metrics');
  metrics.incStudioSendsEnqueued(channel, ids.length);
  return {
    enqueued: ids,
    granted,
    requested: enrolled.length,
    deficit: deficit || 0,
    batchId,
    attachments: { included: attachments.included, skipped: attachments.skipped },
    blocked: blocked || (granted < enrolled.length
      ? { code: 'SALDO_INSUFICIENTE', reason: `Saldo cobriu ${granted} de ${enrolled.length} unidades do lote.` }
      : null),
  };
}

/**
 * Story 3.3/FR8 — re-aplica `StudioContent` aos templates das execuções
 * APENAS para steps/touches ainda sem envio (Design Note "Edição em voo"):
 *  - e-mail: template único do 1º toque só sincroniza se NENHUM e-mail saiu;
 *  - WhatsApp: step do motor com alguma mensagem enviada é imutável.
 * Já enfileirada não enviada PODE ser afetada (PS2); já enviada, nunca;
 * sem débito novo (AD-13). SEM registro falso de edição (E8): quem registra
 * `approval.contentEdits` é o serviço de edição, com mudança real.
 *
 * Corpo de e-mail: SEM fallback para `whatsappText` (V7) — sem emailDoc, o
 * template vigente permanece. Rodapé/headers de descadastro re-aplicados com
 * o `unsubscribeMailto` do conteúdo (E9).
 */
async function syncPendingTemplates(prisma, campaign) {
  const result = { email: null, whatsapp: { synced: [], skipped: [] } };
  const rows = await prisma.studioContent.findMany({ where: { campaignId: campaign.id } });

  // ── E-mail: execução única do 1º toque ──────────────────────────────────
  if (campaign.emailExecutionId) {
    const execution = await prisma.outreachCampaign.findUnique({ where: { id: campaign.emailExecutionId } });
    if (execution) {
      const sent = await prisma.outreachContact.count({
        where: { campaignId: execution.id, sentAt: { not: null } },
      });
      const emailContent = rows.find((c) => c.channel === 'email' && c.kind === 'base' && c.stepIndex === 1);
      if (sent === 0 && emailContent) {
        // Edição só-de-assunto com zero envios TAMBÉM sincroniza: corpo entra
        // só quando há emailDoc (V7 — nunca whatsappText como corpo); rodapé/
        // headers de descadastro re-aplicados junto do corpo (E9).
        const data = {};
        if (emailContent.subject != null) data.emailTemplateSubject = emailContent.subject;
        if (emailContent.emailDoc) {
          data.emailTemplateBody = `${emailDocToText(emailContent.emailDoc)}\n\n${unsubscribeFooter({ unsubscribeMailto: emailContent.unsubscribeMailto })}`;
          data.emailHeaders = unsubscribeHeaders({
            unsubscribeUrl: emailContent.unsubscribeUrl,
            unsubscribeMailto: emailContent.unsubscribeMailto,
          });
        }
        if (Object.keys(data).length > 0) {
          await prisma.outreachCampaign.update({ where: { id: execution.id }, data });
          result.email = { synced: true, sent };
        } else {
          result.email = { synced: false, sent, reason: 'sem conteúdo de e-mail para sincronizar' };
        }
      } else {
        result.email = {
          synced: false,
          sent,
          reason: sent > 0 ? 'envios já realizados — enviados são imutáveis' : 'sem conteúdo de e-mail para sincronizar',
        };
      }
    }
  }

  // ── WhatsApp: stepIndex 1-based do Studio ↔ 0-based do motor ────────────
  if (campaign.whatsappExecutionId) {
    const steps = await prisma.whatsAppSequenceStep.findMany({
      where: { campaignId: campaign.whatsappExecutionId },
    });
    const contactIds = (await waContactModel(prisma).findMany({
      where: { campaignId: campaign.whatsappExecutionId },
      select: { id: true },
    })).map((c) => c.id);
    const sentStepIndexes = new Set(
      contactIds.length
        ? (await prisma.whatsAppMessage.findMany({
            where: { campaignContactId: { in: contactIds }, status: { in: ['SENT', 'DELIVERED', 'READ'] } },
            select: { stepIndex: true },
          })).map((m) => m.stepIndex)
        : []
    );
    for (const content of rows) {
      if (content.channel !== 'whatsapp' || !content.whatsappText) continue;
      // Studio base = stepIndex 1 (motor 0); followup N (motor N-1) = orderIndex N.
      const step = steps.find((s) => s.orderIndex === content.stepIndex);
      if (!step) continue;
      const motorIndex = content.stepIndex - 1;
      if (sentStepIndexes.has(motorIndex)) {
        result.whatsapp.skipped.push({ stepIndex: content.stepIndex, reason: 'passo já enviado — imutável' });
        continue;
      }
      if (step.messageTemplate === content.whatsappText) continue; // sem mudança
      await prisma.whatsAppSequenceStep.update({
        where: { id: step.id },
        data: { messageTemplate: content.whatsappText },
      });
      result.whatsapp.synced.push({ stepIndex: content.stepIndex });
    }
  }
  return result;
}

module.exports = {
  compile,
  ensureEmailExecution,
  ensureWhatsAppExecution,
  enrollAudience,
  connectedSendChannels,
  resolveEmailAttachments,
  resolveWhatsAppAttachment,
  syncPendingTemplates,
  emailAttachmentCapBytes,
  emailDocToText,
  compileSteps,
  enqueueBatch,
  waContactModel,
  unsubscribeHeaders,
  unsubscribeFooter,
};
