import {
  Prospect,
  PipelineAnalytics,
  OperationalAnalytics,
  StatusBreakdownItem,
  QualificationResult, 
  CreditRiskResult,
  WorkflowItem,
  EnrichedCnpjContact,
  CommercialProfile,
  DiscoveredCompany,
  DiscoveryCriteria,
  DiscoveryPage,
  PlanInfo,
  CompanyGraph,
  LeadAddressesResponse,
  LeadEnrichmentEntity,
  ContactDecision,
  DeepAnalysisStatePayload,
  EmailAccount,
  OutreachCampaign,
  OutreachContactSummary,
  OutreachEvent,
  SuppressionEntry,
  StartCampaignResult,
  DispatchHistoryResult,
  WhatsAppAccount,
  WhatsAppCampaign,
  WhatsAppConversation,
  WhatsAppMessage,
  WhatsAppConnectResult,
  WhatsAppReengagementSuggestion,
  WhatsAppAutomationConfig,
  AiCampaignApproval,
  AiCampaignResult,
  DiscoveryJobStatusPayload,
  DiscoveryCandidatesPayload,
  CompanyIntelligenceProfile
} from '../types';

const API_BASE = '/api';

export async function fetchProspects(): Promise<Prospect[]> {
  try {
    const res = await fetch(`${API_BASE}/prospects`);
    if (!res.ok) throw new Error('Falha ao buscar prospectos');
    const json = await res.json();
    return json.data || [];
  } catch (error) {
    console.error('API fetchProspects error:', error);
    return [];
  }
}

/** Busca um prospect por id (deep link da tela de detalhe). 404 → null. */
export async function fetchProspect(id: string): Promise<Prospect | null> {
  const res = await fetch(`${API_BASE}/prospects/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao carregar o lead');
  }
  return json.data;
}

/** Fatos agregados do motor v2 por entidade (capabilities já filtradas por plano). */
export async function fetchProspectEnrichmentEntities(
  id: string
): Promise<LeadEnrichmentEntity[]> {
  const res = await fetch(`${API_BASE}/prospects/${encodeURIComponent(id)}/enrichment`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao carregar fatos de enriquecimento');
  }
  return json.data?.entities || [];
}

/** Dispara/reprocessa o enriquecimento do lead (motor roteado por plano). */
export async function enrichProspect(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/prospects/${encodeURIComponent(id)}/enrich`, {
    method: 'POST',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao disparar enriquecimento');
  }
}

/** Endereços do lead deduplicados e geocodificados (feature 002). */
export async function fetchLeadAddresses(id: string): Promise<LeadAddressesResponse> {
  const res = await fetch(`${API_BASE}/prospects/${encodeURIComponent(id)}/addresses`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao carregar endereços do lead');
  }
  return {
    prospectId: json.prospectId,
    dataRestricted: Boolean(json.dataRestricted),
    addresses: json.addresses || [],
  };
}

/**
 * Painel de decisão de contato do lead (feature 003): Atingibilidade, Momento
 * e recomendação única. 404 (lead ausente ou cross-tenant) ⇒ null.
 */
export async function fetchContactDecision(id: string): Promise<ContactDecision | null> {
  const res = await fetch(`${API_BASE}/prospects/${encodeURIComponent(id)}/contact-decision`);
  if (res.status === 404) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao carregar a decisão de contato do lead');
  }
  return json.data as ContactDecision;
}

// ── Análise profunda de lead por IA (feature 005) ───────────────────────────

/**
 * Estado/resultado da análise profunda vigente. Orgs sem o recurso (403
 * PREMIUM_FEATURE) e leads inexistentes (404) devolvem null — a UI mostra o
 * estado apropriado sem vazar existência de dados (SC-007).
 */
export async function fetchDeepAnalysis(id: string): Promise<DeepAnalysisStatePayload | null> {
  const res = await fetch(`${API_BASE}/prospects/${encodeURIComponent(id)}/deep-analysis`);
  if (res.status === 403 || res.status === 404) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao carregar a análise profunda do lead');
  }
  return json.data as DeepAnalysisStatePayload;
}

/** Reexecuta a análise profunda do lead (FR-014). 409 = já em execução. */
export async function rerunDeepAnalysis(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/prospects/${encodeURIComponent(id)}/deep-analysis/rerun`, {
    method: 'POST',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    if (res.status === 409) throw new Error('A análise já está em execução — aguarde o veredito.');
    if (res.status === 403) throw new Error('A análise profunda é um recurso premium.');
    throw new Error(json.error || 'Erro ao reexecutar a análise profunda');
  }
}

// ── Planos de assinatura (trial | premium) ──────────────────────────────────

export async function fetchPlan(): Promise<PlanInfo> {
  const res = await fetch(`${API_BASE}/plan`);
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao carregar o plano');
  }
  return json.data;
}

/** Cria Checkout Session de assinatura do Premium e devolve a URL do Stripe. */
export async function createBillingCheckout(): Promise<{ url: string; sessionId: string }> {
  const res = await fetch(`${API_BASE}/billing/checkout-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao iniciar o checkout');
  }
  return json.data;
}

/** Cria sessão do Customer Portal (cartão, cancelamento, faturas). */
export async function createBillingPortal(): Promise<{ url: string }> {
  const res = await fetch(`${API_BASE}/billing/portal-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao abrir o portal de assinatura');
  }
  return json.data;
}

export async function exportProspectsCsv(): Promise<void> {
  const res = await fetch(`${API_BASE}/prospects/export`);
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || 'Erro ao exportar prospects');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'prospects.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export async function createProspect(data: {
  cnpj: string;
  companyName: string;
  industry?: string;
  employees?: number;
  status?: string;
  revenueEstimate?: number;
}): Promise<Prospect> {
  const res = await fetch(`${API_BASE}/prospects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    const error = new Error(json.error || 'Erro ao criar prospecto');
    (error as Error & { code?: string }).code = json.code;
    throw error;
  }
  return json.data;
}

export async function updateProspect(id: string, data: Partial<Prospect>): Promise<Prospect> {
  const res = await fetch(`${API_BASE}/prospects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao atualizar prospecto');
  }
  return json.data;
}

export async function deleteProspect(id: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/prospects/${id}`, {
    method: 'DELETE',
  });
  const json = await res.json();
  return json.success || false;
}

export async function bulkUpdateProspects(
  ids: string[],
  action: 'move' | 'delete',
  status?: string
): Promise<{ count: number; skipped: number }> {
  const res = await fetch(`${API_BASE}/prospects/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, action, status }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao atualizar prospectos em lote');
  }
  return { count: json.data?.count ?? 0, skipped: json.data?.skipped ?? 0 };
}

export async function fetchPipelineAnalytics(): Promise<PipelineAnalytics> {
  try {
    const res = await fetch(`${API_BASE}/analytics/pipeline`);
    if (!res.ok) throw new Error('Falha ao buscar métricas de pipeline');
    const json = await res.json();
    return json.data;
  } catch (error) {
    console.error('API fetchPipelineAnalytics error:', error);
    return {
      total_prospects: 0,
      qualified: 0,
      prospects: 0,
      deep_analysis: 0,
      discarded: 0,
      qualification_rate: 0,
      closure_rate: 0,
    };
  }
}

export async function fetchOperationalAnalytics(): Promise<OperationalAnalytics> {
  try {
    const res = await fetch(`${API_BASE}/analytics/operational`);
    if (!res.ok) throw new Error('Falha ao buscar métricas operacionais');
    const json = await res.json();
    return json.data;
  } catch (error) {
    console.error('API fetchOperationalAnalytics error:', error);
    return {
      leads_total: 0,
      leads_uncontacted: 0,
      leads_new_this_month: 0,
      contacted_total: 0,
      contacted_email: 0,
      contacted_whatsapp: 0,
      leads_replied: 0,
      replied_email: 0,
      replied_whatsapp: 0,
      response_rate: 0,
      whatsapp_conversations_active: 0,
      whatsapp_conversations_total: 0,
      dispatches_email_sent: 0,
      dispatches_whatsapp_sent: 0,
    };
  }
}

export async function fetchStatusBreakdown(): Promise<StatusBreakdownItem[]> {
  try {
    const res = await fetch(`${API_BASE}/analytics/breakdown`);
    if (!res.ok) throw new Error('Falha ao buscar breakdown');
    const json = await res.json();
    return json.data || [];
  } catch (error) {
    return [];
  }
}

export async function qualifyCompany(companyName: string): Promise<QualificationResult> {
  const res = await fetch(`${API_BASE}/intelligence/qualify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company_name: companyName }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro na qualificação');
  }
  return json.qualification;
}

export async function assessCreditRisk(cnpj: string): Promise<CreditRiskResult> {
  const res = await fetch(`${API_BASE}/intelligence/credit-risk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cnpj }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro na análise de risco');
  }
  return json.risk_assessment;
}

export async function createWorkflow(data: { name: string; trigger: string; action: string }): Promise<WorkflowItem> {
  const res = await fetch(`${API_BASE}/automation/workflow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao criar workflow');
  }
  return json.workflow;
}

export async function fetchCommercialProfile(): Promise<CommercialProfile> {
  const res = await fetch(`${API_BASE}/settings/commercial-profile`);
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao carregar preferências comerciais');
  }
  return json.data;
}

export async function saveCommercialProfile(data: CommercialProfile): Promise<CommercialProfile> {
  const res = await fetch(`${API_BASE}/settings/commercial-profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao salvar preferências comerciais');
  }
  return json.data;
}

export async function fetchEnrichedCnpjContacts(filters: {
  from?: string;
  to?: string;
  status?: string;
} = {}): Promise<EnrichedCnpjContact[]> {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);

  const query = params.toString();
  const res = await fetch(`${API_BASE}/enrichment/contacts${query ? `?${query}` : ''}`);
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao buscar enriquecimento CNPJ');
  }
  return json.data || [];
}

export async function extractCnpjContacts(data: {
  from?: string;
  to?: string;
  refresh?: boolean;
  limit?: number;
} = {}): Promise<EnrichedCnpjContact[]> {
  const res = await fetch(`${API_BASE}/enrichment/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao extrair contatos CNPJ');
  }
  return json.data || [];
}

export async function fetchDiscoveryProfile(): Promise<{
  onboardingCompleted: boolean;
  targetCnaes: string[];
  targetSegments: string[];
  targetLocations: string[];
  companyStatuses: string[];
  targetSizes: string[];
}> {
  try {
    const res = await fetch(`${API_BASE}/discovery/profile`);
    const json = await res.json();
    if (json.success && json.data) {
      return json.data;
    }
    return {
      onboardingCompleted: false,
      targetCnaes: [],
      targetSegments: [],
      targetLocations: [],
      companyStatuses: ['active'],
      targetSizes: [],
    };
  } catch {
    return {
      onboardingCompleted: false,
      targetCnaes: [],
      targetSegments: [],
      targetLocations: [],
      companyStatuses: ['active'],
      targetSizes: [],
    };
  }
}

export interface DiscoveryCandidatesResult {
  companies: DiscoveredCompany[];
  criteria: DiscoveryCriteria;
  page: DiscoveryPage;
  message?: string;
  mcpError?: string;
}

export async function fetchDiscoveryCandidates(
  options: { cnae?: string; cnaes?: string[]; segment?: string; location?: string; cnpj?: string; limit?: number; page?: number; pageSize?: number; seed?: string } = {}
): Promise<DiscoveryCandidatesResult> {
  const params = new URLSearchParams();
  const rawCnaes = options.cnaes ?? (options.cnae ? [options.cnae] : null);
  if (rawCnaes) {
    // Array passado (mesmo vazio) é escolha explícita da tela: enviamos o
    // parâmetro para o backend NÃO recuar para os CNAEs do perfil.
    params.set('cnaes', rawCnaes.map((c) => c.replace(/\D/g, '')).filter(Boolean).join(','));
  }
  if (options.segment) params.set('segment', options.segment);
  if (options.location) params.set('location', options.location);
  if (options.cnpj) params.set('cnpj', options.cnpj);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.page) params.set('page', String(options.page));
  if (options.pageSize) params.set('pageSize', String(options.pageSize));
  if (options.seed) params.set('seed', options.seed);

  const emptyPage: DiscoveryPage = { page: 1, pageSize: 12, total: 0, totalPages: 0, hasMore: false };

  try {
    const res = await fetch(`${API_BASE}/discovery/candidates?${params.toString()}`);
    const json = await res.json();
    if (json.success) {
      return {
        companies: json.data || [],
        criteria: json.criteria || { segments: [], locations: [], activeOnly: false, usedProfile: false },
        page: {
          page: json.page || 1,
          pageSize: json.pageSize || 12,
          total: json.total || 0,
          totalPages: json.totalPages || 0,
          hasMore: Boolean(json.hasMore),
        },
        message: json.message,
        mcpError: json.mcpError || undefined,
      };
    }
    return {
      companies: [],
      criteria: { segments: [], locations: [], activeOnly: false, usedProfile: false },
      page: emptyPage,
      message: json.error || undefined,
      mcpError: typeof json.error === 'string' && /MCP-CNPJ|configurad/i.test(json.error) ? json.error : undefined,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : undefined;
    return {
      companies: [],
      criteria: { segments: [], locations: [], activeOnly: false, usedProfile: false },
      page: emptyPage,
      message: msg || 'Não foi possível buscar leads descobertos.',
      mcpError: msg && /MCP-CNPJ|configurad/i.test(msg) ? msg : undefined,
    };
  }
}

export async function importDiscoveredCompany(data: {
  cnpj: string;
  legalName: string;
  tradeName?: string | null;
  industry?: string | null;
  status?: string;
  email?: string | null;
  city?: string | null;
  state?: string | null;
  openingDate?: string | null;
  legalNature?: string | null;
}): Promise<{ prospect: Prospect; alreadyExists: boolean }> {
  const res = await fetch(`${API_BASE}/discovery/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    const error = new Error(json.error || 'Erro ao importar lead');
    (error as Error & { code?: string }).code = json.code;
    throw error;
  }
  return { prospect: json.data, alreadyExists: json.alreadyExists || false };
}

export interface BulkImportSummary {
  requested: number;
  importedCount: number;
  imported: string[];
  alreadyExists: number;
  failures: { cnpj: string; error: string }[];
  limitReached: boolean;
  limitMessage: string;
}

export async function importDiscoveredCompaniesBulk(companies: DiscoveredCompany[]): Promise<BulkImportSummary> {
  const res = await fetch(`${API_BASE}/discovery/import-bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      companies: companies.map((c) => ({
        cnpj: c.cnpj,
        legalName: c.legalName,
        tradeName: c.tradeName || null,
        industry: c.industry || null,
        status: c.status || 'active',
        email: c.email || null,
        city: c.city || null,
        state: c.state || null,
        openingDate: c.openingDate || null,
        legalNature: c.legalNature || null,
      })),
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao importar leads em lote');
  }
  return json.data;
}

// ── Importação de leads via CSV (IA entende a estrutura da planilha) ───────

export interface CsvImportFailure {
  row: number | null;
  cnpj: string | null;
  reason: string;
}

export interface CsvImportWarning {
  row: number;
  cnpj: string;
  messages: string[];
}

export interface CsvImportResult {
  requested: number;
  delimiter: string;
  truncated: boolean;
  maxRows: number;
  mapping: Record<string, string | null>;
  mappingSource: 'ai' | 'heuristic' | 'ai+heuristic';
  mappingNotes?: string;
  /** campos derrubados pela auditoria/blocklist de mapeamento */
  mappingRejected?: { field: string; column: string; reason: string }[];
  /** true quando o mapeamento usou memória de imports anteriores do org */
  memoryUsed?: boolean;
  importedCount: number;
  importedWithoutCnpj: number;
  alreadyExists: number;
  failures: CsvImportFailure[];
  warnings: CsvImportWarning[];
  limitReached: boolean;
  limitMessage: string;
}

export async function importLeadsCsv(csv: string): Promise<CsvImportResult> {
  const res = await fetch(`${API_BASE}/prospects/import-csv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    const error = new Error(json.error || 'Erro ao importar CSV');
    (error as Error & { code?: string }).code = json.code;
    (error as Error & { mapping?: Record<string, string | null> }).mapping = json.mapping;
    throw error;
  }
  return json.data;
}

export async function enrichProspectViaMcp(id: string): Promise<Prospect> {
  const res = await fetch(`${API_BASE}/prospects/${id}/enrich-mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao enriquecer lead');
  }
  return json.data;
}

export interface CompanyGraphResponse {
  available: boolean;
  data: CompanyGraph | null;
  error?: string;
}

export async function fetchCompanyGraph(cnpj: string): Promise<CompanyGraphResponse> {
  try {
    const res = await fetch(`${API_BASE}/enrichment/graph/${encodeURIComponent(cnpj)}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      return { available: true, data: null, error: json.error || `Erro ${res.status} ao carregar o grafo` };
    }
    return { available: Boolean(json.available), data: json.data || null, error: json.error };
  } catch (error) {
    console.error('API fetchCompanyGraph error:', error);
    return { available: false, data: null, error: 'Não foi possível falar com o backend' };
  }
}

// ── Outreach / Gmail API ────────────────────────────────────────────────────

export async function fetchGmailAuthUrl(): Promise<string> {
  const res = await fetch(`${API_BASE}/gmail/auth-url`);
  const json = await res.json();
  if (!res.ok || !json.success || !json.authUrl) {
    throw new Error(json.error || 'Não foi possível gerar o link de conexão com o Gmail');
  }
  return json.authUrl;
}

export async function fetchGmailAccounts(): Promise<EmailAccount[]> {
  try {
    const res = await fetch(`${API_BASE}/gmail/accounts`);
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao listar contas do Gmail');
    return json.data || [];
  } catch (error) {
    console.error('API fetchGmailAccounts error:', error);
    return [];
  }
}

export async function disconnectGmailAccount(id: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/gmail/accounts/${id}`, { method: 'DELETE' });
  const json = await res.json();
  return Boolean(json.success);
}

export interface ConnectEmailPayload {
  provider: 'smtp' | 'resend';
  email: string;
  password?: string; // smtp: senha / app password
  apiKey?: string; // resend
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  fromName?: string;
}

export async function connectEmailAccount(payload: ConnectEmailPayload): Promise<EmailAccount> {
  const res = await fetch(`${API_BASE}/email/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Não foi possível conectar a conta de email');
  }
  return json.data;
}

// ── Envio de FOTOS por Gmail (2026-10-27) ──────────────────────────────────

export interface SendPhotosResult {
  to: string;
  from: string;
  count: number;
  messageId: string | null;
  attachmentsSkipped?: Array<{ fileName: string; reason: string }>;
}

/**
 * Envia fotos como anexos reais pela conta Gmail conectada do usuário.
 * XHR (não fetch) para progresso de upload — o navegador não expõe progresso
 * de request no fetch. Confirmação: só é "enviado" com o messageId da API.
 */
export function sendPhotosByEmail(
  files: File[],
  to: string,
  subject: string,
  message: string,
  onProgress?: (percent: number) => void
): Promise<SendPhotosResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('to', to);
    form.append('subject', subject);
    form.append('message', message);
    for (const file of files) form.append('photos', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/gmail/photos`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      let json: { success?: boolean; data?: SendPhotosResult; error?: string } = {};
      try {
        json = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* resposta não-JSON (proxy/erro HTML) */
      }
      if (xhr.status >= 200 && xhr.status < 300 && json.success && json.data) {
        resolve(json.data);
      } else {
        reject(new Error(json.error || `Erro ${xhr.status} ao enviar as fotos`));
      }
    };
    xhr.onerror = () => reject(new Error('Falha de conexão com o servidor — verifique sua internet e tente de novo.'));
    xhr.send(form);
  });
}

export interface EmailProviderOptions {
  gmailOAuth: boolean;
  resendPlatformKey: boolean;
}

export async function fetchEmailProviderOptions(): Promise<EmailProviderOptions | null> {
  try {
    const res = await fetch(`${API_BASE}/email/providers`);
    const json = await res.json();
    if (!res.ok || !json.success) return null;
    return json.data || null;
  } catch {
    return null;
  }
}

export async function fetchOutreachCampaigns(): Promise<OutreachCampaign[]> {
  try {
    const res = await fetch(`${API_BASE}/outreach/campaigns`);
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao listar campanhas');
    return json.data || [];
  } catch (error) {
    console.error('API fetchOutreachCampaigns error:', error);
    return [];
  }
}

export interface CreateCampaignPayload {
  name: string;
  description?: string;
  objective?: string;
  offer?: string;
  trigger?: 'manual' | 'on_enrichment';
  channels?: string[];
  autoActive?: boolean;
  emailAccountId?: string | null;
  emailTemplateSubject?: string;
  emailTemplateBody?: string;
  whatsappAccountId?: string | null;
  whatsappTemplate?: string;
}

export async function createOutreachCampaign(data: CreateCampaignPayload): Promise<OutreachCampaign> {
  const res = await fetch(`${API_BASE}/outreach/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao criar campanha');
  }
  return json.data;
}

export async function updateOutreachCampaign(
  id: string,
  data: Partial<CreateCampaignPayload>
): Promise<OutreachCampaign> {
  const res = await fetch(`${API_BASE}/outreach/campaigns/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao atualizar campanha');
  }
  return json.data;
}

export interface CampaignTestPayload {
  channel: 'email' | 'whatsapp';
  emailAccountId?: string;
  subject?: string;
  body?: string;
  whatsappAccountId?: string;
  message?: string;
  toPhone?: string;
}

/** Envia mensagem de TESTE com o template renderizado (email → própria conta; WhatsApp → número informado) */
export async function sendCampaignTest(payload: CampaignTestPayload): Promise<string> {
  const res = await fetch(`${API_BASE}/outreach/campaigns/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao enviar teste');
  }
  return json.message || 'Teste enviado';
}

export interface DispatchHistoryFilters {
  channel?: 'email' | 'whatsapp';
  campaignId?: string;
  status?: 'sent' | 'pending' | 'failed';
  q?: string;
  limit?: number;
  offset?: number;
}

/** Histórico unificado de disparos (email + WhatsApp) do org. */
export async function fetchDispatchHistory(
  filters: DispatchHistoryFilters = {}
): Promise<DispatchHistoryResult> {
  const params = new URLSearchParams();
  if (filters.channel) params.set('channel', filters.channel);
  if (filters.campaignId) params.set('campaignId', filters.campaignId);
  if (filters.status) params.set('status', filters.status);
  if (filters.q?.trim()) params.set('q', filters.q.trim());
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.offset) params.set('offset', String(filters.offset));

  const res = await fetch(`${API_BASE}/outreach/dispatches?${params.toString()}`);
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao carregar histórico de disparos');
  }
  return json.data;
}

export interface RetryDispatchesPayload {
  ids?: string[];
  allFailed?: boolean;
}

export interface RetryDispatchesResult {
  emailRetried: number;
  whatsappRetried: number;
  retried: number;
}

/** Re-enfileira disparos que falharam (email e/ou WhatsApp). */
export async function retryDispatches(payload: RetryDispatchesPayload): Promise<RetryDispatchesResult> {
  const res = await fetch(`${API_BASE}/outreach/dispatches/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao reprocessar disparos');
  }
  return json.data;
}

export async function startOutreachCampaign(
  campaignId: string,
  prospectIds: string[],
  emailAccountId?: string | null
): Promise<StartCampaignResult> {
  const res = await fetch(`${API_BASE}/outreach/campaigns/${campaignId}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prospectIds, emailAccountId: emailAccountId || null }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao iniciar campanha');
  }
  return json.data;
}

/**
 * Campanha com IA (feature Premium, 007): a IA compõe a mensagem base a partir
 * do perfil comercial, salva as campanhas e devolve a PRÉVIA — nada dispara.
 * Erros de domínio chegam com `code` (PREMIUM_REQUIRED, NO_READY_LEADS,
 * NO_CHANNEL_AVAILABLE, AI_CAMPAIGN_LIMIT, NO_PROFILE_CONTEXT).
 */
export async function createAiCampaign(): Promise<AiCampaignResult> {
  const res = await fetch(`${API_BASE}/ai/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    const err = new Error(json.error || 'Erro ao gerar campanha com IA') as Error & { code?: string };
    err.code = json.code;
    throw err;
  }
  return json.data;
}

/**
 * 007 (FR-009): aprova a mensagem base (opcionalmente editada pelo tenant) e
 * lança os disparos — único caminho de lançamento do fluxo IA.
 */
export async function approveAiCampaign(body: {
  outreachCampaignId?: string | null;
  whatsappCampaignId?: string | null;
  edits?: {
    whatsappMessageTemplate?: string;
    emailTemplateSubject?: string;
    emailTemplateBody?: string;
  };
}): Promise<AiCampaignApproval> {
  const res = await fetch(`${API_BASE}/ai/campaigns/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    const err = new Error(json.error || 'Erro ao aprovar campanha') as Error & { code?: string };
    err.code = json.code;
    throw err;
  }
  return json.data;
}

export async function fetchProspectOutreachTimeline(prospectId: string): Promise<OutreachEvent[]> {
  try {
    const res = await fetch(`${API_BASE}/prospects/${prospectId}/outreach-timeline`);
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao carregar timeline');
    return json.data || [];
  } catch (error) {
    console.error('API fetchProspectOutreachTimeline error:', error);
    return [];
  }
}

export async function fetchProspectOutreachStatus(prospectId: string): Promise<OutreachContactSummary[]> {
  try {
    const res = await fetch(`${API_BASE}/prospects/${prospectId}/outreach-status`);
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao carregar status de outreach');
    return json.data || [];
  } catch (error) {
    console.error('API fetchProspectOutreachStatus error:', error);
    return [];
  }
}

export async function fetchSuppressionList(): Promise<SuppressionEntry[]> {
  try {
    const res = await fetch(`${API_BASE}/outreach/suppression`);
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao carregar lista de supressão');
    return json.data || [];
  } catch (error) {
    console.error('API fetchSuppressionList error:', error);
    return [];
  }
}

export async function addToSuppressionList(email: string, reason?: string): Promise<void> {
  const res = await fetch(`${API_BASE}/outreach/suppression`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, reason: reason || 'manual' }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao adicionar à lista de supressão');
  }
}

export async function removeFromSuppressionList(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/outreach/suppression/${id}`, { method: 'DELETE' });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao remover da lista de supressão');
  }
}

// ── WhatsApp (prospecção via WAHA) ───────────────────────────────────────────

export async function fetchWhatsAppAccounts(): Promise<WhatsAppAccount[]> {
  try {
    const res = await fetch(`${API_BASE}/whatsapp/accounts`);
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao listar conexões');
    return json.data || [];
  } catch (error) {
    console.error('API fetchWhatsAppAccounts error:', error);
    return [];
  }
}

export async function createWhatsAppAccount(): Promise<WhatsAppAccount> {
  const res = await fetch(`${API_BASE}/whatsapp/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao criar conexão');
  }
  return json.data;
}

export async function connectWhatsAppAccount(id: string): Promise<WhatsAppConnectResult> {
  const res = await fetch(`${API_BASE}/whatsapp/accounts/${id}/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao conectar');
  }
  return json.data;
}

export async function fetchWhatsAppQr(id: string): Promise<{ qrCode?: string | null; raw?: string | null }> {
  const res = await fetch(`${API_BASE}/whatsapp/accounts/${id}/qr`);
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao obter o QR Code');
  }
  return json.data?.qr || { qrCode: null, raw: null };
}

export async function disconnectWhatsAppAccount(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/whatsapp/accounts/${id}/disconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao desconectar');
  }
}

export async function reconnectWhatsAppAccount(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/whatsapp/accounts/${id}/reconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao reconectar');
  }
}

export async function removeWhatsAppAccount(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/whatsapp/accounts/${id}`, { method: 'DELETE' });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao remover conexão');
  }
}

export async function fetchWhatsAppConversations(): Promise<WhatsAppConversation[]> {
  try {
    const res = await fetch(`${API_BASE}/whatsapp/conversations`);
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao listar conversas');
    return json.data || [];
  } catch (error) {
    console.error('API fetchWhatsAppConversations error:', error);
    return [];
  }
}

export async function fetchWhatsAppConversation(id: string): Promise<WhatsAppConversation> {
  const res = await fetch(`${API_BASE}/whatsapp/conversations/${id}`);
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao carregar conversa');
  }
  return json.data;
}

export async function fetchWhatsAppMessages(conversationId: string): Promise<WhatsAppMessage[]> {
  try {
    const res = await fetch(`${API_BASE}/whatsapp/conversations/${conversationId}/messages`);
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao carregar mensagens');
    return json.data || [];
  } catch (error) {
    console.error('API fetchWhatsAppMessages error:', error);
    return [];
  }
}

export async function sendWhatsAppMessage(conversationId: string, text: string): Promise<WhatsAppMessage> {
  const res = await fetch(`${API_BASE}/whatsapp/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao enviar mensagem');
  }
  return json.data;
}

export async function assignWhatsAppConversation(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/whatsapp/conversations/${id}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao assumir conversa');
  }
}

export async function markDoNotContact(prospectId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/whatsapp/prospects/${prospectId}/do-not-contact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao bloquear contato');
  }
}

// --- Automação de reengajamento (agente de IA) -------------------------------

export async function fetchWhatsAppAutomationConfig(): Promise<WhatsAppAutomationConfig | null> {
  try {
    const res = await fetch(`${API_BASE}/whatsapp/automation/config`);
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao carregar configuração de automação');
    return json.data || null;
  } catch (error) {
    console.error('API fetchWhatsAppAutomationConfig error:', error);
    return null;
  }
}

export async function fetchWhatsAppSuggestions(): Promise<WhatsAppReengagementSuggestion[]> {
  try {
    const res = await fetch(`${API_BASE}/whatsapp/automation/suggestions`);
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao listar sugestões');
    return json.data || [];
  } catch (error) {
    console.error('API fetchWhatsAppSuggestions error:', error);
    return [];
  }
}

export async function approveWhatsAppSuggestion(id: string, content?: string): Promise<WhatsAppMessage> {
  const res = await fetch(`${API_BASE}/whatsapp/automation/suggestions/${id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(content != null ? { content } : {}),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao aprovar sugestão');
  }
  return json.data;
}

export async function discardWhatsAppSuggestion(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/whatsapp/automation/suggestions/${id}/discard`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao descartar sugestão');
  }
}

export async function pauseWhatsAppAutomation(conversationId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/whatsapp/conversations/${conversationId}/automation/pause`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao pausar automação');
  }
}

export async function resumeWhatsAppAutomation(conversationId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/whatsapp/conversations/${conversationId}/automation/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao reativar automação');
  }
}

export async function fetchWhatsAppCampaigns(): Promise<WhatsAppCampaign[]> {
  try {
    const res = await fetch(`${API_BASE}/whatsapp/campaigns`);
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao listar campanhas');
    return json.data || [];
  } catch (error) {
    console.error('API fetchWhatsAppCampaigns error:', error);
    return [];
  }
}

export async function createWhatsAppCampaign(data: {
  name: string;
  whatsappAccountId?: string | null;
  objective?: string;
  offer?: string;
  ctaUrl?: string;
  steps: Array<{ orderIndex: number; messageTemplate: string; delayMinutes: number; conditions?: unknown[] }>;
}): Promise<WhatsAppCampaign> {
  const res = await fetch(`${API_BASE}/whatsapp/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao criar campanha');
  }
  return json.data;
}

export async function startWhatsAppCampaign(campaignId: string, prospectIds: string[]): Promise<{ campaignId: string; jobsQueued: number }> {
  const res = await fetch(`${API_BASE}/whatsapp/campaigns/${campaignId}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prospectIds }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Erro ao iniciar campanha');
  }
  return json.data;
}

export async function pauseWhatsAppCampaign(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/whatsapp/campaigns/${id}/pause`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao pausar campanha');
}

export async function resumeWhatsAppCampaign(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/whatsapp/campaigns/${id}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao retomar campanha');
}

/** 007: edita as etapas da sequência (revalidação de template retido). */
export async function updateWhatsAppCampaignSteps(
  campaignId: string,
  steps: Array<{ id?: string; orderIndex?: number; messageTemplate?: string; delayMinutes?: number }>
): Promise<WhatsAppCampaign> {
  const res = await fetch(`${API_BASE}/whatsapp/campaigns/${campaignId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao atualizar campanha');
  return json.data;
}

/** 007: regera a mensagem base do WhatsApp a partir do perfil comercial. */
export async function rederiveWhatsAppCampaign(campaignId: string): Promise<{ id: string; messageTemplate: string }> {
  const res = await fetch(`${API_BASE}/whatsapp/campaigns/${campaignId}/rederive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao regerar mensagem');
  return json.data;
}

/** 007: regera o template de email a partir do perfil comercial. */
export async function rederiveOutreachCampaign(campaignId: string): Promise<{ id: string; subject: string; body: string }> {
  const res = await fetch(`${API_BASE}/outreach/campaigns/${campaignId}/rederive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao regerar template');
  return json.data;
}

export async function cancelWhatsAppCampaign(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/whatsapp/campaigns/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao cancelar campanha');
}

// ── Discovery Engine (specs/006-discovery-engine) ───────────────────────────

/** Dispara um job de discovery (202 — execução assíncrona no backend). */
export async function startDiscoveryJob(body: {
  criteria?: Record<string, unknown> | null;
  seed?: Record<string, unknown> | null;
  providers?: string[] | null;
}): Promise<{ jobId: string; status: string; providersTotal: number } | null> {
  const res = await fetch(`${API_BASE}/discovery/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json.error?.message || 'Falha ao criar job de discovery');
  return json.data;
}

/** Estado do job + runs por provider (progresso, custo e erros). */
export async function fetchDiscoveryJob(jobId: string): Promise<DiscoveryJobStatusPayload | null> {
  const res = await fetch(`${API_BASE}/discovery/jobs/${encodeURIComponent(jobId)}`);
  if (res.status === 404) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error('Falha ao carregar status do discovery');
  return json.data;
}

/** Candidatos paginados do job (filtros page/pageSize/minConfidence/status). */
export async function fetchDiscoveryJobCandidates(
  jobId: string,
  params: { page?: number; pageSize?: number; minConfidence?: number; status?: string } = {},
): Promise<DiscoveryCandidatesPayload> {
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.pageSize) query.set('pageSize', String(params.pageSize));
  if (params.minConfidence != null) query.set('minConfidence', String(params.minConfidence));
  if (params.status) query.set('status', params.status);
  const res = await fetch(`${API_BASE}/discovery/jobs/${encodeURIComponent(jobId)}/candidates?${query.toString()}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error('Falha ao carregar candidatos');
  return json.data;
}

/** Importa candidato como Prospect (idempotente no backend). */
export async function importDiscoveryCandidate(
  jobId: string,
  candidateId: string,
): Promise<{ candidateId: string; prospectId: string; status: string }> {
  const res = await fetch(
    `${API_BASE}/discovery/jobs/${encodeURIComponent(jobId)}/candidates/${encodeURIComponent(candidateId)}/import`,
    { method: 'POST' },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json.error?.message || 'Falha ao importar candidato');
  return json.data;
}

/** Inicia discovery a partir de um lead (seed cnpj/domain do Prospect). */
export async function startProspectDiscovery(prospectId: string): Promise<{ jobId: string } | null> {
  const res = await fetch(`${API_BASE}/prospects/${encodeURIComponent(prospectId)}/discovery`, { method: 'POST' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json.error?.message || 'Falha ao iniciar discovery do lead');
  return json.data;
}

/** Perfil completo de inteligência da empresa (corporate/financial/legal/ownership/digital). */
export async function fetchCompanyIntelligence(entityId: string): Promise<CompanyIntelligenceProfile | null> {
  const res = await fetch(`${API_BASE}/companies/${encodeURIComponent(entityId)}/intelligence`);
  if (res.status === 404) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error('Falha ao carregar inteligência da empresa');
  return json.data;
}
