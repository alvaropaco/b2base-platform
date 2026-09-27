'use strict';

/**
 * studio/routes.js — registro das rotas de domínio do Studio.
 *
 * Cada story de specs/010-campaign-studio/tasks.md adiciona seu bloco aqui
 * (campanhas, segmentos, agenda, IA, journeys…). Mantido separado do
 * router.js para que o esqueleto (auth/erros/health) não cresça infinito.
 */

function registerStudioRoutes(router, context) {
  const { registerCampaignRoutes } = require('./campaign-routes');
  const { registerAudienceRoutes } = require('./audience-routes');
  const { registerSegmentRoutes } = require('./segment-routes');
  const { registerMaterialRoutes } = require('./material-routes');
  const { registerContentRoutes } = require('./content-routes');
  const { registerTemplateRoutes } = require('./template-routes');
  const { registerPersonalizeRoutes } = require('./personalize-routes');
  const { registerJourneyRoutes } = require('./journey-routes');
  const { registerAgentRoutes } = require('./agent-routes');
  const { registerExperimentRoutes } = require('./experiment-routes');
  const { registerAnalyticsRoutes } = require('./analytics-routes');
  const { registerBrandRoutes } = require('./brand-routes');
  const { registerAdvancedRoutes } = require('./advanced-routes');
  const { registerChatRoutes } = require('./chat-routes');
  const { registerCockpitRoutes } = require('./cockpit-routes');
  registerCampaignRoutes(router, context);
  registerAudienceRoutes(router, context);
  registerSegmentRoutes(router, context);
  registerMaterialRoutes(router, context);
  registerContentRoutes(router, context);
  registerTemplateRoutes(router, context);
  registerPersonalizeRoutes(router, context);
  registerJourneyRoutes(router, context);
  registerAgentRoutes(router, context);
  registerExperimentRoutes(router, context);
  registerAnalyticsRoutes(router, context);
  registerBrandRoutes(router, context);
  registerAdvancedRoutes(router, context);
  registerChatRoutes(router, context);
  // specs/011 — Cockpit: sugestões, saldo, pausa global, certificado, wakes.
  registerCockpitRoutes(router, context);
}

module.exports = { registerStudioRoutes };
