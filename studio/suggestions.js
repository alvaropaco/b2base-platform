'use strict';

/**
 * studio/suggestions.js — o "Briefing do Mordomo" (specs/011, AD-9; FR-21…25).
 *
 * Módulo PURO de queries: candidatos derivados do estado real da org, com
 * ranking determinístico (dinheiro parado > riscos > retomadas > crescimento)
 * e `motivo` citável em cada chip (o dado que o motivou). Nenhum LLM no
 * caminho crítico — copy determinística. Sem candidato forte → lista VAZIA
 * (graceful degradation é ausência, nunca chip fraco — FR-22). Dia Zero tem
 * caminho próprio (FR-23).
 */

const HOT_LABELS = ['interested', 'meeting_request'];
const HOT_MIN_CONFIDENCE = 0.7;
const HOT_MAX_AGE_HOURS = Number(process.env.STUDIO_SUGGEST_HOT_AGE_HOURS || 72);
const DRAFT_IDLE_DAYS = Number(process.env.STUDIO_SUGGEST_DRAFT_IDLE_DAYS || 2);
const NEW_LEADS_MIN = Number(process.env.STUDIO_SUGGEST_NEW_LEADS_MIN || 20);

function hoursSince(date, now) {
  return (now.getTime() - new Date(date).getTime()) / 3_600_000;
}

function daysSince(date, now) {
  return (now.getTime() - new Date(date).getTime()) / 86_400_000;
}

function ptDay(date) {
  return new Date(date).toLocaleDateString('pt-BR', { weekday: 'long' });
}

// ── Candidatos (queries declaradas) ─────────────────────────────────────────

/** Dinheiro parado no funil: respostas quentes com confiança alta sem tratamento. */
async function hotReplies(prisma, orgId, now) {
  const rows = await prisma.studioReplyClassification.findMany({
    where: { orgId },
    take: 500,
  });
  const hot = rows.filter(
    (r) =>
      HOT_LABELS.includes(r.label) &&
      Number(r.confidence) >= HOT_MIN_CONFIDENCE &&
      hoursSince(r.createdAt, now) <= HOT_MAX_AGE_HOURS
  );
  if (hot.length === 0) return null;
  const n = hot.length;
  const dias = Math.round(HOT_MAX_AGE_HOURS / 24);
  return {
    kind: 'hot_replies',
    priority: 1,
    count: n,
    // Linguagem de gente (não de funil): diz O QUE aconteceu, O QUE fazer e
    // abre o diálogo — o box críptico "esperando tratamento" morreu.
    label: n === 1 ? '1 pessoa respondeu com interesse — quer que eu mostre e responda?' : `${n} pessoas responderam com interesse — quer que eu mostre e responda?`,
    motivo: `${n} resposta${n > 1 ? 's' : ''} com interesse claro (confiança alta) nas últimas ${dias} dia(s). Eu listo quem mandou, o que cada uma disse e rascunho a próxima resposta para você só revisar.`,
    prompt: `Mostre as ${n} resposta${n > 1 ? 's' : ''} com interesse que ${n > 1 ? 'chegaram' : 'chegou'}: quem mandou, o que disse, e rascunhe a próxima resposta de cada uma para eu revisar antes de enviar.`,
  };
}

/** Risco/oportunidade de saldo: saldo saudável + campanha pronta para voar. */
async function balanceWindow(prisma, orgId, campaign) {
  const reputation = require('./reputation'); // lazy: evita ciclo com suggestions
  const account = await reputation.getAccount(prisma, orgId, 'email');
  if (!account || !campaign) return null;
  const available = reputation.effectiveBalance(account);
  const ceiling = account.ceiling || 1;
  const pct = Math.round((available / ceiling) * 100);
  if (pct < 60) return null; // saldo baixo não é sugestão de disparo
  return {
    kind: 'balance_window',
    priority: 2,
    campaignId: campaign.id,
    label: `Saldo único em ${pct}% — autoriza o disparo de "${campaign.name}"?`,
    motivo: `Saldo único (e-mail + WhatsApp): ${available} envios disponíveis (teto ${ceiling}) e campanha "${campaign.name}" pronta.`,
    prompt: `Autorize o disparo da campanha "${campaign.name}" — quero ver o certificado e o saldo antes.`,
  };
}

/** Retomada: campanha em rascunho parada há dias. */
async function idleDrafts(prisma, orgId, now) {
  const rows = await prisma.studioCampaign.findMany({
    where: { orgId, status: 'draft' },
  });
  const idle = rows
    .filter((c) => daysSince(c.updatedAt || c.createdAt, now) >= DRAFT_IDLE_DAYS)
    .sort((a, b) => new Date(a.updatedAt || a.createdAt) - new Date(b.updatedAt || b.createdAt));
  if (idle.length === 0) return null;
  const campaign = idle[0];
  const days = Math.floor(daysSince(campaign.updatedAt || campaign.createdAt, now));
  return {
    kind: 'resume_draft',
    priority: 3,
    campaignId: campaign.id,
    label: `A campanha "${campaign.name}" ficou em rascunho há ${days} dia(s) — finalizo?`,
    motivo: `Rascunho parado desde ${ptDay(campaign.updatedAt || campaign.createdAt)} (${days} dia(s) sem movimento).`,
    prompt: `Vamos finalizar a campanha "${campaign.name}" que ficou parada em rascunho.`,
  };
}

/** Aprovação pendente: campanha em revisão esperando o dono. */
async function pendingApprovals(prisma, orgId) {
  const rows = await prisma.studioCampaign.findMany({
    where: { orgId, status: 'in_review' },
  });
  if (rows.length === 0) return null;
  const campaign = rows[0];
  return {
    kind: 'pending_approval',
    priority: 3,
    campaignId: campaign.id,
    label: `A campanha "${campaign.name}" está pronta — falta sua revisão`,
    motivo: 'Campanha em revisão: conteúdo e audiência prontos, aguardando aprovação humana.',
    prompt: `Revise comigo a campanha "${campaign.name}" para eu aprovar com segurança.`,
  };
}

/** Crescimento: leads enriquecidos sem nenhum contato (FR-21). */
async function untouchedLeads(prisma, orgId) {
  const enriched = await prisma.prospect.findMany({
    where: { orgId },
    take: 2000,
  });
  const withCnpj = enriched.filter((p) => p.cnpj || p.domain);
  if (withCnpj.length === 0) return null;
  // Escopo de org: envios de OUTRAS organizações nunca contam como contato
  // dos leads desta (isolamento constituição IV).
  const contacted = await prisma.outreachContact.findMany({
    // Contato REALIZADO inclui quem já evoluiu além de SENT (pente-fino
    // 2026-10-09: o chip oferecia disparo para lead já disparado).
    where: { status: { in: ['SENT', 'DELIVERED_INFERRED', 'OPENED_INFERRED', 'REPLIED'] }, campaign: { tenantId: orgId } },
    take: 2000,
  });
  const contactedIds = new Set(contacted.map((c) => c.prospectId));
  const untouched = withCnpj.filter((p) => !contactedIds.has(p.id));
  if (untouched.length < NEW_LEADS_MIN) return null;
  return {
    kind: 'new_leads',
    priority: 4,
    count: untouched.length,
    label: `${untouched.length} leads enriquecidos e nenhum contato ainda — começamos por eles?`,
    motivo: `Base enriquecida: ${untouched.length} leads com CNPJ/domínio sem nenhum envio registrado.`,
    prompt: `Monte uma campanha para os ${untouched.length} leads enriquecidos que ainda não recebem contato.`,
  };
}

/**
 * Home do Cockpit. Dia Zero (org sem dados) devolve convites de primeiros
 * passos; org com dados devolve ≥0 e ≤3 chips com motivo citável.
 */
async function suggestions(prisma, { orgId, now = new Date(), limit = 3 } = {}) {
  const metrics = require('../metrics');
  const reputation = require('./reputation');

  // ── Dia Zero (FR-23): org sem leads e sem campanhas ──────────────────────
  const [prospectCount, campaignCount] = await Promise.all([
    prisma.prospect.count({ where: { orgId } }),
    prisma.studioCampaign.count({ where: { orgId } }),
  ]);
  if (prospectCount === 0 && campaignCount === 0) {
    const chips = [
      {
        kind: 'day_zero_import',
        label: 'Importar meus leads',
        motivo: 'Nada importado ainda — a base vem de um CSV do seu CRM.',
        prompt: 'Quero importar meus leads de um arquivo CSV.',
        createCampaign: true,
      },
      {
        kind: 'day_zero_pitch',
        label: 'Contar o que eu vendo',
        motivo: 'Com o seu pitch, monto objetivos e conteúdo com dados reais.',
        prompt: 'Vou te contar o que eu vendo e para quem.',
        createCampaign: true,
      },
      {
        kind: 'day_zero_demo',
        label: 'Ver uma demonstração',
        motivo: 'Uma campanha de exemplo com dados fictícios, sem tocar nos seus ativos.',
        prompt: 'Me mostre uma demonstração com dados fictícios.',
        demo: true,
      },
    ];
    for (const chip of chips) metrics.incSuggestionsShown(chip.kind);
    return { diaZero: true, chips, balances: [], paused: false };
  }

  // ── Operação: candidatos ranqueados ──────────────────────────────────────
  const campaigns = await prisma.studioCampaign.findMany({ where: { orgId } });
  const flightReady = campaigns
    .filter((c) => ['approved', 'scheduled'].includes(c.status))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))[0] || null;

  const candidates = [];
  const hot = await hotReplies(prisma, orgId, now);
  if (hot) candidates.push(hot);
  const balance = await balanceWindow(prisma, orgId, flightReady);
  if (balance) candidates.push(balance);
  const draft = await idleDrafts(prisma, orgId, now);
  if (draft) candidates.push(draft);
  const approval = await pendingApprovals(prisma, orgId);
  if (approval) candidates.push(approval);
  const leads = await untouchedLeads(prisma, orgId);
  if (leads) candidates.push(leads);

  candidates.sort((a, b) => a.priority - b.priority);
  const chips = candidates.slice(0, limit).map(({ priority, ...chip }) => {
    void priority;
    metrics.incSuggestionsShown(chip.kind);
    return chip;
  });

  return { diaZero: false, chips, balances: await reputation.listBalances(prisma, orgId) };
}

module.exports = { suggestions, hotReplies, balanceWindow, idleDrafts, pendingApprovals, untouchedLeads };
