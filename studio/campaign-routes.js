'use strict';

/**
 * studio/campaign-routes.js — rotas de campanha do Studio (T012).
 *
 * Contrato: specs/010-campaign-studio/contracts/rest-api.md
 * Regra de ouro (FR-002): toda campanha nasce `draft` — nenhuma origem cria
 * campanha em estado disparável.
 */

const {
  assertTransition,
  assertEditable,
  STUDIO_STATES,
} = require('./campaign-service');
const { httpError } = require('./errors');
const { validatePlaceholders } = require('./variables');

const FUNNEL_STAGES = ['top', 'middle', 'bottom'];
const CHANNELS = ['email', 'whatsapp', 'linkedin_text'];
const ORIGINS = ['manual', 'ai_prompt', 'material', 'url', 'company_data', 'duplicate', 'template', 'agent'];

function badRequest(code, message) {
  const err = new Error(message || code);
  err.code = code;
  err.status = 400;
  return err;
}

function notFound(message) {
  const err = new Error(message || 'Campanha não encontrada');
  err.code = 'NOT_FOUND';
  err.status = 404;
  return err;
}

function validateChannels(channels) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw badRequest('INVALID_CHANNELS', 'Informe ao menos um canal (email, whatsapp, linkedin_text).');
  }
  for (const c of channels) {
    if (!CHANNELS.includes(c)) {
      throw badRequest('INVALID_CHANNELS', `Canal desconhecido: ${c}`);
    }
  }
  return channels;
}

function validateCreateInput(body) {
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    throw badRequest('INVALID_NAME', 'Nome da campanha é obrigatório.');
  }
  const input = {
    name: body.name.trim().slice(0, 200),
    channels: validateChannels(body.channels || ['email']),
    origin: ORIGINS.includes(body.origin) ? body.origin : 'manual',
  };
  if (body.description != null) input.description = String(body.description).slice(0, 2000);
  if (body.objective != null) input.objective = String(body.objective).slice(0, 2000);
  if (body.offer != null) input.offer = String(body.offer).slice(0, 2000);
  if (body.funnelStage != null) {
    if (!FUNNEL_STAGES.includes(body.funnelStage)) {
      throw badRequest('INVALID_FUNNEL_STAGE', `Estágio inválido: ${body.funnelStage}`);
    }
    input.funnelStage = body.funnelStage;
  }
  if (body.journeyEnabled != null) input.journeyEnabled = Boolean(body.journeyEnabled);
  if (body.duplicateOf != null) input.sourceCampaignId = String(body.duplicateOf);
  if (body.templateId != null) input.templateId = String(body.templateId);
  return input;
}

/** Carrega a campanha garantindo escopo da org (constituição IV). */
async function loadOrgCampaign(prisma, orgId, id) {
  const campaign = await prisma.studioCampaign.findUnique({ where: { id } });
  if (!campaign || campaign.orgId !== orgId) throw notFound();
  return campaign;
}

function registerCampaignRoutes(router, context) {
  const { prisma } = context;
  const overrides = context.overrides || {};
  const flow = require('./campaign-service').flow;

  // ── Fluxo de revisão/aprovação (US1) ─────────────────────────────────────

  // POST /:id/submit-review — draft|paused|retained → in_review.
  router.post('/campaigns/:id/submit-review', async (req, res, next) => {
    try {
      const campaign = await loadOrgCampaign(prisma, req.studio.orgId, req.params.id);
      require('./campaign-service').assertTransition(campaign.status, 'in_review');
      const updated = await prisma.studioCampaign.update({
        where: { id: campaign.id },
        data: { status: 'in_review', statusReason: null },
      });
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/approve — in_review → approved (congela audiência + compliance).
  router.post('/campaigns/:id/approve', async (req, res, next) => {
    try {
      const campaign = await loadOrgCampaign(prisma, req.studio.orgId, req.params.id);
      const result = await flow.approveCampaign(prisma, { campaign, userId: req.studio.userId });
      res.json({ success: true, data: result.campaign });
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/schedule — approved → running (imediato) ou scheduled com
  // janelas/ritmo e previsão de conclusão (US3: FR-016/017/020).
  router.post('/campaigns/:id/schedule', async (req, res, next) => {
    try {
      const campaign = await loadOrgCampaign(prisma, req.studio.orgId, req.params.id);
      const body = req.body || {};
      const mode = body.mode || 'immediate';

      if (mode === 'immediate') {
        const result = await flow.runImmediateDispatch(prisma, {
          campaign,
          userId: req.studio.userId,
          overrides,
        });
        return res.json({ success: true, data: result.campaign, dispatch: result.dispatch });
      }

      if (mode !== 'scheduled') {
        const err = new Error(`Modo inválido: ${mode}`);
        err.code = 'INVALID_SCHEDULE_MODE';
        err.status = 400;
        throw err;
      }

      // Modo agendado: valida janelas/ritmo e congela a agenda na campanha.
      const windows = Array.isArray(body.windows) ? body.windows : [];
      for (const w of windows) {
        const daysOk = Array.isArray(w.days) && w.days.every((d) => d >= 1 && d <= 7);
        if (!daysOk || !(w.startHour >= 0 && w.startHour < 24 && w.endHour > w.startHour && w.endHour <= 24)) {
          const err = new Error('Janela inválida: days 1–7 (1=seg) e 0 <= startHour < endHour <= 24.');
          err.code = 'INVALID_WINDOW';
          err.status = 400;
          throw err;
        }
      }
      const scheduleService = require('./schedule-service');
      const schedule = {
        mode: 'scheduled',
        startAt: body.startAt || null,
        windows,
        hourlyLimit: Number(body.hourlyLimit) || 5,
        dailyLimit: Number(body.dailyLimit) || 30,
        timezone: body.timezone || 'America/Sao_Paulo',
        useLeadTimezone: Boolean(body.useLeadTimezone),
      };
      require('./campaign-service').assertTransition(campaign.status, 'scheduled');
      const updated = await prisma.studioCampaign.update({
        where: { id: campaign.id },
        data: { status: 'scheduled', schedule },
      });
      // Previsão de conclusão (FR-020) a partir da audiência congelada.
      const snapshot = await flow.activeSnapshot(prisma, campaign);
      const forecast = scheduleService.forecast(schedule, snapshot?.includedCount || 0, new Date());
      res.json({ success: true, data: updated, forecast });
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/control — pause | resume | cancel (FR-021; ritmo na US3).
  router.post('/campaigns/:id/control', async (req, res, next) => {
    try {
      const campaign = await loadOrgCampaign(prisma, req.studio.orgId, req.params.id);
      const action = (req.body || {}).action;
      const target = {
        pause: 'paused',
        resume: 'running',
        cancel: 'cancelled',
        // US3: 'pace' altera o ritmo a quente (sem mudar de estado).
        pace: campaign.status,
      }[action];
      if (action !== 'pace' && !target) {
        const err = new Error(`Ação inválida: ${action}`);
        err.code = 'INVALID_ACTION';
        err.status = 400;
        throw err;
      }
      if (action === 'cancel' && (req.body || {}).confirm !== true) {
        const err = new Error('Cancelamento requer confirm: true.');
        err.code = 'CONFIRMATION_REQUIRED';
        err.status = 400;
        throw err;
      }
      require('./campaign-service').assertTransition(campaign.status, target);
      const updated = await prisma.studioCampaign.update({
        where: { id: campaign.id },
        data: { status: target, ...(action === 'cancel' ? { statusReason: 'cancelada pelo usuário' } : {}) },
      });

      if (action === 'cancel') {
        // specs/011 (AD-13): lote não enviado é estornado em bloco (ledger).
        try {
          await require('./campaign-service').flow.refundUnsentOnCancel(prisma, campaign);
        } catch (_) { /* estorno nunca quebra o cancelamento */ }
        // Leads na fila saem com status cancelado; enviados mantêm status real.
        if (campaign.emailExecutionId) {
          await prisma.outreachContact.updateMany({
            where: { campaignId: campaign.emailExecutionId, status: { in: ['SELECTED', 'QUEUED', 'GENERATING', 'SCHEDULED'] } },
            data: { status: 'CANCELLED', cancelReason: 'cancelled' },
          });
        }
        if (campaign.whatsappExecutionId) {
          await prisma.whatsappCampaignContact.updateMany({
            where: { campaignId: campaign.whatsappExecutionId, status: 'QUEUED' },
            data: { status: 'CANCELLED', cancelReason: 'cancelled' },
          });
        }
      }

      // US3: pace — altera limites por hora/dia da campanha em execução.
      let paceApplied = null;
      if (action === 'pace') {
        const pace = (req.body || {}).pace || {};
        const schedule = { ...(campaign.schedule || {}) };
        if (pace.hourlyLimit != null) schedule.hourlyLimit = Number(pace.hourlyLimit);
        if (pace.dailyLimit != null) schedule.dailyLimit = Number(pace.dailyLimit);
        await prisma.studioCampaign.update({ where: { id: campaign.id }, data: { schedule } });
        paceApplied = { hourlyLimit: schedule.hourlyLimit, dailyLimit: schedule.dailyLimit };
      }

      res.json({ success: true, data: updated, ...(paceApplied ? { pace: paceApplied } : {}) });
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/approve-first-batch — guard-rails da automação opt-in (clarify).
  router.post('/campaigns/:id/approve-first-batch', async (req, res, next) => {
    try {
      const campaign = await loadOrgCampaign(prisma, req.studio.orgId, req.params.id);
      const guardrails = require('./guardrails');
      const result = await guardrails.approveFirstBatch(prisma, campaign);
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/require-review — aprovada/agendada volta a revisão (FR-003).
  router.post('/campaigns/:id/require-review', async (req, res, next) => {
    try {
      const campaign = await loadOrgCampaign(prisma, req.studio.orgId, req.params.id);
      require('./campaign-service').assertTransition(campaign.status, 'in_review');
      const updated = await prisma.studioCampaign.update({
        where: { id: campaign.id },
        data: { status: 'in_review', statusReason: String((req.body || {}).reason || 'revisão exigida pelo usuário') },
      });
      // specs/011 (AD-13): saída do voo (retida/em revisão) estorna o lote
      // restante em bloco — saldo fantasma nunca fica no ledger.
      try {
        await require('./campaign-service').flow.refundUnsentOnCancel(prisma, campaign);
      } catch (_) { /* estorno nunca quebra a transição */ }
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/rederive — retida pelo saneamento volta a revisão (padrão 007).
  router.post('/campaigns/:id/rederive', async (req, res, next) => {
    try {
      const campaign = await loadOrgCampaign(prisma, req.studio.orgId, req.params.id);
      require('./campaign-service').assertTransition(campaign.status, 'in_review');
      const updated = await prisma.studioCampaign.update({
        where: { id: campaign.id },
        data: { status: 'in_review', statusReason: null },
      });
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  });

  // GET /:id/queue — fila por lead com motivo de retenção (FR-021/US3).
  router.get('/campaigns/:id/queue', async (req, res, next) => {
    try {
      const campaign = await loadOrgCampaign(prisma, req.studio.orgId, req.params.id);
      const rows = [];
      if (campaign.emailExecutionId) {
        const contacts = await prisma.outreachContact.findMany({
          where: { campaignId: campaign.emailExecutionId },
        });
        for (const c of contacts) {
          rows.push({
            prospectId: c.prospectId,
            channel: 'email',
            status: c.status,
            scheduledAt: c.scheduledAt || null,
            sentAt: c.sentAt || null,
            cancelReason: c.cancelReason || null,
          });
        }
      }
      if (campaign.whatsappExecutionId) {
        const contacts = await prisma.whatsappCampaignContact.findMany({
          where: { campaignId: campaign.whatsappExecutionId },
        });
        for (const c of contacts) {
          rows.push({
            prospectId: c.prospectId,
            channel: 'whatsapp',
            status: c.status,
            scheduledAt: c.nextSendAt || null,
            sentAt: c.lastSentAt || null,
            cancelReason: c.cancelReason || null,
          });
        }
      }
      // Motivo de retenção global da fila (US3/US3 guard-rails):
      // fora da janela, 1º lote pendente (automação) ou pausa por anomalia.
      let flowStatus = 'flowing';
      const scheduleService = require('./schedule-service');
      const guardrails = require('./guardrails');
      if (campaign.status === 'paused') {
        flowStatus = campaign.statusReason?.includes('anomalia') ? 'paused_anomaly' : 'paused';
      } else if (await guardrails.hasPendingFirstBatch(prisma, campaign)) {
        flowStatus = 'first_batch_pending';
      } else if (!scheduleService.inWindow(campaign.schedule || {}, new Date())) {
        flowStatus = 'outside_window';
      }
      // Nome da empresa em uma query só — o monitor mostra QUEM, não só ids.
      const prospectIds = [...new Set(rows.map((r) => r.prospectId))].slice(0, 500);
      if (prospectIds.length) {
        const prospects = await prisma.prospect.findMany({
          where: { id: { in: prospectIds } },
          select: { id: true, companyName: true },
        });
        const byId = new Map(prospects.map((p) => [p.id, p.companyName]));
        for (const r of rows) r.companyName = byId.get(r.prospectId) || null;
      }
      for (const row of rows) {
        if (row.status === 'QUEUED' || row.status === 'SELECTED') {
          row.retainedReason = flowStatus === 'flowing' ? null : flowStatus;
        }
      }
      res.json({ success: true, data: rows, count: rows.length, flowStatus });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/studio/campaigns — cria campanha (sempre status=draft).
  router.post('/campaigns', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const input = validateCreateInput(req.body);
      const campaign = await prisma.studioCampaign.create({
        data: {
          orgId,
          name: input.name,
          description: input.description || null,
          objective: input.objective || null,
          offer: input.offer || null,
          funnelStage: input.funnelStage || 'middle',
          channels: input.channels,
          origin: input.origin,
          sourceCampaignId: input.sourceCampaignId || null,
          journeyEnabled: Boolean(input.journeyEnabled),
          status: 'draft',
        },
      });
      res.status(201).json({ success: true, data: campaign });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/studio/campaigns — lista com contagens resumidas.
  router.get('/campaigns', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const where = { orgId };
      if (req.query.status && STUDIO_STATES.includes(String(req.query.status))) {
        where.status = String(req.query.status);
      }
      const campaigns = await prisma.studioCampaign.findMany({ where });

      // Audiência vigente (snapshot ativo) por campanha — 2 queries, sem N+1.
      const snapshots = await prisma.studioAudienceSnapshot.findMany({
        where: { orgId, status: 'active' },
      });
      const audienceByCampaign = new Map(snapshots.map((s) => [s.campaignId, s.includedCount]));

      const data = campaigns.map((c) => ({
        ...c,
        audienceCount: audienceByCampaign.get(c.id) || 0,
      }));
      res.json({ success: true, data, count: data.length });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/studio/campaigns/:id — detalhe completo.
  router.get('/campaigns/:id', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await loadOrgCampaign(prisma, orgId, req.params.id);
      const contents = await prisma.studioContent.findMany({ where: { campaignId: campaign.id } });
      const snapshot = (
        await prisma.studioAudienceSnapshot.findMany({
          where: { campaignId: campaign.id, status: 'active' },
        })
      )[0];
      res.json({
        success: true,
        data: {
          ...campaign,
          contents,
          audience: snapshot
            ? {
                id: snapshot.id,
                totalCount: snapshot.totalCount,
                includedCount: snapshot.includedCount,
                excludedCount: snapshot.excludedCount,
              }
            : null,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/studio/campaigns/:id — remove a campanha e seus derivados.
  // Campanha em voo (running/scheduled) precisa ser cancelada/pausada antes:
  // remover algo enviando deixaria o histórico órfão sem trilha de auditoria.
  router.delete('/campaigns/:id', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await loadOrgCampaign(prisma, orgId, req.params.id);
      if (['running', 'scheduled'].includes(campaign.status)) {
        throw httpError('CAMPAIGN_IN_FLIGHT', 409, 'Cancele ou pause a campanha antes de removê-la.');
      }
      await prisma.studioContent.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.studioChatMessage.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.studioAudienceSnapshot.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.studioActionRun.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.studioComplianceReview.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.studioExperiment.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.studioRecommendation.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.studioJourney.deleteMany({ where: { campaignId: campaign.id } });
      await prisma.studioCampaign.deleteMany({ where: { id: campaign.id } });
      res.json({ success: true, data: { id: campaign.id, deleted: true } });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/studio/campaigns/:id — edita metadados (apenas estados editáveis).
  router.patch('/campaigns/:id', async (req, res, next) => {
    try {
      const { orgId, userId } = req.studio;
      const campaign = await loadOrgCampaign(prisma, orgId, req.params.id);
      assertEditable(campaign);

      const data = {};
      const body = req.body || {};
      if (body.name != null) {
        if (!String(body.name).trim()) throw badRequest('INVALID_NAME', 'Nome não pode ser vazio.');
        data.name = String(body.name).trim().slice(0, 200);
      }
      if (body.description != null) data.description = String(body.description).slice(0, 2000);
      if (body.objective != null) data.objective = String(body.objective).slice(0, 2000);
      if (body.offer != null) data.offer = String(body.offer).slice(0, 2000);
      if (body.funnelStage != null) {
        if (!FUNNEL_STAGES.includes(body.funnelStage)) {
          throw badRequest('INVALID_FUNNEL_STAGE', `Estágio inválido: ${body.funnelStage}`);
        }
        data.funnelStage = body.funnelStage;
      }
      if (body.channels != null) data.channels = validateChannels(body.channels);

      if (body.status != null) {
        // Transição de estado explícita (ex.: devolver para rascunho).
        assertTransition(campaign.status, body.status);
        data.status = body.status;
      }

      // FR-006: editar na pausa devolve para revisão (re-aprovação
      // obrigatória antes de voltar a rodar).
      if (campaign.status === 'paused' && data.status == null) {
        data.status = 'in_review';
      }

      // Conteúdos: valida placeholders contra o catálogo (FR-033).
      if (Array.isArray(body.contents)) {
        for (const content of body.contents) {
          const texts = [content.subject, content.preheader, content.whatsappText, content.linkedinText];
          for (const text of texts) {
            const { ok, unknown } = validatePlaceholders(text || '');
            if (!ok) {
              throw badRequest('UNKNOWN_VARIABLE', `Variáveis fora do catálogo: ${unknown.join(', ')}`);
            }
          }
          if (content.id) {
            await prisma.studioContent.update({
              where: { id: content.id },
              data: {
                ...(content.subject != null ? { subject: content.subject } : {}),
                ...(content.preheader != null ? { preheader: content.preheader } : {}),
                ...(content.whatsappText != null ? { whatsappText: content.whatsappText } : {}),
                ...(content.linkedinText != null ? { linkedinText: content.linkedinText } : {}),
                ...(content.ctaUrl != null ? { ctaUrl: content.ctaUrl } : {}),
                editHistory: [
                  ...((content.editHistory || [])),
                  { by: userId, at: new Date().toISOString(), summary: 'edição via revisão' },
                ],
              },
            });
          }
        }
      }

      const updated = await prisma.studioCampaign.update({ where: { id: campaign.id }, data });
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  });

  // ── Amostra por lead (US1, FR-004): prévia do que cada lead receberá ──────
router.get('/campaigns/:id/sample', async (req, res, next) => {
  try {
    const campaign = await loadOrgCampaign(prisma, req.studio.orgId, req.params.id);
    const flowSvc = require('./campaign-service').flow;
    const snapshot = await flowSvc.activeSnapshot(prisma, campaign);
    if (!snapshot) return res.json({ success: true, data: [] });

    const members = await prisma.studioAudienceMember.findMany({
      where: { snapshotId: snapshot.id, included: true },
    });
    const contents = await prisma.studioContent.findMany({
      where: { campaignId: campaign.id, kind: 'base', stepIndex: 1 },
    });
    const { renderTemplate } = require('./variables');
    const { emailDocToText } = require('./channel-bridge');
    const limit = Math.min(Number(req.query.limit) || 5, 20);

    const sample = [];
    for (const member of members.slice(0, limit)) {
      const prospect = await prisma.prospect.findUnique({ where: { id: member.prospectId } });
      const renders = contents.map((content) => {
        if (content.channel === 'email') {
          return {
            channel: 'email',
            subject: renderTemplate(content.subject || '', prospect),
            text: renderTemplate(emailDocToText(content.emailDoc), prospect),
          };
        }
        if (content.channel === 'whatsapp') {
          return { channel: 'whatsapp', text: renderTemplate(content.whatsappText || '', prospect) };
        }
        if (content.channel === 'linkedin_text') {
          return { channel: 'linkedin_text', text: renderTemplate(content.linkedinText || '', prospect) };
        }
        return { channel: content.channel, text: '' };
      });
      sample.push({
        prospectId: member.prospectId,
        companyName: prospect?.companyName || null,
        contactName: prospect?.contactName || null,
        renders,
      });
    }
    res.json({ success: true, data: sample });
  } catch (err) {
    next(err);
  }
});


// ── Classificações de respostas (US6, T070): fila de revisão humana ────────
router.get('/replies', async (req, res, next) => {
  try {
    const { orgId } = req.studio;
    const where = req.query.review === '1' ? { orgId, needsHumanReview: true } : { orgId };
    const data = await prisma.studioReplyClassification.findMany({ where });
    res.json({ success: true, data, count: data.length });
  } catch (err) {
    next(err);
  }
});

// POST /replies/:id/confirm — confirmação humana do label (FR-045).
router.post('/replies/:id/confirm', async (req, res, next) => {
  try {
    const { orgId, userId } = req.studio;
    const row = await prisma.studioReplyClassification.findUnique({ where: { id: req.params.id } });
    if (!row || row.orgId !== orgId) {
      throw httpError('NOT_FOUND', 404, 'Classificação não encontrada');
    }
    const label = String((req.body || {}).label || row.label);
    const updated = await prisma.studioReplyClassification.update({
      where: { id: row.id },
      data: { label, needsHumanReview: false, confirmedById: userId },
    });
    // Opt-out confirmado manualmente propaga como os automáticos (FR-046).
    if (label === 'opt_out' && row.label !== 'opt_out') {
      const classifier = require('./ai/classify-reply').createReplyClassifier();
      await classifier.classifyAndStore(prisma, {
        orgId,
        prospectId: row.prospectId,
        channel: row.channel,
        sourceMessageId: row.sourceMessageId,
        text: 'opt-out confirmado manualmente pelo operador',
      }).catch(() => {});
    }
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

}

module.exports = { registerCampaignRoutes, loadOrgCampaign, validateCreateInput, validateChannels };

