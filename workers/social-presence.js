// =============================================================================
// workers/social-presence.js — worker company.social_presence (maigret, MIT).
//
// Mapeia a presença social da EMPRESA por @handle (fantasia/razão social):
// o driver Python (social-presence-driver.py) roda a biblioteca maigret sobre
// ~200 sites-chave e emite NDJSON no stdout; este worker parseia, crawleia as
// páginas de perfil mais valiosas e devolve perfis + contato público achado.
// Contato wa.me/telefone volta em data.contacts[{type:'whatsapp'}] — o
// enrichment-manager promove para a FRENTE de cnpjPhones (mesmo caminho do
// digital_presence), destravando o disparo.
//
// LGPD: modo "pessoa de contato" (contactName como candidato) SÓ com
// SOCIAL_OSINT_PERSON=true — desligado por padrão.
//
// APENAS lógica de negócio aqui — infra é do SDK (workers/sdk).
// Rodar: `node workers/social-presence.js` (requer `pip install maigret`).
// =============================================================================

const { spawn } = require('child_process');
const path = require('path');
const { createWorkerRuntime } = require('./sdk/runtime');
const dp = require('./digital-presence');

const DEADLINE_MS = Number(process.env.SOCIAL_PRESENCE_TIMEOUT_MS || 150000);
const PERSON_MODE = process.env.SOCIAL_OSINT_PERSON === 'true';

// Perfis que mais valem para negócio BR — crawleio primeiro em busca de contato.
const PROFILE_CRAWL_PRIORITY = /(instagram|tiktok|facebook|youtube|linkedin|linktr|taplink|ifood|cardapio)/i;
const PROFILE_CRAWL_MAX = 5;

/** Candidatos de @handle da empresa: slug do fantasia/razão (e contato só com flag). */
function buildHandleCandidates({ companyName, tradeName, contactName, city }) {
  const out = [];
  const push = (value) => {
    const slug = slugOf(value);
    if (slug && slug.length >= 4 && slug.length <= 40 && !out.includes(slug)) out.push(slug);
  };
  function slugOf(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, 'e')
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 40);
  }
  // searchableName limpa sufixos societários (LTDA/COMERCIO DE…) do slug —
  // 'purpleiceacaicomerciodealimentosltda' não é handle de rede social.
  const searchName = dp.searchableName({ companyName, tradeName });
  push(searchName);
  if (city) push(`${searchName}${city}`);
  if (PERSON_MODE) push(contactName);
  return out.slice(0, 4);
}

/** Roda o driver Python e devolve as linhas NDJSON parseadas (parcial OK). */
function runDriverScan(candidates, { signal, deadlineMs = DEADLINE_MS } = {}) {
  // Driver/python lidos NA CHAMADA (env sobrescrevível por teste/deploy).
  const driver = process.env.SOCIAL_PRESENCE_DRIVER || path.join(__dirname, 'social-presence-driver.py');
  const python = process.env.SOCIAL_PRESENCE_PYTHON || 'python3';
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, [driver, ...candidates], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ kind: 'unavailable', message: err.message, rows: [] });
      return;
    }

    const rows = [];
    let stderr = '';
    let done = false;
    const finish = (kind, message) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch (_e) { /* já saiu */ }
      resolve({ kind, message, rows });
    };
    const timer = setTimeout(() => finish('timeout', `driver excedeu ${deadlineMs}ms (parcial parseado)`), deadlineMs);
    const onAbort = () => finish('timeout', 'task signal abortou o scan');
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => finish(err.code === 'ENOENT' ? 'unavailable' : 'error', err.message));
    child.stdout.setEncoding('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try { rows.push(JSON.parse(line)); } catch (_e) { /* linha parcial/ruído */ }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('close', (code) => {
      const errorRow = rows.find((r) => r && r.kind === 'error');
      if (errorRow && errorRow.code === 'MAIGRET_UNAVAILABLE') finish('unavailable', errorRow.message || stderr);
      else finish(code === 0 || rows.length ? 'ok' : 'error', code === 0 ? null : (stderr || `exit ${code}`));
    });
  });
}

/** Crawleia os perfis mais valiosos e extrai contato público (regras BR). */
async function extractContactFromProfiles(profiles, { signal, fetchImpl = fetch, logger } = {}) {
  const ordered = [...profiles].sort((a, b) => {
    const pa = PROFILE_CRAWL_PRIORITY.test(a.site || a.url) ? 0 : 1;
    const pb = PROFILE_CRAWL_PRIORITY.test(b.site || b.url) ? 0 : 1;
    return pa - pb;
  }).slice(0, PROFILE_CRAWL_MAX);
  for (const profile of ordered) {
    if (!profile.url || !/^https?:\/\//.test(profile.url)) continue;
    let html = '';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const onAbort = () => controller.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetchImpl(profile.url, {
          signal: controller.signal,
          redirect: 'follow',
          headers: { Accept: 'text/html,*/*', 'Accept-Language': 'pt-BR,pt;q=0.9', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
        });
        if (res.ok) html = await res.text();
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    } catch (_e) {
      continue; // login wall/403 (Instagram etc.) — perfil segue mapeado
    }
    const found = dp.extractWhatsAppFromHtml(html);
    if (!found) continue;
    // Número que a PLATAFORMA usa nela mesma não é da empresa (mesmo guard do
    // multi-source: diretórios embutem o próprio suporte em toda página).
    const blacklist = await dp.platformWaBlacklist(profile.url, { signal, logger });
    if (blacklist.has(found)) continue;
    return { value: `+${found}`, sourceUrl: profile.url };
  }
  return null;
}

// Um scan de maigret POR VEZ neste processo: o pod do worker tem limite de
// memória pequeno (384Mi) e scans paralelos (runtime com concorrência > 1)
// estouraram o limite em produção — OOM derruba as tasks dos OUTROS canais
// também (2026-10-13). A fila espera o scan anterior terminar.
let scanChain = Promise.resolve();
const serializeScan = (fn) => {
  const next = scanChain.then(fn, fn);
  scanChain = next.catch(() => {});
  return next;
};

const executors = {
  async 'company.social_presence'(task, { signal, logger } = {}) {
    const companyName = String(task.input.companyName || '').trim();
    const tradeName = String(task.input.tradeName || '').trim();
    const contactName = String(task.input.contactName || '').trim();
    const city = String(task.input.city || '').trim();
    if (!companyName && !tradeName) {
      return { status: 'FAILED', error: { type: 'INVALID_INPUT', message: 'company.social_presence exige companyName ou tradeName', retryable: false } };
    }

    const candidates = buildHandleCandidates({ companyName, tradeName, contactName, city });
    if (candidates.length === 0) {
      return {
        status: 'COMPLETED',
        provider: 'maigret.cli',
        data: { social_presence: { profiles: [], usernames: [], count: 0 }, contacts: [] },
        facts: [],
      };
    }

    logger && logger.info && logger.info(`social_presence: candidatos ${candidates.join(', ')}`);
    const scan = await serializeScan(() => runDriverScan(candidates, { signal }));
    if (scan.kind === 'unavailable') {
      logger && logger.warn && logger.warn(`social_presence: maigret indisponível (${scan.message})`);
      return { status: 'FAILED', error: { type: 'MAIGRET_UNAVAILABLE', message: String(scan.message || 'maigret ausente').slice(0, 200), retryable: false } };
    }

    const profiles = scan.rows
      .filter((r) => r && r.kind === 'found' && r.url)
      .map((r) => ({ site: r.site, url: r.url, username: r.username }));
    const scanErrors = scan.rows.filter((r) => r && r.kind === 'error' && r.code === 'SCAN_ERROR');

    // Parcial por deadline ainda vale (perfis achados antes do corte ficam).
    const contact = profiles.length ? await extractContactFromProfiles(profiles, { signal, logger }) : null;
    if (scan.kind === 'timeout' && profiles.length === 0) {
      return { status: 'FAILED', error: { type: 'TIMEOUT', message: scan.message || 'scan excedeu o deadline sem achados', retryable: false } };
    }

    const facts = profiles.slice(0, 20).map((p) => ({
      attribute: 'social.profile',
      value: p.url,
      confidence: 0.7,
      evidence: { sourceType: 'maigret', site: p.site, retrievedAt: new Date().toISOString() },
    }));
    if (contact) {
      facts.push({
        attribute: 'contact.whatsapp',
        value: contact.value,
        confidence: 0.6,
        evidence: { sourceType: 'maigret', url: contact.sourceUrl, retrievedAt: new Date().toISOString() },
      });
    }
    if (scanErrors.length) {
      logger && logger.warn && logger.warn(`social_presence: ${scanErrors.length} username(s) com erro no driver`);
    }

    logger && logger.info && logger.info(`social_presence: ${profiles.length} perfil(is) para "${tradeName || companyName}"${contact ? ` + WhatsApp ${contact.value}` : ''}`);
    return {
      status: 'COMPLETED',
      provider: 'maigret.cli',
      data: {
        social_presence: { profiles, usernames: candidates, count: profiles.length },
        contacts: contact ? [{ type: 'whatsapp', value: contact.value, classification: 'FOUND', confidence: 0.6 }] : [],
      },
      facts,
    };
  },
};

function createSocialPresenceWorker({ prisma, js, jsm = null, deps = {} } = {}) {
  const logger = deps.logger || require('../logger').createLogger({ component: 'worker', family: 'social-presence' });
  const { makeResultPublisher } = require('./sdk/result-publisher');
  const runtime = createWorkerRuntime({
    name: 'social-presence',
    filterSubject: 'enrichment.task.company.social_presence.>',
    durable: 'enrichment-engine-company-social-presence',
    capabilities: require('../enrichment-capabilities'),
    workerVersion: process.env.GIT_SHA || 'dev',
    deps: {
      prisma,
      js,
      jsm,
      publisher: js ? makeResultPublisher({ js }) : null,
      logger,
      ...deps,
    },
  });
  runtime.registerExecutors(executors);
  return runtime;
}

// Boot direto: `node workers/social-presence.js` (requer `pip install maigret`).
if (require.main === module) {
  const { PrismaClient } = require('@prisma/client');
  (async () => {
    const prisma = new PrismaClient();
    const nc = await require('../nats-stream').connectNats({ name: 'b2base-worker-social-presence' });
    const jsm = await nc.jetstreamManager();
    const js = nc.jetstream();
    const runtime = createSocialPresenceWorker({ prisma, js, jsm });
    await runtime.start();
    const shutdown = async () => {
      await runtime.stop();
      await require('../nats-stream').closeAll();
      await prisma.$disconnect().catch(() => {});
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })().catch((err) => {
    console.error(`[worker:social-presence] falha no boot: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  executors,
  createSocialPresenceWorker,
  buildHandleCandidates,
  runDriverScan,
  extractContactFromProfiles,
};
