/**
 * MCP-CNPJ client
 *
 * Wraps the external Brazilian company-data MCP server (streamable HTTP) so the
 * B2Base backend can search, filter and enrich real CNPJ companies using the
 * CNAE/segment/location criteria captured during onboarding.
 *
 * Configuration (env):
 *   CNPJ_MCP_URL        – default https://mcps.0xcloud.net/mcp
 *   CNPJ_MCP_TOKEN      – Bearer token for the MCP endpoint
 *
 * Tools consumed:
 *   search_companies    – semantic search (query + state/status/cnae/city/limit)
 *   filter_companies    – structured filter (state/city/status/cnae/legal_name_contains)
 *   get_company_by_cnpj – exact CNPJ lookup
 */

const MCP_URL = process.env.CNPJ_MCP_URL || 'https://mcps.0xcloud.net/mcp';
const MCP_TOKEN = process.env.CNPJ_MCP_TOKEN || '';

let sessionId = null;
let sessionExpiresAt = 0;
const SESSION_TTL_MS = 1000 * 60 * 4; // refresh after 4 min

function authorizationHeaders() {
  if (!MCP_TOKEN) {
    throw new Error('MCP-CNPJ token not configured (set CNPJ_MCP_TOKEN)');
  }
  return { Authorization: `Bearer ${MCP_TOKEN}` };
}

async function mcpPost(payload, withSession = false) {
  const headers = {
    ...authorizationHeaders(),
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (withSession && sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch(MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`MCP-CNPJ HTTP ${response.status} ${body.slice(0, 200)}`);
    }

    const sessionHeader = response.headers.get('mcp-session-id');
    if (sessionHeader) {
      sessionId = sessionHeader;
      sessionExpiresAt = Date.now() + SESSION_TTL_MS;
    }

    // Streamable HTTP returns SSE (event:\n data: {...}) or a plain JSON body.
    const raw = await response.text();
    const message = parseMcpMessage(raw);
    if (message?.error) {
      const code = message.error.code;
      if (code === -32600 && /session/i.test(String(message.error.message || ''))) {
        throw new McpSessionError(message.error.message);
      }
      throw new Error(`MCP-CNPJ error: ${message.error.message || JSON.stringify(message.error)}`);
    }
    return message?.result ?? message;
  } finally {
    clearTimeout(timeout);
  }
}

class McpSessionError extends Error {}

function parseMcpMessage(raw) {
  const text = String(raw || '').trim();
  // Prefer the last SSE data: line if present, else treat as plain JSON.
  let candidates = [];
  if (text.includes('\n')) {
    candidates = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
  }
  if (candidates.length === 0) candidates = [text];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // ignore and try next
    }
  }
  return null;
}

async function ensureSession() {
  if (sessionId && Date.now() < sessionExpiresAt) return sessionId;
  const result = await mcpPost({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'b2base-backend', version: '1.0.0' },
    },
  });
  // notify initialized (fire and forget)
  await mcpPost(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    true
  ).catch(() => {});
  return sessionId;
}

let idCounter = 100;

async function callTool(name, args) {
  // (re)establish the session, then call. Retry once if the session was lost.
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      await ensureSession();
      idCounter += 1;
      const result = await mcpPost(
        {
          jsonrpc: '2.0',
          id: idCounter,
          method: 'tools/call',
          params: { name, arguments: args || {} },
        },
        true
      );
      return normalizeToolResult(result);
    } catch (error) {
      if (error instanceof McpSessionError && attempts < 2) {
        sessionId = null;
        continue;
      }
      throw error;
    }
  }
}

function normalizeToolResult(result) {
  if (!result) return null;
  const structured = result.structuredContent;
  if (structured && structured.result !== undefined) {
    return structured.result;
  }
  if (structured && !('result' in structured)) return structured;
  // fall back to the text payload
  const content = Array.isArray(result.content) ? result.content : [];
  for (const block of content) {
    if (block && block.type === 'text' && block.text) {
      try {
        return JSON.parse(block.text);
      } catch {
        return block.text;
      }
    }
  }
  return null;
}

const IN_ACTIVE_STATUSES = new Set(['ATIVA', 'ATIVO', 'ACTIVE']);

function mapMcpCompany(record) {
  const cnpj = String(record.cnpj || '').replace(/\D/g, '');
  const isActive =
    record.is_active != null
      ? Boolean(record.is_active)
      : IN_ACTIVE_STATUSES.has(String(record.registration_status || '').toUpperCase());
  return {
    cnpj: formatCnpj(cnpj),
    legalName: record.legal_name || record.trade_name || '',
    tradeName: record.trade_name || null,
    industry: record.main_cnae_description || null,
    status: isActive ? 'active' : 'inactive',
    city: record.city_name || null,
    state: record.state || null,
    openingDate: record.opening_date || null,
    legalNature: record.legal_nature_description || null,
    companySize: record.company_size_code || null,
    shareCapital: record.share_capital != null ? Number(record.share_capital) : null,
    email: record.email || null,
    isActive,
    isHeadquarters: record.is_headquarters != null ? Boolean(record.is_headquarters) : true,
    source: 'mcp.cnpj',
  };
}

function formatCnpj(cnpj) {
  const digits = String(cnpj || '').replace(/\D/g, '');
  if (digits.length !== 14) return String(cnpj || '');
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

function normalizeStatusArg(value) {
  const v = String(value || '').toUpperCase();
  if (!v) return undefined;
  if (['ATIVA', 'ATIVO', 'ACTIVE'].includes(v)) return 'ATIVA';
  if (['BAIXADA', 'INATIVO', 'INACTIVE', 'CANCELADA', 'SUSPENSA', 'NULA'].includes(v)) return 'BAIXADA';
  return v;
}

// Aceita string ou array e normaliza para o formato do MCP: string quando há
// um único valor, array quando há vários (o servidor combina por OR). Vazio
// → undefined (filtro ausente).
function _listArg(value) {
  const list = Array.isArray(value)
    ? value.map((v) => String(v || '').trim()).filter(Boolean)
    : value
      ? [String(value).trim()]
      : [];
  if (!list.length) return undefined;
  return list.length === 1 ? list[0] : list;
}

/**
 * Search companies semantically. Returns mapped company records.
 * `state` e `city` aceitam string ou array (array = OR no servidor).
 */
async function searchCompanies({ query, state, status, cnae, city, limit = 10 } = {}) {
  const args = {
    query,
    limit: clampLimit(limit, 1, 50),
  };
  const stateArg = _listArg(state);
  const cityArg = _listArg(city);
  if (stateArg) args.state = stateArg;
  if (cnae) args.cnae = cnae;
  if (cityArg) args.city = cityArg;
  const statusValue = normalizeStatusArg(status);
  if (statusValue) args.status = statusValue;

  const result = await callTool('search_companies', args);
  const list = Array.isArray(result) ? result : [];
  return list.map(mapMcpCompany);
}

/**
 * Filter companies by structured attributes.
 * `state` e `city` aceitam string ou array (array = OR no servidor).
 */
async function filterCompanies({
  state,
  city,
  status,
  cnae,
  legalNameContains,
  isActive,
  limit = 25,
} = {}) {
  const args = { limit: clampLimit(limit, 1, 100) };
  const stateArg = _listArg(state);
  const cityArg = _listArg(city);
  if (stateArg) args.state = stateArg;
  if (cityArg) args.city = cityArg;
  const statusValue = normalizeStatusArg(status);
  if (statusValue) args.status = statusValue;
  if (cnae) args.cnae = cnae;
  if (legalNameContains) args.legal_name_contains = legalNameContains;
  if (isActive != null) args.is_active = Boolean(isActive);

  const result = await callTool('filter_companies', args);
  const list = Array.isArray(result) ? result : [];
  return list.map(mapMcpCompany);
}

/**
 * Exact CNPJ lookup (returns a single mapped company or null).
 */
async function getCompanyByCnpj(cnpj) {
  const result = await callTool('get_company_by_cnpj', {
    cnpj: String(cnpj || '').replace(/\D/g, ''),
  });
  if (!result) return null;
  return mapMcpCompany(result);
}

async function getDatasetStats() {
  const result = await callTool('stats', {});
  return result || {};
}

function clampLimit(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return min;
  return Math.min(Math.max(Math.round(n), min), max);
}

/**
 * Whether the external MCP-CNPJ server is configured (i.e. a token is present).
 * Exposed so endpoints can fail gracefully with a clear message instead of
 * throwing on every call when the token is missing.
 */
function isMcpConfigured() {
  if (_testOverrides && _testOverrides.isMcpConfigured) return _testOverrides.isMcpConfigured();
  return Boolean(MCP_URL && MCP_TOKEN);
}

// ── Stub para testes (Epic 2, captura via MCP sem rede) ─────────────────────
// Padrão _setBullForTests (outreach-queues.js): override POR FUNÇÃO, checado
// DENTRO de cada export — destructure no import-time não burla o stub.
let _testOverrides = null;

function _setMcpForTests(overrides = {}) {
  _testOverrides = { ...overrides };
}

function _resetMcpForTests() {
  _testOverrides = null;
}

/** Envolve um export async com o override de teste, quando presente. */
function withOverride(impl) {
  return async (...args) => {
    if (_testOverrides && _testOverrides[impl.name]) {
      return _testOverrides[impl.name](...args);
    }
    return impl(...args);
  };
}

module.exports = {
  searchCompanies: withOverride(searchCompanies),
  filterCompanies: withOverride(filterCompanies),
  getCompanyByCnpj: withOverride(getCompanyByCnpj),
  getDatasetStats: withOverride(getDatasetStats),
  mapMcpCompany,
  formatCnpj,
  isMcpConfigured,
  _setMcpForTests,
  _resetMcpForTests,
};
