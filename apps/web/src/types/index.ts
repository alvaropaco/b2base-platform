/**
 * Estágios do pipeline (feature 005): `deep_analysis` é a "Análise profunda"
 * (IA) entre Em Qualificação e Prontas para contato; `discarded` é destino
 * final. `contacted`/`proposal` são valores legados fora do kanban.
 */
export type ProspectStatus =
  | 'prospect'
  | 'deep_analysis'
  | 'qualified'
  | 'closed'
  | 'discarded'
  | 'contacted' // legado — fora do kanban
  | 'proposal'; // legado — fora do kanban

/** Estado da análise profunda de IA (feature 005). */
export type AnalysisStatus = 'not_started' | 'running' | 'completed' | 'failed';

/** Veredito final da análise de IA sobre entrar em contato ou não. */
export type AnalysisVerdict = 'contact' | 'no_contact';

/** Análise profunda vigente (contrato: specs/005-deep-lead-analysis/contracts/api.md). */
export interface DeepAnalysisResult {
  id: string;
  finalScore: number;
  verdict: AnalysisVerdict;
  summary: string;
  /** impressões da IA sobre o lead (FR-013) */
  impressions: string[];
  factorsPro: string[];
  factorsCon: string[];
  /** score determinístico no momento da análise (referência, FR-008) */
  deterministicScore: number | null;
  /** false ⇒ contexto comercial da org ausente na análise (FR-017) */
  orgContextConsidered: boolean;
  /** veredito negativo superado manualmente pelo usuário */
  override: boolean;
  modelVersion: string | null;
  completedAt: string;
}

/** Payload de GET /api/prospects/:id/deep-analysis. */
export interface DeepAnalysisStatePayload {
  state: AnalysisStatus;
  analysis: DeepAnalysisResult | null;
  errorMessage: string | null;
}

export type PlanType = 'trial' | 'premium';

export interface PlanBillingInfo {
  configured: boolean; // servidor com STRIPE_SECRET_KEY/STRIPE_PRICE_ID
  hasSubscription: boolean;
  subscriptionStatus: string | null; // active, trialing, past_due, canceled…
}

export interface PlanInfo {
  plan: PlanType;
  canExport: boolean;
  leadLimit: number | null;
  leadCount: number;
  leadsRemaining: number | null;
  atLeadLimit: boolean;
  billing?: PlanBillingInfo;
}

/** Resultado do gerador de campanha com IA (feature Premium). */
// 007: a criação NÃO dispara — responde pending_approval com a prévia da
// mensagem base para aprovação explícita do tenant (FR-009).
export interface AiCampaignPreview {
  sampleProspect: { id: string; companyName: string; contactName: string | null };
  whatsapp: { message: string; aiPersonalized: boolean } | null;
  email: { subject: string; body: string } | null;
}

export interface AiCampaignResult {
  status: 'pending_approval';
  emailCampaignId: string | null;
  whatsappCampaignId: string | null;
  channels: Array<'email' | 'whatsapp'>;
  leadCount: number;
  contextConfigured: boolean;
  strategy: { name: string; objective: string | null; offer: string | null; fallbackUsed?: boolean };
  preview: AiCampaignPreview;
}

export interface AiCampaignApproval {
  status: 'launched' | 'launched_with_errors';
  approvedAt: string;
  enrolled: { email: number; whatsapp: number };
  launchErrors: string[];
}

export interface EnrichmentSummary {
  domain?: string | null;
  website_active?: boolean | null;
  corporate_email?: boolean | null;
  launch_velocity?: number | null;
  operational_readiness?: number | null;
  commercial_potential?: number | null;
  tech_count?: number | null;
  /** decomposição do score de sinais (recalcLeadScore) */
  score_breakdown?: Record<string, number> | null;
  /** resolução de CNPJ de leads importados sem identificador */
  cnpj_resolution?: { source: string; confidence: number; matched_name?: string } | null;
  /** enriquecimento profundo (premium): PDL + scans */
  lead_enrichment?: Record<string, unknown> | null;
}

// --- Painel de decisão de contato (feature 003, GET /api/prospects/:id/contact-decision) ---

export type DecisionLevel = 'high' | 'medium' | 'low' | 'unknown';

/** Evidência por trás de uma métrica — NUNCA contém valor de e-mail/telefone. */
export interface DecisionEvidence {
  key: string;
  label: string;
  detail: string;
  confidence?: number | null;
  date?: string | null;
}

export interface DecisionChannel {
  type: 'email' | 'phone' | 'whatsapp';
  classification: 'corporate' | 'generic' | 'third_party' | 'unknown';
  confidence?: number | null;
}

export interface DecisionBasis {
  prospect: boolean;
  graph: boolean;
  graph_available: boolean;
}

/** "Consigo chegar até este lead?" (FR-002). */
export interface ReachabilityMetric {
  level: DecisionLevel;
  score: number | null;
  usableChannel: boolean;
  recommendedChannel: 'email' | 'phone' | 'whatsapp' | null;
  channels: DecisionChannel[];
  evidence: DecisionEvidence[];
  basis: DecisionBasis;
  stale: boolean;
}

/** "Este é um bom momento para abordar?" (FR-003). */
export interface TimingMetric {
  level: DecisionLevel;
  score: number | null;
  inactive: boolean | null;
  /** FR-018: sinais oficiais ausentes (lead sem CNPJ) */
  missingOfficialSignals: string[];
  evidence: DecisionEvidence[];
  basis: DecisionBasis;
  stale: boolean;
}

export type DecisionVerdict = 'contact_now' | 'contact_lower_priority' | 'do_not_prioritize';

export interface RecommendationFactor {
  weight: number;
  value: number | null;
  status: 'used' | 'neutral' | 'unknown';
}

/** Recomendação única e explicável (FR-004..FR-007). */
export interface ContactRecommendation {
  verdict: DecisionVerdict;
  reasons: Array<{ code: string; detail: string }>;
  factors: {
    reachability: RecommendationFactor;
    timing: RecommendationFactor;
    fit: RecommendationFactor;
    risk: RecommendationFactor;
  };
  suggestedAction: 'enrich_lead' | 'start_email' | 'start_whatsapp' | 'defer' | null;
  /** FR-015 — null quando o lead nunca recebeu contato */
  contactedContext: { contacted: boolean; channels: string[]; lastContact: string | null } | null;
}

/** Painel completo (contrato: specs/003-contact-decision-metrics/contracts/api.md). */
export interface ContactDecision {
  prospectId: string;
  generatedAt: string;
  dataRestricted: boolean;
  freshness: { stale: boolean; lastEvidenceAt: string | null; thresholdDays: number };
  reachability: ReachabilityMetric;
  timing: TimingMetric;
  recommendation: ContactRecommendation;
}

export interface Prospect {
  id: string;
  /** CNPJ (chave de enriquecimento no BR) — null em leads importados sem identificador */
  cnpj: string | null;
  taxIdType?: string | null;
  /** site/domínio — segunda chave universal de enriquecimento B2B */
  domain?: string | null;
  /** pessoa de contato (import CSV / enriquecimento PDL) */
  contactName?: string | null;
  /** logo da empresa (enriquecimento premium) */
  logoUrl?: string | null;
  companyName: string;
  industry?: string | null;
  employees?: number | null;
  opportunityScore: number;
  status: ProspectStatus;
  revenueEstimate?: number | null;
  qualificationStage?: string | null;
  lastContact?: string | null;
  /** canais em que o lead já recebeu contato real (badge "Contatado") */
  contactedChannels?: string[];
  orgId?: string;
  city?: string | null;
  state?: string | null;
  tradeName?: string | null;
  cnpjEmail?: string | null;
  cnpjPhones?: string[] | null;
  cnpjPartners?: CnpjPartner[] | null;
  cnpjOpenedAt?: string | null;
  cnpjLegalNature?: string | null;
  enrichmentStatus?: string | null;
  enrichmentSource?: string | null;
  enrichmentError?: string | null;
  enrichmentVersion?: number | null;
  enrichmentSummary?: EnrichmentSummary | null;
  enrichedAt?: string | null;
  /** estado da análise profunda de IA (feature 005) — ausente para orgs sem o recurso */
  analysisStatus?: AnalysisStatus | null;
  /** veredito vigente da análise (payload do kanban, premium) */
  verdict?: AnalysisVerdict | null;
  /** score de risco de crédito (0-100) e faixa — análise de risco */
  creditRiskScore?: number | null;
  creditRiskLevel?: 'low' | 'medium' | 'high' | string | null;
  createdAt: string;
  updatedAt: string;
  /** true quando o plano trial mascarou os campos sensíveis na resposta da API */
  dataRestricted?: boolean;
}

export interface PipelineAnalytics {
  total_prospects: number;
  qualified: number;
  prospects: number;
  /** cards em "Análise profunda" (feature 005) */
  deep_analysis: number;
  /** leads descartados (pela IA ou manualmente — feature 005) */
  discarded: number;
  qualification_rate: number;
  closure_rate: number;
}

/** Métricas operacionais reais do funil de contato (GET /api/analytics/operational). */
export interface OperationalAnalytics {
  leads_total: number;
  /** leads que nunca receberam contato real (contactedChannels vazio) */
  leads_uncontacted: number;
  /** leads criados no mês corrente */
  leads_new_this_month: number;
  contacted_total: number;
  contacted_email: number;
  contacted_whatsapp: number;
  /** união (por prospect) de quem respondeu por email ou WhatsApp */
  leads_replied: number;
  replied_email: number;
  replied_whatsapp: number;
  /** leads_replied / contacted_total */
  response_rate: number;
  whatsapp_conversations_active: number;
  whatsapp_conversations_total: number;
  /** volume histórico de disparos enviados por canal */
  dispatches_email_sent: number;
  dispatches_whatsapp_sent: number;
}

export interface StatusBreakdownItem {
  status: ProspectStatus;
  _count: number;
}

export interface QualificationResult {
  score: number;
  /** banda de score — 'lead' é legado (renomeada para 'initial' na feature 005) */
  level: 'qualified' | 'prospect' | 'initial' | 'lead';
  confidence: string;
}

export interface CreditRiskResult {
  score: number;
  level: 'low' | 'medium' | 'high';
  factors: string[];
}

export interface WorkflowItem {
  id: string | number;
  name: string;
  trigger: string;
  action: string;
  status: 'active' | 'paused';
  createdAt: string;
}

export interface CommercialProfile {
  id?: string | null;
  orgId?: string | null;
  onboardingCompleted: boolean;
  onboardingStep?: number;
  companyName: string;
  salesTeamSize: string;
  targetSegments: string[];
  targetCnaes: string[];
  targetLocations: string[];
  companyStatuses: string[];
  targetSizes: string[];
  ageRanges: string[];
  averageTicket?: number | null;
  salesCycle: string;
  valueProposition: string;
  // Contexto de negócio consumido pela IA (org-context.js)
  productDescription: string;
  businessModel: string;
  differentiators: string[];
  websiteUrl: string;
  ctaGoal: string;
  toneNotes: string;
  // Onboarding conversacional (009)
  crmName: string | null;
  onboardingAnswers: unknown | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface CnpjPartner {
  name?: string;
  qualification?: string;
  country?: string;
  ageRange?: string;
  joinedAt?: string;
}

export interface DiscoveredCompany {
  cnpj: string;
  legalName: string;
  tradeName?: string | null;
  industry?: string | null;
  status?: 'active' | 'inactive' | string | null;
  city?: string | null;
  state?: string | null;
  openingDate?: string | null;
  legalNature?: string | null;
  companySize?: string | null;
  shareCapital?: number | null;
  email?: string | null;
  isActive?: boolean;
  source?: string;
}

export interface DiscoveryCriteria {
  segments: string[];
  cnaeCodes?: string[];
  locations: string[];
  activeOnly: boolean;
  usedProfile: boolean;
}

export interface DiscoveryPage {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export interface EnrichedCnpjContact {
  id: string;
  cnpj: string;
  companyName: string;
  tradeName?: string | null;
  industry?: string | null;
  status: ProspectStatus;
  opportunityScore: number;
  email?: string | null;
  phones: string[];
  partners: CnpjPartner[];
  openedAt?: string | null;
  legalNature?: string | null;
  enrichmentStatus: 'pending' | 'enriched' | 'unavailable' | 'error';
  enrichmentSource?: string | null;
  enrichmentError?: string | null;
  enrichedAt?: string | null;
  createdAt: string;
  /** true quando o plano trial mascarou os campos sensíveis na resposta da API */
  dataRestricted?: boolean;
}

// 'studio' existe no union para o item da sidebar/mobile-nav apontar para o
// Cockpit (/studio) — NÃO é tab do shell (nenhuma view renderiza com ele;
// o clique redireciona via window.location.assign, ver Sidebar/Layout).
export type ActiveTab = 'dashboard' | 'prospects' | 'pipeline' | 'risk' | 'workflows' | 'enrichment' | 'outreach' | 'studio' | 'whatsapp' | 'history' | 'settings';

// --- Histórico de disparos (email + WhatsApp) ---------------------------------

export interface DispatchHistoryItem {
  id: string; // "email:<cuid>" | "wa:<cuid>"
  channel: 'email' | 'whatsapp';
  prospectId: string | null;
  companyName: string | null;
  cnpj: string | null;
  destination: string | null; // email do lead ou telefone
  campaignId: string | null;
  campaignName: string | null;
  origin: 'auto' | 'manual' | 'conversation'; // suíte automática, campanha manual, conversa 1:1
  compositionOrigin?: 'tenant_template' | 'ai' | 'ai_fallback_template' | 'profile_base' | null; // auditoria da composição (007)
  preview: string | null; // assunto (email) ou início da mensagem (WhatsApp)
  status: string; // status bruto do canal
  bucket: 'sent' | 'pending' | 'failed';
  error: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface DispatchHistoryCampaignOption {
  id: string;
  name: string | null;
  channel: 'email' | 'whatsapp';
}

export interface DispatchHistoryResult {
  items: DispatchHistoryItem[];
  total: number;
  hasMore: boolean;
  counts: { sent: number; pending: number; failed: number };
  campaigns: DispatchHistoryCampaignOption[];
}

// --- Outreach / Cold sales via Gmail ----------------------------------------

export interface EmailAccount {
  id: string;
  email: string;
  provider: string; // gmail (OAuth), smtp, resend
  status: string; // connected, revoked, expired, error
  scopes: string[];
  fromName?: string | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  lastHistoryId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutreachCampaign {
  id: string;
  name: string;
  description?: string | null;
  // Proposta comercial da campanha (contexto da IA)
  objective?: string | null;
  offer?: string | null;
  status: string; // draft, active, paused, completed
  // Suíte multicanal (gatilho pós-enriquecimento)
  trigger?: string; // manual | on_enrichment
  channels?: string[]; // ["email", "whatsapp"]
  autoActive?: boolean;
  emailAccountId?: string | null;
  emailTemplateSubject?: string | null;
  emailTemplateBody?: string | null;
  whatsappAccountId?: string | null;
  whatsappTemplate?: string | null;
  // Governança de template (007): retenção do saneamento + aprovação do fluxo IA
  needsReview?: boolean;
  reviewReason?: string | null;
  approvedAt?: string | null;
  // Leads já inscritos nesta campanha (OutreachContact) — a lista de
  // lançamento os exclui: nunca reenviar o primeiro toque na mesma campanha.
  contactedProspectIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface OutreachMessageSummary {
  id: string;
  subject: string;
  status?: string | null;
  sentAt?: string | null;
  scheduledFor?: string | null;
  gmailMessageId?: string | null;
  gmailThreadId?: string | null;
  trackingToken?: string | null;
  error?: string | null;
}

export interface OutreachEvent {
  id: string;
  contactId?: string | null;
  messageId?: string | null;
  type: string;
  status: string;
  details?: Record<string, unknown> | null;
  createdAt: string;
  message?: Pick<OutreachMessageSummary, 'id' | 'subject' | 'status' | 'sentAt' | 'gmailMessageId'> | null;
}

export interface OutreachContactSummary {
  id: string;
  status: string; // SELECTED → QUEUED → … → REPLIED
  outreachSequence: number;
  scheduledAt?: string | null;
  sentAt?: string | null;
  nextFollowupAt?: string | null;
  lastReplyAt?: string | null;
  replyCount: number;
  unsubscribed: boolean;
  cancelReason?: string | null;
  campaign?: { name: string; status: string } | null;
  messages: OutreachMessageSummary[];
  events: OutreachEvent[];
}

export interface SuppressionEntry {
  id: string;
  email: string;
  reason?: string | null;
  addedAt: string;
}

export interface StartCampaignResult {
  campaignId: string;
  jobsQueued: number;
  skippedAlreadyEnrolled?: number;
  jobIds: string[];
}

// --- WhatsApp (prospecção via WAHA) ------------------------------------------

export type WhatsAppAccountStatus =
  | 'CREATED'
  | 'STARTING'
  | 'QR_REQUIRED'
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'STOPPED'
  | 'ERROR';

export interface WhatsAppAccount {
  id: string;
  provider: string;
  sessionName: string;
  phoneNumber?: string | null;
  status: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export type WhatsAppCampaignStatus =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'CANCELLED';

export interface WhatsAppSequenceStep {
  id: string;
  campaignId: string;
  orderIndex: number;
  messageTemplate: string;
  delayMinutes: number;
  conditions: unknown[];
  createdAt?: string;
}

export interface WhatsAppCampaign {
  id: string;
  name: string;
  // Proposta comercial da campanha (contexto da IA)
  objective?: string | null;
  offer?: string | null;
  ctaUrl?: string | null;
  whatsappAccountId?: string | null;
  whatsappAccount?: Pick<WhatsAppAccount, 'id' | 'phoneNumber' | 'status'> | null;
  status: string;
  startedAt?: string | null;
  pausedAt?: string | null;
  completedAt?: string | null;
  // Governança de template (007): retenção do saneamento + aprovação do fluxo IA
  needsReview?: boolean;
  reviewReason?: string | null;
  approvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  steps?: WhatsAppSequenceStep[];
  _count?: { contacts: number };
  contacts?: Array<{ id: string; status: string; prospect?: { id: string; companyName: string; cnpj: string } | null }>;
}

export interface WhatsAppMessage {
  id: string;
  conversationId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  type: string;
  content?: string | null;
  mediaUrl?: string | null;
  providerMessageId?: string | null;
  status: string;
  compositionOrigin?: string | null; // auditoria da composição (007)
  sentAt?: string | null;
  deliveredAt?: string | null;
  readAt?: string | null;
  createdAt: string;
  error?: string | null;
}

export type WhatsAppConversationStatus =
  | 'ACTIVE'
  | 'PAUSED'
  | 'HUMAN_HANDOFF'
  | 'CLOSED'
  | 'OPTED_OUT';

export interface WhatsAppConversation {
  id: string;
  phoneNumber: string;
  status: string;
  prospectId?: string | null;
  assignedTo?: string | null;
  lastMessageAt?: string | null;
  lastInboundMessageAt?: string | null;
  // Reengajamento automático (agente de IA)
  reengageAttempts?: number;
  reengageTotal?: number;
  lastReengageAt?: string | null;
  automationPausedAt?: string | null;
  whatsappAccountId?: string | null;
  whatsappAccount?: Pick<WhatsAppAccount, 'id' | 'phoneNumber' | 'status'> | null;
  prospect?: { id: string; companyName: string; cnpj: string; city?: string | null; state?: string | null; industry?: string | null } | null;
  _count?: { messages: number };
}

// Sugestão do agente de reengajamento aguardando aprovação (modo suggest).
export interface WhatsAppReengagementSuggestion {
  id: string;
  conversationId: string;
  prospectId?: string | null;
  attempt: number;
  strategy?: string | null;
  reason?: string | null;
  content?: string | null;
  origin?: string | null;
  mode: string;
  status: string;
  createdAt: string;
  conversation?: { id: string; phoneNumber: string; chatId?: string | null; prospectId?: string | null } | null;
  prospect?: { id: string; companyName: string; tradeName?: string | null } | null;
}

export interface WhatsAppAutomationConfig {
  enabled: boolean;
  mode: 'shadow' | 'suggest' | 'auto';
  maxAttempts: number;
  maxTotal: number;
  cooldownHours: number;
  minGapHours: number;
  dailyCap: number;
  scanIntervalMin: number;
}

export interface WhatsAppConnectResult {
  accountId: string;
  status: string;
  qr?: { qrCode?: string | null; raw?: string | null } | null;
}

// --- Perfil completo do lead enriquecido (feature 002) -----------------------

/** Estado independente de cada seção da tela de detalhe (FR-015). */
export type LeadSectionState = 'idle' | 'loading' | 'ready' | 'error' | 'empty';

/** Precisão da geolocalização de um endereço (data-model.md). */
export type LeadAddressPrecision = 'street' | 'zip' | 'city';

export interface LeadAddressLocation {
  lat: number;
  lng: number;
  precision: LeadAddressPrecision;
}

export type LeadAddressKind = 'headquarters' | 'captured' | 'city';
export type LeadAddressSource = 'cnpj_raw' | 'graph_fact' | 'prospect_summary';

/** Endereço do lead deduplicado, com geolocalização opcional (contracts/api.md). */
export interface LeadAddress {
  id: string;
  fullText: string;
  kind: LeadAddressKind;
  source: LeadAddressSource;
  confidence?: number | null;
  location: LeadAddressLocation | null;
}

export interface LeadAddressesResponse {
  prospectId: string;
  dataRestricted: boolean;
  addresses: LeadAddress[];
}

/** Fatos agregados do motor v2 por entidade (GET /api/prospects/:id/enrichment). */
export interface LeadEnrichmentEntity {
  entityKey: string;
  entityType: string;
  /** mapa capability → entrada do summary v2: { entityKey, status, provider, taskId, data, facts } */
  capabilities: Record<
    string,
    { status?: string; provider?: string | null } & Record<string, unknown>
  >;
}

// --- Grafo de enriquecimento (v_company_graph) -------------------------------

export interface GraphNode {
  id: string;
  type: string;
  key: string;
  label: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  confidence?: number | null;
  observed_at?: string | null;
}

export interface GraphFact {
  entity_type: string;
  entity_key: string;
  entity_label?: string | null;
  fact_key: string;
  value: unknown;
  confidence?: number | null;
  confidence_label?: 'alta' | 'média' | 'baixa';
  source?: Record<string, unknown> | null;
  observed_at?: string | null;
}

export interface CompanyProfile {
  firmographics: Record<string, unknown>;
  domain: unknown;
  social: Record<string, { url?: string; confidence?: number | null }>;
  contact_points: Array<{ type: string; value: string; confidence?: number | null }>;
  financial_indicators: Record<string, unknown>;
  technologies: Array<{ name?: string; category?: string; confidence?: number | null }>;
  people: Array<{ id: string; label: string; role: string; confidence?: number | null }>;
  relationships: {
    co_owners: string[];
    edge_count: number;
    edges: GraphEdge[];
  };
  evidence: unknown[];
  raw_facts?: Array<{ key: string; value: unknown; confidence?: number | null }>;
}

export interface CompanyGraph {
  companyId: string;
  cnpj: string;
  enrichmentVersion: number;
  status: string;
  enrichedAt: string | null;
  profile: CompanyProfile;
  summary: Record<string, unknown>;
  companyLabel: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  facts: GraphFact[];
  /** true quando o plano trial mascarou contatos/quadro societário na resposta */
  dataRestricted?: boolean;
}

// --- Taxonomia CNAE ---------------------------------------------------------

export interface CnaeAtividade {
  cnae: string;
  codigo: string;
  atividade: string;
}

export interface CnaeCategoria {
  divisao: string;
  nome: string;
  atividades: CnaeAtividade[];
}

export interface CnaeRamo {
  secao: string;
  nome: string;
  oficial: string;
  categorias: CnaeCategoria[];
}

// --- Discovery Engine (specs/006-discovery-engine) ---------------------------

export type DiscoveryJobStatus = 'queued' | 'running' | 'partial' | 'completed' | 'failed' | 'cancelled';

export interface DiscoveryProviderRunState {
  provider: string;
  capability: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  attempt: number;
  items: number;
  requests: number;
  estimatedCost: number;
  errorCode: string | null;
}

export interface DiscoveryJobPayload {
  id: string;
  orgId: string;
  status: DiscoveryJobStatus;
  trigger: string;
  providersTotal: number;
  providersDone: number;
  providersFailed: number;
  itemsFound: number;
  estimatedCost: number;
  createdAt: string;
  completedAt: string | null;
}

export interface DiscoveryJobStatusPayload {
  job: DiscoveryJobPayload;
  providers: DiscoveryProviderRunState[];
  progress: { total: number; done: number; failed: number };
}

export interface DiscoveryCandidate {
  id: string;
  jobId: string;
  companyEntityId: string | null;
  cnpj: string | null;
  name: string | null;
  domain: string | null;
  confidence: number;
  status: 'discovered' | 'imported' | 'dismissed';
  evidenceCount: number;
  importedProspectId: string | null;
}

export interface DiscoveryCandidatesPayload {
  total: number;
  page: number;
  candidates: DiscoveryCandidate[];
}

export interface CompanyIntelligenceProfile {
  company: {
    id: string;
    type: string;
    displayName: string | null;
    confidence: number;
    attributes: Record<string, unknown>;
    identifiers: Record<string, unknown>;
  };
  corporate: {
    identity: { cnpj: string | null; legalName: string | null; tradeName: string | null; status: string | null; isActive: boolean; openingDate: string | null };
    classification: { legalNature: string | null; companySize: string | null; industry: string | null; cnaes: string[] };
    address: { city: string | null; state: string | null } | null;
    shareCapital: number | null;
    confidence: number;
    evidenceCount: number;
  };
  financial: {
    capitalSocial: { value: number; formatted: string | null; evidenceType: string } | null;
    funding: Array<{ name: string | null; stage: string | null; amount: number | null; currency: string; announcedAt: string | null; investors: Array<{ name: string }>; evidenceType: string }>;
    hasEstimatedData: boolean;
    confidence: number;
  };
  legal: {
    cases: Array<{ caseNumber: string; displayName: string | null; court: string | null; status: string | null; sources: string[]; confidence: number }>;
    courts: string[];
    totalCases: number;
    riskScore: number;
  };
  ownership: {
    partners: Array<{ name: string | null; ownershipPct: number | null; confidence: number }>;
    directors: Array<{ name: string | null; role: string | null; confidence: number }>;
    representatives: Array<{ name: string | null; confidence: number }>;
    confidence: number;
  };
  digital: {
    technologies: unknown[];
    evidenceCount: number;
  };
  signals: Array<{ id: string; type: string; value: Record<string, unknown>; confidence: number; observedAt: string | null }>;
  evidenceSummary: { total: number; byType: Record<string, number> };
}
