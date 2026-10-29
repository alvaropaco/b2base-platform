'use strict';

/**
 * studio/compose-service.js — geração e persistência do pacote multicanal
 * (US4 + chat-first). Compartilhado entre o wizard de materiais e o
 * assistente de conversa para que os dois caminhos criem EXATAMENTE os
 * mesmos conteúdos (adaptação real por canal, FR-025/026).
 */

async function generateAndStorePackage(prisma, composer, { campaign, sourceText, tones, orgId, orgContext, origin = 'ai_from_material', onlyChannel = null }) {
  const created = [];
  // onlyChannel (QA 2026-10-06: "mensagem para whatsapp" criava 2 e-mails e
  // NENHUM whatsapp): quando o usuário pede UM canal, só ele persiste — o
  // resto do pack (o compose é multicanal) é descartado, sem duplicar linhas.
  const wants = (channel) => (onlyChannel ? channel === onlyChannel : (campaign.channels || []).includes(channel));
  for (const tone of tones) {
    const pack = await composer.composeForTone({
      tone,
      sourceText,
      orgContext,
      objective: campaign.objective,
      offer: campaign.offer,
    });
    const variantLabel = String(tone).slice(0, 20);
    if (wants('email') && pack.email) {
      // LINK INVENTADO PELO MODELO (2026-10-29, caso real: botão apontando
      // para domínio de exemplo apesar da regra no prompt): bloco button com
      // URL placeholder NÃO é persistido — e-mail sem botão é melhor que
      // botão levando o lead a domínio fictício. O link real entra pelo
      // edit_content (ctaUrl) com o endereço verdadeiro do dono.
      const { isPlaceholderLink } = require('./email-renderer');
      const emailBlocks = (pack.email.blocks || []).filter((b) => {
        if (b && b.type === 'button' && b.url && isPlaceholderLink(b.url)) {
          console.warn('[compose] botão com URL placeholder descartado na geração (defina o link real pelo chat: ctaUrl)');
          return false;
        }
        return true;
      });
      created.push(
        await prisma.studioContent.create({
          data: {
            orgId,
            campaignId: campaign.id,
            channel: 'email',
            variantLabel,
            kind: 'base',
            stepIndex: 1,
            title: pack.title || null,
            subject: pack.email.subject || null,
            preheader: pack.email.preheader || null,
            emailDoc: { blocks: emailBlocks },
            ctaUrl: emailBlocks.find((b) => b.type === 'button')?.url || null,
            tone,
            origin,
          },
        })
      );
    }
    if (wants('whatsapp') && pack.whatsapp?.text) {
      created.push(
        await prisma.studioContent.create({
          data: {
            orgId,
            campaignId: campaign.id,
            channel: 'whatsapp',
            variantLabel,
            kind: 'base',
            stepIndex: 1,
            whatsappText: pack.whatsapp.text,
            tone,
            origin,
          },
        })
      );
    }
    if (wants('linkedin_text') && pack.linkedinText) {
      created.push(
        await prisma.studioContent.create({
          data: {
            orgId,
            campaignId: campaign.id,
            channel: 'linkedin_text',
            variantLabel,
            kind: 'base',
            stepIndex: 1,
            linkedinText: pack.linkedinText,
            tone,
            origin,
          },
        })
      );
    }
  }
  // Pacote cai em revisão — nunca dispara (FR-002).
  if (campaign.status === 'draft') {
    await prisma.studioCampaign.update({
      where: { id: campaign.id },
      data: { status: 'in_review' },
    });
    campaign.status = 'in_review';
  }
  return created;
}

/**
 * Geração DEDICADA de WhatsApp (QA 2026-10-06: o caminho multicanal truncava
 * e o usuário nunca recebia a mensagem). UMA chamada pequena por tom — sem
 * depender do e-mail — e persistência direta em channel='whatsapp'.
 * Lança o erro de LLM por tom (o handler trata como failedTone honesto).
 */
async function generateAndStoreWhatsApp(prisma, composer, { campaign, sourceText, tones, orgId, orgContext, origin = 'ai_from_material' }) {
  const created = [];
  for (const tone of tones) {
    const { text } = await composer.composeWhatsApp({
      tone,
      sourceText,
      orgContext,
      objective: campaign.objective,
      offer: campaign.offer,
    });
    created.push(
      await prisma.studioContent.create({
        data: {
          orgId,
          campaignId: campaign.id,
          channel: 'whatsapp',
          variantLabel: String(tone).slice(0, 20),
          kind: 'base',
          stepIndex: 1,
          whatsappText: text,
          tone,
          origin,
        },
      })
    );
  }
  // Pacote cai em revisão — nunca dispara (FR-002).
  if (campaign.status === 'draft') {
    await prisma.studioCampaign.update({
      where: { id: campaign.id },
      data: { status: 'in_review' },
    });
    campaign.status = 'in_review';
  }
  return created;
}

module.exports = { generateAndStorePackage, generateAndStoreWhatsApp };
