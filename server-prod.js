const express = require('express');
const { PrismaClient } = require('@prisma/client');

// Minimal .env loader (no dotenv dependency): loads KEY=VALUE pairs from
// .env and .env.local, never overriding variables already in the environment.
// .env.local holds local secrets and is excluded from version control.
const fsLoadEnv = require('fs');
const pathLoadEnv = require('path');
(function loadEnvFile() {
  const files = ['.env', '.env.local'];
  for (const file of files) {
    try {
      const envPath = pathLoadEnv.join(__dirname, file);
      if (!fsLoadEnv.existsSync(envPath)) continue;
      const lines = fsLoadEnv.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
          process.env[key] = value;
        }
      }
    } catch (_err) {
      // ignore: environment is already configured
    }
  }
})();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3001;

const path = require('path');
const fs = require('fs');
const {
  searchCompanies,
  filterCompanies,
  getCompanyByCnpj,
  getDatasetStats,
  isMcpConfigured,
} = require('./mcp-cnpj');
const {
  enrichProspectWithCnpj,
  hydrateFirmographics,
  listEnrichedProspects,
  formatEnrichedProspect
} = require('./cnpj-enrichment');
const natsEnrichment = require('./nats-enrichment');
const csvImport = require('./csv-import');
const leadEnrichment = require('./lead-enrichment');
const enrichmentGraph = require('./enrichment-graph');
// Epic 1 (FR4): searchText normalizado do Prospect mantido em toda escrita.
const { withSearchText } = require('./search-text');
const { computeContactDecision } = require('./contact-decision');
// Regras de transição do pipeline (feature 005) — módulo puro testável.
const pipelineTransitions = require('./pipeline-transitions');
// Análise profunda de lead por IA (feature 005) — runner compartilhado do processo.
const deepAnalysis = require('./deep-analysis');
const geocoding = require('./geocoding');
const firebaseAuth = require('./firebase-auth');
const adminAuth = require('./admin');

// ─── Outreach modules ─────────────────────────────────────────────
const gmailAuth = require('./gmail-auth');
const gmailApi = require('./gmail-api');
const emailProvider = require('./email-provider');
const { maskProspectForTrial, maskCompanyGraphForTrial, stripMaskedIncomingFields, stripDeepAnalysisFields } = require('./plan-masking');
// ─── Motor de enriquecimento distribuído v2 (specs/001-distributed-enrichment)
const enrichmentConfig = require('./enrichment-config');
const enrichmentCapabilities = require('./enrichment-capabilities');
// Feature 006: notificador de falhas reais (Slack tempo real + digest e-mail).
const enrichmentNotifier = require('./enrichment-notifier').createEnrichmentNotifier({
  prisma,
  logger: console,
});
const enrichmentManager = require('./enrichment-manager').getManager({
  prisma,
  onFailureReal: async (info) => {
    try {
      const lead = await prisma.prospect.findUnique({
        where: { id: info.prospectId },
        select: { companyName: true, cnpj: true },
      });
      const metrics = require('./metrics');
      if (metrics.isEnabled()) metrics.incEnrichmentFailuresReal(info.capability, info.errorType, info.orgId);
      await enrichmentNotifier.notifyTaskFailed({
        ...info,
        companyName: lead ? lead.companyName : info.prospectId,
        cnpj: lead ? lead.cnpj : null,
      });
    } catch (err) {
      console.error('[notifier] falha real não notificada:', err.message);
    }
  },
});
// Feature 006: sweeper de tasks PARKED (re-publicação com taxa por provedor).
const enrichmentSweeper = require('./enrichment-sweeper');

// Singleton do sweeper (Redis dedicado ao lock/token bucket + re-publicação
// via manager + métricas prom-client). Lazy — não conecta no require.
let _sweeper = null;
let _sweeperRedis = null;
const _circuitOpenSince = new Map(); // provider → primeiro momento visto em OPEN
async function getSweeperCircuitState(provider) {
  try {
    if (!_sweeperRedis) return 0;
    const state = await _sweeperRedis.get(`cb:${provider}:state`);
    if (state === 'OPEN') {
      const first = _circuitOpenSince.get(provider) || Date.now();
      if (!_circuitOpenSince.has(provider)) _circuitOpenSince.set(provider, first);
      return Date.now() - first > 3600e3 ? 2 : 1;
    }
    _circuitOpenSince.delete(provider);
    return state === 'HALF-OPEN' || state === 'DEGRADED' ? 1 : 0;
  } catch (_e) {
    return 0;
  }
}

function getSweeper() {
  if (_sweeper) return _sweeper;
  const Redis = require('ioredis');
  _sweeperRedis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    retryStrategy: (t) => Math.min(t * 2000, 30000),
  });
  _sweeperRedis.on('error', (e) => console.error('[sweeper] redis:', e.message));
  _sweeper = enrichmentSweeper.createEnrichmentSweeper({
    prisma,
    republishTask: (task, opts) => enrichmentManager.republishParkedTask(task, opts),
    redis: _sweeperRedis,
    notifier: enrichmentNotifier,
    logger: console,
    onMetric: (name, labels = {}) => {
      const metrics = require('./metrics');
      if (!metrics.isEnabled()) return;
      if (name === 'republished') metrics.incEnrichmentTasksRepublished(labels.provider);
      else if (name === 'park_expired') metrics.incEnrichmentParkExpired(labels.capability);
    },
  });
  return _sweeper;
}
const outreachWorkers = require('./outreach-workers');
const aiCampaign = require('./ai-campaign');
const dispatchUtils = require('./dispatch-utils');
const { closeAllQueues, closeAllWorkers, getQueues } = require('./outreach-queues');

// ─── WhatsApp modules (WAHA) ───────────────────────────────────────
const wahaProvider = require('./waha-provider');
const whatsappEngine = require('./whatsapp-engine');
const whatsappWorkers = require('./whatsapp-workers');
const whatsappNats = require('./whatsapp-nats');
const whatsappUtils = require('./whatsapp-utils');
const reengagementAgent = require('./reengagement-agent');
const reengagementReply = require('./reengagement-reply');
const { closeWhatsAppQueues, getWhatsAppQueues } = require('./whatsapp-queues');
// ─── Campaign Studio (specs/010) ───────────────────────────────────
const { createStudioRouter } = require('./studio/router');
const metrics = require('./metrics');

// Middleware
// Self-hosted Firebase Auth callback endpoints. Registered before the body
// parsers so raw OAuth POSTs to /__/auth/* can be forwarded untouched.
app.use('/__/auth', firebaseAuth.createFirebaseAuthHandlerProxy());
// verify captura o body bruto: a verificação de assinatura do webhook do
// Stripe (stripe-billing) precisa do payload exato como foi enviado.
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(firebaseAuth.cookieParserMiddleware);

// Global error handling middleware
app.use((err, req, res, next) => {
  console.error('Express error middleware caught:', err.message);
  console.error(err.stack);
  if (!res.headersSent) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'apps', 'web', 'dist')));
app.use(express.static('public'));

// ============================================================================
// AUTHENTICATION
// ============================================================================
// /api/auth/* é público (login/logout/resolver sessão); todo o restante de /api
// exige um cookie de sessão válido emitido após a verificação do Firebase ID token.
app.use('/api/auth', firebaseAuth.createAuthRouter(prisma));
// Área administrativa — autenticação BÁSICA com login/senha do Infisical
// (env ADMIN_USERNAME/ADMIN_PASSWORD), independente do Firebase. Registrado
// ANTES do guard global de /api porque usa o próprio cookie de sessão admin.
// Desligado (fail-closed) se ADMIN_USERNAME/ADMIN_PASSWORD não estiverem setadas.
if (adminAuth.isAdminEnabled()) {
  const adminRouter = adminAuth.createAdminRouter(prisma);
  // Saúde operacional dos providers do motor distribuído (US4/US8 — FR-021).
  adminRouter.get('/enrichment/providers', async (req, res) => {
    try {
      const registry = require('./enrichment-provider-registry').getSharedRegistry();
      const catalogProviders = [...new Set(
        enrichmentCapabilities.listCapabilities()
          .filter((c) => c.enabled)
          .flatMap((c) => c.providers)
      )];
      const providers = await registry.listProviders(catalogProviders);
      res.json({ success: true, data: { providers } });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  app.use('/api/admin', adminRouter);
  console.log('[admin] área administrativa habilitada em /api/admin');
} else {
  console.warn('[admin] ADMIN_USERNAME/ADMIN_PASSWORD não configuradas — admin DESLIGADO');
}
// Webhook do Stripe: PÚBLICO — autenticado por assinatura HMAC própria, não
// por sessão. Precisa ser registrado antes do guard global de /api abaixo.
app.post('/api/webhooks/stripe', async (req, res) => {
  try {
    const stripeBilling = require('./stripe-billing');
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      // Sem segredo configurado o endpoint não pode validar nada — falha
      // fechada, nunca aceita evento não verificado.
      console.error('[billing] STRIPE_WEBHOOK_SECRET não configurado — webhook rejeitado');
      return res.status(503).json({ success: false, error: 'Webhook não configurado.' });
    }

    const signature = req.headers['stripe-signature'];
    const stripe = stripeBilling.getStripe();
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, signature, secret);
    } catch (err) {
      console.warn(`[billing] assinatura de webhook inválida: ${err.message}`);
      return res.status(400).json({ success: false, error: 'Assinatura de webhook inválida.' });
    }

    const result = await stripeBilling.handleStripeWebhookEvent(prisma, event);
    if (!result.handled) console.log(`[billing] evento ${event.type}: ${result.reason}`);
    res.json({ received: true });
  } catch (err) {
    console.error('[billing] webhook error:', err.message);
    // 500 faz o Stripe reentregar com backoff — correto para falha transitória.
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});
// GET /api/version — PÚBLICO. Identifica o build rodando no pod: GIT_SHA é
// injetado como build-arg no Dockerfile pela CI. Sem ele não há como conferir
// remotamente se um fix específico chegou ao cluster ("está no main mas
// produção continua com o bug?") — precisa ficar antes do guard de /api.
app.get('/api/version', (req, res) => {
  const uptimeSeconds = Math.floor(process.uptime());
  res.json({
    success: true,
    data: {
      sha: process.env.GIT_SHA || null,
      node: process.version,
      startedAt: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
      uptimeSeconds,
    },
    timestamp: new Date().toISOString(),
  });
});
app.use('/api', firebaseAuth.createRequireAuth(prisma));

// Campaign Studio (specs/010) — área própria sob /api/studio, escopo de org
// resolvido dentro do router (mesma semântica de requireRequestOrgId).
app.use('/api/studio', createStudioRouter(prisma));

// Dashboard route - serve enterprise React UI when built, fallback to legacy HTML
app.get('/', async (req, res) => {
  const reactDashboardPath = path.join(__dirname, 'apps', 'web', 'dist', 'index.html');
  if (fs.existsSync(reactDashboardPath)) {
    return res.sendFile(reactDashboardPath);
  }

  const dashboardPath = path.join(__dirname, 'public', 'dashboard.html');
  if (fs.existsSync(dashboardPath)) {
    return res.sendFile(dashboardPath);
  }
  
  res.json({ success: true, message: 'B2Base Dashboard' });
});

// ============================================================================
// LEGAL DOCUMENTS (public, no auth) — Privacy Policy & Terms of Use
// ============================================================================
// These pages are reachable without authentication and rendered server-side so
// they remain accessible for compliance (LGPD / SOC 2), consent flows and
// crawlers regardless of the SPA auth gate. They are intentionally NOT served
// through the React login-guarded shell.
function renderLegalPage({ path, title, updated, summary, sections, toc }) {
  const nav = [
    { href: '/privacy-policy', label: 'Política de Privacidade' },
    { href: '/terms-of-usage', label: 'Termos de Uso' },
  ];
  const menuItems = (toc || sections.map((s) => s.id))
    .map((id) => {
      const s = sections.find((x) => x.id === id);
      return s ? `<a class="toc" href="#${id}">${s.heading}</a>` : '';
    })
    .join('');

  const body = sections
    .map(
      (s) => `
      <section id="${s.id}">
        <h2>${s.heading}</h2>
        ${s.body}
      </section>`
    )
    .join('\n');

  return (
    `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — B2Base Platform</title>
<meta name="description" content="${summary}" />
<meta name="robots" content="index,follow" />
<link rel="canonical" href="https://b2base.net${path}" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.7;
    color: #0f172a;
    background: #f8fafc;
  }
  .topbar {
    background: #0f172a; color: #fff; padding: 0.75rem 1.5rem;
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  }
  .topbar .brand { font-weight: 700; letter-spacing: .02em; }
  .topbar nav { display: flex; gap: 1.25rem; flex-wrap: wrap; }
  .topbar nav a { color: #e2e8f0; text-decoration: none; font-size: .9rem; }
  .topbar nav a:hover { color: #fff; text-decoration: underline; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
  header.hero { border-bottom: 1px solid #e2e8f0; padding-bottom: 1.5rem; margin-bottom: 2rem; }
  header.hero h1 { margin: 0 0 .35rem; font-size: 2rem; line-height: 1.2; }
  .meta { color: #475569; font-size: .9rem; }
  .updated { display:inline-block; background:#eef2ff; color:#4338ca; border:1px solid #c7d2fe;
    border-radius:999px; padding:.15rem .7rem; font-size:.8rem; font-weight:600; }
  .summary { color:#475569; font-size:1.02rem; }
  .toc-box { background:#f1f5f9; border:1px solid #e2e8f0; border-radius:12px; padding:1.25rem 1.5rem; margin-bottom:2rem; }
  .toc-box p { margin:0 0 .5rem; font-weight:600; font-size:.95rem; }
  .toc-box .toc { display:block; color:#1d4ed8; text-decoration:none; font-size:.92rem; padding:.15rem 0; }
  .toc-box .toc:hover { text-decoration:underline; }
  section h2 { font-size:1.3rem; margin-top:2.2rem; color:#0f172a; }
  section p, section li { color:#334155; font-size:.98rem; }
  section ul { padding-left:1.3rem; }
  section li { margin:.3rem 0; }
  strong { color:#0f172a; }
  .legal-note { font-size:.82rem; color:#64748b; margin-top:3rem; border-top:1px solid #e2e8f0; padding-top:1rem; }
  footer { text-align:center; color:#64748b; font-size:.85rem; padding:2rem 1.5rem 3rem; }
  footer a { color:#1d4ed8; text-decoration:none; }
  @media (prefers-color-scheme: dark) {
    body { background:#0f172a; color:#e2e8f0; }
    header.hero { border-color:#1e293b; }
    .meta, .summary, .legal-note, footer { color:#94a3b8; }
    .toc-box { background:#1e293b; border-color:#334155; }
    .toc-box .toc, footer a { color:#93c5fd; }
    section h2, strong, section p, section li { color:#e2e8f0; }
    .updated { background:#312e81; color:#c7d2fe; border-color:#4338ca; }
    section p, section li { color:#cbd5e1; }
  }
</style>
</head>
<body>
  <div class="topbar">
    <span class="brand">B2Base Platform</span>
    <nav>${nav
      .map((n) => `<a href="${n.href}">${n.label}</a>`)
      .join('')}</nav>
  </div>
  <main class="wrap">
    <header class="hero">
      <h1>${title}</h1>
      <p class="meta">B2Base Platform · Vigência em <span class="updated">${updated}</span></p>
      <p class="summary">${summary}</p>
    </header>
    <nav class="toc-box" aria-label="Sumário">
      <p>Neste documento</p>
      ${menuItems}
    </nav>
    ${body}
    <p class="legal-note">
      Este documento foi elaborado com base em boas práticas de mercado para plataformas B2B SaaS e em
      conformidade com a LGPD (Lei nº 13.709/2018) e com controles alinhados ao framework SOC&nbsp;2.
      Não substitui aconselhamento jurídico. Última atualização: <strong>${updated}</strong>.
    </p>
  </main>
  <footer>
    <p>B2Base Platform · <a href="mailto:contato@b2base.net">contato@b2base.net</a></p>
    <p><a href="/privacy-policy">Política de Privacidade</a> · <a href="/terms-of-usage">Termos de Uso</a></p>
  </footer>
</body>
</html>`
  );
}

app.get('/privacy-policy', (req, res) => {
  const updated = '17 de agosto de 2026';
  const html = renderLegalPage({
    path: '/privacy-policy',
    title: 'Política de Privacidade',
    updated,
    summary:
      'Como a B2Base Platform coleta, usa, compartilha e protege os dados pessoais dos usuários e das empresas consultadas, em conformidade com a LGPD e com controles de segurança alinhados ao SOC 2.',
    sections: [
      {
        id: 'quem-somos',
        heading: '1. Quem somos e a abrangência desta política',
        body: `
          <p>A <strong>B2Base Platform</strong> é uma plataforma B2B SaaS de inteligência comercial que
          consolida dados empresariais (insights de CNPJ), prospecção, CRM e automação de outreach por e-mail.</p>
          <p>Esta Política de Privacidade descreve como tratamos dados pessoais no uso da plataforma, tanto os
          dados dos <strong>clientes e usuários</strong> (titulares) quanto os <strong>dados de contato das empresas
          prospectadas</strong> (dados públicos de fontes oficiais). Ela se aplica ao acesso ao produto
          (aplicação web) e aos serviços associados.</p>`,
      },
      {
        id: 'base-legal',
        heading: '2. Base legal e princípios (LGPD)',
        body: `
          <p>Tratamos dados pessoais apenas com fundamento legal previsto na LGPD (art. 7º), e nos princípios de
          finalidade, adequação, necessidade, livre acesso, qualidade, transparência, segurança, prevenção,
          não discriminação e responsabilização (art. 6º). As bases legais que normalmente aplicamos incluem:</p>
          <ul>
            <li><strong>Execução de contrato</strong> (art. 7º, V) — para prestar os serviços contratados;</li>
            <li><strong>Legítimo interesse</strong> (art. 7º, IX) — para segurança, prevenção a fraude e melhoria do produto; e</li>
            <li><strong>Consentimento</strong> (art. 7º, I) — quando aplicável e sempre revogável.</li>
          </ul>
          <p>Dados de empresas (CNPJ) são tratados com base em fontes de dados abertos, públicas e oficiais
          (ex.: Receita Federal e órgãos públicos), observando a boa-fé e a finalidade legítima de prospecção comercial.</p>`,
      },
      {
        id: 'o-que-coletamos',
        heading: '3. Que dados coletamos',
        body: `
          <p>Coletamos apenas o necessário para operar a plataforma:</p>
          <ul>
            <li><strong>Dados de conta</strong>: nome, e-mail corporativo, telefone, domínio e credenciais de autenticação;</li>
            <li><strong>Dados organizacionais</strong>: CNPJ, perfil comercial, segmentos e configurações da conta;</li>
            <li><strong>Dados de prospecção</strong>: informações empresariais públicas (razão social, endereço, sócios, situação cadastral) obtidas de fontes oficiais;</li>
            <li><strong>Dados de uso</strong>: logs de acesso, endereço IP, navegador, páginas acessadas e métricas de desempenho;</li>
            <li><strong>Dados de comunicação</strong>: metadados de e-mails de outreach (destinatário, status, eventos de abertura/clique) e, quando o cliente conecta sua caixa, escopos mínimos de acesso ao Gmail.</li>
          </ul>`,
      },
      {
        id: 'como-usamos',
        heading: '4. Como usamos os dados',
        body: `
          <p>Utilizamos os dados para:</p>
          <ul>
            <li>Fornecer e operar a plataforma (consultas de CNPJ, CRM, pipeline, relatórios e automação de outreach);</li>
            <li>Autenticar usuários e proteger a conta contra acesso não autorizado;</li>
            <li>Enviar comunicações operacionais e, com consentimento, comunicações de marketing;</li>
            <li>Garantir a segurança da informação, detectar e prevenir fraude e abuso;</li>
            <li>Cumprir obrigações legais e regulatórias.</li>
          </ul>
          <p>Não vendemos dados pessoais. Não usamos dados de clientes para treinar modelos de terceiros.</p>`,
      },
      {
        id: 'compartilhamento',
        heading: '5. Com quem compartilhamos',
        body: `
          <p>Podemos compartilhar dados com categorias de operadores, sempre sob contrato e com finalidade determinada:</p>
          <ul>
            <li><strong>Infraestrutura em nuvem</strong> (hospedagem, banco de dados e filas de mensageria);</li>
            <li><strong>Provedores de autenticação</strong> (ex.: Google/Firebase para login);</li>
            <li><strong>Provedores de correio</strong> (Gmail), apenas quando o cliente conecta sua conta para envio de outreach;</li>
            <li><strong>Fontes de dados oficiais</strong> (Receita Federal, órgãos públicos) usadas para enriquecimento;</li>
            <li><strong>Autoridades</strong>, quando exigido por lei ou ordem judicial.</li>
          </ul>
          <p>Exigimos desses operadores os mesmos padrões de confidencialidade e segurança, em linha com o modelo de
          responsabilidade compartilhada do SOC 2.</p>`,
      },
      {
        id: 'retencao',
        heading: '6. Retenção e eliminação',
        body: `
          <p>Mantemos os dados apenas pelo tempo necessário às finalidades, respeitando prazos legais e a data de
          vigência da relação contratual. Ao final do contrato, ou mediante solicitação do titular, os dados são
          excluídos ou anonimizados, salvo retenção legalmente exigida. Mecanismos de retenção por apagamento
          (deletion) e backup são controlados e testados periodicamente.</p>`,
      },
      {
        id: 'seguranca',
        heading: '7. Segurança da informação (SOC 2)',
        body: `
          <p>Adotamos controles organizacionais e técnicos alinhados aos princípios de segurança, disponibilidade e
          confidencialidade do SOC 2 (Trust Services Criteria):</p>
          <ul>
            <li><strong>Criptografia</strong> de dados em trânsito (TLS) e sensíveis em repouso;</li>
            <li><strong>Controle de acesso</strong> baseado em papéis (RBAC), autenticação segura e sessões com expiração;</li>
            <li><strong>Gestão de vulnerabilidades</strong>, atualizações de segurança e monitoramento de logs;</li>
            <li><strong>Backups</strong> com teste de restauração e planos de resposta a incidentes;</li>
            <li><strong>Rate limiting</strong> e proteção contra abuso em endpoints críticos;</li>
            <li><strong>Minimização de escopos</strong>: o acesso ao Gmail usa apenas os escopos necessários para envio e metadados.</li>
          </ul>
          <p>Em caso de incidente de segurança com risco a titulares, notificaremos a ANPD e os titulares conforme
          previsto no art. 48 da LGPD.</p>`,
      },
      {
        id: 'direitos',
        heading: '8. Seus direitos como titular (LGPD)',
        body: `
          <p>Você pode, a qualquer momento, exercer seus direitos previstos no art. 18 da LGPD:</p>
          <ul>
            <li>Confirmação da existência de tratamento e acesso aos dados;</li>
            <li>Correção de dados incompletos, inexatos ou desatualizados;</li>
            <li>Anonimização, bloqueio ou eliminação de dados desnecessários ou excessivos;</li>
            <li>Portabilidade dos dados, nos termos da regulamentação;</li>
            <li>Informação sobre compartilhamento e a possibilidade de não fornecer consentimento;</li>
            <li>Revogação do consentimento e revisão de decisões automatizadas.</li>
          </ul>
          <p>Para exercer seus direitos, fale conosco pelo e-mail
          <a href="mailto:contato@b2base.net">contato@b2base.net</a>. Responderemos
          dentro dos prazos legais, com medidas para confirmar sua identidade.</p>`,
      },
      {
        id: 'cookies',
        heading: '9. Cookies e tecnologias similares',
        body: `
          <p>Utilizamos cookies estritamente necessários (ex.: autenticação, sessão e segredos httpOnly) e, quando
          aplicável, tecnologias de análise com dados agregados. Você pode gerenciar cookies pelo navegador; a
          recusa de cookies essenciais pode impedir o funcionamento da plataforma.</p>`,
      },
      {
        id: 'lgpd-completa',
        heading: '10. Encarregado (DPO) e contato LGPD',
        body: `
          <p>Para questões relacionadas à LGPD e à privacidade, você pode contactar nosso Encarregado de Proteção de
          Dados (DPO) pelo e-mail <a href="mailto:contato@b2base.net">contato@b2base.net</a>
          ou pela <a href="https://www.gov.br/anpd" target="_blank" rel="noopener">Autoridade Nacional de Proteção de Dados (ANPD)</a>.</p>`,
      },
      {
        id: 'alteracoes',
        heading: '11. Alterações desta política',
        body: `
          <p>Podemos atualizar esta política periodicamente. Alterações relevantes serão comunicadas por meio da
          plataforma ou por e-mail antes de entrarem em vigor. A data de "última atualização" no topo desta página
          reflete a versão vigente.</p>`,
      },
    ],
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/terms-of-usage', (req, res) => {
  const updated = '17 de agosto de 2026';
  const html = renderLegalPage({
    path: '/terms-of-usage',
    title: 'Termos de Uso',
    updated,
    summary:
      'Os termos e condições que regem o uso da plataforma B2Base Platform, incluindo responsabilidades, uso aceitável, propriedade intelectual e disposições de compliance (LGPD e SOC 2).',
    sections: [
      {
        id: 'aceite',
        heading: '1. Aceitação dos termos',
        body: `
          <p>Ao acessar ou usar a <strong>B2Base Platform</strong>, você concorda com estes Termos de Uso e com a
          nossa <a href="/privacy-policy">Política de Privacidade</a>. Se você usa a plataforma em nome de uma
          organização, declara ter autoridade para vinculá-la a estes termos. Se não concordar com qualquer
          disposição, cessará imediatamente o uso.</p>`,
      },
      {
        id: 'servico',
        heading: '2. O serviço',
        body: `
          <p>A plataforma oferece, entre outras funcionalidades: consulta e enriquecimento de dados de CNPJ a partir de
          fontes públicas e oficiais, gestão de prospecção (CRM), pipeline comercial, automação de outreach por e-mail
          e relatórios de desempenho. O escopo exato de funcionalidades disponíveis depende do plano contratado.</p>`,
      },
      {
        id: 'conta',
        heading: '3. Conta, credenciais e conduta',
        body: `
          <ul>
            <li>Você é responsável por manter a confidencialidade das suas credenciais de acesso e pelas atividades realizadas sob a sua conta;</li>
            <li>Deve fornecer informações verdadeiras e mantê-las atualizadas;</li>
            <li>Deve notificar-nos imediatamente sobre qualquer uso não autorizado da sua conta;</li>
            <li>O usuário deve ser maior de idade e ter capacidade legal para contratar.</li>
          </ul>`,
      },
      {
        id: 'uso-aceitavel',
        heading: '4. Uso aceitável e boas práticas de outreach',
        body: `
          <p>Você concorda em usar a plataforma em conformidade com a legislação aplicável, incluindo a LGPD, o Código
          de Defesa do Consumidor e as políticas dos provedores de e-mail. Em especial, em atividades de <strong>outreach</strong>:</p>
          <ul>
            <li>Utilizar apenas dados de contato obtidos licitamente e dentro das finalidades informadas;</li>
            <li>Respeitar listas de supressão, a opção de descadastro (opt-out) e os limites de envio (rate limits);</li>
            <li>Não enviar mensagens não solicitadas em massa, spam ou conteúdo fraudulento, enganoso ou ofensivo;</li>
            <li>Cumprir as políticas de uso aceitável dos provedores de e-mail (ex.: diretrizes do Gmail).</li>
          </ul>
          <p>É vedado usar a plataforma para: burlar sistemas, acessar dados de terceiros sem autorização, violar leis,
          propriedade intelectual ou direitos de terceiros, ou interferir na operação do serviço.</p>`,
      },
      {
        id: 'propriedade',
        heading: '5. Propriedade intelectual e licença',
        body: `
          <p>A plataforma, seu código, design, marcas e conteúdo são de titularidade da B2Base ou de seus
          licenciantes. Concedemos a você uma licença limitada, não exclusiva e intransferível para uso do serviço
          durante a vigência do contrato. Os dados que você insere e gerencia na plataforma permanecem seus; você nos
          concede uma licença para processá-los apenas para prestar o serviço.</p>`,
      },
      {
        id: 'responsabilidade',
        heading: '6. Responsabilidades e isenções',
        body: `
          <p>A plataforma é fornecida "como está", dentro de padrões razoáveis de disponibilidade e segurança. Não
          garantimos que dados de terceiros (ex.: dados públicos de CNPJ) estejam livres de erros ou atualizados em
          tempo real, sendo estes fornecidos por fontes oficiais e sujeitos à disponibilidade de tais fontes. Na
          medida permitida por lei, não nos responsabilizamos por danos indiretos, lucros cessantes ou perda de dados,
          salvo dolo ou culpa grave ou quando houver disposição legal imperativa (ex.: responsabilidade por dados
          pessoais na LGPD).</p>
          <p>Você é responsável pelo uso que faz das informações da plataforma e por decisões comerciais tomadas a
          partir delas.</p>`,
      },
      {
        id: 'dados-e-lgpd',
        heading: '7. Dados pessoais e LGPD',
        body: `
          <p>O tratamento de dados pessoais é regido pela nossa <a href="/privacy-policy">Política de Privacidade</a>.
          Você se compromete a tratar os dados de terceiros (ex.: contatos prospectados) em conformidade com a LGPD e
          demais normas aplicáveis, atuando como controlador em relação a tais dados e isentando a plataforma de
          usos indevidos por sua parte.</p>`,
      },
      {
        id: 'suspensao',
        heading: '8. Suspensão, rescisão e prazos',
        body: `
          <p>Podemos suspender o acesso em caso de descumprimento destes termos, violação à segurança ou uso ilegal.
          Você pode encerrar sua conta a qualquer momento. No encerramento, permanecem válidas as cláusulas que, por
          natureza, devam sobreviver (confidencialidade, propriedade intelectual, responsabilidade, e disposições
          gerais). Dados serão tratados conforme a política de retenção da Política de Privacidade.</p>`,
      },
      {
        id: 'seguraca-soc2',
        heading: '9. Segurança e controles (SOC 2)',
        body: `
          <p>Mantemos controles organizacionais e técnicos alinhados aos critérios de segurança, disponibilidade e
          confidencialidade do SOC 2, incluindo criptografia, controle de acesso, monitoramento, gestão de
          vulnerabilidades, backup e resposta a incidentes. Não obstante, nenhum sistema é inviolável, e você deve
          adotar práticas de segurança em sua própria infraestrutura e contas.</p>`,
      },
      {
        id: 'legislacao',
        heading: '10. Legislação aplicável e foro',
        body: `
          <p>Estes Termos são regidos pelas leis da República Federativa do Brasil. As partes elegem o foro da comarca
          da sede da B2Base para dirimir controvérsias, sem prejuízo de normas de ordem pública e das disposições
          do CDC e da LGPD.</p>`,
      },
      {
        id: 'contato-termos',
        heading: '11. Contato',
        body: `
          <p>Para perguntas, solicitações ou notificações relacionadas a estes Termos, fale conosco por
          <a href="mailto:contato@b2base.net">contato@b2base.net</a>.</p>`,
      },
    ],
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Validate database connection without creating demo data
async function initDatabase() {
  try {
    await prisma.$connect();
    console.log('✅ Database connection ready');
    return null;
  } catch (error) {
    console.error('Database initialization error:', error);
    process.exit(1);
  }
}

// ============================================================================
// ISOLAMENTO DE DADOS POR USUÁRIO (multi-tenant)
// ============================================================================
// Cada usuário possui uma Organization exclusiva (orgId). Toda a leitura e
// escrita de dados (prospects, pipeline, configurações, outreach) deve ser
// escopada pelo orgId do usuário autenticado. NUNCA usar organization.findFirst()
// ou consultas sem WHERE de orgId em endpoints autenticados.
//
// O JWT de sessão já carrega `orgId`; resolvemos pelo token e caímos no banco
// apenas como fallback (e para validar que o usuário existe).

async function resolveRequestOrgId(req) {
  // 1) orgId presente no token de sessão (caminho normal).
  const orgIdFromToken = req.user && req.user.orgId;

  // 2) Fallback: carregar o usuário do banco para obter orgId.
  const userId = req.user && (req.user.id || req.user.uid);
  if (!orgIdFromToken && userId) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
    if (user) return { userId, orgId: user.orgId };
  }

  if (orgIdFromToken) return { userId, orgId: orgIdFromToken };

  return { userId: null, orgId: null };
}

// Resolve o orgId do usuário autenticado (lança erro 401 se não autenticado).
async function requireRequestOrgId(req) {
  const { orgId } = await resolveRequestOrgId(req);
  if (!orgId) {
    const err = new Error('Não autenticado');
    err.status = 401;
    throw err;
  }
  return orgId;
}

// ============================================================================
// PLANOS DE ASSINATURA (trial | premium)
// ============================================================================
// Toda conta começa em "trial". O plano é por Organization.
//  - Trial: máximo de 10 leads captados, sem exportação de dados.
//  - Premium: acesso completo (sem esses limites).

const PLAN_TRIAL_LEAD_LIMIT = 10;

const PLANS = {
  trial: { canExport: false, leadLimit: PLAN_TRIAL_LEAD_LIMIT },
  premium: { canExport: true, leadLimit: null },
};

function normalizePlan(value) {
  return value === 'premium' ? 'premium' : 'trial';
}

// Retorna o plano normalizado de uma Organization (ou null se não existir).
async function getOrgPlan(orgId) {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { plan: true },
  });
  return org ? normalizePlan(org.plan) : 'trial';
}

function planLimits(plan) {
  return PLANS[normalizePlan(plan)] || PLANS.trial;
}

// Conta os leads (prospects) já captados para a Organization.
async function countOrgLeads(orgId) {
  return prisma.prospect.count({ where: { orgId } });
}

/**
 * Garante que a Organization ainda pode captar um novo lead.
 * Lança erro 403 (com code PLAN_LIMIT_REACHED) quando o plano trial já atingiu
 * o teto de leads. É chamado ANTES de qualquer criação de prospect.
 */
async function assertCanCaptureLead(orgId) {
  const plan = await getOrgPlan(orgId);
  const { leadLimit } = planLimits(plan);
  if (leadLimit !== null) {
    const count = await countOrgLeads(orgId);
    if (count >= leadLimit) {
      const err = new Error(
        `Limite do plano Trial atingido: você pode captar até ${leadLimit} leads. ` +
          'Faça upgrade para o plano Premium para captar leads ilimitados.'
      );
      err.status = 403;
      err.code = 'PLAN_LIMIT_REACHED';
      throw err;
    }
  }
}

/**
 * Garante que a Organization é Premium — gate das features pagas (ex.:
 * campanha com IA). Lança erro 403 (code PREMIUM_REQUIRED) para trial.
 */
async function assertPremiumOrg(orgId) {
  const plan = await getOrgPlan(orgId);
  if (plan !== 'premium') {
    const err = new Error(
      'Este recurso está disponível apenas no plano Premium. ' +
        'Faça upgrade para desbloquear a campanha com IA.'
    );
    err.status = 403;
    err.code = 'PREMIUM_REQUIRED';
    throw err;
  }
}

// ============================================================================
// E2E enforcement of trial "no export" — data-level masking (blur + lock)
// ============================================================================
// O botão "Baixar lista" gera CSV no browser a partir dos dados JÁ renderizados,
// então esconder o botão não é proteção real (um trial técnico lê o DOM/network).
// A garantia dura é não ENTREGAR os campos exportáveis (contato/firmografia) à
// conta trial na resposta da API. Se o dado nunca chega ao browser, não há como
// exportá-lo.
//
// Desde a introdução do teaser visual (blur + cadeado), a redação passou a ser
// MÁSCARA PARCIAL em vez de nulificar: o trial recebe "j••••@e••••.com.br" —
// suficiente para ver que o dado existe, insuficiente para reconstruí-lo —
// e a UI marca o campo com `dataRestricted` (blur + cadeado + CTA upgrade).
//
// Campos mascarados no trial (contato + firmografia exportável). O CNPJ é
// mantido de propósito: é o identificador público de inscrição usado pelo fluxo
// de import ("adicionar lead") e é trivialmente recuperável pelo nome da
// empresa; não é "dado de contato". O endereço completo (logradouro etc.) vive
// no cnpjRawData, que segue não entregue (null) — cidade/UF são resumo comercial
// público e permitem navegar a lista.
//
//   email, cnpjEmail, phones, cnpjPhones, partners, cnpjPartners,
//   cnpjOpenedAt/openedAt, cnpjLegalNature/legalNature, cnpjRawData

/**
 * Mascara os campos exportáveis de um prospect/contato quando o plano é trial.
 * Retorna sempre um objeto novo (não muta o original) e marca `dataRestricted`.
 * No premium retorna o objeto como veio (nenhuma mudança).
 */
function redactProspectForPlan(prospect, plan) {
  if (plan === 'premium' || prospect === null || typeof prospect !== 'object') {
    return prospect;
  }
  // Feature 005: trial não recebe nenhuma saída da análise profunda
  // (estado/veredito removidos antes do masking dos contatos — FR-018/SC-007).
  return maskProspectForTrial(stripDeepAnalysisFields(prospect));
}

/**
 * Aplica a redação a uma lista de prospects/contatos conforme o plano da org.
 */
function redactProspectListForPlan(list, plan) {
  if (plan === 'premium' || !Array.isArray(list)) return list;
  return list.map((item) => redactProspectForPlan(item, plan));
}

function asStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function emptyCommercialProfile() {
  return {
    id: null,
    orgId: null,
    onboardingCompleted: false,
    onboardingStep: 0,
    companyName: '',
    salesTeamSize: '',
    targetSegments: [],
    targetCnaes: [],
    targetLocations: [],
    companyStatuses: ['active'],
    targetSizes: [],
    ageRanges: [],
    averageTicket: null,
    salesCycle: '',
    valueProposition: '',
    productDescription: '',
    businessModel: '',
    differentiators: [],
    websiteUrl: '',
    ctaGoal: '',
    toneNotes: '',
    crmName: null,
    onboardingAnswers: null,
    createdAt: null,
    updatedAt: null,
  };
}

function formatCommercialProfile(settings, organization) {
  if (!settings) return { ...emptyCommercialProfile(), companyName: organization?.name || '' };

  return {
    id: settings.id,
    orgId: settings.orgId,
    onboardingCompleted: settings.onboardingCompleted,
    onboardingStep: typeof settings.onboardingStep === 'number' ? settings.onboardingStep : 0,
    companyName: settings.companyName || organization?.name || '',
    salesTeamSize: settings.salesTeamSize || '',
    targetSegments: Array.isArray(settings.targetSegments) ? settings.targetSegments : [],
    targetCnaes: Array.isArray(settings.targetCnaes) ? settings.targetCnaes : [],
    targetLocations: Array.isArray(settings.targetLocations) ? settings.targetLocations : [],
    companyStatuses: Array.isArray(settings.companyStatuses) && settings.companyStatuses.length ? settings.companyStatuses : ['active'],
    targetSizes: Array.isArray(settings.targetSizes) ? settings.targetSizes : [],
    ageRanges: Array.isArray(settings.ageRanges) ? settings.ageRanges : [],
    averageTicket: settings.averageTicket,
    salesCycle: settings.salesCycle || '',
    valueProposition: settings.valueProposition || '',
    productDescription: settings.productDescription || '',
    businessModel: settings.businessModel || '',
    differentiators: Array.isArray(settings.differentiators) ? settings.differentiators : [],
    websiteUrl: settings.websiteUrl || '',
    ctaGoal: settings.ctaGoal || '',
    toneNotes: settings.toneNotes || '',
    crmName: settings.crmName || null,
    onboardingAnswers: settings.onboardingAnswers || null,
    createdAt: settings.createdAt,
    updatedAt: settings.updatedAt,
  };
}

function normalizeCommercialProfilePayload(body = {}) {
  const rawStep = Number(body.onboardingStep);
  return {
    onboardingCompleted: Boolean(body.onboardingCompleted),
    onboardingStep: Number.isFinite(rawStep) ? Math.min(4, Math.max(0, Math.floor(rawStep))) : 0,
    companyName: String(body.companyName || '').trim() || null,
    salesTeamSize: String(body.salesTeamSize || '').trim() || null,
    targetSegments: asStringArray(body.targetSegments),
    targetCnaes: asStringArray(body.targetCnaes),
    targetLocations: asStringArray(body.targetLocations),
    companyStatuses: asStringArray(body.companyStatuses).length ? asStringArray(body.companyStatuses) : ['active'],
    targetSizes: asStringArray(body.targetSizes),
    ageRanges: asStringArray(body.ageRanges),
    averageTicket: body.averageTicket === '' || body.averageTicket === null || body.averageTicket === undefined ? null : Number(body.averageTicket) || null,
    salesCycle: String(body.salesCycle || '').trim() || null,
    valueProposition: String(body.valueProposition || '').trim() || null,
    // Contexto de negócio consumido pela IA (org-context.js).
    productDescription: String(body.productDescription || '').trim() || null,
    businessModel: String(body.businessModel || '').trim() || null,
    differentiators: asStringArray(body.differentiators),
    websiteUrl: String(body.websiteUrl || '').trim() || null,
    ctaGoal: String(body.ctaGoal || '').trim() || null,
    toneNotes: String(body.toneNotes || '').trim() || null,
    // Onboarding conversacional (009)
    crmName: String(body.crmName || '').trim() || null,
    onboardingAnswers: body.onboardingAnswers && typeof body.onboardingAnswers === 'object' ? body.onboardingAnswers : null,
  };
}

let DEFAULT_ORG_ID;

// ============================================================================
// DISCOVERY ENGINE (specs/006-discovery-engine)
// ============================================================================
// Publisher JetStream lazy: sem NATS o engine roda igual (só sem eventos).
const natsStreamMod = require('./nats-stream');
const { createDiscoveryEngine, makeNatsPublisher } = require('./discovery');
const { createDiscoveryApi } = require('./discovery/api');

const discoveryPublisher = (() => {
  let jsPromise = null;
  return async (message) => {
    try {
      if (!natsStreamMod.isNatsEnabled()) return;
      if (!jsPromise) jsPromise = natsStreamMod.connectNats({ name: 'b2base-discovery' }).then((nc) => nc.jetstream());
      const js = await jsPromise;
      await makeNatsPublisher(js, { logger: console })(message);
    } catch (err) {
      console.warn(`[discovery] publisher indisponível: ${err.message}`);
    }
  };
})();

const discoveryEngine = createDiscoveryEngine({
  prisma,
  publish: discoveryPublisher,
  registry: process.env.REDIS_URL
    ? require('./discovery/provider-registry').createDiscoveryRegistry({ redis: new (require('ioredis'))(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 }) })
    : null,
  logger: console,
});
createDiscoveryApi({ app, prisma, engine: discoveryEngine, requireRequestOrgId });

// ============================================================================
// API ENDPOINTS
// ============================================================================

// GET /api/settings/commercial-profile - Commercial preferences and onboarding state
app.get('/api/settings/commercial-profile', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) {
      return res.json({ success: true, data: emptyCommercialProfile(), timestamp: new Date().toISOString() });
    }

    const settings = await prisma.commercialSettings.findUnique({ where: { orgId } });
    res.json({
      success: true,
      data: formatCommercialProfile(settings, org),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// PUT /api/settings/commercial-profile - Save commercial preferences from onboarding/settings
app.put('/api/settings/commercial-profile', async (req, res) => {
  try {
    const data = normalizeCommercialProfilePayload(req.body || {});
    // Sempre derivado do usuário autenticado; nunca do body/orgId global.
    const orgId = await requireRequestOrgId(req);

    if (data.companyName) {
      await prisma.organization.update({
        where: { id: orgId },
        data: { name: data.companyName }
      });
    }

    const settings = await prisma.commercialSettings.upsert({
      where: { orgId },
      create: { ...data, orgId },
      update: data,
    });
    const org = await prisma.organization.findUnique({ where: { id: orgId } });

    res.json({
      success: true,
      data: formatCommercialProfile(settings, org),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ONBOARDING CONVERSACIONAL (Ava) — extração stateless de ativos (feature 004)
// ============================================================================
// POST /api/onboarding/ava/extract — recebe os ativos informados na conversa
// (site institucional, materiais, catálogo) e devolve o contexto de negócio
// extraído. Stateless e idempotente: NADA é persistido — arquivos vivem só na
// request (memoryStorage) e são descartados (constituição V; contrato em
// specs/004-ai-onboarding/contracts/http-api.md).
const multer = require('multer');
const { createAvaExtractor } = require('./ava-extract');

const avaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 5, fileSize: 20 * 1024 * 1024, fields: 10 },
});
const avaExtractor = createAvaExtractor({});

app.post('/api/onboarding/ava/extract', avaUpload.any(), async (req, res) => {
  const startedAt = Date.now();
  try {
    // Guard global /api já autenticou; orgId vem do token (auditoria).
    const orgId = await requireRequestOrgId(req);
    const siteUrl = typeof req.body.siteUrl === 'string' && req.body.siteUrl.trim() ? req.body.siteUrl.trim() : null;
    const catalogUrl = typeof req.body.catalogUrl === 'string' && req.body.catalogUrl.trim() ? req.body.catalogUrl.trim() : null;
    const files = (req.files || []).map((f) => ({ name: f.originalname, mime: f.mimetype, buffer: f.buffer }));

    if (!siteUrl && !catalogUrl && files.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'EMPTY_REQUEST' } });
    }

    const result = await avaExtractor.extractBusinessAssets({ siteUrl, catalogUrl, files });
    metrics.observeAvaExtractDuration(Date.now() - startedAt);
    for (const doc of result.extractedFrom.documents) metrics.incAvaExtractFile(doc.status);
    if (!result.businessContext && result.warnings.some((w) => w.startsWith('LLM_UNAVAILABLE'))) {
      metrics.incAvaExtractLlmFailure();
    }
    console.log(`[ava-extract] org=${orgId} fontes ok=${Boolean(result.businessContext)} warnings=${result.warnings.length}`);
    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (error) {
    if (error && error.status === 400) {
      return res.status(400).json({ success: false, error: { code: 'EMPTY_REQUEST' } });
    }
    if (error && error.status === 413) {
      return res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
    }
    console.error('[ava-extract] erro inesperado:', error.message);
    res.status(500).json({ success: false, error: { code: 'EXTRACT_FAILED' } });
  }
});

// Erros de multipart (multer) → 413/400 do contrato, não o 500 global.
app.use('/api/onboarding/ava/extract', (err, req, res, _next) => {
  const code = err && err.code;
  if (code === 'LIMIT_FILE_SIZE' || code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
  }
  console.error('[ava-extract] multipart rejeitado:', code || err.message);
  res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST' } });
});

// ============================================================================
// PLANOS DE ASSINATURA — endpoints
// ============================================================================

// GET /api/plan - plano atual da Organization (trial | premium) + limites e uso.
app.get('/api/plan', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const plan = await getOrgPlan(orgId);
    const { canExport, leadLimit } = planLimits(plan);
    const leadCount = await countOrgLeads(orgId);
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { stripeCustomerId: true, stripeSubscriptionId: true, stripePlanStatus: true },
    });
    res.json({
      success: true,
      data: {
        plan,
        canExport,
        leadLimit,
        leadCount,
        leadsRemaining: leadLimit === null ? null : Math.max(0, leadLimit - leadCount),
        atLeadLimit: leadLimit !== null && leadCount >= leadLimit,
        billing: {
          configured: require('./stripe-billing').isBillingConfigured(),
          hasSubscription: Boolean(org?.stripeSubscriptionId),
          subscriptionStatus: org?.stripePlanStatus || null,
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// ─── Billing Stripe (assinatura do plano premium) ───────────────────────────
// O upgrade passa por Checkout Session (mode=subscription) e o plano só
// muda via webhook — a fonte de verdade é o ciclo de vida da assinatura.

// Origem do frontend para success_url/cancel_url do checkout e do portal.
function resolveAppBaseUrl(req) {
  return process.env.APP_URL || req.headers.origin || `${req.protocol}://${req.get('host')}`;
}

// POST /api/billing/checkout-session — cria Checkout Session de assinatura
// do plano premium e devolve a URL para redirecionar o usuário.
app.post('/api/billing/checkout-session', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const stripeBilling = require('./stripe-billing');
    if (!stripeBilling.isBillingConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Billing não configurado no servidor (STRIPE_SECRET_KEY/STRIPE_PRICE_ID).',
      });
    }
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return res.status(404).json({ success: false, error: 'Organization not found' });

    const session = await stripeBilling.createPremiumCheckoutSession(prisma, org, resolveAppBaseUrl(req));
    console.log(`[billing] checkout session criada para org ${orgId}: ${session.id}`);
    res.json({ success: true, data: { url: session.url, sessionId: session.id }, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[billing] checkout-session error:', err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/billing/portal-session — Customer Portal (cartão, cancelar, faturas).
app.post('/api/billing/portal-session', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const stripeBilling = require('./stripe-billing');
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return res.status(404).json({ success: false, error: 'Organization not found' });

    const session = await stripeBilling.createBillingPortalSession(prisma, org, resolveAppBaseUrl(req));
    res.json({ success: true, data: { url: session.url }, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[billing] portal-session error:', err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/webhooks/stripe — definido no topo do arquivo (antes do guard
// global de auth em /api), pois é endpoint público autenticado por HMAC.

// GET /api/prospects/export - CSV dos prospects (somente plano premium).
app.get('/api/prospects/export', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const plan = await getOrgPlan(orgId);
    const { canExport } = planLimits(plan);
    if (!canExport) {
      return res.status(403).json({
        success: false,
        error: 'A exportação de dados está disponível apenas no plano Premium.',
        code: 'EXPORT_NOT_ALLOWED',
      });
    }

    const prospects = await prisma.prospect.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
    });

    const header = ['cnpj', 'companyName', 'tradeName', 'status', 'industry', 'city', 'state', 'cnpjEmail', 'employees', 'revenueEstimate', 'opportunityScore', 'createdAt'];
    const escapeCsv = (value) => {
      const str = value === null || value === undefined ? '' : String(value);
      if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
      return str;
    };
    const lines = [
      header.join(','),
      ...prospects.map((p) =>
        header
          .map((key) => {
            let v = p[key];
            if (v instanceof Date) v = v.toISOString();
            return escapeCsv(v);
          })
          .join(',')
      ),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="prospects.csv"');
    res.send('\uFEFF' + lines.join('\n'));
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// GET /api/prospects - Get all prospects (escopado pelo usuário autenticado)
app.get('/api/prospects', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    if (process.env.DEBUG_DASHBOARD === 'true') {
      console.log('[dashboard-debug] GET /api/prospects -> orgId=', orgId, 'userId=', req.user && (req.user.id || req.user.uid), 'email=', req.user && req.user.email);
    }
    const prospects = await prisma.prospect.findMany({
      where: { orgId },
      select: {
        id: true,
        cnpj: true,
        companyName: true,
        status: true,
        opportunityScore: true,
        revenueEstimate: true,
        employees: true,
        industry: true,
        city: true,
        state: true,
        tradeName: true,
        cnpjEmail: true,
        cnpjPhones: true,
        cnpjPartners: true,
        cnpjOpenedAt: true,
        cnpjLegalNature: true,
        enrichmentStatus: true,
        enrichmentSource: true,
        enrichmentError: true,
        enrichmentVersion: true,
        enrichmentSummary: true,
        enrichedAt: true,
        // Feature 005: estado mínimo da análise profunda para o card do kanban
        // (o resumo completo só existe em GET /:id/deep-analysis).
        analysisStatus: true,
        verdict: true,
        createdAt: true,
        updatedAt: true,
        orgId: true
      },
      orderBy: { createdAt: 'desc' }
    });

    if (process.env.DEBUG_DASHBOARD === 'true') {
      console.log('[dashboard-debug] GET /api/prospects -> count=', prospects.length, 'orgId=', orgId);
    }
    // E2E: trial nunca recebe contato/firmografia (não há como exportar o que não chega ao browser).
    const plan = await getOrgPlan(orgId);
    const data = redactProspectListForPlan(prospects, plan);
    res.json({
      success: true,
      data,
      count: prospects.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/prospects/:id - Get specific prospect (escopado pelo usuário)
app.get('/api/prospects/:id', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const prospect = await prisma.prospect.findFirst({
      where: { id: req.params.id, orgId }
    });

    if (!prospect) {
      return res.status(404).json({ success: false, error: 'Prospect not found' });
    }

    const plan = await getOrgPlan(orgId);
    res.json({ success: true, data: redactProspectForPlan(prospect, plan) });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// GET /api/prospects/:id/contact-decision - Painel de decisão de contato
// (feature 003): Atingibilidade, Momento e recomendação única, computados
// on-read a partir das evidências já persistidas. O payload NUNCA contém
// valores de e-mail/telefone — seguro a trial por construção (FR-011).
app.get('/api/prospects/:id/contact-decision', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const prospect = await prisma.prospect.findFirst({
      where: { id: req.params.id, orgId },
    });
    if (!prospect) {
      return res.status(404).json({ success: false, error: 'Prospect not found' });
    }

    // Grafo é evidência complementar: falha degrada (FR-013), não derruba.
    let graphData = null;
    if (prospect.cnpj) {
      try {
        const graph = await enrichmentGraph.fetchCompanyGraph(prospect.cnpj);
        graphData = graph && graph.available ? graph.data : null;
      } catch (graphErr) {
        console.error('[contact-decision] grafo indisponível:', graphErr.message);
      }
    }

    const decision = computeContactDecision(prospect, graphData);
    const plan = await getOrgPlan(orgId);
    decision.dataRestricted = plan !== 'premium';

    res.json({ success: true, data: decision, timestamp: new Date().toISOString() });
  } catch (error) {
    if (error.status === 401) {
      return res.status(401).json({ success: false, error: error.message });
    }
    console.error('[contact-decision] erro ao computar decisão:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/prospects/:id/deep-analysis — Análise profunda vigente (feature
// 005): estado da execução + resultado (score final, veredito, resumo,
// impressões, fatores). Contrato: specs/005-deep-lead-analysis/contracts/api.md.
// Orgs sem o recurso recebem 403 PREMIUM_FEATURE sem nenhuma informação sobre
// a análise no corpo (SC-007); 404 cross-tenant nunca vaza existência.
app.get('/api/prospects/:id/deep-analysis', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const plan = await getOrgPlan(orgId);
    if (plan !== 'premium') {
      return res.status(403).json({
        success: false,
        code: 'PREMIUM_FEATURE',
        error: 'A análise profunda por IA é um recurso do plano Premium.',
      });
    }
    const prospect = await prisma.prospect.findFirst({
      where: { id: req.params.id, orgId },
    });
    if (!prospect) {
      return res.status(404).json({ success: false, error: 'Prospect not found' });
    }

    const analysis = prospect.currentDeepAnalysisId
      ? await prisma.deepAnalysis.findUnique({ where: { id: prospect.currentDeepAnalysisId } })
      : null;
    const state = prospect.analysisStatus || 'not_started';

    res.json({
      success: true,
      data: {
        state,
        analysis:
          analysis && analysis.status === 'completed'
            ? {
                id: analysis.id,
                finalScore: analysis.finalScore,
                verdict: analysis.verdict,
                summary: analysis.summary,
                impressions: analysis.impressions || [],
                factorsPro: analysis.factorsPro || [],
                factorsCon: analysis.factorsCon || [],
                deterministicScore: analysis.deterministicScore,
                orgContextConsidered: analysis.orgContextConsidered,
                override: analysis.override,
                modelVersion: analysis.modelVersion,
                completedAt: analysis.completedAt,
              }
            : null,
        errorMessage: analysis && analysis.status === 'failed' ? analysis.errorMessage : null,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[deep-analysis] erro ao carregar análise:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/prospects/:id/deep-analysis/rerun — Reexecuta a análise profunda
// (FR-014). Execução assíncrona: o estado passa a 'running' e é sondado pelo
// GET acima. 409 ANALYSIS_RUNNING em reexecução concorrente.
app.post('/api/prospects/:id/deep-analysis/rerun', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const plan = await getOrgPlan(orgId);
    if (plan !== 'premium') {
      return res.status(403).json({
        success: false,
        code: 'PREMIUM_FEATURE',
        error: 'A análise profunda por IA é um recurso do plano Premium.',
      });
    }
    const prospect = await prisma.prospect.findFirst({
      where: { id: req.params.id, orgId },
    });
    if (!prospect) {
      return res.status(404).json({ success: false, error: 'Prospect not found' });
    }
    if (prospect.status !== 'deep_analysis') {
      return res.status(422).json({
        success: false,
        code: 'STAGE_TRANSITION_BLOCKED',
        error: 'Só é possível reexecutar a análise de leads que estão em "Análise profunda".',
      });
    }

    const result = await deepAnalysis.getSharedRunner(prisma).enqueue(prospect, { trigger: 'manual' });
    if (result.skipped) {
      return res.status(409).json({
        success: false,
        code: 'ANALYSIS_RUNNING',
        error:
          result.reason === 'running'
            ? 'A análise já está em execução — aguarde o veredito.'
            : 'Não foi possível reexecutar a análise agora.',
      });
    }
    result.done.catch((err) =>
      console.error(`[deep-analysis] reexecução falhou (lead ${prospect.id}):`, err.message)
    );
    res.status(202).json({ success: true, data: { state: 'running' }, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[deep-analysis] erro ao reexecutar análise:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/prospects - Create prospect
app.post('/api/prospects', async (req, res) => {
  try {
    const { cnpj, companyName, status, industry, employees, revenueEstimate } = req.body;

    if (!cnpj || !companyName) {
      return res.status(400).json({ success: false, error: 'CNPJ and company name required' });
    }

    // Sempre associa o prospect ao orgId do usuário autenticado.
    const targetOrgId = await requireRequestOrgId(req);

    // Plano: garante que o trial ainda pode captar mais um lead antes do create.
    await assertCanCaptureLead(targetOrgId);
    const plan = await getOrgPlan(targetOrgId);

    const prospect = await prisma.prospect.create({
      data: {
        cnpj,
        companyName,
        status: pipelineTransitions.normalizeStatus(status) || 'prospect',
        industry: industry || '',
        employees: employees || 0,
        revenueEstimate: revenueEstimate || 0,
        opportunityScore: 65,
        // Epic 1 (FR4): searchText normalizado p/ matching de segmento.
        ...withSearchText({ companyName, industry: industry || '' }),
        orgId: targetOrgId
      }
    });

    // Consentimento WhatsApp AUTOMÁTICO no cadastro (QA 2026-10-07, diretriz
    // do dono: lead cadastrado já nasce habilitado para a matrícula WA).
    require('./studio/certificate')
      .grantConsent(prisma, {
        orgId: targetOrgId,
        prospectId: prospect.id,
        source: 'manual-import',
        grantedById: req.user?.id || null,
        evidence: { declaredBy: 'owner-policy', via: 'painel' },
      })
      .catch((err) => console.error('[prospects] consentimento WhatsApp falhou (lead segue):', err.message));

    // Enriquecimento roteado por plano (NATS premium; BrasilAPI trial).
    const enrichedProspect = await dispatchEnrichmentForPlan(prisma, prospect);

    res.json({
      success: true,
      data: redactProspectForPlan(enrichedProspect, plan),
      enrichment: {
        status: enrichedProspect.enrichmentStatus,
        source: enrichedProspect.enrichmentSource,
        error: enrichedProspect.enrichmentError
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ success: false, error: 'CNPJ already exists' });
    }
    if (error.code === 'PLAN_LIMIT_REACHED' || error.status === 403) {
      return res.status(403).json({ success: false, error: error.message, code: 'PLAN_LIMIT_REACHED' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/prospects/:id/enrich - Enrich a specific prospect CNPJ
app.post('/api/prospects/:id/enrich', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const plan = await getOrgPlan(orgId);
    const prospect = await prisma.prospect.findFirst({ where: { id: req.params.id, orgId } });
    if (!prospect) return res.status(404).json({ success: false, error: 'Prospect not found' });

    // Roteia por plano: sem CNPJ → resolução (SearXNG/RFB) + deep enrich
    // premium; com CNPJ → NATS (premium) ou BrasilAPI (trial).
    const enriched = await dispatchEnrichmentForPlan(prisma, prospect);
    res.json({
      success: true,
      data: redactProspectForPlan(enriched, plan),
      enrichment: {
        status: enriched.enrichmentStatus,
        source: enriched.enrichmentSource,
        error: enriched.enrichmentError
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// GET /api/enrichment/jobs/:jobId — status do job no motor distribuído
// (percentuais de conclusão em tempo real — FR-006). 404 cross-tenant.
app.get('/api/enrichment/jobs/:jobId', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const status = await enrichmentManager.getJobStatus(req.params.jobId, orgId);
    if (!status) return res.status(404).json({ success: false, error: 'Job not found' });
    res.json({ success: true, data: status });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// GET /api/prospects/:id/enrichment — fatos agregados por capability com
// evidência (US6). Trial não recebe fatos de capability premium (FR-033).
app.get('/api/prospects/:id/enrichment', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const plan = await getOrgPlan(orgId);
    const prospect = await prisma.prospect.findFirst({ where: { id: req.params.id, orgId } });
    if (!prospect) return res.status(404).json({ success: false, error: 'Prospect not found' });
    const data = await enrichmentManager.getProspectFacts(prospect.id, orgId);
    const masked = enrichmentCapabilities.filterFactsForPlan(data, plan);
    res.json({ success: true, data: masked });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// GET /api/prospects/:id/addresses — endereços do lead deduplicados e
// geocodificados (feature 002: Perfil Completo do Lead Enriquecido). Escopo
// por organização (404 cross-tenant); masking por plano feito no
// geocoding.collectLeadAddresses (trial: só resumo cidade/UF).
app.get('/api/prospects/:id/addresses', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const prospect = await prisma.prospect.findFirst({ where: { id: req.params.id, orgId } });
    if (!prospect) return res.status(404).json({ success: false, error: 'Prospect not found' });
    const plan = await getOrgPlan(orgId);

    // Endereços capturados no grafo (nós ADDRESS) — premium apenas; falha da
    // fonte do grafo degrada sem quebrar a resposta.
    let graphAddressLabels = [];
    if (plan === 'premium' && prospect.cnpj && enrichmentGraph.isConfigured()) {
      try {
        const graph = await enrichmentGraph.fetchCompanyGraph(prospect.cnpj);
        graphAddressLabels = (graph.data?.nodes || [])
          .filter((n) => n && n.type === 'ADDRESS' && n.label)
          .map((n) => n.label);
      } catch (err) {
        console.error('[addresses] grafo indisponível para endereços capturados:', err.message);
      }
    }

    const body = await geocoding.collectLeadAddresses({
      prospect,
      plan,
      prisma,
      fetchImpl: fetch,
      graphAddressLabels,
    });
    res.json({ success: true, ...body });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    console.error('[addresses] erro ao montar endereços do lead:', error.message);
    res.status(status).json({ success: false, error: error.message });
  }
});

// PUT /api/prospects/:id - Update prospect
// ============================================================================
// PIPELINE — regras de transição de estágio (kanban)
// ============================================================================
// Fonte da verdade: pipeline-transitions.js (módulo puro, testes em
// test/pipeline-transitions.test.js). Resumo (feature 005):
//   - "Novas oportunidades" (lead) NÃO EXISTE MAIS: entradas legadas são
//     normalizadas para 'prospect' (scripts/backfill-lead-status.js migra o
//     banco).
//   - "Em Qualificação" (prospect) segue sendo o estágio do enriquecimento;
//     ao CONCLUIR, premium avança para "Análise profunda" (deep_analysis) e
//     demais planos para "Prontas para contato" (qualified) — ver
//     statusAfterEnrichment.
//   - deep_analysis/qualified a partir de prospect exigem enriquecimento
//     concluído.
//   - Nenhum movimento manual saindo de deep_analysis enquanto a análise de
//     IA está em execução (ANALYSIS_RUNNING); concluída, o humano pode
//     avançar mesmo com veredito negativo (override registrado pela IA).
//   - discarded (Descartados) é destino final: só restaura para
//     deep_analysis (reanálise); qualified/closed → prospect segue
//     sempre bloqueado.

/**
 * Delega as regras ao módulo puro. Retorna null quando permitida ou
 * { code, message } com o motivo do bloqueio.
 */
function stageTransitionError(previousStatus, nextStatus, prospect) {
  const result = pipelineTransitions.validateTransition(previousStatus, nextStatus, prospect);
  return result.ok ? null : { code: result.code, message: result.message };
}

/**
 * Roteador único de enriquecimento, com gating por plano:
 * - Lead SEM CNPJ → lead-enrichment (resolve o CNPJ; premium recebe deep
 *   enrich com PDL/jurídico/notícias/logo, trial só o básico).
 * - PREMIUM → esteira profunda (worker NATS; fallback BrasilAPI).
 * - TRIAL → básico: firmografia oficial BrasilAPI apenas.
 */
async function dispatchEnrichmentForPlan(prisma, prospect) {
  // ── Motor v2 (specs/001-distributed-enrichment): rollout gradual por flag +
  // allowlist de organizações (research R11). Qualquer falha do motor cai no
  // fluxo legado — o enriquecimento nunca deixa de disparar por causa do v2.
  if (enrichmentConfig.isEnabledForOrg(prospect.orgId)) {
    try {
      await enrichmentManager.dispatchForProspect(prospect, { trigger: 'api' });
      return prisma.prospect.update({
        where: { id: prospect.id },
        data: { enrichmentStatus: 'pending', enrichmentSource: 'enrichment.engine.v2', enrichmentError: null },
      });
    } catch (err) {
      if (err.code === 'ENRICHMENT_QUOTA_EXCEEDED') { err.status = 429; throw err; }
      console.error(`[enrichment] motor v2 indisponível (${err.message}); usando fluxo legado`);
    }
  }
  if (!prospect.cnpj && leadEnrichment.enabled()) {
    return leadEnrichment.requestLeadEnrichment(prisma, prospect);
  }
  const orgPlan = await getOrgPlan(prospect.orgId);
  if (orgPlan !== 'premium') {
    return enrichProspectWithCnpj(prisma, prospect);
  }
  if (natsEnrichment.isNatsEnabled()) {
    const eventId = await natsEnrichment.requestEnrichment(prisma, prospect);
    if (eventId) {
      const marked = await prisma.prospect.update({
        where: { id: prospect.id },
        data: { enrichmentStatus: 'pending', enrichmentSource: 'nats.enrichment', enrichmentError: null },
      });
      hydrateFirmographics(prisma, marked).catch((err) =>
        console.error(`[enrichment] erro ao hidratar firmografia ${prospect.id}:`, err.message)
      );
      return marked;
    }
  }
  return enrichProspectWithCnpj(prisma, prospect);
}

/**
 * Dispara a esteira de enriquecimento de um prospect que acabou de entrar em
 * "Em Qualificação" (com gating por plano — ver dispatchEnrichmentForPlan).
 */
async function triggerQualificationEnrichment(prisma, prospect) {
  return dispatchEnrichmentForPlan(prisma, prospect);
}

/**
 * RECONCILIAÇÃO DE ENRIQUECIMENTO NO BOOT
 * ---------------------------------------------------------------------------
 * Jobs de enriquecimento rodam em memória (fila _inFlight do lead-enrichment e
 * pedidos NATS) e não são persistidos de forma transacional: se o pod reiniciar
 * no meio do processamento, os prospects ficam presos em `enrichmentStatus =
 * 'pending'` para sempre (não há retomada automática).
 *
 * Este passo varre os prospects `pending` no startup e re-despacha cada um pelo
 * roteador canônico `dispatchEnrichmentForPlan` (que respeita o gating por
 * plano: sem CNPJ → lead-enrichment; premium → NATS; trial → BrasilAPI).
 *
 * É fire-and-forget: não bloqueia o boot e não quebra caso o NATS esteja fora.
 * Limitado por RECONCILE_PENDING_ON_BOOT (bool) e RECONCILE_PENDING_LIMIT.
 */
async function resumePendingEnrichments(prisma, opts = {}) {
  const limit = opts.limit != null ? opts.limit : (Number(process.env.RECONCILE_PENDING_LIMIT) || 100);
  if (process.env.RECONCILE_PENDING_ON_BOOT === 'false') {
    console.log('[reconcile] retomada de pendentes desabilitada (RECONCILE_PENDING_ON_BOOT=false)');
    return { disabled: true, reconciled: 0, remaining: 0 };
  }
  try {
    const pending = await prisma.prospect.findMany({
      where: { enrichmentStatus: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    if (pending.length === 0) {
      console.log('[reconcile] nenhum prospect pendente para retomar.');
      return { reconciled: 0, remaining: 0 };
    }
    console.log(`[reconcile] retomando ${pending.length} prospect(s) pendente(s) no boot...`);
    // Sequencial com pausa curta para não martelar RFB/SearXNG/NATS de uma vez.
    for (const prospect of pending) {
      try {
        await dispatchEnrichmentForPlan(prisma, prospect);
      } catch (err) {
        console.error(`[reconcile] falha ao re-despachar prospect ${prospect.id}:`, err.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const stillPending = await prisma.prospect.count({ where: { enrichmentStatus: 'pending' } });
    console.log(`[reconcile] retomada concluída para ${pending.length} prospect(s); ainda pendentes: ${stillPending}.`);
    return { reconciled: pending.length, remaining: stillPending };
  } catch (err) {
    console.error('[reconcile] erro ao retomar pendentes:', err.message);
    return { error: err.message, reconciled: 0, remaining: null };
  }
}

app.put('/api/prospects/:id', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const previous = await prisma.prospect.findFirst({ where: { id: req.params.id, orgId } });
    if (!previous) return res.status(404).json({ success: false, error: 'Prospect not found' });
    const plan = await getOrgPlan(orgId);

    const body = req.body || {};

    // CNPJ: normaliza para dígitos (vazio → null) e valida DV. Preencher o
    // CNPJ de um lead importado sem identificador é a "formatura" — combinado
    // com a mudança de estágio abaixo, dispara a esteira de enriquecimento.
    let effectiveCnpj = previous.cnpj;
    if (body.cnpj !== undefined) {
      const digits = String(body.cnpj || '').replace(/\D/g, '');
      if (!digits) {
        body.cnpj = null;
        body.taxIdType = null;
        effectiveCnpj = null;
      } else {
        if (digits.length !== 14 || !csvImport.isValidCnpj(digits)) {
          const err = new Error('CNPJ inválido — confira os dígitos (incluindo os verificadores).');
          err.status = 422;
          err.code = 'INVALID_CNPJ';
          throw err;
        }
        body.cnpj = digits;
        if (!body.taxIdType) body.taxIdType = 'br_cnpj';
        effectiveCnpj = digits;
      }
    }

    // Regras de transição do kanban (fonte da verdade server-side). A checagem
    // usa o CNPJ EFETIVO pós-update: "informar CNPJ + mover para Em
    // Qualificação" na mesma requisição é permitido. Entradas do estágio
    // removido ('lead') são normalizadas para 'prospect' (feature 005).
    if (body.status !== undefined) {
      body.status = pipelineTransitions.normalizeStatus(body.status);
    }
    const nextStatus = body.status;
    if (nextStatus && nextStatus !== previous.status) {
      const transitionError = stageTransitionError(previous.status, nextStatus, {
        ...previous,
        cnpj: effectiveCnpj,
      });
      if (transitionError) {
        const err = new Error(transitionError.message);
        err.status = 422;
        err.code = transitionError.code || 'STAGE_TRANSITION_BLOCKED';
        throw err;
      }
    }

    const prospect = await prisma.prospect.update({
      where: { id: req.params.id },
      // Epic 1 (FR4): searchText recalculado da LINHA FINAL (patch ∪ linha) —
      // updates parciais nunca deixam o searchText defasado.
      data: { ...body, ...withSearchText(body, previous) }
    });

    // Dispara enriquecimento quando o lead entra na esteira de "Em Qualificação"
    // (status 'prospect'), inclusive ao trocar de coluna no kanban.
    const enteredQualification =
      prospect.status === 'prospect' && (!previous || previous.status !== 'prospect');

    // Feature 005: entrada em "Análise profunda" dispara a análise de IA
    // (FR-005). Restauração de "Descartados" reexecuta substituindo a
    // análise anterior (FR-011/FR-014); demais entradas usam o gatilho
    // idempotente por enrichmentVersion.
    const enteredDeepAnalysis =
      prospect.status === 'deep_analysis' && previous.status !== 'deep_analysis';
    if (enteredDeepAnalysis) {
      const trigger = previous.status === 'discarded' ? 'manual' : 'auto';
      deepAnalysis
        .getSharedRunner(prisma)
        .enqueue(prospect, { trigger })
        .then((enqueued) => {
          if (enqueued.started) enqueued.done.catch(() => {});
        })
        .catch((err) => console.error(`[deep-analysis] gatilho falhou (lead ${prospect.id}):`, err.message));
    }

    // Override humano: avançar manualmente um lead reprovado pela IA é
    // permitido, mas fica registrado na análise vigente (FR-010/transparência).
    if (
      previous.status === 'deep_analysis' &&
      prospect.status === 'qualified' &&
      previous.verdict === 'no_contact' &&
      previous.currentDeepAnalysisId
    ) {
      prisma.deepAnalysis
        .update({ where: { id: previous.currentDeepAnalysisId }, data: { override: true } })
        .catch((err) => console.error('[deep-analysis] falha ao registrar override:', err.message));
    }

    let responseData = prospect;
    if (enteredQualification) {
      responseData = await triggerQualificationEnrichment(prisma, prospect);
    }

    res.json({ success: true, data: redactProspectForPlan(responseData, plan) });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ success: false, error: 'Prospect not found' });
    }
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
});

// DELETE /api/prospects/:id - Delete prospect
app.delete('/api/prospects/:id', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    // deleteMany com orgId garante que outro usuário não apague dados alheios.
    const result = await prisma.prospect.deleteMany({
      where: { id: req.params.id, orgId }
    });
    if (result.count === 0) {
      return res.status(404).json({ success: false, error: 'Prospect not found' });
    }

    res.json({ success: true, message: 'Prospect deleted' });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// POST /api/prospects/bulk - Bulk move or delete selected prospects
app.post('/api/prospects/bulk', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map((id) => String(id)).filter(Boolean)
      : [];
    const action = String(req.body?.action || '').toLowerCase();
    const status = String(req.body?.status || '');

    if (!ids.length) {
      return res.status(400).json({ success: false, error: 'Selecione ao menos um prospecto.' });
    }

    if (action === 'delete') {
      const result = await prisma.prospect.deleteMany({ where: { id: { in: ids }, orgId } });
      return res.json({ success: true, data: { count: result.count }, timestamp: new Date().toISOString() });
    }

    if (action === 'move') {
      const normalized = pipelineTransitions.normalizeStatus(status);
      if (!pipelineTransitions.PIPELINE_STATUSES.includes(normalized)) {
        return res.status(400).json({ success: false, error: 'Estágio de destino inválido.' });
      }

      // Valida a transição de cada item (mesmas regras do PUT) e move apenas
      // os permitidos — devolve `skipped` para a UI explicar o que ficou.
      const current = await prisma.prospect.findMany({
        where: { id: { in: ids }, orgId },
        select: { id: true, status: true, enrichmentStatus: true, analysisStatus: true, cnpj: true },
      });
      const blockedItem = (p) => stageTransitionError(p.status, normalized, p);
      const allowed = current.filter((p) => !blockedItem(p));
      const skipped = current.length - allowed.length;

      if (allowed.length === 0) {
        const firstBlocked = current[0];
        const reason = (firstBlocked && blockedItem(firstBlocked)) || {
          code: 'STAGE_TRANSITION_BLOCKED',
          message: 'Transição de estágio não permitida.',
        };
        return res
          .status(422)
          .json({ success: false, code: reason.code || 'STAGE_TRANSITION_BLOCKED', error: reason.message });
      }

      const result = await prisma.prospect.updateMany({
        where: { id: { in: allowed.map((p) => p.id) }, orgId },
        data: { status: normalized },
      });

      // Entrou em "Em Qualificação" via lote também dispara enriquecimento
      // (antes só o PUT disparava — card movido em lote ficava pendente
      // para sempre e, com o gate de transição, ficaria travado).
      if (normalized === 'prospect') {
        const entered = allowed.filter((p) => p.status !== 'prospect');
        for (const item of entered) {
          const fresh = await prisma.prospect.findUnique({ where: { id: item.id } });
          if (fresh) {
            triggerQualificationEnrichment(prisma, fresh).catch((err) => {
              console.error(`[bulk] erro ao enriquecer prospect ${item.id}:`, err.message);
            });
          }
        }
      }

      // Feature 005: entrada em "Análise profunda" via lote dispara a análise
      // (restauração de Descartados reexecuta; demais entradas, gatilho auto).
      if (normalized === 'deep_analysis') {
        for (const item of allowed) {
          const fresh = await prisma.prospect.findUnique({ where: { id: item.id } });
          if (!fresh) continue;
          const trigger = item.status === 'discarded' ? 'manual' : 'auto';
          deepAnalysis
            .getSharedRunner(prisma)
            .enqueue(fresh, { trigger })
            .then((enqueued) => {
              if (enqueued.started) enqueued.done.catch(() => {});
            })
            .catch((err) => console.error(`[bulk] erro ao analisar prospect ${item.id}:`, err.message));
        }
      }

      return res.json({
        success: true,
        data: { count: result.count, skipped },
        timestamp: new Date().toISOString(),
      });
    }

    return res.status(400).json({ success: false, error: 'Ação em lote inválida.' });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// POST /api/prospects/import-csv — importação de leads via CSV.
// O arquivo chega como texto no corpo; a IA (csv-import.js) entende a
// ESTRUTURA da planilha (mapeia colunas → modelo Prospect, com fallback
// heurístico), e a normalização dos valores é determinística. CNPJ é a chave
// de enriquecimento principal mas é OPCIONAL: linhas sem CNPJ (e sem chave)
// são cadastradas como 'lead' com enrichmentStatus 'unavailable' — ficam
// contactáveis e entram na esteira assim que o CNPJ for informado. Linhas com
// CNPJ entram como 'prospect' e disparam o pipeline (NATS; fallback síncrono
// BrasilAPI serializado em background no dev). A resposta traz o relatório
// completo: mapeamento usado, importados, duplicados, falhas por linha.
app.post('/api/prospects/import-csv', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
    if (!csv.trim()) {
      return res.status(400).json({ success: false, error: 'Envie o conteúdo do arquivo CSV.' });
    }
    if (csv.length > csvImport.MAX_CSV_CHARS) {
      return res.status(413).json({ success: false, error: 'Arquivo muito grande (limite de 2MB).' });
    }

    const parsed = csvImport.parseCsv(csv);
    if (!parsed.headers.length) {
      return res.status(400).json({ success: false, error: 'Não foi possível ler o cabeçalho do CSV.' });
    }
    if (!parsed.records.length) {
      return res.status(400).json({ success: false, error: 'O CSV não possui linhas de dados.' });
    }

    // Memória de mapeamento: planilhas recorrentes do cliente mapeiam igual.
    // Escolhe o mapeamento memorizado mais parecido (Jaccard ≥ limiar) e o
    // injeta como referência no prompt da IA. Falha de memória não bloqueia.
    let previous = null;
    let memoryUsed = false;
    try {
      const memories = await prisma.csvMappingMemory.findMany({
        where: { orgId },
        orderBy: { lastUsedAt: 'desc' },
        take: 20,
      });
      const match = csvImport.pickMemoryMapping(parsed.headers, memories);
      if (match) {
        previous = { headers: match.headers, mapping: match.mapping };
        memoryUsed = true;
        console.log(`[csv-import] memória de mapeamento aplicada (similaridade ${match.similarity.toFixed(2)})`);
      }
    } catch (memErr) {
      console.warn(`[csv-import] falha ao ler memória de mapeamento: ${memErr.message}`);
    }

    const { mapping, source: mappingSource, notes: mappingNotes, rejected } = await csvImport.resolveMapping(
      parsed.headers,
      parsed.records,
      { previous }
    );
    // Rastreabilidade: sem esta linha, um mapeamento errado do LLM é
    // indistinguível de planilha malformada no diagnóstico de produção.
    console.log(
      `[csv-import] mapeamento (${mappingSource}): ${JSON.stringify(mapping)}` +
      (rejected.length ? ` | rejeitados: ${JSON.stringify(rejected)}` : '')
    );

    // Monta os registros normalizados. Numeração da linha segue a planilha
    // (cabeçalho = linha 1), para o usuário achar o problema no arquivo.
    // Dedup dentro do arquivo: CNPJ para quem tem; importKey (e-mail ou
    // nome+cidade) para leads sem CNPJ.
    const staged = [];
    const failures = [];
    const warnings = [];
    const seenCnpjs = new Set();
    const seenKeys = new Set();
    parsed.records.forEach((row, idx) => {
      const rowNumber = idx + 2;
      const { record, issues } = csvImport.buildRecord(row, mapping);
      if (!record) {
        failures.push({ row: rowNumber, cnpj: null, reason: issues[0] || 'Linha inválida' });
        return;
      }
      if (record.cnpj && seenCnpjs.has(record.cnpj)) {
        failures.push({ row: rowNumber, cnpj: record.cnpj, reason: 'CNPJ duplicado no arquivo' });
        return;
      }
      const importKey = csvImport.computeImportKey(record);
      if (!record.cnpj && importKey && seenKeys.has(importKey)) {
        failures.push({ row: rowNumber, cnpj: null, reason: 'Lead duplicado no arquivo (mesmo nome/e-mail)' });
        return;
      }
      if (record.cnpj) seenCnpjs.add(record.cnpj);
      if (importKey) seenKeys.add(importKey);
      if (issues.length) {
        warnings.push({ row: rowNumber, cnpj: record.cnpj, messages: issues });
      }
      staged.push({ ...record, importKey });
    });

    const plan = await getOrgPlan(orgId);
    let importedCount = 0;
    let importedWithoutCnpj = 0;
    let alreadyExists = 0;
    let limitReached = false;
    let limitMessage = '';

    // Dev sem NATS: serializa os fallbacks BrasilAPI em background para a
    // resposta HTTP voltar rápido sem martelar o serviço público.
    let enrichChain = Promise.resolve();

    for (const record of staged) {
      try {
        // Duplicidade dentro do org (mesma política do import de discovery):
        // por CNPJ quando existe; por importKey para leads sem identificador.
        const existing = record.cnpj
          ? await prisma.prospect.findFirst({ where: { cnpj: record.cnpj, orgId } })
          : await prisma.prospect.findFirst({ where: { importKey: record.importKey, orgId } });
        if (existing) {
          alreadyExists++;
          continue;
        }
        await assertCanCaptureLead(orgId);

        let prospect = await prisma.prospect.create({
          data: {
            cnpj: record.cnpj,
            taxIdType: record.taxIdType,
            domain: record.domain,
            importKey: record.importKey,
            companyName: record.companyName,
            tradeName: record.tradeName,
            contactName: record.contactName,
            industry: record.industry,
            city: record.city,
            state: record.state,
            cnpjEmail: record.cnpjEmail,
            ...(record.cnpjPhones ? { cnpjPhones: record.cnpjPhones } : {}),
            employees: record.employees,
            revenueEstimate: record.revenueEstimate,
            // Epic 1 (FR4): import CSV já nasce com searchText normalizado —
            // a audiência descrita no chat casa desde o primeiro dia.
            ...withSearchText({
              industry: record.industry,
              companyName: record.companyName,
              tradeName: record.tradeName,
            }),
            // Feature 005 (FR-002): todo lead importado entra em "Em
            // Qualificação" — o estágio 'lead' não existe mais. Sem CNPJ,
            // fica com enrichmentStatus 'unavailable' até a chave ser
            // informada ( PUT + CNPJ dispara a esteira).
            status: 'prospect',
            opportunityScore: 60,
            enrichmentStatus: record.cnpj ? 'pending' : 'unavailable',
            ...(record.cnpj ? {} : { enrichmentSource: 'csv_import' }),
            orgId,
          },
        });
        importedCount++;
        if (!record.cnpj) importedWithoutCnpj++;

        // Esteira roteada por plano (NATS premium / BrasilAPI trial /
        // resolução de CNPJ para leads sem chave) — serializada para não
        // martelar os serviços externos.
        enrichChain = enrichChain
          .then(() => dispatchEnrichmentForPlan(prisma, prospect))
          .catch((err) =>
            console.error(`[csv-import] erro na esteira de enriquecimento ${prospect.id}:`, err.message)
          );
      } catch (error) {
        if (error.code === 'PLAN_LIMIT_REACHED' || error.status === 403) {
          limitReached = true;
          limitMessage = error.message;
          break;
        }
        // CNPJ já cadastrado em outro org (unicidade por org não conflita aqui;
        // P2002 agora só ocorre na corrida entre imports simultâneos).
        if (error.code === 'P2002') {
          alreadyExists++;
          continue;
        }
        console.error(`[csv-import] falha ao importar linha (cnpj=${record.cnpj}):`, error.message);
        failures.push({ row: null, cnpj: record.cnpj, reason: error.message });
      }
    }

    // Memoriza o mapeamento final aceito (cabeçalhos + mapping; nunca valores
    // das linhas) para as próximas planilhas do org. Best-effort.
    try {
      const signature = csvImport.computeHeaderSignature(parsed.headers);
      await prisma.csvMappingMemory.upsert({
        where: { orgId_headerSignature: { orgId, headerSignature: signature } },
        create: {
          orgId,
          headerSignature: signature,
          headers: parsed.headers,
          mapping,
        },
        update: {
          headers: parsed.headers,
          mapping,
          lastUsedAt: new Date(),
          useCount: { increment: 1 },
        },
      });
      // Teto de memórias por org (planilhas antigas saem, as recentes ficam).
      const old = await prisma.csvMappingMemory.findMany({
        where: { orgId },
        orderBy: { lastUsedAt: 'desc' },
        skip: 20,
        select: { id: true },
      });
      if (old.length) {
        await prisma.csvMappingMemory.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
      }
    } catch (memErr) {
      console.warn(`[csv-import] falha ao memorizar mapeamento: ${memErr.message}`);
    }

    res.json({
      success: true,
      data: {
        requested: parsed.records.length,
        delimiter: parsed.delimiter,
        truncated: parsed.truncated,
        maxRows: csvImport.MAX_IMPORT_ROWS,
        mapping,
        mappingSource,
        mappingNotes,
        mappingRejected: rejected,
        memoryUsed,
        importedCount,
        importedWithoutCnpj,
        alreadyExists,
        failures,
        warnings,
        limitReached,
        limitMessage,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// GET /api/analytics/pipeline - Pipeline metrics
app.get('/api/analytics/pipeline', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const prospects = await prisma.prospect.findMany({
      where: { orgId },
      select: { status: true }
    });

    const qualified = prospects.filter(p => p.status === 'qualified').length;
    const prospect_count = prospects.filter(p => p.status === 'prospect').length;
    // Feature 005: o estágio 'lead' foi removido; os contadores refletem o
    // pipeline novo (Análise profunda e Descartados).
    const deep_analysis = prospects.filter(p => p.status === 'deep_analysis').length;
    const discarded = prospects.filter(p => p.status === 'discarded').length;
    const total = prospects.length;

    res.json({
      success: true,
      data: {
        total_prospects: total,
        qualified,
        prospects: prospect_count,
        deep_analysis,
        discarded,
        qualification_rate: total > 0 ? (qualified / total).toFixed(2) : '0',
        closure_rate: total > 0 ? (qualified / total * 0.85).toFixed(2) : '0'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/analytics/operational — métricas operacionais reais do funil de
// contato (substitui as projeções de receita fictícias do dashboard):
//   - leads sem nenhum contato real (contactedChannels vazio)
//   - leads criados no mês corrente
//   - leads contactados por canal (badge "Contatado" gravado no envio real)
//   - leads que responderam (email: OutreachContact REPLIED/replyCount>0;
//     WhatsApp: conversa com lastInboundMessageAt — união por prospectId)
//   - conversas de WhatsApp abertas (ACTIVE + HUMAN_HANDOFF)
app.get('/api/analytics/operational', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const prospects = await prisma.prospect.findMany({
      where: { orgId },
      select: { contactedChannels: true, createdAt: true }
    });

    const channelList = (raw) => {
      if (Array.isArray(raw)) return raw;
      try {
        const parsed = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };

    const contacted = prospects.filter((p) => channelList(p.contactedChannels).length > 0);
    const contactedEmail = prospects.filter((p) => channelList(p.contactedChannels).includes('email'));
    const contactedWhatsapp = prospects.filter((p) => channelList(p.contactedChannels).includes('whatsapp'));
    const contactedTotal = contacted.length;

    const [emailReplies, waInbound, waActive, waTotal, emailSent, waSent] = await Promise.all([
      prisma.outreachContact.findMany({
        where: {
          campaign: { tenantId: orgId },
          OR: [{ replyCount: { gt: 0 } }, { status: 'REPLIED' }]
        },
        select: { prospectId: true },
        distinct: ['prospectId']
      }),
      prisma.whatsAppConversation.findMany({
        where: { orgId, lastInboundMessageAt: { not: null } },
        select: { prospectId: true }
      }),
      prisma.whatsAppConversation.count({
        where: { orgId, status: { in: ['ACTIVE', 'HUMAN_HANDOFF'] } }
      }),
      prisma.whatsAppConversation.count({ where: { orgId } }),
      prisma.outreachMessage.count({
        where: { status: 'SENT', contact: { campaign: { tenantId: orgId } } }
      }),
      prisma.whatsAppMessage.count({
        // Só origem CAMPANHA (pente-fino 2026-10-09): inbox manual e
        // reengagement inflavam "enviados WhatsApp" vs o funil de e-mail.
        where: { orgId, direction: 'OUTBOUND', status: { in: ['SENT', 'DELIVERED', 'READ'] }, campaignContactId: { not: null } }
      })
    ]);

    const repliedByEmail = new Set(emailReplies.map((r) => r.prospectId).filter(Boolean));
    const repliedByWhatsapp = new Set(waInbound.map((c) => c.prospectId).filter(Boolean));
    const repliedAll = new Set([...repliedByEmail, ...repliedByWhatsapp]);

    res.json({
      success: true,
      data: {
        leads_total: prospects.length,
        leads_uncontacted: prospects.length - contactedTotal,
        leads_new_this_month: prospects.filter((p) => p.createdAt >= monthStart).length,
        contacted_total: contactedTotal,
        contacted_email: contactedEmail.length,
        contacted_whatsapp: contactedWhatsapp.length,
        leads_replied: repliedAll.size,
        replied_email: repliedByEmail.size,
        replied_whatsapp: repliedByWhatsapp.size,
        response_rate: contactedTotal > 0 ? Number((repliedAll.size / contactedTotal).toFixed(4)) : 0,
        whatsapp_conversations_active: waActive,
        whatsapp_conversations_total: waTotal,
        dispatches_email_sent: emailSent,
        dispatches_whatsapp_sent: waSent
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// GET /api/analytics/forecast - Revenue forecast
app.get('/api/analytics/forecast', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const qualified = await prisma.prospect.count({
      where: { status: 'qualified', orgId }
    });

    const avgDeal = 15000;
    const thisMonth = qualified * avgDeal;

    res.json({
      success: true,
      data: {
        this_month: thisMonth,
        next_month: Math.round(thisMonth * 1.15),
        q3_projection: Math.round(thisMonth * 2.5),
        currency: 'BRL'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// GET /api/analytics/breakdown - Status breakdown
app.get('/api/analytics/breakdown', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const breakdown = await prisma.prospect.groupBy({
      by: ['status'],
      where: { orgId },
      _count: true,
      _avg: { opportunityScore: true }
    });

    const formatted = breakdown.map(item => ({
      status: item.status,
      count: item._count,
      avg_score: Math.round(item._avg.opportunityScore || 0)
    }));

    res.json({
      success: true,
      data: { breakdown: formatted },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// ============================================================================
// INTELLIGENCE — Credit risk & qualification
// ============================================================================
// Estes endpoints avaliam um lead a partir de dados reais já persistidos no
// banco (score de oportunidade, porte, receita, idade/tempo de atividade e
// estado do enriquecimento). Quando o lead ainda não foi enriquecido, tentamos
// completar a firmografia via BrasilAPI/MCP para não punir leads com dados
// incompletos. O resultado também é persistido (creditRiskScore/Level) para
// histórico e reuso na lista de leads.

function normalizeCnpjInput(value) {
  return String(value || '').replace(/\D/g, '');
}

function scoreCompanyAge(openedAt, now = new Date()) {
  if (!openedAt) return { years: null, points: 0 };
  const opened = new Date(openedAt);
  if (Number.isNaN(opened.getTime())) return { years: null, points: 0 };
  const years = (now.getTime() - opened.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  if (years < 0) return { years: 0, points: 0 };
  // Mais tempo de atividade = menor risco de calote/descontinuidade.
  if (years >= 10) return { years, points: 30 };
  if (years >= 5) return { years, points: 24 };
  if (years >= 2) return { years, points: 16 };
  if (years >= 1) return { years, points: 8 };
  return { years, points: 2 };
}

function scoreCompanySize(employees) {
  const count = Number(employees) || 0;
  if (count >= 500) return 15;
  if (count >= 100) return 12;
  if (count >= 20) return 8;
  if (count >= 5) return 4;
  return 0;
}

function scoreRevenue(revenueEstimate) {
  const revenue = Number(revenueEstimate) || 0;
  if (revenue >= 5_000_000) return 20;
  if (revenue >= 1_000_000) return 15;
  if (revenue >= 250_000) return 10;
  if (revenue >= 50_000) return 5;
  return 0;
}

// opportunityScore já varia de 0 a 100 e reflete o potencial comercial do lead.
function scoreOpportunity(opportunityScore) {
  const score = Number(opportunityScore) || 0;
  return Math.round(score * 0.35); // até 35 pontos
}

function deriveCreditRiskScore(prospect) {
  let score = 50; // linha de base neutra

  score += scoreOpportunity(prospect.opportunityScore);
  score += scoreCompanySize(prospect.employees);
  score += scoreRevenue(prospect.revenueEstimate);
  score += scoreCompanyAge(prospect.cnpjOpenedAt).points;

  // Enriquecido = dados verificados em fonte oficial, menor incerteza.
  if (prospect.enrichmentStatus === 'enriched') score += 10;
  if (prospect.cnpjEmail) score += 5;
  if (Array.isArray(prospect.cnpjPhones) && prospect.cnpjPhones.length) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function creditRiskLevelFromScore(score) {
  if (score >= 70) return 'low';
  if (score >= 40) return 'medium';
  return 'high';
}

function creditRiskFactors(prospect, ageInfo) {
  const factors = [];
  if (ageInfo.years != null) {
    if (ageInfo.years >= 10) factors.push('company_longevity');
    else if (ageInfo.years >= 2) factors.push('company_age');
    else factors.push('company_recent');
  } else {
    factors.push('company_age_unknown');
  }
  if (prospect.cnpjEmail) factors.push('corporate_email_present');
  if (Array.isArray(prospect.cnpjPhones) && prospect.cnpjPhones.length) factors.push('phone_present');
  if (prospect.enrichmentStatus === 'enriched') factors.push('officially_enriched');
  if ((Number(prospect.employees) || 0) >= 100) factors.push('company_size');
  if ((Number(prospect.revenueEstimate) || 0) >= 1_000_000) factors.push('revenue_potential');
  if (!factors.length) factors.push('insufficient_data');
  return factors;
}

async function findOrgProspectByCnpj(prisma, orgId, cnpj) {
  const normalized = normalizeCnpjInput(cnpj);
  if (!normalized) return null;
  return prisma.prospect.findFirst({ where: { cnpj: normalized, orgId } });
}

// POST /api/intelligence/credit-risk - avalia a saúde financeira/comercial de um lead.
app.post('/api/intelligence/credit-risk', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const { cnpj } = req.body || {};
    const normalized = normalizeCnpjInput(cnpj);
    if (!normalized) {
      return res.status(400).json({ success: false, error: 'CNPJ é obrigatório' });
    }

    let prospect = await findOrgProspectByCnpj(prisma, orgId, normalized);

    // Se existe mas ainda não foi enriquecido, enriquece no lugar para não punir
    // leads com dados incompletos (mesmo caminho usado no import de descoberta).
    if (prospect && prospect.enrichmentStatus !== 'enriched') {
      try {
        prospect = await enrichProspectWithCnpj(prisma, prospect);
      } catch (_err) {
        // mantém prospect como está; a pontuação usa os dados disponíveis
      }
    }

    if (!prospect) {
      return res.status(404).json({
        success: false,
        error: 'Lead não encontrado. Importe-o em "Descobrir leads" ou informe um CNPJ válido.',
      });
    }

    const score = deriveCreditRiskScore(prospect);
    const level = creditRiskLevelFromScore(score);
    const ageInfo = scoreCompanyAge(prospect.cnpjOpenedAt);
    const risk_assessment = {
      score,
      level,
      factors: creditRiskFactors(prospect, ageInfo),
      ageYears: ageInfo.years ? Math.round(ageInfo.years * 10) / 10 : null,
      enrichmentStatus: prospect.enrichmentStatus,
    };

    // Persiste o resultado para histórico/reuso.
    await prisma.prospect.update({
      where: { id: prospect.id },
      data: { creditRiskScore: score, creditRiskLevel: level },
    }).catch(() => {});

    res.json({
      success: true,
      cnpj: normalized,
      risk_assessment,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// POST /api/intelligence/qualify - qualifica um lead pelo nome/razão social.
app.post('/api/intelligence/qualify', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const companyName = String((req.body || {}).company_name || '').trim();
    if (!companyName) {
      return res.status(400).json({ success: false, error: 'Nome do lead é obrigatório' });
    }

    // Busca exata e, em seguida, por correspondência parcial, dentro da organização.
    let prospect = await prisma.prospect.findFirst({
      where: { orgId, companyName: { equals: companyName, mode: 'insensitive' } },
    });
    if (!prospect) {
      prospect = await prisma.prospect.findFirst({
        where: {
          orgId,
          OR: [
            { companyName: { contains: companyName, mode: 'insensitive' } },
            { tradeName: { contains: companyName, mode: 'insensitive' } },
          ],
        },
      });
    }

    if (!prospect) {
      return res.status(404).json({
        success: false,
        error: 'Lead não encontrado na sua organização.',
      });
    }

    const score = Math.max(0, Math.min(100, Number(prospect.opportunityScore) || 0));
    // Feature 005 (FR-001): banda 'lead' renomeada para 'initial' — não
    // referencia mais o estágio removido. (Leitura de 'lead' segue aceita
    // no client por compatibilidade.)
    const level =
      score >= 70 ? 'qualified' :
      score >= 40 ? 'prospect' : 'initial';
    // Confiança reflete o quão completo é o dado: enriquecido oficialmente dá mais
    // confiança do que um lead com dados parciais/mockados.
    const confidence =
      prospect.enrichmentStatus === 'enriched' ? 0.9 :
      prospect.cnpjEmail || prospect.cnpjLegalNature ? 0.65 : 0.5;

    const qualification = {
      score,
      level,
      confidence: confidence.toFixed(2),
      companyName: prospect.companyName,
      cnpj: prospect.cnpj,
      enrichmentStatus: prospect.enrichmentStatus,
    };

    res.json({
      success: true,
      company: companyName,
      qualification,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// GET /api/enrichment/contacts - List enriched contacts, partners and phones by date range
app.get('/api/enrichment/contacts', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const contacts = await listEnrichedProspects(prisma, {
      from: req.query.from,
      to: req.query.to,
      status: req.query.status,
      orgId,
    });

    const plan = await getOrgPlan(orgId);
    const data = redactProspectListForPlan(contacts, plan);

    res.json({
      success: true,
      data,
      count: contacts.length,
      filters: {
        from: req.query.from || null,
        to: req.query.to || null,
        status: req.query.status || 'all'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// POST /api/enrichment/extract - Enrich CNPJs already present in PostgreSQL/MCP by createdAt time range
app.post('/api/enrichment/extract', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const { from, to, refresh = false, limit = 25 } = req.body || {};
    const where = { orgId };

    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    if (!refresh) {
      where.OR = [
        { enrichmentStatus: 'pending' },
        { enrichmentStatus: 'error' },
        { enrichmentStatus: 'unavailable' },
        { enrichedAt: null }
      ];
    }

    const prospects = await prisma.prospect.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(limit) || 25, 50),
    });

    const enriched = [];
    for (const prospect of prospects) {
      // Sequential by design to avoid hammering the public CNPJ service.
      enriched.push(await enrichProspectWithCnpj(prisma, prospect));
    }

    const plan = await getOrgPlan(orgId);
    res.json({
      success: true,
      processed: enriched.length,
      data: redactProspectListForPlan(enriched.map(formatEnrichedProspect), plan),
      filters: { from: from || null, to: to || null, refresh: Boolean(refresh) },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/system/enrichment-sweeper/run - Dispara um ciclo do sweeper de
// tasks PARKED (feature 006). Interno, protegido por X-Internal-Token.
app.post('/api/system/enrichment-sweeper/run', async (req, res) => {
  try {
    const expected = process.env.INTERNAL_RECONCILE_TOKEN;
    const provided = req.get('X-Internal-Token');
    if (!expected || provided !== expected) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }
    const limit = Number(req.body && req.body.limit) || 100;
    const result = await getSweeper().runOnce({ limit });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/system/enrichment/parked - Inspeção de tasks PARKED (operação).
app.get('/api/system/enrichment/parked', async (req, res) => {
  try {
    const expected = process.env.INTERNAL_RECONCILE_TOKEN;
    const provided = req.get('X-Internal-Token');
    if (!expected || provided !== expected) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }
    const limit = Number(req.query.limit) || 50;
    const rows = await prisma.enrichmentTask.findMany({
      where: { status: 'PARKED' },
      orderBy: { parkedAt: 'asc' },
      take: limit,
      select: {
        id: true, orgId: true, capability: true, provider: true,
        parkedAt: true, nextAttemptAt: true, parkCycles: true, lastError: true,
      },
    });
    res.json({ success: true, data: rows, count: rows.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/system/reconcile-pending - Retoma prospects presos em 'pending'
// ---------------------------------------------------------------------------
// Endpoint INTERNO, consumido pelo SRE (guardiao-check.sh) e por ferramentas
// de operação. Protegido por header X-Internal-Token (env INTERNAL_RECONCILE_TOKEN).
// Fire-and-forget: dispara o dispatch canônico para os pending e responde com
// o quanto foi re-despachado. Não bloqueia o request do usuário.
app.post('/api/system/reconcile-pending', async (req, res) => {
  try {
    const expected = process.env.INTERNAL_RECONCILE_TOKEN;
    const provided = req.get('X-Internal-Token');
    if (!expected || provided !== expected) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }
    const limit = Number(req.body && req.body.limit) || (Number(process.env.RECONCILE_PENDING_LIMIT) || 100);
    // Dispara em background para não bloquear a resposta do guardião.
    resumePendingEnrichments(prisma, { limit }).then((result) => {
      console.log(`[reconcile] endpoint disparado por SRE:`, result);
    }).catch((err) => {
      console.error('[reconcile] endpoint SRE falhou:', err.message);
    });
    // Feature 005: também re-despacha análises profundas presas (running/
    // not_started) — mesmo gatilho do boot, no padrão fire-and-forget.
    let deepAnalysisTriggered = false;
    try {
      deepAnalysis.getSharedRunner(prisma).reconcile({ limit }).then((result) => {
        console.log(`[reconcile] deep-analysis disparado por SRE:`, result);
      }).catch((err) => {
        console.error('[reconcile] deep-analysis SRE falhou:', err.message);
      });
      deepAnalysisTriggered = true;
    } catch (err) {
      console.error('[reconcile] deep-analysis dispatch falhou:', err.message);
    }
    res.json({ success: true, message: 'reconciliação de pendentes disparada', limit, deepAnalysis: deepAnalysisTriggered ? 'triggered' : 'failed' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// DISCOVERY (after onboarding) - fetch real companies by CNAE via MCP-CNPJ
// ============================================================================

// Extrai, de uma string de localização, o estado (UF) e a cidade. Aceita:
//   "São Paulo (SP)"  -> { state: "SP", city: "São Paulo" }
//   "São Paulo, SP"   -> { state: "SP", city: "São Paulo" }
//   "SP"              -> { state: "SP", city: null }
//   "São Paulo"       -> { state: null, city: "São Paulo" }
function parseLocation(location) {
  const raw = String(location || '').trim();
  if (!raw) return { state: undefined, city: undefined };

  let state;
  let withoutUf = raw;

  const ufMatch = raw.match(/\(([A-Za-z]{2})\)/);
  if (ufMatch) {
    state = ufMatch[1].toUpperCase();
    withoutUf = raw.replace(/\([A-Za-z]{2}\)/i, '').trim();
  } else {
    const comma = raw.match(/,\s*([A-Za-z]{2})\s*$/);
    if (comma) {
      state = comma[1].toUpperCase();
      withoutUf = raw.replace(/,\s*[A-Za-z]{2}\s*$/i, '').trim();
    }
  }

  // Uma UF sozinha (ex.: "SP") é filtro de estado, não de cidade — o guard
  // antigo (`!withoutUf && ...`) nunca disparava para UF solta (nada era
  // removido da string) e "SP" acabava filtrando city_name ILIKE '%SP%'.
  let city;
  if (/^[A-Za-z]{2}$/.test(raw)) {
    city = undefined;
    if (!state) state = raw.toUpperCase();
  } else {
    city = withoutUf || undefined;
  }

  return { state, city };
}

// Remove diacríticos (ã→a, ç→c). O dataset do MCP-CNPJ normaliza os nomes de
// cidade SEM acento ("SAO PAULO", "FLORIANOPOLIS") e o ILIKE do Postgres não
// dobra acentos — filtrar por "São Paulo" (label acentuado que o autocomplete
// do onboarding grava) retornava 0 empresas e zerava a descoberta inteira.
function stripAccents(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Deterministic helpers so the discovery listing can rotate results per "seed"
// (a new seed on "Buscar novamente" reveals a different order) while keeping a
// page stable within the same seed. The MCP-CNPJ source has no offset support,
// so we fetch a wide pool once, cache it briefly, and page through it locally.
function hashSeed(input) {
  let h = 2166136261 >>> 0;
  const str = String(input || '');
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithSeed(array, seed) {
  const arr = array.slice();
  const rand = mulberry32(hashSeed(seed));
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

// Janela rotativa determinística: mesmos (arr, seed) → mesmos itens, seeds
// diferentes exploram outras partes do array. Usada para distribuir as
// consultas de descoberta entre TODOS os CNAEs do perfil a cada busca.
function rotateBySeed(array, seed, count) {
  if (!Array.isArray(array) || array.length <= count) return (array || []).slice();
  const start = hashSeed(seed) % array.length;
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(array[(start + i) % array.length]);
  return out;
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

// In-memory pool cache: same criteria + seed within TTL reuses the fetched MCP
// window, so paging through results does not hit the external server per page.
const discoveryPoolCache = new Map();
const DISCOVERY_POOL_TTL_MS = 10 * 60 * 1000;

// GET /api/discovery/profile - onboarding criteria that drive discovery
app.get('/api/discovery/profile', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) {
      return res.json({
        success: true,
        data: { onboardingCompleted: false, targetCnaes: [], targetSegments: [], targetLocations: [], companyStatuses: ['active'], targetSizes: [] },
        timestamp: new Date().toISOString(),
      });
    }
    const settings = await prisma.commercialSettings.findUnique({ where: { orgId: org.id } });
    const profile = settings
      ? {
          onboardingCompleted: settings.onboardingCompleted,
          targetCnaes: Array.isArray(settings.targetCnaes) ? settings.targetCnaes : [],
          targetSegments: Array.isArray(settings.targetSegments) ? settings.targetSegments : [],
          targetLocations: Array.isArray(settings.targetLocations) ? settings.targetLocations : [],
          companyStatuses: Array.isArray(settings.companyStatuses) && settings.companyStatuses.length ? settings.companyStatuses : ['active'],
          targetSizes: Array.isArray(settings.targetSizes) ? settings.targetSizes : [],
        }
      : { onboardingCompleted: false, targetCnaes: [], targetSegments: [], targetLocations: [], companyStatuses: ['active'], targetSizes: [] };

    res.json({ success: true, data: profile, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/discovery/candidates - search real companies by CNAE/segment/location
// Supports pagination (?page=&pageSize=) and seeded rotation (?seed=) so the
// listing can browse through the full pool of discovered leads. Companies that
// were already added to the lead list are always excluded from the results.
app.get('/api/discovery/candidates', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(parseInt(req.query.pageSize, 10) || Number(req.query.limit) || 12, 25));
    const seed = req.query.seed ? String(req.query.seed).slice(0, 64) : 'default';
    // CNAEs vindo da UI (multi-valor: ?cnaes=6201501,6209100) ou valor único
    // (?cnae=). Normalizamos para dígitos puros — o formato IBGE de 7 dígitos
    // (Subclasse) é o mesmo que a taxonomia do onboarding armazena e o único
    // que o MCP-CNPJ indexa ("6201501" retorna; "6201-5/01" não).
    const parseCnaeCodes = (raw) =>
      String(raw || '')
        .split(',')
        .map((c) => c.trim().replace(/\D/g, ''))
        .filter((c) => c.length >= 4);
    // `cnaes=` presente porém vazio = escolha EXPLÍCITA de busca livre (sem
    // filtro por CNAE); parâmetro ausente = usa os CNAEs do perfil.
    const hasExplicitCnaes = req.query.cnaes !== undefined || req.query.cnae !== undefined;
    const explicitCnaes = parseCnaeCodes(req.query.cnaes !== undefined ? req.query.cnaes : req.query.cnae);
    const explicitSegment = req.query.segment ? String(req.query.segment) : null;
    const explicitLocation = req.query.location ? String(req.query.location) : null;
    const explicitCnpj = req.query.cnpj ? String(req.query.cnpj).replace(/\D/g, '') : null;

    // Perfil comercial: os CNAEs/localizações do onboarding COMBINAM com os
    // filtros explícitos da tela (antes, digitar qualquer busca descartava
    // silenciosamente os targetCnaes do perfil — o filtro nunca chegava ao MCP).
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    const settings = org ? await prisma.commercialSettings.findUnique({ where: { orgId: org.id } }) : null;
    const profileCnaes = parseCnaeCodes((Array.isArray(settings && settings.targetCnaes) ? settings.targetCnaes : []).join(','));
    const profileSegments = (Array.isArray(settings && settings.targetSegments) ? settings.targetSegments : [])
      .filter((s) => typeof s === 'string' && s.trim());
    const profileLocations = (Array.isArray(settings && settings.targetLocations) ? settings.targetLocations : [])
      .filter((s) => typeof s === 'string' && s.trim());

    const cnaeCodes = hasExplicitCnaes ? explicitCnaes : profileCnaes;
    const hasExplicitFilters = Boolean(explicitCnaes.length || explicitSegment || explicitLocation || explicitCnpj);
    // Busca semântica usa o texto digitado; sem texto, um segmento do perfil —
    // apenas quando NÃO há CNAEs (os CNAEs já restringem estruturadamente).
    const segments = explicitSegment ? [explicitSegment] : (cnaeCodes.length ? [] : profileSegments);
    const locations = explicitLocation ? [explicitLocation] : profileLocations;
    const activeOnly = settings
      ? !Array.isArray(settings.companyStatuses) || settings.companyStatuses.includes('active')
      : false;
    const usedProfile = Boolean(
      settings && (!hasExplicitFilters || profileCnaes.length || profileLocations.length || profileSegments.length)
    );

    // Se o servidor MCP-CNPJ não estiver configurado (token ausente), não há
    // como descobrir empresas. Respondemos de forma limpa (200) com uma mensagem
    // clara para a UI, em vez de lançar um 500 em cada busca.
    if (!isMcpConfigured()) {
      return res.json({
        success: true,
        data: [],
        page,
        pageSize,
        total: 0,
        totalPages: 0,
        hasMore: false,
        source: [],
        criteria: { segments, cnaeCodes, locations, activeOnly, usedProfile },
        mcpError: 'MCP-CNPJ não configurado',
        message:
          'A descoberta de leads está indisponível: o servidor MCP-CNPJ não está configurado (defina CNPJ_MCP_TOKEN no ambiente).',
        timestamp: new Date().toISOString(),
      });
    }

    // TODAS as localizações do perfil/tela combinam (OR no MCP) — antes só
    // locations[0] era usada e as demais eram ignoradas em silêncio.
    // "Cidade, UF" vira filtro de cidade (o nome do município já restringe o
    // estado); localização só-UF vira filtro de UF. Precedência: havendo
    // qualquer cidade, só as cidades vão ao filtro (UFs "soltas" junto de
    // cidades não são expressáveis no MCP e seriam AND, zerando o OR).
    // Cidades seguem sem acentos (formato da coluna city_name no dataset —
    // com acento o ILIKE não casa nada).
    const parsedLocations = locations
      .map((l) => parseLocation(l))
      .filter((p) => p.city || p.state);
    const cityList = [...new Set(parsedLocations.filter((p) => p.city).map((p) => stripAccents(p.city)))];
    const ufList = [...new Set(parsedLocations.filter((p) => !p.city && p.state).map((p) => p.state))];
    let effectiveState;
    let city;
    if (cityList.length) {
      const singleCityWithUf = cityList.length === 1
        ? parsedLocations.find((p) => p.city && p.state)
        : null;
      if (singleCityWithUf) {
        // Uma cidade só: mantém state+city (afina homônimos em outros estados).
        city = cityList[0];
        effectiveState = singleCityWithUf.state;
      } else {
        city = cityList; // array → OR no MCP
      }
    } else if (ufList.length === 1) {
      effectiveState = ufList[0];
    } else if (ufList.length > 1) {
      effectiveState = ufList; // array → OR no MCP
    }

    if (!cnaeCodes.length && !segments.length && !effectiveState && !city && !explicitCnpj) {
      return res.json({
        success: true,
        data: [],
        page,
        pageSize,
        total: 0,
        totalPages: 0,
        hasMore: false,
        source: [],
        criteria: { segments, cnaeCodes, locations, activeOnly, usedProfile },
        message: 'Configure segmentos, CNAEs ou localização no onboarding para descobrir leads.',
        timestamp: new Date().toISOString(),
      });
    }

    // Cache key: same criteria + seed reuses the fetched MCP window (10 min TTL),
    // so paging between pages does not call the external server again.
    const cacheKey = [orgId, cnaeCodes.join('|'), segments.join('|'), locations.join('|'), activeOnly ? '1' : '0', explicitCnpj || '', seed].join('::');
    let unique = null;
    const cached = discoveryPoolCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      unique = cached.unique;
    } else {
      const candidates = [];

      // 1) Structured CNAE filter when we have codes. Consulta TODOS os
      //    CNAEs (antes: só os 6 primeiros — num perfil de 40, 34 códigos
      //    jamais eram pesquisados). O limite por código escala para manter
      //    o pool total em ~400 (teto do dedupe abaixo) e o número de
      //    chamadas ao MCP sob controle; acima de 60 códigos, uma janela
      //    rotativa por seed decide QUAIS são consultados nessa busca.
      //    Chamadas em lotes de 8 para não metralhar o MCP (réplica única).
      const codesToQuery = rotateBySeed(cnaeCodes, seed, Math.min(cnaeCodes.length, 60));
      const perCodeLimit = Math.max(3, Math.min(100, Math.ceil(400 / Math.max(1, codesToQuery.length))));
      let codeCallsFailed = 0;
      let lastCodeError = null;
      for (const batch of chunk(codesToQuery, 8)) {
        const results = await Promise.all(
          batch.map((code) =>
            filterCompanies({
              cnae: code,
              state: effectiveState,
              city,
              isActive: activeOnly || undefined,
              limit: perCodeLimit,
            }).catch((err) => {
              // Falha pontual de um CNAE não derruba a descoberta — os
              // demais seguem. Se TODAS falharem, o erro sobe (MCP caído).
              codeCallsFailed += 1;
              lastCodeError = err;
              console.error(`[discovery/candidates] cnae ${code}:`, err.message);
              return [];
            }),
          ),
        );
        results.forEach((filtered) => filtered.forEach((company) => candidates.push(company)));
      }
      if (codesToQuery.length && codeCallsFailed === codesToQuery.length) {
        throw lastCodeError || new Error('MCP-CNPJ não retornou nada para nenhum CNAE');
      }

      // 2) Semantic search for segment/natural-language criteria (MCP caps at 40).
      //    Com CNAEs selecionados, o foco semântico fica em 3 códigos ROTACIONADOS
      //    por seed — "Buscar novamente" explora CNAEs diferentes a cada busca, em
      //    vez de martelar sempre os 3 primeiros. Cidades/UFs combinam por OR.
      const query = explicitSegment || segments[0] || '';
      if (query && !/^\d+$/.test(query)) {
        if (cnaeCodes.length) {
          for (const code of rotateBySeed(cnaeCodes, seed, 3)) {
            const found = await searchCompanies({
              query,
              cnae: code,
              state: effectiveState,
              city,
              limit: 30,
            });
            found.forEach((company) => candidates.push(company));
          }
        } else {
          const found = await searchCompanies({
            query,
            state: effectiveState,
            city,
            limit: 50,
          });
          found.forEach((company) => candidates.push(company));
        }
      }

      // 3) Exact CNPJ lookup when the user filters by CNPJ.
      if (explicitCnpj) {
        const exact = await getCompanyByCnpj(explicitCnpj);
        if (exact) candidates.push(exact);
      }

      const seen = new Set();
      unique = [];
      for (const c of candidates.slice(0, 400)) {
        if (!c || seen.has(c.cnpj)) continue;
        seen.add(c.cnpj);
        unique.push(c);
      }

      discoveryPoolCache.set(cacheKey, { unique, expiresAt: Date.now() + DISCOVERY_POOL_TTL_MS });
      if (discoveryPoolCache.size > 60) {
        const oldestKey = discoveryPoolCache.keys().next().value;
        if (oldestKey) discoveryPoolCache.delete(oldestKey);
      }
    }

    // Optional CNPJ filter: refine the pool by exact/partial CNPJ match. The
    // exact lookup above covers a precise CNPJ; this also handles partial
    // matches against the fetched pool (e.g. typing the first digits).
    let source = unique;
    if (explicitCnpj) {
      source = unique.filter((c) => String(c.cnpj || '').replace(/\D/g, '').includes(explicitCnpj));
    }

    // Always exclude CNPJs already registered as leads (fresh check per request,
    // so an import disappears from the listing immediately). Scoped ao org do
    // usuário para que o lead de um usuário não afete a descoberta de outro.
    const existing = await prisma.prospect.findMany({ where: { orgId }, select: { cnpj: true } });
    const existingCnpjs = new Set(existing.map((p) => String(p.cnpj).replace(/\D/g, '')));
    const available = source.filter((c) => !existingCnpjs.has(String(c.cnpj).replace(/\D/g, '')));

    // Rotate deterministically by seed: stable within a seed, different order
    // when the user asks for a fresh batch ("Buscar novamente").
    const pool = shuffleWithSeed(available, seed);

    const total = pool.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;
    const data = pool.slice(start, start + pageSize);

    // E2E: trial não recebe os contatos (email/telefones/sócios) dos candidatos.
    const plan = await getOrgPlan(orgId);
    const redactedData = redactProspectListForPlan(data, plan);

    res.json({
      success: true,
      data: redactedData,
      page,
      pageSize,
      total,
      totalPages,
      hasMore: page < totalPages,
      source: ['mcp.cnpj'],
      criteria: { segments, cnaeCodes, locations, activeOnly, usedProfile },
      message: !total
        ? 'Nenhum lead novo encontrado para os critérios atuais. Ajuste o nicho ou a localização.'
        : undefined,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    // Fracasso no MCP-CNPJ (servidor inalcançável, token inválido, timeout...).
    // Em vez de 500 (que a UI engolia), respondemos 200 com um mcpError claro
    // para o frontend exibir a causa real para o usuário.
    console.error('[discovery/candidates] erro ao buscar leads do MCP-CNPJ:', error.message);
    return res.status(200).json({
      success: true,
      data: [],
      page,
      pageSize,
      total: 0,
      totalPages: 0,
      hasMore: false,
      source: [],
      criteria: { segments, cnaeCodes, locations, activeOnly, usedProfile },
      mcpError: 'MCP-CNPJ indisponível',
      message:
        'Não foi possível buscar leads agora: o servidor de dados empresariais (MCP-CNPJ) não respondeu. ' +
        `Detalhe interno: ${error.message}`,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Importa uma empresa descoberta (MCP-CNPJ) como Prospect do org e dispara a
 * esteira de enriquecimento (NATS ou fallback síncrono BrasilAPI) — mesma
 * rota usada pelo import individual e pelo bulk.
 * Retorna { prospect, alreadyExists, plan }; alreadyExists=true quando o CNPJ
 * já estava na base do org (nada é criado nem re-enriquecido).
 * Lança 403/PLAN_LIMIT_REACHED quando o plano não tem mais cota de leads.
 */
async function importDiscoveredCompanyForOrg(orgId, data) {
  const { cnpj, legalName, tradeName, industry, status, email, city, state, openingDate, legalNature } = data || {};
  if (!cnpj || !legalName) {
    const err = new Error('CNPJ and company name required');
    err.status = 400;
    throw err;
  }

  const normalizedCnpj = String(cnpj).replace(/\D/g, '');
  const plan = await getOrgPlan(orgId);

  // Verifica duplicidade DENTRO do org do usuário (não globalmente).
  const existing = await prisma.prospect.findFirst({ where: { cnpj: normalizedCnpj, orgId } });
  if (existing) {
    return { prospect: existing, alreadyExists: true, plan };
  }

  // Plano: garante que o trial ainda pode captar mais um lead antes do create.
  await assertCanCaptureLead(orgId);

  // Trial: o client só conhece valores MASCARADOS desses campos (a resposta
  // de discovery os mascara), então não podemos gravá-los como se fossem
  // reais — a esteira de enriquecimento re-preenche com dados verdadeiros.
  let importEmail = email;
  let importOpeningDate = openingDate;
  let importLegalNature = legalNature;
  if (plan !== 'premium') {
    const sanitized = stripMaskedIncomingFields({ email, openingDate, legalNature });
    importEmail = sanitized.email;
    importOpeningDate = sanitized.openingDate;
    importLegalNature = sanitized.legalNature;
  }

  let prospect = await prisma.prospect.create({
    data: {
      cnpj: normalizedCnpj,
      companyName: legalName || tradeName || normalizedCnpj,
      tradeName: tradeName || null,
      industry: industry || null,
      city: city || null,
      state: state || null,
      cnpjEmail: importEmail || null,
      cnpjOpenedAt: importOpeningDate ? new Date(importOpeningDate) : null,
      cnpjLegalNature: importLegalNature || null,
      // Epic 1 (FR4): searchText normalizado já na importação de discovery.
      ...withSearchText({
        companyName: legalName || tradeName || normalizedCnpj,
        tradeName: tradeName || null,
        industry: industry || null,
      }),
      // Feature 005 (FR-002): todo lead novo entra em "Em Qualificação",
      // independentemente do status da empresa descoberta.
      status: 'prospect',
      opportunityScore: 60,
      // Não marcamos como 'enriched': a esteira de enriquecimento (NATS) ou o
      // fallback síncrono BrasilAPI é quem completa firmografia + scoring.
      enrichmentStatus: 'pending',
      orgId,
    },
  });

  // Empresas descobertas entram na esteira roteada por plano (NATS premium;
  // BrasilAPI trial).
  const enriched = await dispatchEnrichmentForPlan(prisma, prospect).catch((err) => {
    console.error('[discovery] erro na esteira de enriquecimento:', err.message);
    return prospect;
  });

  return { prospect: enriched, alreadyExists: false, plan };
}

// POST /api/discovery/import - persist a discovered company as a Prospect
app.post('/api/discovery/import', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const { prospect, alreadyExists, plan } = await importDiscoveredCompanyForOrg(orgId, req.body || {});

    const payload = {
      success: true,
      data: redactProspectForPlan(formatEnrichedProspect(prospect), plan),
      alreadyExists,
      timestamp: new Date().toISOString(),
    };
    if (!alreadyExists) {
      payload.enrichment = { status: prospect.enrichmentStatus, source: prospect.enrichmentSource };
    }
    res.json(payload);
  } catch (error) {
    if (error.code === 'PLAN_LIMIT_REACHED' || error.status === 403) {
      return res.status(403).json({ success: false, error: error.message, code: 'PLAN_LIMIT_REACHED' });
    }
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// POST /api/discovery/import-bulk - persiste em lote as empresas selecionadas
// na tela "Leads descobertos agora" (checkbox "selecionar todos"). Cada lead
// passa pela mesma esteira do import individual (persist + enriquecimento),
// em sequência para não martelar o serviço público de CNPJ. Para no primeiro
// estouro de cota do plano e devolve o resumo parcial.
app.post('/api/discovery/import-bulk', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const companies = Array.isArray(req.body?.companies) ? req.body.companies : [];
    if (!companies.length) {
      return res.status(400).json({ success: false, error: 'Nenhuma empresa recebida para importar.' });
    }
    if (companies.length > 50) {
      return res.status(400).json({ success: false, error: 'Máximo de 50 leads por lote.' });
    }

    const imported = [];
    let alreadyExists = 0;
    const failures = [];
    let limitReached = false;
    let limitMessage = '';

    for (const company of companies) {
      try {
        const { prospect, alreadyExists: existed } = await importDiscoveredCompanyForOrg(orgId, company);
        if (existed) {
          alreadyExists += 1;
        } else {
          imported.push(prospect.cnpj);
        }
      } catch (error) {
        if (error.code === 'PLAN_LIMIT_REACHED' || error.status === 403) {
          limitReached = true;
          limitMessage = error.message;
          break;
        }
        console.error('[discovery/import-bulk] falha ao importar CNPJ:', error.message);
        failures.push({ cnpj: String(company?.cnpj || ''), error: error.message });
      }
    }

    res.json({
      success: true,
      data: {
        requested: companies.length,
        importedCount: imported.length,
        imported,
        alreadyExists,
        failures,
        limitReached,
        limitMessage,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// POST /api/prospects/:id/enrich-mcp - enrich an existing prospect via MCP-CNPJ
// Suíte multicanal pós-enriquecimento (email/WhatsApp) — ver campaign-suite.js
function emailSuiteHook(updatedProspect) {
  require('./campaign-suite')
    .onLeadEnriched(prisma, updatedProspect)
    .catch((err) => console.error('[suite] erro pós-enriquecimento (mcp):', err.message));
}
app.post('/api/prospects/:id/enrich-mcp', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const prospect = await prisma.prospect.findFirst({ where: { id: req.params.id, orgId } });
    if (!prospect) return res.status(404).json({ success: false, error: 'Prospect not found' });
    const plan = await getOrgPlan(orgId);

    const company = await getCompanyByCnpj(prospect.cnpj);
    if (!company) {
      return res.json({
        success: true,
        data: redactProspectForPlan(prospect, plan),
        enrichment: { status: 'unavailable', source: 'mcp.cnpj', error: 'Company not found in MCP-CNPJ' },
        timestamp: new Date().toISOString(),
      });
    }

    const updated = await prisma.prospect.update({
      where: { id: prospect.id },
      data: {
        companyName: company.legalName || prospect.companyName,
        tradeName: company.tradeName || prospect.tradeName,
        industry: company.industry || prospect.industry,
        cnpjEmail: company.email || prospect.cnpjEmail,
        cnpjOpenedAt: company.openingDate ? new Date(company.openingDate) : prospect.cnpjOpenedAt,
        cnpjLegalNature: company.legalNature || prospect.cnpjLegalNature,
        // Epic 1 (FR4): enriquecimento muda identidade/setor → searchText
        // recalculado da linha final.
        ...withSearchText(
          {
            companyName: company.legalName || prospect.companyName,
            tradeName: company.tradeName || prospect.tradeName,
            industry: company.industry || prospect.industry,
          },
          prospect
        ),
        enrichmentStatus: 'enriched',
        enrichmentSource: 'mcp.cnpj',
        enrichmentError: null,
        enrichedAt: new Date(),
        // Enriquecimento concluído: card em "Em Qualificação" avança
        // automaticamente para "Prontas para contato".
        ...(prospect.status === 'prospect' ? { status: 'qualified' } : {}),
      },
    });

    // Suíte multicanal pós-enriquecimento (email/WhatsApp)
    emailSuiteHook(updated);

    res.json({
      success: true,
      data: redactProspectForPlan(formatEnrichedProspect(updated), plan),
      enrichment: { status: 'enriched', source: 'mcp.cnpj' },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/discovery/stats - quick dataset stats from MCP-CNPJ
app.get('/api/discovery/stats', async (req, res) => {
  try {
    const stats = await getDatasetStats();
    res.json({ success: true, data: stats, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/enrichment/status/:id - Status do enriquecimento (resultados NATS)
app.get('/api/enrichment/status/:id', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const prospect = await prisma.prospect.findFirst({ where: { id: req.params.id, orgId } });
    if (!prospect) return res.status(404).json({ success: false, error: 'Prospect not found' });

    const results = await prisma.cnpjEnrichment.findMany({
      where: { companyId: prospect.id },
      orderBy: { enrichmentVersion: 'desc' },
    });

    res.json({
      success: true,
      data: {
        prospect: {
          id: prospect.id,
          cnpj: prospect.cnpj,
          enrichmentStatus: prospect.enrichmentStatus,
          enrichmentSource: prospect.enrichmentSource,
          enrichmentError: prospect.enrichmentError,
          enrichmentVersion: prospect.enrichmentVersion,
          enrichedAt: prospect.enrichedAt,
        },
        results,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/enrichment/graph/:cnpj - Grafo completo de enriquecimento (view v_company_graph)
app.get('/api/enrichment/graph/:cnpj', async (req, res) => {
  try {
    const graph = await enrichmentGraph.fetchCompanyGraph(req.params.cnpj);

    // Trial: máscara dos pontos de contato (email/telefone) e do quadro
    // societário; raw_facts (payload bruto com endereço) não é entregue.
    let data = graph.data;
    if (data) {
      const orgId = await requireRequestOrgId(req);
      const plan = await getOrgPlan(orgId);
      if (plan !== 'premium') {
        data = maskCompanyGraphForTrial(data);
      }
    }

    res.json({ success: true, ...graph, data, timestamp: new Date().toISOString() });
  } catch (error) {
    if (error.status === 401) {
      return res.status(401).json({ success: false, error: error.message });
    }
    console.error('[enrichment-graph] erro ao buscar grafo:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// OUTREACH — Cold Sales Automático via Gmail
// ============================================================================

// GET /api/gmail/auth-url — generate Google OAuth2 URL
app.get('/api/gmail/auth-url', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const url = gmailApi.getAuthUrl(userId);
    res.json({ success: true, authUrl: url, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/gmail/callback — Google OAuth2 callback
app.get('/api/gmail/callback', async (req, res) => {
  try {
    const { code, state, error: authError } = req.query;

    if (authError) {
      return res.status(400).json({ success: false, error: `Google OAuth error: ${authError}` });
    }

    if (!code || !state) {
      return res.redirect('/'); // back to dashboard
    }

    // Validate state (CSRF) — lookup in-memory store
    const stateData = require('./gmail-api')._oauthState?.get(state);
    if (!stateData) {
      return res.redirect('/'); // invalid state, drop
    }

    // Remove from store
    require('./gmail-api')._oauthState?.delete(state);

    const { email } = await gmailApi.exchangeCodeForTokens(prisma, code, stateData.userId);

    // Redirect back with success
    res.redirect(`/settings?gmail_connected=${encodeURIComponent(email)}`);
  } catch (err) {
    console.error('[gmail] OAuth callback error:', err.message);
    res.redirect('/settings?gmail_error=connection_failed');
  }
});

// GET /api/gmail/accounts — list connected email accounts (todos os providers)
app.get('/api/gmail/accounts', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const accounts = await prisma.emailAccount.findMany({
      where: { userId },
      select: {
        id: true,
        email: true,
        provider: true,
        status: true,
        scopes: true,
        fromName: true,
        smtpHost: true,
        smtpPort: true,
        lastHistoryId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json({
      success: true,
      data: accounts,
      count: accounts.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/gmail/accounts/:id — disconnect Gmail account
app.delete('/api/gmail/accounts/:id', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const account = await prisma.emailAccount.findFirst({
      where: { id: req.params.id, userId },
    });

    if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

    await prisma.emailAccount.update({
      where: { id: account.id },
      data: { status: 'revoked', encryptedRefreshToken: null, encryptedSecret: null },
    });

    res.json({ success: true, message: 'Account disconnected', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Conexão de contas SMTP / Resend (alternativas ao Gmail OAuth) ──

// POST /api/email/connect — conectar conta via SMTP (ex.: Gmail App Password)
// ou Resend (API key). Valida as credenciais antes de salvar.
app.post('/api/email/connect', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const {
      provider, email, password, apiKey, smtpHost, smtpPort, smtpSecure, fromName,
    } = req.body || {};

    if (!['smtp', 'resend'].includes(provider)) {
      return res.status(400).json({ success: false, error: 'provider deve ser "smtp" ou "resend"' });
    }

    const secret =
      provider === 'smtp'
        ? password
        : (apiKey || process.env.RESEND_API_KEY); // fallback: key da plataforma

    const account = await emailProvider.connectEmailAccount(prisma, {
      provider,
      email,
      secret,
      smtpHost,
      smtpPort: smtpPort ? Number(smtpPort) : undefined,
      smtpSecure: Boolean(smtpSecure),
      fromName,
      userId,
    });

    console.log(`[email] ✓ conta ${provider} conectada: ${account.email}`);
    res.status(201).json({
      success: true,
      data: {
        id: account.id,
        email: account.email,
        provider: account.provider,
        status: account.status,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[email] connect error:', err.message);
    // Erro de validação de credencial → 400 com mensagem amigável
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/email/providers — opções de provider disponíveis (para a UI)
app.get('/api/email/providers', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    res.json({
      success: true,
      data: {
        gmailOAuth: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
        resendPlatformKey: Boolean(process.env.RESEND_API_KEY),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Campaigns ─────────────────────────────────────────────────────

// Governança de lançamento de campanha WhatsApp (007 — FR-008/FR-012):
// campanha retida pelo saneamento (needsReview) ou sem etapas não dispara.
async function assertWhatsAppCampaignLaunchable(orgId, campaignId) {
  const campaign = await prisma.whatsAppCampaign.findFirst({ where: { id: campaignId, orgId } });
  if (!campaign) {
    return { ok: false, code: 'CAMPAIGN_NOT_FOUND', message: 'Campanha não encontrada' };
  }
  if (campaign.needsReview) {
    return {
      ok: false,
      code: 'CAMPAIGN_REVIEW_REQUIRED',
      message: 'Esta campanha foi retida para revisão do template (rederive ou edite a mensagem antes de lançar).',
    };
  }
  const stepCount = await prisma.whatsAppSequenceStep.count({ where: { campaignId } });
  if (stepCount === 0) {
    return {
      ok: false,
      code: 'TEMPLATE_REQUIRED',
      message: 'Configure ao menos uma mensagem na sequência antes de lançar.',
    };
  }
  return { ok: true };
}

// Guard de ingestão de templates de mensagem (007 — FR-004/FR-005): rejeita
// BLOCKLIST, limite do canal e placeholders desconhecidos ANTES de persistir.
// Retorna true se tudo válido; já respondeu 400 caso contrário.
function validateOutreachTemplatesOr400(res, templates) {
  const { validateTemplateMessage } = require('./whatsapp-utils');
  for (const [field, value, maxLength] of templates) {
    if (value === undefined || value === null || value === '') continue;
    const guard = validateTemplateMessage(value, { maxLength });
    if (!guard.ok) {
      res.status(400).json({
        success: false,
        code: 'TEMPLATE_REJECTED',
        error: `Template rejeitado (${field}: ${guard.reason}).`,
      });
      return false;
    }
  }
  return true;
}

// GET /api/outreach/campaigns — list campaigns
app.get('/api/outreach/campaigns', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    // Find user's orgId
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const campaigns = await prisma.outreachCampaign.findMany({
      where: { tenantId: user.orgId },
      orderBy: { createdAt: 'desc' },
    });

    // Leads já inscritos por campanha: a UI de "Lançar campanha em leads"
    // exclui da lista quem já foi contatado — nunca reenviar o primeiro
    // toque do mesmo lead na mesma campanha.
    const contacts = await prisma.outreachContact.findMany({
      where: { campaign: { tenantId: user.orgId } },
      select: { campaignId: true, prospectId: true },
    });
    const enrolledByCampaign = new Map();
    contacts.forEach((c) => {
      const list = enrolledByCampaign.get(c.campaignId);
      if (list) list.push(c.prospectId);
      else enrolledByCampaign.set(c.campaignId, [c.prospectId]);
    });

    res.json({
      success: true,
      data: campaigns.map((c) => ({
        ...c,
        contactedProspectIds: enrolledByCampaign.get(c.id) || [],
      })),
      count: campaigns.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/outreach/campaigns — create campaign (suíte multicanal ou manual)
app.post('/api/outreach/campaigns', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const {
      name, description, objective, offer,
      trigger, channels, autoActive,
      emailAccountId, emailTemplateSubject, emailTemplateBody,
      whatsappAccountId, whatsappTemplate,
    } = req.body || {};
    if (!name) return res.status(400).json({ success: false, error: 'Campaign name required' });

    // Guard de ingestão (007): BLOCKLIST/limite/placeholder desconhecido é
    // rejeitado na entrada, nunca persistido.
    if (!validateOutreachTemplatesOr400(res, [
      ['emailTemplateSubject', emailTemplateSubject, 5000],
      ['emailTemplateBody', emailTemplateBody, 5000],
      ['whatsappTemplate', whatsappTemplate, 600],
    ])) return;

    // Validação da suíte multicanal
    const validChannels = Array.isArray(channels)
      ? channels.filter((c) => ['email', 'whatsapp'].includes(c))
      : [];
    if (trigger === 'on_enrichment') {
      if (validChannels.length === 0) {
        return res.status(400).json({ success: false, error: 'Selecione ao menos um canal (email ou WhatsApp).' });
      }
      if (validChannels.includes('email') && (!emailAccountId || !emailTemplateSubject || !emailTemplateBody)) {
        return res.status(400).json({ success: false, error: 'Canal email: selecione a conta de envio e preencha assunto e mensagem.' });
      }
      if (validChannels.includes('whatsapp') && (!whatsappAccountId || !whatsappTemplate)) {
        return res.status(400).json({ success: false, error: 'Canal WhatsApp: selecione a conta conectada e escreva a mensagem.' });
      }
    }

    const campaign = await prisma.outreachCampaign.create({
      data: {
        tenantId: user.orgId,
        name,
        description: description || null,
        objective: objective || null,
        offer: offer || null,
        trigger: trigger === 'on_enrichment' ? 'on_enrichment' : 'manual',
        channels: validChannels,
        autoActive: trigger === 'on_enrichment' ? Boolean(autoActive) : false,
        emailAccountId: emailAccountId || null,
        emailTemplateSubject: emailTemplateSubject || null,
        emailTemplateBody: emailTemplateBody || null,
        whatsappAccountId: whatsappAccountId || null,
        whatsappTemplate: whatsappTemplate || null,
      },
    });

    res.json({ success: true, data: campaign, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/outreach/campaigns/:id — atualizar config da suíte (templates,
// canais, contas, toggle de automação)
app.patch('/api/outreach/campaigns/:id', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
    const existing = await prisma.outreachCampaign.findFirst({
      where: { id: req.params.id, tenantId: user?.orgId },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Campaign not found' });

    const {
      name, description, objective, offer, status,
      trigger, channels, autoActive,
      emailAccountId, emailTemplateSubject, emailTemplateBody,
      whatsappAccountId, whatsappTemplate,
    } = req.body || {};

    const validChannels = Array.isArray(channels)
      ? channels.filter((c) => ['email', 'whatsapp'].includes(c))
      : undefined;

    // Guard de ingestão (007) nos templates alterados; editar template
    // revalida a campanha retida pelo saneamento (FR-008).
    if (!validateOutreachTemplatesOr400(res, [
      ['emailTemplateSubject', emailTemplateSubject, 5000],
      ['emailTemplateBody', emailTemplateBody, 5000],
      ['whatsappTemplate', whatsappTemplate, 600],
    ])) return;
    const templateTouched = [emailTemplateSubject, emailTemplateBody, whatsappTemplate]
      .some((v) => v !== undefined);

    if (autoActive === true) {
      const ch = validChannels ?? existing.channels ?? [];
      if (!Array.isArray(ch) || ch.length === 0) {
        return res.status(400).json({ success: false, error: 'Configure ao menos um canal antes de ativar a automação.' });
      }
      if (ch.includes('email') && (!(emailAccountId ?? existing.emailAccountId) || !(emailTemplateSubject ?? existing.emailTemplateSubject) || !(emailTemplateBody ?? existing.emailTemplateBody))) {
        return res.status(400).json({ success: false, error: 'Canal email incompleto: conta de envio, assunto e mensagem são obrigatórios.' });
      }
      if (ch.includes('whatsapp') && (!(whatsappAccountId ?? existing.whatsappAccountId) || !(whatsappTemplate ?? existing.whatsappTemplate))) {
        return res.status(400).json({ success: false, error: 'Canal WhatsApp incompleto: conta conectada e mensagem são obrigatórias.' });
      }
    }

    const campaign = await prisma.outreachCampaign.update({
      where: { id: existing.id },
      data: {
        ...(name ? { name } : {}),
        ...(description !== undefined ? { description: description || null } : {}),
        ...(objective !== undefined ? { objective: objective || null } : {}),
        ...(offer !== undefined ? { offer: offer || null } : {}),
        ...(status ? { status } : {}),
        ...(trigger ? { trigger: trigger === 'on_enrichment' ? 'on_enrichment' : 'manual' } : {}),
        ...(validChannels ? { channels: validChannels } : {}),
        ...(autoActive !== undefined ? { autoActive: Boolean(autoActive) } : {}),
        ...(emailAccountId !== undefined ? { emailAccountId: emailAccountId || null } : {}),
        ...(emailTemplateSubject !== undefined ? { emailTemplateSubject: emailTemplateSubject || null } : {}),
        ...(emailTemplateBody !== undefined ? { emailTemplateBody: emailTemplateBody || null } : {}),
        ...(whatsappAccountId !== undefined ? { whatsappAccountId: whatsappAccountId || null } : {}),
        ...(whatsappTemplate !== undefined ? { whatsappTemplate: whatsappTemplate || null } : {}),
        ...(templateTouched ? { needsReview: false, reviewReason: null } : {}),
      },
    });

    res.json({ success: true, data: campaign, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/outreach/campaigns/test — envia mensagem de TESTE com o template
// da suíte (renderizado com dados de exemplo): email vai para a própria conta
// conectada; WhatsApp para um número informado (não é possível enviar para o
// próprio número conectado).
app.post('/api/outreach/campaigns/test', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const { channel, emailAccountId, subject, body, whatsappAccountId, message, toPhone } = req.body || {};
    const { renderTemplate, normalizePhone, toChatId } = require('./whatsapp-utils');

    // Dados de exemplo — mesmos exibidos no preview da UI
    const SAMPLE = {
      firstName: 'Mariana',
      companyName: 'Transportes Alfa Ltda',
      jobTitle: 'Sócia-Administradora',
      city: 'Curitiba',
      industry: 'Transporte rodoviário de carga',
    };

    if (channel === 'email') {
      if (!emailAccountId || !subject || !body) {
        return res.status(400).json({ success: false, error: 'Preencha conta, assunto e mensagem antes de testar.' });
      }
      // EmailAccount é escopada por userId (mesmo critério de GET/DELETE
      // /api/gmail/accounts). O tenantId gravado na criação nem sempre é o
      // orgId do dono (contas antigas/Gmail usam userId), então filtrar por
      // orgId aqui fazia a conta "não ser encontrada" e o teste nunca sair.
      const account = await prisma.emailAccount.findFirst({
        where: { id: emailAccountId, userId, status: 'connected' },
      });
      if (!account) {
        return res.status(400).json({ success: false, error: 'Conta de email não encontrada ou não conectada.' });
      }

      // Destino do teste: a caixa de entrada do usuário logado. Para Resend,
      // account.email é o endereço "from" (nem sempre é uma caixa legível);
      // login email pode ser sintético em login por telefone → cai no from.
      const loginEmail = String(req.user?.email || '').toLowerCase();
      const to = loginEmail && !loginEmail.endsWith('@b2base.local') ? loginEmail : account.email;

      const renderedBody = renderTemplate(body, SAMPLE);
      const crypto = require('crypto');
      await emailProvider.sendEmailForAccount(prisma, account.id, {
        to,
        subject: `[TESTE] ${renderTemplate(subject, SAMPLE)}`,
        body: renderedBody,
        htmlBody: `<p>${renderedBody
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/\n{2,}/g, '</p><p>')
          .replace(/\n/g, '<br/>')}</p>`,
        messageId: `teste-${crypto.randomUUID()}`,
      });

      console.log(`[suite-test] email de teste enviado para ${to}`);
      return res.json({
        success: true,
        message: `Email de teste enviado para ${to} — confira a caixa de entrada (e o spam).`,
        timestamp: new Date().toISOString(),
      });
    }

    if (channel === 'whatsapp') {
      if (!whatsappAccountId || !message) {
        return res.status(400).json({ success: false, error: 'Selecione a conta e escreva a mensagem antes de testar.' });
      }
      const phone = normalizePhone(toPhone);
      const chatId = toChatId(toPhone);
      if (!phone || phone.length < 10) {
        return res.status(400).json({ success: false, error: 'Informe um número válido com DDD (ex.: 11 99999-8888).' });
      }
      const account = await prisma.whatsAppAccount.findFirst({
        where: { id: whatsappAccountId, orgId: user.orgId, status: 'CONNECTED' },
      });
      if (!account) {
        return res.status(400).json({ success: false, error: 'Conta WhatsApp não encontrada ou não conectada.' });
      }

      const wahaProviderModule = require('./waha-provider');
      const result = await wahaProviderModule.WAHAWhatsAppProvider.sendText(account.sessionName, chatId, renderTemplate(message, SAMPLE));
      if (!result?.providerMessageId) {
        return res.status(500).json({ success: false, error: 'O WAHA não confirmou o envio — verifique se a sessão está conectada.' });
      }

      console.log(`[suite-test] whatsapp de teste enviado (${phone})`);
      return res.json({
        success: true,
        message: 'Mensagem de teste enviada — confira o WhatsApp do número informado.',
        timestamp: new Date().toISOString(),
      });
    }

    return res.status(400).json({ success: false, error: 'channel deve ser "email" ou "whatsapp".' });
  } catch (err) {
    console.error('[suite-test] erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/outreach/campaigns/:id/start — start outreach on selected prospects
app.post('/api/outreach/campaigns/:id/start', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const { prospectIds, emailAccountId } = req.body || {};
    if (!prospectIds || !Array.isArray(prospectIds) || prospectIds.length === 0) {
      return res.status(400).json({ success: false, error: 'prospectIds array required' });
    }

    // Isolamento: a campanha deve pertencer ao org do usuário.
    const campaign = await prisma.outreachCampaign.findFirst({
      where: { id: req.params.id, tenantId: user.orgId },
    });
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

    // Retenção do saneamento (007 — FR-008): campanha retida não dispara.
    if (campaign.needsReview) {
      return res.status(409).json({
        success: false,
        code: 'CAMPAIGN_REVIEW_REQUIRED',
        error: 'Esta campanha foi retida para revisão do template (rederive ou edite o template antes de lançar).',
      });
    }

    // Isolamento: cada prospect deve pertencer ao org do usuário (evita
    // disparar outreach contra leads de outro tenant).
    const ownedProspects = await prisma.prospect.findMany({
      where: { id: { in: prospectIds }, orgId: user.orgId },
      select: { id: true },
    });
    const ownedIds = new Set(ownedProspects.map((p) => p.id));
    const filteredIds = prospectIds.filter((id) => ownedIds.has(id));

    if (filteredIds.length !== prospectIds.length) {
      return res.status(400).json({
        success: false,
        error: 'Um ou mais prospects informados não pertencem à sua conta.',
      });
    }

    const result = await outreachWorkers.startOutreachCampaign(
      prisma,
      req.params.id,
      prospectIds,
      emailAccountId || null,
      userId
    );

    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// CAMPANHA COM IA (feature PREMIUM)
// ============================================================================
// POST /api/ai/campaigns — a IA gera a estratégia (nome/objetivo/oferta) a
// partir do contexto comercial da org e SALVA as campanhas (email e/ou
// WhatsApp conforme contas conectadas) com a MENSAGEM BASE composta do perfil
// comercial — NÃO dispara nada. O tenant visualiza a prévia e aprova via
// POST /api/ai/campaigns/approve, que lança os disparos para os leads em
// "Prontos para contato" (status='qualified').
//   - email: template composto (base por perfil); IA gera por lead no prepare;
//   - whatsapp: step aiPersonalized (base composta = fallback garantido).
// Resposta: { success, data: { status: 'pending_approval', emailCampaignId,
//   whatsappCampaignId, channels, leadCount, strategy, preview } }
app.post('/api/ai/campaigns', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    // Gate do plano (o orquestrador revalida — defesa em profundidade).
    await assertPremiumOrg(user.orgId);

    const result = await aiCampaign.createAndLaunchAiCampaign(prisma, {
      orgId: user.orgId,
      userId,
    });

    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (err) {
    if (err.code && err.status) {
      return res.status(err.status).json({ success: false, code: err.code, error: err.message });
    }
    console.error('[ai-campaign] erro inesperado:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/ai/campaigns/approve — aprova a mensagem base da campanha IA e
// LANÇA os disparos (único caminho de lançamento do fluxo IA — FR-009).
// body: { outreachCampaignId?, whatsappCampaignId?,
//         edits?: { whatsappMessageTemplate?, emailTemplateSubject?, emailTemplateBody? } }
app.post('/api/ai/campaigns/approve', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    // Gate do plano (o orquestrador revalida — defesa em profundidade).
    await assertPremiumOrg(user.orgId);

    const { outreachCampaignId, whatsappCampaignId, edits } = req.body || {};
    const result = await aiCampaign.approveAiCampaign(prisma, {
      orgId: user.orgId,
      userId,
      outreachCampaignId: outreachCampaignId || null,
      whatsappCampaignId: whatsappCampaignId || null,
      edits: edits || {},
    });

    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (err) {
    if (err.code && err.status) {
      return res.status(err.status).json({ success: false, code: err.code, error: err.message });
    }
    console.error('[ai-campaign] erro inesperado no approve:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/outreach/dispatches — histórico unificado de disparos (email +
// WhatsApp) do org, mais recentes primeiro.
//   ?channel=email|whatsapp  ?campaignId=  ?status=sent|pending|failed
//   ?q=<busca>  ?limit=50  ?offset=0
// Fontes: OutreachMessage (email de campanha/suíte) e WhatsAppMessage
// direction=OUTBOUND (campanha e conversa 1:1). As duas fontes são mescladas
// em memória (volume por org é pequeno) para poder ordenar/paginar unificado.
app.get('/api/outreach/dispatches', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const channel = req.query.channel === 'email' || req.query.channel === 'whatsapp'
      ? String(req.query.channel)
      : null;
    const campaignId = req.query.campaignId ? String(req.query.campaignId) : null;
    const statusFilter = ['sent', 'pending', 'failed'].includes(String(req.query.status))
      ? String(req.query.status)
      : null;
    const q = String(req.query.q || '').toLowerCase().trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const bucketForEmail = (msg) => {
      if (msg.status === 'SENT') return 'sent';
      if (msg.error || ['FAILED', 'BOUNCED'].includes(msg.status)) return 'failed';
      return 'pending'; // GENERATING, SCHEDULED, SENDING
    };
    const bucketForWhatsApp = (msg) => {
      if (['SENT', 'DELIVERED', 'READ'].includes(msg.status)) return 'sent';
      if (msg.status === 'FAILED' || msg.error) return 'failed';
      return 'pending'; // PENDING
    };

    // Últimos 500 por canal bastam para o histórico paginado de um org.
    const FETCH_CAP = 500;
    const [emailMessages, waMessages] = await Promise.all([
      channel === 'whatsapp'
        ? []
        : prisma.outreachMessage.findMany({
            where: {
              contact: {
                campaign: {
                  tenantId: user.orgId,
                  ...(campaignId ? { id: campaignId } : {}),
                },
              },
            },
            include: { contact: { include: { campaign: true } } },
            orderBy: { createdAt: 'desc' },
            take: FETCH_CAP,
          }),
      channel === 'email'
        ? []
        : prisma.whatsAppMessage.findMany({
            where: {
              orgId: user.orgId,
              direction: 'OUTBOUND',
              ...(campaignId ? { campaignContactId: { not: null } } : {}),
            },
            include: { conversation: true },
            orderBy: { createdAt: 'desc' },
            take: FETCH_CAP,
          }),
    ]);

    // WhatsAppMessage não tem relation com WhatsAppCampaignContact (só o FK
    // campaignContactId) — resolve campanhas em query separada.
    const waContactIds = Array.from(
      new Set(waMessages.map((m) => m.campaignContactId).filter(Boolean))
    );
    const waContacts = waContactIds.length
      ? await prisma.whatsAppCampaignContact.findMany({
          where: { id: { in: waContactIds } },
          include: { campaign: { select: { id: true, name: true } } },
        })
      : [];
    const waContactById = new Map(waContacts.map((c) => [c.id, c]));

    // Dados do lead em uma única query (OutreachContact não tem relation
    // com Prospect — o vínculo é por prospectId).
    const prospectIds = new Set([
      ...emailMessages.map((m) => m.contact?.prospectId).filter(Boolean),
      ...waMessages.map((m) => m.conversation?.prospectId).filter(Boolean),
    ]);
    const prospects = prospectIds.size
      ? await prisma.prospect.findMany({
          where: { id: { in: Array.from(prospectIds) }, orgId: user.orgId },
          select: { id: true, companyName: true, cnpj: true, cnpjEmail: true },
        })
      : [];
    const prospectById = new Map(prospects.map((p) => [p.id, p]));

    const dispatches = [
      ...emailMessages.map((m) => dispatchUtils.toEmailDispatchItem(m, { prospectById })),
      ...waMessages
        .map((m) => dispatchUtils.toWhatsAppDispatchItem(m, { prospectById, waContactById }))
        .filter((d) => !campaignId || d.campaignId === campaignId),
    ];

    // Campanhas presentes no histórico (para o dropdown de filtro da UI).
    const campaignOptions = [];
    const seenCampaigns = new Set();
    for (const d of dispatches) {
      if (d.campaignId && !seenCampaigns.has(d.campaignId)) {
        seenCampaigns.add(d.campaignId);
        campaignOptions.push({ id: d.campaignId, name: d.campaignName, channel: d.channel });
      }
    }

    const filtered = dispatches.filter((d) => {
      if (statusFilter && d.bucket !== statusFilter) return false;
      if (q) {
        const haystack = [d.companyName, d.destination, d.preview, d.campaignName, d.cnpj]
          .filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      const ta = new Date(a.sentAt || a.createdAt).getTime();
      const tb = new Date(b.sentAt || b.createdAt).getTime();
      return tb - ta;
    });

    const counts = {
      sent: filtered.filter((d) => d.bucket === 'sent').length,
      pending: filtered.filter((d) => d.bucket === 'pending').length,
      failed: filtered.filter((d) => d.bucket === 'failed').length,
    };

    res.json({
      success: true,
      data: {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        hasMore: offset + limit < filtered.length,
        counts,
        campaigns: campaignOptions,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[dispatches] erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/outreach/dispatches/retry — reprocessa disparos que falharam.
//   body: { ids?: ["email:<cuid>"|"wa:<cuid>"], allFailed?: boolean }
// Re-enfileira o envio (email → outreach:message-send, whatsapp → whatsapp:send)
// resetando o status para SCHEDULED/PENDING e limpando o erro.
app.post('/api/outreach/dispatches/retry', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const { ids, allFailed } = req.body || {};
    const emailIds = [];
    const waIds = [];
    for (const raw of (Array.isArray(ids) ? ids : [])) {
      const s = String(raw);
      if (s.startsWith('email:')) emailIds.push(s.slice('email:'.length));
      else if (s.startsWith('wa:')) waIds.push(s.slice('wa:'.length));
    }

    const sendQueue = getQueues().send;
    const waSendQueue = getWhatsAppQueues().send;
    let emailRetried = 0;
    let whatsappRetried = 0;

    // ── Email ──
    if (emailIds.length || allFailed) {
      const failedEmails = await prisma.outreachMessage.findMany({
        where: {
          contact: { campaign: { tenantId: user.orgId } },
          ...(allFailed ? {} : { id: { in: emailIds } }),
          status: 'FAILED',
        },
        include: { contact: true },
      });

      for (const m of failedEmails) {
        await prisma.outreachMessage.update({
          where: { id: m.id },
          data: { status: 'SCHEDULED', error: null },
        });
        // Só "ressuscita" contactos em estado FAILED (não mexe em terminais).
        await prisma.outreachContact.updateMany({
          where: { id: m.contactId, status: 'FAILED' },
          data: { status: 'SCHEDULED', cancelReason: null },
        });
        await sendQueue.add(
          { messageId: m.id },
          { attempts: 3, backoff: { type: 'exponential', delay: 60 * 1000 } }
        );
        emailRetried++;
      }
    }

    // ── WhatsApp ──
    if (waIds.length || allFailed) {
      const failedWa = await prisma.whatsAppMessage.findMany({
        where: {
          orgId: user.orgId,
          direction: 'OUTBOUND',
          ...(allFailed ? {} : { id: { in: waIds } }),
          status: 'FAILED',
        },
      });

      for (const m of failedWa) {
        await prisma.whatsAppMessage.update({
          where: { id: m.id },
          data: { status: 'PENDING', error: null, failedAt: null },
        });
        await waSendQueue.add(
          { messageId: m.id },
          { attempts: 5, backoff: { type: 'exponential', delay: 5000 } }
        );
        whatsappRetried++;
      }
    }

    res.json({
      success: true,
      data: { emailRetried, whatsappRetried, retried: emailRetried + whatsappRetried },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[dispatches] retry erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Timeline ──────────────────────────────────────────────────────

// GET /api/prospects/:id/outreach-timeline — outreach events for a lead
app.get('/api/prospects/:id/outreach-timeline', async (req, res) => {
  try {
    const prospectId = req.params.id;

    // Verify the prospect belongs to the requesting user's org
    const user = await prisma.user.findUnique({ where: { id: req.user?.id }, select: { orgId: true } });
    if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const prospect = await prisma.prospect.findFirst({
      where: { id: prospectId, orgId: user.orgId },
      select: { id: true },
    });
    if (!prospect) return res.status(404).json({ success: false, error: 'Prospect not found' });

    const events = await prisma.outreachEvent.findMany({
      where: {
        contact: { prospectId },
      },
      include: {
        message: {
          select: {
            id: true,
            subject: true,
            status: true,
            sentAt: true,
            gmailMessageId: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: events,
      count: events.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/prospects/:id/outreach-status — current outreach status for a lead
app.get('/api/prospects/:id/outreach-status', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user?.id }, select: { orgId: true } });
    if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const prospect = await prisma.prospect.findFirst({
      where: { id: req.params.id, orgId: user.orgId },
      select: { id: true },
    });
    if (!prospect) return res.status(404).json({ success: false, error: 'Prospect not found' });

    const contacts = await prisma.outreachContact.findMany({
      where: { prospectId: prospect.id },
      include: {
        campaign: { select: { name: true, status: true } },
        messages: {
          select: {
            id: true,
            subject: true,
            status: true,
            sentAt: true,
            gmailMessageId: true,
            gmailThreadId: true,
            trackingToken: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        events: {
          select: {
            type: true,
            status: true,
            details: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: contacts,
      count: contacts.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Tracking Pixel ────────────────────────────────────────────────

// GET /t/o/:token.gif — open tracking pixel
app.get('/t/o/:token.gif', async (req, res) => {
  try {
    const token = req.params.token;

    if (!token) {
      return res.status(400).send(Buffer.from(''));
    }

    console.log('[tracking] processing request for token:', token);

    // Find message by tracking token
    const message = await prisma.outreachMessage.findFirst({
      where: { trackingToken: token },
      include: { contact: true },
    });

    console.log('[tracking] message found:', !!message);

    if (!message) {
      console.log('[tracking] no message found, returning 404');
      return res.status(404).send(Buffer.from(''));
    }

    // Check if already tracked (prevent double counting)
    const existingEvent = await prisma.outreachEvent.findFirst({
      where: {
        contactId: message.contactId,
        type: 'email_opened_inferred',
      },
    });

    console.log('[tracking] existing event:', !!existingEvent);

    if (!existingEvent) {
      await prisma.outreachEvent.create({
        data: {
          contactId: message.contactId,
          messageId: message.id,
          type: 'email_opened_inferred',
          status: 'opened',
          details: { trackingToken: token, ip: req.ip, userAgent: req.headers['user-agent'] },
        },
      });

      console.log('[tracking] created new event');

      // Update contact status if not already replied
      if (['SENT', 'SCHEDULED', 'DELIVERED_INFERRED', 'OPENED_INFERRED'].includes(message.contact.status)) {
        await prisma.outreachContact.update({
          where: { id: message.contactId },
          data: { status: 'OPENED_INFERRED' },
        });
        console.log('[tracking] updated contact status');
      }
    }

    // Return transparent 1x1 GIF
    const gifBuffer = Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      'base64'
    );

    res.set({
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
    });

    console.log('[tracking] sending response');
    res.send(gifBuffer);
    console.log('[tracking] response sent successfully');
  } catch (err) {
    console.error('[tracking] error:', err.message);
    console.error(err.stack);
    res.status(500).send(Buffer.from(''));
  }
});

// ─── Suppression List ──────────────────────────────────────────────

// GET /api/outreach/suppression — list suppressed emails
app.get('/api/outreach/suppression', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user?.id }, select: { orgId: true } });
    if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const list = await prisma.suppressionList.findMany({
      where: { tenantId: user.orgId },
      orderBy: { addedAt: 'desc' },
    });

    res.json({ success: true, data: list, count: list.length, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/outreach/suppression — add to suppression list
app.post('/api/outreach/suppression', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user?.id }, select: { orgId: true } });
    if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { email, reason } = req.body || {};
    if (!email) return res.status(400).json({ success: false, error: 'Email required' });

    await prisma.suppressionList.upsert({
      where: { tenantId_email: { tenantId: user.orgId, email } },
      create: { tenantId: user.orgId, email, reason: reason || 'manual' },
      update: { reason: reason || 'manual' },
    });

    res.json({ success: true, message: 'Email added to suppression list', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/outreach/suppression/:id — remove from suppression list
app.delete('/api/outreach/suppression/:id', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user?.id }, select: { orgId: true } });
    if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const result = await prisma.suppressionList.deleteMany({
      where: { id: req.params.id, tenantId: user.orgId },
    });
    if (result.count === 0) {
      return res.status(404).json({ success: false, error: 'Suppression entry not found' });
    }
    res.json({ success: true, message: 'Removed from suppression list', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Automação (aba "Ações automáticas" do app) ────────────────────────────
// P0 pente-fino 2026-10-09: a rota só existia no server legado de dev —
// em produção o botão de criar workflow estourava 404 em silêncio.

// POST /api/automation/workflow — cria regra de automação da organização.
app.post('/api/automation/workflow', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user?.id }, select: { orgId: true } });
    if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const { name, trigger, action } = req.body || {};
    if (!name || !trigger || !action) {
      return res.status(400).json({ success: false, error: 'name, trigger e action são obrigatórios' });
    }
    const workflow = await prisma.workflow.create({
      data: {
        orgId: user.orgId,
        name: String(name).slice(0, 200),
        trigger: String(trigger).slice(0, 100),
        action: String(action).slice(0, 100),
        status: 'active',
      },
    });
    res.status(201).json({
      success: true,
      workflow: {
        id: workflow.id,
        name: workflow.name,
        trigger: workflow.trigger,
        action: workflow.action,
        status: workflow.status,
        created_at: workflow.createdAt.toISOString(),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/automation/workflow — lista as regras da organização.
app.get('/api/automation/workflow', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user?.id }, select: { orgId: true } });
    if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const workflows = await prisma.workflow.findMany({
      where: { orgId: user.orgId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      success: true,
      workflows: workflows.map((w) => ({
        id: w.id, name: w.name, trigger: w.trigger, action: w.action, status: w.status,
        created_at: w.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// WHATSAPP (WAHA) — Webhook + API
// ============================================================================

// Mapeia um evento WAHA para um subject interno do NATS (`whatsapp.*`).
function whatsappSubjectForEvent(event) {
  const type = event && event.event;
  if (type === 'message') return whatsappNats.SUBJECTS.MESSAGE_RECEIVED;
  if (type === 'message.ack') return whatsappNats.SUBJECTS.MESSAGE_DELIVERED;
  if (type === 'session.status') {
    const mapped = whatsappEngine.mapWahaSessionStatus(event.payload && event.payload.status);
    return mapped === 'CONNECTED'
      ? whatsappNats.SUBJECTS.SESSION_CONNECTED
      : whatsappNats.SUBJECTS.SESSION_DISCONNECTED;
  }
  return 'whatsapp.events';
}

// POST /webhooks/whatsapp/waha — recebe eventos do WAHA.
// Valida a chave, resolve a sessão, publica no NATS e responde 2xx rápido.
// Processamento pesado fica no consumer NATS (fallback inline se NATS off).
app.post('/webhooks/whatsapp/waha', async (req, res) => {
  try {
    const key = req.headers['x-api-key'] || req.query.apiKey;
    if (!wahaProvider.verifyWebhookApiKey(key)) {
      return res.status(401).json({ success: false, error: 'Chave de webhook inválida' });
    }

    const event = req.body || {};
    const sessionName = event.session;
    if (!sessionName) {
      return res.status(400).json({ success: false, error: 'session ausente' });
    }

    // Identifica a conta (isolamento multi-tenant) apenas para validar.
    const account = await prisma.whatsAppAccount.findUnique({ where: { sessionName } });
    if (!account) {
      return res.status(404).json({ success: false, error: 'Sessão desconhecida' });
    }

    if (whatsappNats.isEnabled()) {
      await whatsappNats.publishEvent(whatsappSubjectForEvent(event), event);
    } else {
      // Fallback: processa inline (idempotente), sem bloquear a resposta.
      whatsappEngine
        .handleEvent(prisma, wahaProvider.WAHAWhatsAppProvider, { subject: event.event, payload: event })
        .catch((e) => console.error('[whatsapp:webhook] erro no processamento inline:', e.message));
    }

    res.json({ success: true, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[whatsapp:webhook] erro:', err.message);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// ─── Contas WhatsApp ────────────────────────────────────────────────────────

// POST /api/whatsapp/accounts — cria a conta (sessão determinística por workspace).
app.post('/api/whatsapp/accounts', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const sessionName = wahaProvider.deterministicSessionName(orgId);

    const existing = await prisma.whatsAppAccount.findUnique({ where: { sessionName } });
    if (existing) {
      return res.json({ success: true, data: existing, alreadyExists: true, timestamp: new Date().toISOString() });
    }

    const account = await prisma.whatsAppAccount.create({
      data: { orgId, userId: req.user.id || req.user.uid, provider: 'waha', sessionName, status: 'CREATED' },
    });

    res.json({ success: true, data: account, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// GET /api/whatsapp/accounts — lista contas do workspace.
app.get('/api/whatsapp/accounts', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const accounts = await prisma.whatsAppAccount.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, provider: true, sessionName: true, phoneNumber: true, status: true,
        metadata: true, createdAt: true, updatedAt: true,
      },
    });
    res.json({ success: true, data: accounts, count: accounts.length, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// GET /api/whatsapp/accounts/:id — detalha uma conta (reconcilia status com WAHA).
app.get('/api/whatsapp/accounts/:id', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const account = await prisma.whatsAppAccount.findFirst({ where: { id: req.params.id, orgId } });
    if (!account) return res.status(404).json({ success: false, error: 'Conta não encontrada' });

    await whatsappEngine.reconcileSessionStatus(prisma, wahaProvider.WAHAWhatsAppProvider, account);
    const fresh = await prisma.whatsAppAccount.findUnique({ where: { id: account.id } });

    res.json({ success: true, data: fresh, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// Aguarda o WhatsApp gerar um QR utilizável. O engine NOWEB demora alguns
// segundos após o start/restart para chegar a SCAN_QR_CODE, e o endpoint
// /auth/qr do WAHA só responde 200 nesse estado (antes devolve 422 após ~10s
// de espera interna). Sondamos o status da sessão e só então buscamos o QR.
async function waitForWhatsAppQr(provider, sessionName, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let status = null;
    try {
      status = (await provider.getSessionStatus(sessionName))?.status;
    } catch (_e) { /* sessão pode ainda não existir no WAHA */ }

    if (status === 'WORKING' || status === 'CONNECTED') {
      return { connected: true, qr: null };
    }
    if (status === 'SCAN_QR_CODE' || status === 'QRCODE') {
      const qr = await provider.getQRCode(sessionName);
      if (qr && qr.qrCode) return { connected: false, qr };
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { connected: false, qr: null };
}

// POST /api/whatsapp/accounts/:id/connect — inicia sessão e devolve o QR Code.
app.post('/api/whatsapp/accounts/:id/connect', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const account = await prisma.whatsAppAccount.findFirst({ where: { id: req.params.id, orgId } });
    if (!account) return res.status(404).json({ success: false, error: 'Conta não encontrada' });

    const provider = wahaProvider.WAHAWhatsAppProvider;
    try { await provider.createSession(account.sessionName); } catch (_e) { /* idempotente */ }

    // Sessão travada (FAILED) nunca sai do lugar com um simples start — o WAHA
    // responde "Session is already running" e não faz nada. Nesse caso (ou em
    // estados parados) reiniciamos/arrancamos de verdade a sessão.
    let currentStatus = null;
    try { currentStatus = (await provider.getSessionStatus(account.sessionName))?.status; } catch (e) { console.error(`[whatsapp] falha ao consultar status da sessão ${account.sessionName}:`, e.message); }
    if (currentStatus === 'FAILED') {
      try {
        await provider.restartSession(account.sessionName);
        console.log(`[whatsapp] sessão FAILED reiniciada: ${account.sessionName}`);
      } catch (e) {
        console.error(`[whatsapp] falha ao reiniciar sessão FAILED ${account.sessionName}:`, e.message);
      }
    } else if (!currentStatus || ['STOPPED', 'DISCONNECTED'].includes(currentStatus)) {
      await provider.startSession(account.sessionName);
    }

    await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { status: 'STARTING' } });

    const { connected, qr } = await waitForWhatsAppQr(provider, account.sessionName, 45000);
    if (connected) {
      await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { status: 'CONNECTED' } });
      return res.json({ success: true, data: { accountId: account.id, status: 'CONNECTED', qr: null }, timestamp: new Date().toISOString() });
    }
    if (qr && qr.qrCode) {
      await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { status: 'QR_REQUIRED' } });
    }

    res.json({ success: true, data: { accountId: account.id, status: qr && qr.qrCode ? 'QR_REQUIRED' : 'STARTING', qr }, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// GET /api/whatsapp/accounts/:id/qr — QR Code atualizado (re-pareamento).
app.get('/api/whatsapp/accounts/:id/qr', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const account = await prisma.whatsAppAccount.findFirst({ where: { id: req.params.id, orgId } });
    if (!account) return res.status(404).json({ success: false, error: 'Conta não encontrada' });

    // Se a sessão ainda está subindo (ou travou em FAILED), arruma e espera o QR
    // por um tempo curto antes de responder — evita "Mostrar QR" virar no-op.
    const provider = wahaProvider.WAHAWhatsAppProvider;
    let currentStatus = null;
    try { currentStatus = (await provider.getSessionStatus(account.sessionName))?.status; } catch (e) { console.error(`[whatsapp] falha ao consultar status da sessão ${account.sessionName}:`, e.message); }
    if (currentStatus === 'FAILED') {
      try { await provider.restartSession(account.sessionName); } catch (e) { console.error(`[whatsapp] falha ao reiniciar sessão ${account.sessionName}:`, e.message); }
    }

    const { connected, qr } = await waitForWhatsAppQr(provider, account.sessionName, 20000);
    if (connected) {
      await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { status: 'CONNECTED' } }).catch(() => {});
    }
    res.json({ success: true, data: { accountId: account.id, qr, connected }, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/accounts/:id/disconnect — desconecta (mantém dados).
app.post('/api/whatsapp/accounts/:id/disconnect', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const account = await prisma.whatsAppAccount.findFirst({ where: { id: req.params.id, orgId } });
    if (!account) return res.status(404).json({ success: false, error: 'Conta não encontrada' });

    try {
      await wahaProvider.WAHAWhatsAppProvider.stopSession(account.sessionName);
    } catch (e) {
      console.error(`[whatsapp] falha ao parar sessão ${account.sessionName}:`, e.message);
    }
    await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { status: 'STOPPED' } });

    res.json({ success: true, data: { accountId: account.id, status: 'STOPPED' }, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/accounts/:id/reconnect — reconecta uma sessão existente.
app.post('/api/whatsapp/accounts/:id/reconnect', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const account = await prisma.whatsAppAccount.findFirst({ where: { id: req.params.id, orgId } });
    if (!account) return res.status(404).json({ success: false, error: 'Conta não encontrada' });

    const provider = wahaProvider.WAHAWhatsAppProvider;
    let currentStatus = null;
    try { currentStatus = (await provider.getSessionStatus(account.sessionName))?.status; } catch (e) { console.error(`[whatsapp] falha ao consultar status da sessão ${account.sessionName}:`, e.message); }
    if (currentStatus === 'FAILED') {
      await provider.restartSession(account.sessionName);
    } else {
      await provider.startSession(account.sessionName);
    }
    await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { status: 'STARTING' } });

    const { qr } = await waitForWhatsAppQr(provider, account.sessionName, 30000);
    if (qr && qr.qrCode) {
      await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { status: 'QR_REQUIRED' } });
    }

    res.json({ success: true, data: { accountId: account.id, status: qr && qr.qrCode ? 'QR_REQUIRED' : 'STARTING', qr }, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// DELETE /api/whatsapp/accounts/:id — remove a conta (logout + delete da sessão).
app.delete('/api/whatsapp/accounts/:id', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const account = await prisma.whatsAppAccount.findFirst({ where: { id: req.params.id, orgId } });
    if (!account) return res.status(404).json({ success: false, error: 'Conta não encontrada' });

    try { await wahaProvider.WAHAWhatsAppProvider.logout(account.sessionName); } catch (e) { console.error(`[whatsapp] falha ao deslogar sessão ${account.sessionName}:`, e.message); }
    try { await wahaProvider.WAHAWhatsAppProvider.deleteSession(account.sessionName); } catch (e) { console.error(`[whatsapp] falha ao apagar sessão ${account.sessionName}:`, e.message); }
    await prisma.whatsAppAccount.delete({ where: { id: account.id } });

    res.json({ success: true, message: 'Conta removida', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ─── Conversas (inbox) ──────────────────────────────────────────────────────

// GET /api/whatsapp/conversations — lista conversas do workspace.
app.get('/api/whatsapp/conversations', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const conversations = await prisma.whatsAppConversation.findMany({
      where: { orgId },
      orderBy: { lastMessageAt: 'desc' },
      include: {
        whatsappAccount: { select: { id: true, phoneNumber: true, status: true } },
        _count: { select: { messages: true } },
      },
    });

    // Enriquecer com nome do prospect (sem N+1 pesado).
    const prospectIds = [...new Set(conversations.map((c) => c.prospectId).filter(Boolean))];
    const prospects = prospectIds.length
      ? await prisma.prospect.findMany({ where: { id: { in: prospectIds } }, select: { id: true, companyName: true, cnpj: true, city: true, state: true } })
      : [];
    const prospectMap = new Map(prospects.map((p) => [p.id, p]));

    const data = conversations.map((c) => ({ ...c, prospect: c.prospectId ? prospectMap.get(c.prospectId) || null : null }));

    res.json({ success: true, data, count: data.length, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// GET /api/whatsapp/conversations/:id — detalha uma conversa.
app.get('/api/whatsapp/conversations/:id', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const conversation = await prisma.whatsAppConversation.findFirst({
      where: { id: req.params.id, orgId },
      include: { whatsappAccount: { select: { id: true, phoneNumber: true, status: true } } },
    });
    if (!conversation) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });

    const prospect = conversation.prospectId
      ? await prisma.prospect.findUnique({ where: { id: conversation.prospectId }, select: { id: true, companyName: true, cnpj: true, city: true, state: true, industry: true } })
      : null;

    res.json({ success: true, data: { ...conversation, prospect }, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// GET /api/whatsapp/conversations/:id/messages — histórico.
app.get('/api/whatsapp/conversations/:id/messages', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const conversation = await prisma.whatsAppConversation.findFirst({ where: { id: req.params.id, orgId }, select: { id: true } });
    if (!conversation) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });

    const messages = await prisma.whatsAppMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ success: true, data: messages, count: messages.length, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/conversations/:id/messages — resposta manual (handoff).
app.post('/api/whatsapp/conversations/:id/messages', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const conversation = await prisma.whatsAppConversation.findFirst({
      where: { id: req.params.id, orgId },
      include: { whatsappAccount: true },
    });
    if (!conversation) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });

    const { text } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ success: false, error: 'text é obrigatório' });
    }

    let account = conversation.whatsappAccount;
    if (!account) return res.status(409).json({ success: false, error: 'Conta WhatsApp não conectada' });

    // O status no banco pode estar defasado (ex.: evento DISCONNECTED
    // transitório durante restart do WAHA): reconcilia com o WAHA antes de
    // rejeitar o envio.
    if (account.status !== 'CONNECTED') {
      await whatsappEngine.reconcileSessionStatus(prisma, wahaProvider.WAHAWhatsAppProvider, account);
      account = await prisma.whatsAppAccount.findUnique({ where: { id: account.id } });
      if (!account || account.status !== 'CONNECTED') {
        return res.status(409).json({ success: false, error: 'Conta WhatsApp não conectada' });
      }
    }

    // Prefere o JID original da conversa (chats LID/grupo não entregam se o
    // chatId for reconstruído como "<digits>@c.us").
    const chatId = conversation.chatId || whatsappUtils.toChatId(conversation.phoneNumber);
    const result = await wahaProvider.WAHAWhatsAppProvider.sendText(account.sessionName, chatId, String(text).trim());

    const now = new Date();
    const message = await prisma.whatsAppMessage.create({
      data: {
        conversationId: conversation.id,
        orgId,
        direction: 'OUTBOUND',
        type: 'TEXT',
        content: String(text).trim(),
        providerMessageId: result.providerMessageId,
        status: 'SENT',
        sentAt: now,
      },
    });

    await prisma.whatsAppConversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: now, assignedTo: req.user.id || req.user.uid || conversation.assignedTo, status: 'ACTIVE' },
    });

    res.json({ success: true, data: message, timestamp: now.toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/conversations/:id/assign — assume a conversa.
app.post('/api/whatsapp/conversations/:id/assign', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const conversation = await prisma.whatsAppConversation.findFirst({ where: { id: req.params.id, orgId } });
    if (!conversation) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });

    await prisma.whatsAppConversation.update({
      where: { id: conversation.id },
      data: { assignedTo: req.user.id || req.user.uid },
    });

    res.json({ success: true, data: { id: conversation.id, assignedTo: req.user.id || req.user.uid }, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ─── Automação de reengajamento (agente de IA) ───────────────────────────────

// GET /api/whatsapp/automation/config — configuração vigente do agente (leitura).
app.get('/api/whatsapp/automation/config', async (req, res) => {
  try {
    await requireRequestOrgId(req);
    const { enabled, mode, maxAttempts, maxTotal, cooldownHours, minGapHours, dailyCap, scanIntervalMin } = reengagementAgent.CONFIG;
    const { enabled: replyEnabled, mode: replyMode, maxRepliesPerConversation, dailyCap: replyDailyCap, includeCampaign } = reengagementReply.CONFIG;
    res.json({ success: true, data: { enabled, mode, maxAttempts, maxTotal, cooldownHours, minGapHours, dailyCap, scanIntervalMin, reply: { enabled: replyEnabled, mode: replyMode, maxRepliesPerConversation, dailyCap: replyDailyCap, includeCampaign } }, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// GET /api/whatsapp/automation/suggestions — fila de aprovação (modo suggest).
app.get('/api/whatsapp/automation/suggestions', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const events = await reengagementAgent.listSuggestions(prisma, orgId, Number(req.query.limit) || 50);

    const conversationIds = [...new Set(events.map((e) => e.conversationId))];
    const conversations = conversationIds.length
      ? await prisma.whatsAppConversation.findMany({
          where: { id: { in: conversationIds }, orgId },
          select: { id: true, phoneNumber: true, chatId: true, prospectId: true },
        })
      : [];
    const convMap = new Map(conversations.map((c) => [c.id, c]));
    const prospectIds = [...new Set(conversations.map((c) => c.prospectId).filter(Boolean))];
    const prospects = prospectIds.length
      ? await prisma.prospect.findMany({ where: { id: { in: prospectIds } }, select: { id: true, companyName: true, tradeName: true } })
      : [];
    const prospectMap = new Map(prospects.map((p) => [p.id, p]));

    const data = events.map((e) => {
      const conv = convMap.get(e.conversationId);
      const prospect = conv && conv.prospectId ? prospectMap.get(conv.prospectId) || null : null;
      return { ...e, conversation: conv || null, prospect };
    });

    res.json({ success: true, data, count: data.length, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/automation/suggestions/:id/approve — aprova (e envia).
// Body opcional: { content } para o operador editar o texto antes de enviar.
app.post('/api/whatsapp/automation/suggestions/:id/approve', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const result = await reengagementAgent.approveSuggestion(prisma, {
      orgId,
      eventId: req.params.id,
      content: req.body && req.body.content,
    });
    if (result.error) {
      const status = { not_found: 404, not_pending: 409, paused: 409, conversation_OPTED_OUT: 409, conversation_PAUSED: 409, do_not_contact: 409, lead_responded: 409, empty_content: 400 }[result.error] || 400;
      return res.status(status).json({ success: false, error: result.error });
    }
    res.json({ success: true, data: result.message, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/automation/suggestions/:id/discard — descarta a sugestão.
app.post('/api/whatsapp/automation/suggestions/:id/discard', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const result = await reengagementAgent.discardSuggestion(prisma, {
      orgId,
      eventId: req.params.id,
      reason: req.body && req.body.reason,
    });
    if (result.error) {
      const status = { not_found: 404, not_pending: 409 }[result.error] || 400;
      return res.status(status).json({ success: false, error: result.error });
    }
    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// GET /api/whatsapp/conversations/:id/automation — estado da automação + últimos eventos.
app.get('/api/whatsapp/conversations/:id/automation', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const state = await reengagementAgent.getConversationAutomation(prisma, { orgId, conversationId: req.params.id });
    if (!state) return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
    res.json({ success: true, data: state, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/conversations/:id/automation/pause — kill switch por conversa.
app.post('/api/whatsapp/conversations/:id/automation/pause', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const result = await reengagementAgent.pauseConversationAutomation(prisma, { orgId, conversationId: req.params.id });
    if (result.error) return res.status(404).json({ success: false, error: result.error });
    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/conversations/:id/automation/resume — reativa a automação.
app.post('/api/whatsapp/conversations/:id/automation/resume', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const result = await reengagementAgent.resumeConversationAutomation(prisma, { orgId, conversationId: req.params.id });
    if (result.error) return res.status(404).json({ success: false, error: result.error });
    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/prospects/:id/do-not-contact — bloqueio manual.
app.post('/api/whatsapp/prospects/:id/do-not-contact', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const prospect = await prisma.prospect.findFirst({ where: { id: req.params.id, orgId }, select: { id: true } });
    if (!prospect) return res.status(404).json({ success: false, error: 'Lead não encontrado' });

    const result = await whatsappEngine.markDoNotContact(prisma, { orgId, prospectId: prospect.id, reason: 'manual' });
    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ─── Campanhas ──────────────────────────────────────────────────────────────

// GET /api/whatsapp/campaigns — lista campanhas.
app.get('/api/whatsapp/campaigns', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const campaigns = await prisma.whatsAppCampaign.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      include: {
        steps: { orderBy: { orderIndex: 'asc' } },
        whatsappAccount: { select: { id: true, phoneNumber: true, status: true } },
        _count: { select: { contacts: true } },
      },
    });
    res.json({ success: true, data: campaigns, count: campaigns.length, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// GET /api/whatsapp/campaigns/:id — detalha uma campanha.
app.get('/api/whatsapp/campaigns/:id', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const campaign = await prisma.whatsAppCampaign.findFirst({
      where: { id: req.params.id, orgId },
      include: {
        steps: { orderBy: { orderIndex: 'asc' } },
        whatsappAccount: { select: { id: true, phoneNumber: true, status: true } },
        contacts: { include: { prospect: { select: { id: true, companyName: true, cnpj: true } } } },
      },
    });
    if (!campaign) return res.status(404).json({ success: false, error: 'Campanha não encontrada' });

    res.json({ success: true, data: campaign, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/campaigns — cria campanha + sequência de etapas.
app.post('/api/whatsapp/campaigns', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const { name, whatsappAccountId, steps, objective, offer, ctaUrl } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: 'name é obrigatório' });
    }

    const account = whatsappAccountId
      ? await prisma.whatsAppAccount.findFirst({ where: { id: whatsappAccountId, orgId }, select: { id: true } })
      : null;
    if (whatsappAccountId && !account) {
      return res.status(400).json({ success: false, error: 'Conta WhatsApp inválida' });
    }

    const normalizedSteps = Array.isArray(steps) && steps.length
      ? steps.map((s, i) => ({
          orderIndex: Number.isInteger(s.orderIndex) ? s.orderIndex : i,
          messageTemplate: String(s.messageTemplate || ''),
          delayMinutes: Number(s.delayMinutes) || 0,
          conditions: Array.isArray(s.conditions) ? s.conditions : [],
        })).filter((s) => s.messageTemplate.trim())
      : null;

    // Guard de ingestão (007): cada step passa pela validação de conteúdo.
    if (normalizedSteps) {
      for (const [i, step] of normalizedSteps.entries()) {
        if (!validateOutreachTemplatesOr400(res, [[`steps[${i}].messageTemplate`, step.messageTemplate, 600]])) return;
      }
    }

    const campaign = await prisma.whatsAppCampaign.create({
      data: {
        orgId,
        name: String(name).trim(),
        objective: objective ? String(objective).trim() : null,
        offer: offer ? String(offer).trim() : null,
        ctaUrl: ctaUrl ? String(ctaUrl).trim() : null,
        whatsappAccountId: account ? account.id : null,
        status: 'DRAFT',
        ...(normalizedSteps ? {
          steps: { create: normalizedSteps },
        } : {}),
      },
      include: { steps: { orderBy: { orderIndex: 'asc' } } },
    });

    res.json({ success: true, data: campaign, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/campaigns/:id/start — inicia a campanha nos leads selecionados.
app.post('/api/whatsapp/campaigns/:id/start', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const { prospectIds } = req.body || {};
    if (!prospectIds || !Array.isArray(prospectIds) || prospectIds.length === 0) {
      return res.status(400).json({ success: false, error: 'prospectIds é obrigatório (array)' });
    }

    // Governança de template (007 — FR-008/FR-012): campanha retida pelo
    // saneamento ou sem etapas de sequência não pode disparar.
    const startGuard = await assertWhatsAppCampaignLaunchable(orgId, req.params.id);
    if (!startGuard.ok) {
      return res.status(409).json({ success: false, code: startGuard.code, error: startGuard.message });
    }

    // Isolamento: os leads devem pertencer ao org do usuário.
    const owned = await prisma.prospect.findMany({
      where: { id: { in: prospectIds }, orgId },
      select: { id: true },
    });
    if (owned.length !== new Set(prospectIds).size) {
      return res.status(400).json({ success: false, error: 'Um ou mais leads não pertencem à sua conta.' });
    }

    const result = await whatsappWorkers.startCampaign(prisma, { campaignId: req.params.id, prospectIds, orgId });
    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/campaigns/:id/pause — pausa a campanha.
app.post('/api/whatsapp/campaigns/:id/pause', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const result = await whatsappWorkers.pauseCampaign(prisma, { campaignId: req.params.id, orgId });
    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/campaigns/:id/resume — retoma a campanha.
app.post('/api/whatsapp/campaigns/:id/resume', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    // Retenção do saneamento (FR-008): revalidar antes de retomar.
    const campaign = await prisma.whatsAppCampaign.findFirst({ where: { id: req.params.id, orgId } });
    if (!campaign) return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
    if (campaign.needsReview) {
      return res.status(409).json({
        success: false,
        code: 'CAMPAIGN_REVIEW_REQUIRED',
        error: 'Esta campanha foi retida para revisão do template (rederive ou edite a mensagem antes de retomar).',
      });
    }
    const result = await whatsappWorkers.resumeCampaign(prisma, { campaignId: req.params.id, orgId });
    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// PATCH /api/whatsapp/campaigns/:id — edita as etapas da sequência (contrato
// 007 §3). Sucesso limpa a retenção do saneamento, mas NÃO reativa a campanha:
// reativação é sempre ação explícita (resume/start).
app.patch('/api/whatsapp/campaigns/:id', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const campaign = await prisma.whatsAppCampaign.findFirst({
      where: { id: req.params.id, orgId },
      include: { steps: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!campaign) return res.status(404).json({ success: false, error: 'Campanha não encontrada' });

    const { steps } = req.body || {};
    if (!Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ success: false, error: 'steps é obrigatório (array)' });
    }

    const { validateTemplateMessage } = require('./whatsapp-utils');
    const updates = [];
    for (const [i, incoming] of steps.entries()) {
      const target = campaign.steps.find((st) => st.id === incoming.id || st.orderIndex === incoming.orderIndex);
      if (!target) {
        return res.status(400).json({ success: false, error: `steps[${i}]: etapa não encontrada nesta campanha` });
      }
      if (incoming.messageTemplate !== undefined) {
        const guard = validateTemplateMessage(incoming.messageTemplate);
        if (!guard.ok) {
          return res.status(400).json({
            success: false,
            code: 'TEMPLATE_REJECTED',
            error: `Mensagem rejeitada (${guard.reason}).`,
          });
        }
        updates.push({ id: target.id, data: { messageTemplate: incoming.messageTemplate } });
      }
      if (incoming.delayMinutes !== undefined) {
        updates.push({ id: target.id, data: { delayMinutes: Number(incoming.delayMinutes) || 0 } });
      }
    }
    for (const u of updates) {
      await prisma.whatsAppSequenceStep.update({ where: { id: u.id }, data: u.data });
    }
    if (campaign.needsReview) {
      await prisma.whatsAppCampaign.update({
        where: { id: campaign.id },
        data: { needsReview: false, reviewReason: null },
      });
    }

    const updated = await prisma.whatsAppCampaign.findFirst({
      where: { id: campaign.id, orgId },
      include: { steps: { orderBy: { orderIndex: 'asc' } } },
    });
    res.json({ success: true, data: updated, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/campaigns/:id/rederive — regera a mensagem base a partir
// do perfil comercial da org (atalho de revalidação do saneamento — 007 §4).
// Mantém a campanha pausada: reativação é ação explícita do tenant.
app.post('/api/whatsapp/campaigns/:id/rederive', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const result = await aiCampaign.rederiveWhatsAppBase(prisma, { orgId, campaignId: req.params.id });
    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (err) {
    if (err.code && err.status) {
      return res.status(err.status).json({ success: false, code: err.code, error: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/outreach/campaigns/:id/rederive — regera o template de email
// (assunto + corpo) a partir do perfil comercial (007 §4).
app.post('/api/outreach/campaigns/:id/rederive', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    const result = await aiCampaign.rederiveEmailBase(prisma, { orgId: user.orgId, campaignId: req.params.id });
    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (err) {
    if (err.code && err.status) {
      return res.status(err.status).json({ success: false, code: err.code, error: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/campaigns/:id/cancel — cancela a campanha.
app.post('/api/whatsapp/campaigns/:id/cancel', async (req, res) => {
  try {
    const orgId = await requireRequestOrgId(req);
    const result = await whatsappWorkers.cancelCampaign(prisma, { campaignId: req.params.id, orgId });
    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// SPA fallback: serve index.html for extensionless GET requests that accept
// HTML (e.g. the Firebase OAuth redirect landing page /auth/callback and any
// future client-side routes). API and asset requests keep a 404 JSON response.
app.use((req, res) => {
  if (
    req.method === 'GET' &&
    !req.path.startsWith('/api/') &&
    !req.path.startsWith('/__/') &&
    !path.extname(req.path) &&
    req.accepts('html')
  ) {
    const reactIndexPath = path.join(__dirname, 'apps', 'web', 'dist', 'index.html');
    if (fs.existsSync(reactIndexPath)) {
      return res.sendFile(reactIndexPath);
    }
  }

  res.status(404).json({ success: false, error: 'Route not found' });
});

// Start server
async function start() {
  try {
    DEFAULT_ORG_ID = await initDatabase();

    // Initialize token encryption
    gmailAuth.initEncryption();

    // Inicia o pipeline NATS (consumer de resultados + monitor de DLQ) quando
    // habilitado. Não bloqueia o boot caso o NATS esteja indisponível.
    if (natsEnrichment.isNatsEnabled()) {
      natsEnrichment.startEnrichmentConsumer(prisma);
      natsEnrichment.startDlqMonitor();
      // Motor v2: consumidor de qualificação desacoplado (US7) + consumer de
      // resultados do manager. Falhas isoladas — nunca bloqueiam o boot.
      if (enrichmentConfig.isEngineV2Enabled()) {
        try {
          // T061: consumidor de resultados do manager (aplica fatos aos leads).
          enrichmentManager.startResultConsumer()
            .catch((err) => console.error(`[enrichment] consumer do manager não iniciado: ${err.message}`));
        } catch (err) {
          console.error(`[enrichment] falha ao iniciar consumer do manager: ${err.message}`);
        }
        try {
          const { createQualificationConsumer } = require('./qualification');
          const { createLogger } = require('./logger');
          const consumer = createQualificationConsumer({
            prisma,
            logger: createLogger({ component: 'qualification' }),
            onMetric: (name) => { if (name.includes('failures') && metrics.incQualificationFailure) metrics.incQualificationFailure(); },
          });
          consumer.start().catch((err) => console.error(`[qualification] consumer não iniciado: ${err.message}`));
        } catch (err) {
          console.error(`[qualification] falha ao iniciar consumidor: ${err.message}`);
        }
      }
    } else {
      console.log('[nats] NATS desabilitado - usando enriquecimento síncrono BrasilAPI.');
    }

    // Retoma prospects que ficaram presos em 'pending' por reinício do pod
    // (jobs de enriquecimento são em memória e não sobrevivem ao restart).
    await resumePendingEnrichments(prisma);

    // Feature 006: sweeper de tasks PARKED (re-publicação com taxa por
    // provedor) — drena o backlog de forma controlada.
    try {
      getSweeper().startLoop();
      console.log('[sweeper] loop de tasks PARKED iniciado');
    } catch (err) {
      console.error('[sweeper] falha ao iniciar loop:', err.message);
    }

    // Feature 006: gauges de resiliência (parked por provedor, jobs DEGRADED)
    // + detector de circuito aberto > 1h (alerta deduplicado por hora).
    const resilienceTick = async () => {
      try {
        const metrics = require('./metrics');
        if (!metrics.isEnabled()) return;
        // Gauges de resiliência: parked por provedor + jobs DEGRADED.
        const parkedRows = await prisma.enrichmentTask.groupBy({
          by: ['lastError', 'orgId'],
          where: { status: 'PARKED' },
          _count: true,
        }).catch(() => []);
        for (const row of parkedRows) {
          const provider = (row.lastError && row.lastError.provider) || 'unknown';
          metrics.setEnrichmentTasksParked(provider, row._count, row.orgId);
        }
        metrics.setEnrichmentJobsDegraded(
          await prisma.enrichmentJob.count({ where: { status: 'DEGRADED' } }).catch(() => 0)
        );
        // Circuitos (estado no Redis do provider-registry); OPEN > 1h alerta 1×/hora.
        const circuitKeys = await _sweeperRedis.keys('cb:*:state').catch(() => []);
        for (const key of circuitKeys) {
          const provider = String(key).match(/cb:(.+):state/);
          if (!provider) continue;
          const num = await getSweeperCircuitState(provider[1]);
          metrics.setEnrichmentProviderCircuit(provider[1], num);
          if (num === 2) {
            await enrichmentNotifier
              .notifyCircuitOpen({ provider: provider[1], affected: await prisma.enrichmentTask.count({ where: { status: 'PARKED' } }).catch(() => 0) })
              .catch(() => {});
          }
        }
      } catch (err) {
        console.error('[resilience] tick falhou:', err.message);
      }
    };
    resilienceTick();
    const resilienceTimer = setInterval(resilienceTick, 60000);
    if (resilienceTimer.unref) resilienceTimer.unref();

    // Feature 006 (FR-016): digest diário às 12:00 UTC — dedup por dia no
    // próprio notifier; tick por minuto só dispara no minuto exato.
    let digestSentOn = null;
    const digestTick = async () => {
      try {
        const d = new Date();
        if (d.getUTCHours() !== 12 || d.getUTCMinutes() !== 0) return;
        const day = d.toISOString().slice(0, 10);
        if (digestSentOn === day) return;
        digestSentOn = day;
        const since = new Date(d.getTime() - 86400e3);
        const completed24h = await prisma.enrichmentTask.count({
          where: { status: 'COMPLETED', updatedAt: { gte: since } },
        }).catch(() => 0);
        const failedTasks = await prisma.enrichmentTask.findMany({
          where: { status: 'FAILED', updatedAt: { gte: since } },
          select: { lastError: true },
        }).catch(() => []);
        const failedByReason = {};
        for (const f of failedTasks) {
          const t = (f.lastError && f.lastError.type) || 'UNKNOWN';
          failedByReason[t] = (failedByReason[t] || 0) + 1;
        }
        const successRate = completed24h + failedTasks.length > 0
          ? completed24h / (completed24h + failedTasks.length)
          : 1;
        const parkedOldest = (await prisma.enrichmentTask.findMany({
          where: { status: 'PARKED' },
          orderBy: { parkedAt: 'asc' },
          take: 5,
        }).catch(() => [])).map((t) => ({
          companyName: t.taskKey.slice(0, 30),
          hours: Math.round((d - new Date(t.parkedAt || t.createdAt)) / 3600e3),
        }));
        await enrichmentNotifier.sendDailyDigest({
          completed24h, failedByReason, parkedOldest, successRate,
        });
        console.log(`[notifier] digest diário enviado (${day})`);
      } catch (err) {
        console.error('[notifier] digest diário falhou:', err.message);
      }
    };
    const digestTimer = setInterval(digestTick, 60000);
    if (digestTimer.unref) digestTimer.unref();

    // Feature 005: re-despacha análises profundas presas em 'running' (pod
    // reiniciou no meio) e leads parados em not_started — mesmo padrão da
    // retomada de enriquecimentos acima (R6). Fire-and-forget.
    deepAnalysis
      .getSharedRunner(prisma)
      .reconcile()
      .then((result) => {
        if (result.reconciled > 0) {
          console.log(`[deep-analysis] reconcile no boot: ${result.reconciled} re-despachadas`);
        }
      })
      .catch((err) => console.error('[deep-analysis] reconcile no boot falhou:', err.message));

    // Inicia workers de outreach (BullMQ)
    try {
      const workers = outreachWorkers.registerAllWorkers(prisma);
      console.log('[outreach] workers initialized');
    } catch (err) {
      console.error('[outreach] failed to initialize workers:', err.message);
      console.log('[outreach] continuing without workers (BullMQ/Redis unavailable)');
    }

    // Inicia workers do canal WhatsApp (WAHA) + consumer NATS + resume de sessões.
    try {
      whatsappWorkers.registerAllWorkers();
      console.log('[whatsapp] workers initialized');
    } catch (err) {
      console.error('[whatsapp] failed to initialize workers:', err.message);
      console.log('[whatsapp] continuing without WhatsApp workers');
    }

    // Campaign Studio (specs/010): scheduler com janelas/ritmo (repeat 60s)
    // e rollup de métricas (repeat 5min).
    try {
      require('./studio/scheduler-worker').registerStudioScheduler(prisma);
      require('./studio/analytics-service').registerStudioMetrics(prisma);
      require('./studio/analytics-service').registerSnapshotPurge(prisma);
      // specs/011 (AD-8): revalidação DNS diária do domínio de envio —
      // falha → floor do saldo efetivo zero (o gate bloqueia com instrução).
      require('./studio/dns-verify').registerDailyJob(prisma);
      // specs/011 (FR-17): reposição diária do saldo (rampa de warm-up +
      // engajamento positivo sobe o estágio) para toda account existente.
      try {
        const reputation = require('./studio/reputation');
        const { createQueue } = require('./outreach-queues');
        const reputationQueue = createQueue('studio:reputation:daily');
        reputationQueue
          .add('daily', {}, { repeat: { cron: '0 0 * * *' }, jobId: 'studio-reputation-daily' })
          .then(() => console.log('[studio:reputation] ✓ reposição diária registrada (00:00 UTC = 21h BRT)'))
          .catch((err) => console.error('[studio:reputation] falha ao registrar repeat job:', err.message));
        reputationQueue.process(async () => {
          // Saldo ÚNICO (2026-10-08): uma linha 'unified' por org — reposição
          // e rampa por org (os caps diários por canal derivam do estágio e
          // os contadores zeram lazily na virada do usageDay).
          const accounts = await prisma.studioReputationAccount.findMany();
          for (const account of accounts) {
            try {
              await reputation.applyDailyReplenishment(prisma, account.orgId);
              await reputation.promoteRamp(prisma, account.orgId);
            } catch (err) {
              console.error('[studio:reputation] reposição falhou para', account.orgId, account.channel, err.message);
            }
          }
          return { accounts: accounts.length };
        });
      } catch (err) {
        console.error('[studio:reputation] registro indisponível:', err.message);
      }
    } catch (err) {
      console.error('[studio] failed to initialize workers:', err.message);
    }

    // Agente de reengajamento de conversas frias (shadow|auto via REENGAGE_MODE).
    try {
      await reengagementAgent.startReengagement();
    } catch (err) {
      console.error('[reengage] failed to start:', err.message);
    }

    // Resposta rápida do agente quando o lead responde (continuação automática).
    try {
      await reengagementReply.startReengagementReply();
    } catch (err) {
      console.error('[reengage-reply] failed to start:', err.message);
    }

    if (whatsappNats.isEnabled()) {
      whatsappNats.startConsumer(prisma, async ({ subject, payload }) => {
        await whatsappEngine.handleEvent(prisma, wahaProvider.WAHAWhatsAppProvider, { subject, payload });
      });
    } else {
      console.log('[whatsapp] NATS desabilitado — eventos processados inline no webhook.');
    }

    // Conexão durável: retoma sessões conectadas após reinício do servidor.
    try {
      const resumed = await whatsappEngine.resumeSessions(prisma, wahaProvider.WAHAWhatsAppProvider);
      if (resumed > 0) console.log(`[whatsapp] ${resumed} sessão(ões) retomada(s) no boot.`);
    } catch (err) {
      console.error('[whatsapp] falha ao retomar sessões:', err.message);
    }

    // Endpoint de métricas Prometheus (METRICS_PORT, default 9090).
    metrics.startMetricsServer(prisma);

    app.listen(PORT, () => {
      console.log('');
      console.log('╔════════════════════════════════════════════╗');
      console.log('║  B2Base Platform - PRODUCTION MODE 🚀  ║');
      console.log('╠════════════════════════════════════════════╣');
      console.log('║                                            ║');
      console.log('║  📊 Database: PostgreSQL (localhost:5432) ║');
      console.log(`║  🌐 Dashboard: http://localhost:${PORT}          ║`);
      console.log('║                                            ║');
      console.log(`║  📡 NATS enrichment: ${natsEnrichment.isNatsEnabled() ? 'ON' : 'OFF'}        ║`);
      console.log('║  🔐 Firebase auth: Google + email + phone              ║');
      console.log('║  📧 Outreach (Gmail): configured           ║');
      console.log('║  ✅ Real data from database (no mock!)     ║');
      console.log('║  ✅ All CRUD operations supported          ║');
      console.log('║  ✅ Error handling & validation            ║');
      console.log('║  ✅ Production-ready code                  ║');
      console.log('║                                            ║');
      console.log('║  Press Ctrl+C to stop                      ║');
      console.log('║                                            ║');
      console.log('╚════════════════════════════════════════════╝');
      console.log('');
    });
  } catch (error) {
    console.error('Server startup error:', error);
    process.exit(1);
  }
}

// Saneamento idempotente de campanhas IA legadas (007 — FR-008): roda em
// background no boot; falha não derruba o servidor. Desativar com
// SANITIZE_LEGACY_CAMPAIGNS=off.
if (process.env.SANITIZE_LEGACY_CAMPAIGNS !== 'off') {
  setImmediate(() => {
    aiCampaign.sanitizeLegacyCampaigns(prisma)
      .then((stats) => console.log(
        '[sanitize-legacy] concluído:', JSON.stringify(stats)
      ))
      .catch((err) => console.error('[sanitize-legacy] falhou (não fatal):', err.message));
  });
}

// Epic 2 (FR7/D1): backfill dos embeddings de captura no boot — fire-and-forget,
// idempotente/resumável (só linhas NULL) e NÃO fatal (gateway de embeddings
// fora não pode derrubar o servidor; a captura segue lexical-only). Teto por
// execução; o próximo boot retoma. Desativar com STUDIO_EMBEDDINGS_BACKFILL=off.
if (process.env.STUDIO_EMBEDDINGS_BACKFILL !== 'off') {
  setImmediate(() => {
    require('./jobs/embeddings-backfill').runEmbeddingsBackfill(prisma)
      .then((result) => console.log('[embeddings-backfill] concluído:', JSON.stringify(result)))
      .catch((err) => console.error('[embeddings-backfill] falhou (não fatal):', err.message));
  });
}

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await natsEnrichment.shutdown();
  await whatsappNats.shutdown();
  await closeAllWorkers();
  await closeAllQueues();
  await closeWhatsAppQueues();
  await prisma.$disconnect();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  console.log('\nShutting down (SIGTERM)...');
  await natsEnrichment.shutdown();
  await whatsappNats.shutdown();
  await closeAllWorkers();
  await closeAllQueues();
  await closeWhatsAppQueues();
  await prisma.$disconnect();
  process.exit(0);
});

start();
