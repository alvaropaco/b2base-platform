/**
 * Cliente da API /api/studio do Campaign Studio (specs/010).
 * Padrão de apps/web/src/services/api.ts: fetch relativo, cookie de sessão
 * same-origin, erros normalizados em StudioApiError.
 */
import type {
  StudioCampaignDetail,
  StudioCampaignSummary,
  StudioApiError,
} from './types';

const API_BASE = '/api/studio';

export class StudioRequestError extends Error implements StudioApiError {
  error: string;
  status: number;

  constructor(error: string, status: number, message?: string) {
    super(message || error);
    this.name = 'StudioRequestError';
    this.error = error;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new StudioRequestError(
      (payload as StudioApiError)?.error || 'REQUEST_FAILED',
      res.status,
      (payload as StudioApiError)?.message
    );
  }
  return payload as T;
}

/** Healthcheck do módulo (smoke/monitoração). */
export function fetchStudioHealth(): Promise<{ success: boolean; module: string }> {
  return request('/health');
}

// ── Campanhas (T012 em diante) ──────────────────────────────────────────────

export async function fetchCampaigns(params?: { status?: string; q?: string }): Promise<
  StudioCampaignSummary[]
> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.q) qs.set('q', params.q);
  const data = await request<{ data: StudioCampaignSummary[] }>(
    `/campaigns${qs.toString() ? `?${qs}` : ''}`
  );
  return data.data ?? [];
}

export async function fetchCampaign(id: string): Promise<StudioCampaignDetail> {
  const data = await request<{ data: StudioCampaignDetail }>(
    `/campaigns/${encodeURIComponent(id)}`
  );
  return data.data;
}

/** Remove campanha (rascunho/revisão/concluída). Em voo → 409 do backend. */
export async function deleteCampaign(id: string): Promise<void> {
  await request(`/campaigns/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface CreateCampaignInput {
  name: string;
  description?: string;
  objective?: string;
  offer?: string;
  funnelStage?: 'top' | 'middle' | 'bottom';
  channels: Array<'email' | 'whatsapp' | 'linkedin_text'>;
  origin?: 'manual';
  templateId?: string;
  duplicateOf?: string;
  journeyEnabled?: boolean;
}

export async function createCampaign(
  input: CreateCampaignInput
): Promise<StudioCampaignDetail> {
  const data = await request<{ data: StudioCampaignDetail }>('/campaigns', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.data;
}

export interface ContentPatchInput {
  id: string;
  subject?: string | null;
  preheader?: string | null;
  whatsappText?: string | null;
  linkedinText?: string | null;
  ctaUrl?: string | null;
  emailDoc?: { blocks: EmailBlock[] } | null;
}

export async function patchCampaign(
  id: string,
  patch: Partial<Omit<CreateCampaignInput, 'origin' | 'templateId' | 'duplicateOf'>> & {
    contents?: ContentPatchInput[];
  }
): Promise<StudioCampaignDetail> {
  const data = await request<{ data: StudioCampaignDetail }>(
    `/campaigns/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(patch) }
  );
  return data.data;
}

// ── Fluxo de revisão/aprovação (US1) ────────────────────────────────────────

export async function submitReview(id: string): Promise<StudioCampaignDetail> {
  const data = await request<{ data: StudioCampaignDetail }>(
    `/campaigns/${encodeURIComponent(id)}/submit-review`,
    { method: 'POST' }
  );
  return data.data;
}

export async function approveCampaign(id: string): Promise<StudioCampaignDetail> {
  const data = await request<{ data: StudioCampaignDetail }>(
    `/campaigns/${encodeURIComponent(id)}/approve`,
    { method: 'POST', body: JSON.stringify({ confirm: true }) }
  );
  return data.data;
}

export async function scheduleImmediate(
  id: string
): Promise<StudioCampaignDetail> {
  const data = await request<{ data: StudioCampaignDetail }>(
    `/campaigns/${encodeURIComponent(id)}/schedule`,
    { method: 'POST', body: JSON.stringify({ mode: 'immediate' }) }
  );
  return data.data;
}

export async function controlCampaign(
  id: string,
  action: 'pause' | 'resume' | 'cancel'
): Promise<StudioCampaignDetail> {
  const data = await request<{ data: StudioCampaignDetail }>(
    `/campaigns/${encodeURIComponent(id)}/control`,
    { method: 'POST', body: JSON.stringify({ action, ...(action === 'cancel' ? { confirm: true } : {}) }) }
  );
  return data.data;
}

export async function requireReview(id: string, reason?: string): Promise<StudioCampaignDetail> {
  const data = await request<{ data: StudioCampaignDetail }>(
    `/campaigns/${encodeURIComponent(id)}/require-review`,
    { method: 'POST', body: JSON.stringify({ reason }) }
  );
  return data.data;
}

export interface AudienceMemberView {
  prospectId: string;
  companyName: string | null;
  included: boolean;
  excludeReason: string | null;
}

export interface AudienceView {
  snapshotId: string;
  totalCount: number;
  includedCount: number;
  excludedCount: number;
  members: AudienceMemberView[];
}

export async function setManualAudience(id: string, prospectIds: string[]): Promise<AudienceView> {
  const data = await request<{ data: AudienceView }>(
    `/campaigns/${encodeURIComponent(id)}/audience`,
    { method: 'POST', body: JSON.stringify({ manual: { prospectIds } }) }
  );
  return data.data;
}

export interface SampleRow {
  prospectId: string;
  companyName: string | null;
  contactName: string | null;
  renders: Array<{ channel: string; subject?: string; text?: string }>;
}

export async function fetchCampaignSample(id: string, limit = 5): Promise<SampleRow[]> {
  const data = await request<{ data: SampleRow[] }>(
    `/campaigns/${encodeURIComponent(id)}/sample?limit=${limit}`
  );
  return data.data;
}

// ── Segmentos (US2) ─────────────────────────────────────────────────────────

export interface SegmentCriteria {
  version: number;
  groups: Array<{
    op: 'AND' | 'OR';
    conditions: Array<{ field: string; op: string; value: unknown }>;
  }>;
}

export interface StudioSegment {
  id: string;
  name: string;
  description?: string | null;
  criteria: SegmentCriteria;
  lastCount?: number | null;
  lastCountAt?: string | null;
}

export interface SegmentPreview {
  count: number;
  delta: number | null;
  previousCount: number | null;
  sample: Array<{
    id: string;
    companyName: string;
    state?: string | null;
    industry?: string | null;
    opportunityScore?: number | null;
  }>;
}

export async function fetchSegments(): Promise<StudioSegment[]> {
  const data = await request<{ data: StudioSegment[] }>('/segments');
  return data.data ?? [];
}

export async function createSegment(input: {
  name: string;
  description?: string;
  criteria: SegmentCriteria;
  naturalLanguageInput?: string;
}): Promise<StudioSegment> {
  const data = await request<{ data: StudioSegment }>('/segments', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.data;
}

export async function previewSegment(id: string): Promise<SegmentPreview> {
  const data = await request<{ data: SegmentPreview }>(
    `/segments/${encodeURIComponent(id)}/preview`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  return data.data;
}

export async function setSegmentAudience(id: string, segmentId: string): Promise<AudienceView> {
  const data = await request<{ data: AudienceView }>(
    `/campaigns/${encodeURIComponent(id)}/audience`,
    { method: 'POST', body: JSON.stringify({ segmentId }) }
  );
  return data.data;
}

export async function setListAudience(id: string, list: string[]): Promise<AudienceView> {
  const data = await request<{ data: AudienceView }>(
    `/campaigns/${encodeURIComponent(id)}/audience`,
    { method: 'POST', body: JSON.stringify({ list }) }
  );
  return data.data;
}

// ── Agenda e fila (US3) ─────────────────────────────────────────────────────

export interface StudioWindow {
  days: number[];
  startHour: number;
  endHour: number;
}

export interface ScheduleForecast {
  estimatedAt: string | null;
  hoursNeeded?: number | null;
}

export async function scheduleCampaign(
  id: string,
  input: {
    mode: 'immediate' | 'scheduled';
    startAt?: string;
    windows?: StudioWindow[];
    hourlyLimit?: number;
    dailyLimit?: number;
    timezone?: string;
    useLeadTimezone?: boolean;
  }
): Promise<{ campaign: StudioCampaignDetail; forecast?: ScheduleForecast }> {
  const data = await request<{ data: StudioCampaignDetail; forecast?: ScheduleForecast }>(
    `/campaigns/${encodeURIComponent(id)}/schedule`,
    { method: 'POST', body: JSON.stringify(input) }
  );
  return { campaign: data.data, forecast: data.forecast };
}

export async function paceCampaign(
  id: string,
  pace: { hourlyLimit?: number; dailyLimit?: number }
): Promise<StudioCampaignDetail> {
  const data = await request<{ data: StudioCampaignDetail }>(
    `/campaigns/${encodeURIComponent(id)}/control`,
    { method: 'POST', body: JSON.stringify({ action: 'pace', pace }) }
  );
  return data.data;
}

export interface QueueRow {
  prospectId: string;
  channel: string;
  status: string;
  scheduledAt: string | null;
  sentAt: string | null;
  cancelReason: string | null;
  retainedReason?: string | null;
  companyName?: string | null;
}

/** Divergência audiência×fila (Epic 3): contatos em voo fora da seleção vigente. */
export interface QueueDivergence {
  count: number;
  byChannel: Record<string, number>;
  reason: string | null;
}

export async function fetchQueue(id: string): Promise<{ rows: QueueRow[]; flowStatus: string; divergence?: QueueDivergence }> {
  const data = await request<{ data: QueueRow[]; flowStatus: string; divergence?: QueueDivergence }>(
    `/campaigns/${encodeURIComponent(id)}/queue`
  );
  return { rows: data.data, flowStatus: data.flowStatus, divergence: data.divergence };
}

/** Funil agregado da campanha (StudioMetricDaily rollup) — monitor. */
export interface CampaignFunnel {
  sent: number;
  delivered: number;
  opens: number;
  clicks: number;
  replies: number;
  conversions: number;
  bounces: number;
  unsubs: number;
  estimated: boolean;
  rates: { deliveredRate: number; openRate: number; clickRate: number; replyRate: number; bounceRate: number };
}

export async function fetchCampaignAnalytics(id: string): Promise<{
  funnel: CampaignFunnel;
  roi: Record<string, unknown>;
  campaign: { id: string; name: string; goalMetric?: string | null };
}> {
  const data = await request<{ data: { funnel: CampaignFunnel; roi: Record<string, unknown>; campaign: { id: string; name: string; goalMetric?: string | null } } }>(
    `/campaigns/${encodeURIComponent(id)}/analytics`
  );
  return data.data;
}

export async function approveFirstBatch(
  id: string
): Promise<{ approvedAt: string; sample: Array<{ prospectId: string; companyName: string | null; channel: string }> }> {
  const data = await request<{
    data: { approvedAt: string; sample: Array<{ prospectId: string; companyName: string | null; channel: string }> };
  }>(`/campaigns/${encodeURIComponent(id)}/approve-first-batch`, { method: 'POST', body: JSON.stringify({}) });
  return data.data;
}

// ── Criação com IA (US4) ────────────────────────────────────────────────────

export interface StudioMaterial {
  id: string;
  kind: string;
  sourceRef?: string | null;
  extractionStatus: 'pending' | 'extracted' | 'failed' | 'needs_manual';
  extractionError?: string | null;
  extraction?: {
    product?: string | null;
    offer?: string | null;
    benefits?: string[];
    audience?: string | null;
    cta?: string | null;
    confidence?: number;
    confirmedAt?: string | null;
  } | null;
  confirmedAt?: string | null;
}

export async function createMaterialFromUrl(url: string): Promise<StudioMaterial> {
  const data = await request<{ data: StudioMaterial }>('/materials', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
  return data.data;
}

export async function createMaterialFromPrompt(prompt: string): Promise<StudioMaterial> {
  const data = await request<{ data: StudioMaterial }>('/materials', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  });
  return data.data;
}

export async function extractMaterial(id: string): Promise<StudioMaterial> {
  const data = await request<{ data: StudioMaterial }>(
    `/materials/${encodeURIComponent(id)}/extract`,
    { method: 'POST' }
  );
  return data.data;
}

export async function confirmMaterial(
  id: string,
  extraction: Partial<NonNullable<StudioMaterial['extraction']>>
): Promise<StudioMaterial> {
  const data = await request<{ data: StudioMaterial }>(
    `/materials/${encodeURIComponent(id)}/confirm`,
    { method: 'POST', body: JSON.stringify({ extraction }) }
  );
  return data.data;
}

export async function composeCampaign(
  id: string,
  input: { materialId?: string; prompt?: string; tones: string[] }
): Promise<{ batchId: string }> {
  const data = await request<{ data: { batchId: string } }>(
    `/campaigns/${encodeURIComponent(id)}/compose`,
    { method: 'POST', body: JSON.stringify(input) }
  );
  return data.data;
}

export interface BatchProgress {
  batchId: string;
  kind: string;
  status: 'running' | 'completed' | 'paused';
  done: number;
  total: number;
}

export async function fetchBatchProgress(batchId: string): Promise<BatchProgress> {
  const data = await request<{ data: BatchProgress }>(`/ai-batch/${encodeURIComponent(batchId)}`);
  return data.data;
}

// ── Anexos e Materiais da campanha (Stories 2.1/2.4 — onda 2026-09-29) ─────

import type { StudioAttachment } from './types';
export type { StudioAttachment };

export type AttachmentChannel = 'email' | 'whatsapp' | 'both';

export async function fetchAttachments(campaignId: string): Promise<StudioAttachment[]> {
  const data = await request<{ data: StudioAttachment[] }>(
    `/campaigns/${encodeURIComponent(campaignId)}/attachments`
  );
  return data.data ?? [];
}

/** Upload multipart (sem Content-Type manual — boundary é do FormData). */
export async function uploadAttachment(
  campaignId: string,
  file: File,
  channels: AttachmentChannel = 'both'
): Promise<StudioAttachment> {
  const form = new FormData();
  form.append('file', file);
  form.append('channels', channels);
  const res = await fetch(`/api/studio/campaigns/${encodeURIComponent(campaignId)}/attachments`, {
    method: 'POST',
    body: form,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.success) {
    throw new StudioRequestError(payload.error || 'UPLOAD_FAILED', res.status, payload.message);
  }
  return payload.data as StudioAttachment;
}

export async function deleteAttachment(campaignId: string, attachmentId: string): Promise<void> {
  await request(
    `/campaigns/${encodeURIComponent(campaignId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: 'DELETE' }
  );
}

/** Aba Materiais (Story 2.4/D7): por campanha + anexos + materiais da org. */
export interface CampaignMaterials {
  campaignMaterials: Array<{
    id: string;
    kind: string;
    sourceRef?: string | null;
    extractionStatus: string;
    extractionError?: string | null;
    confirmedAt?: string | null;
    scope: 'campaign' | 'org';
    createdAt: string;
  }>;
  attachments: StudioAttachment[];
  orgMaterials: Array<{
    id: string;
    kind: string;
    sourceRef?: string | null;
    extractionStatus: string;
    extractionError?: string | null;
    confirmedAt?: string | null;
    scope: 'campaign' | 'org';
    createdAt: string;
  }>;
}

export async function fetchCampaignMaterials(campaignId: string): Promise<CampaignMaterials> {
  const data = await request<{ data: CampaignMaterials }>(
    `/campaigns/${encodeURIComponent(campaignId)}/materials`
  );
  return data.data;
}

// ── Email Studio (US5) ──────────────────────────────────────────────────────

export interface EmailBlock {
  type: 'text' | 'button' | 'image' | 'divider' | 'columns';
  text?: string;
  label?: string;
  url?: string;
  src?: string;
  alt?: string;
  condition?: { field: string; op: string; value: unknown };
}

export interface StudioContent {
  id: string;
  channel: string;
  variantLabel: string;
  kind: string;
  stepIndex: number;
  subject?: string | null;
  preheader?: string | null;
  whatsappText?: string | null;
  linkedinText?: string | null;
  emailDoc?: { blocks: EmailBlock[] } | null;
  ctaUrl?: string | null;
  tone?: string | null;
}

export async function createContent(
  campaignId: string,
  input: { channel: string; subject?: string; emailDoc?: { blocks: EmailBlock[] }; whatsappText?: string; linkedinText?: string }
): Promise<StudioContent> {
  const data = await request<{ data: StudioContent }>(
    `/campaigns/${encodeURIComponent(campaignId)}/contents`,
    { method: 'POST', body: JSON.stringify(input) }
  );
  return data.data;
}

export async function fetchPreview(
  campaignId: string,
  contentId: string,
  view: 'desktop' | 'mobile' = 'desktop'
): Promise<{ html: string; text: string; subject?: string | null }> {
  const data = await request<{ data: { html: string; text: string; subject?: string | null } }>(
    `/campaigns/${encodeURIComponent(campaignId)}/contents/${encodeURIComponent(contentId)}/preview?view=${view}`
  );
  return data.data;
}

export async function runChecks(
  campaignId: string
): Promise<{ spamScore: number; level: string; items: Array<{ check: string; level: string; detail: string }> }> {
  const data = await request<{ data: { spamScore: number; level: string; items: Array<{ check: string; level: string; detail: string }> } }>(
    `/campaigns/${encodeURIComponent(campaignId)}/checks`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  return data.data;
}

export async function suggestFor(
  contentId: string,
  kind: 'subject' | 'preheader' | 'cta'
): Promise<{ suggestions: string[] }> {
  const data = await request<{ data: { suggestions: string[] } }>(
    `/contents/${encodeURIComponent(contentId)}/suggest`,
    { method: 'POST', body: JSON.stringify({ kind, n: 5 }) }
  );
  return data.data;
}

export async function applyUtm(
  campaignId: string,
  utm: { utmSource?: string; utmMedium?: string; utmCampaign?: string }
): Promise<StudioCampaignDetail> {
  const data = await request<{ data: StudioCampaignDetail }>(
    `/campaigns/${encodeURIComponent(campaignId)}/apply-utm`,
    { method: 'POST', body: JSON.stringify(utm) }
  );
  return data.data;
}

// ── WhatsApp Studio (US6) ───────────────────────────────────────────────────

export interface ReplyClassification {
  id: string;
  prospectId: string;
  channel: string;
  label: string;
  confidence: number;
  needsHumanReview: boolean;
  createdAt: string;
}

export async function fetchRepliesForReview(): Promise<ReplyClassification[]> {
  const data = await request<{ data: ReplyClassification[] }>('/replies?review=1');
  return data.data ?? [];
}

export async function confirmReplyLabel(
  id: string,
  label: string
): Promise<ReplyClassification> {
  const data = await request<{ data: ReplyClassification }>(
    `/replies/${encodeURIComponent(id)}/confirm`,
    { method: 'POST', body: JSON.stringify({ label }) }
  );
  return data.data;
}

// ── Personalização (US7) ────────────────────────────────────────────────────

export async function runPersonalization(
  campaignId: string,
  input: { contentId: string; level: 'greeting' | 'intro' | 'full'; prospectIds?: string[] }
): Promise<{ batchId: string; total: number }> {
  const data = await request<{ data: { batchId: string; total: number } }>(
    `/campaigns/${encodeURIComponent(campaignId)}/personalize`,
    { method: 'POST', body: JSON.stringify(input) }
  );
  return data.data;
}

export async function patchPersonalization(
  contentId: string,
  prospectId: string,
  input: { overrides: { intro?: string }; propagate?: boolean }
): Promise<unknown> {
  const data = await request<{ data: unknown }>(
    `/personalization/${encodeURIComponent(contentId)}/${encodeURIComponent(prospectId)}`,
    { method: 'PATCH', body: JSON.stringify(input) }
  );
  return data.data;
}

export interface PersonalizationPreviewRow {
  prospectId: string;
  companyName: string | null;
  status: string;
  rendered: string;
}

export async function fetchPersonalizationPreview(
  campaignId: string,
  contentId: string,
  sample = 10
): Promise<PersonalizationPreviewRow[]> {
  const data = await request<{ data: PersonalizationPreviewRow[] }>(
    `/campaigns/${encodeURIComponent(campaignId)}/personalization-preview?contentId=${encodeURIComponent(contentId)}&sample=${sample}`
  );
  return data.data;
}

// ── IA avançada (US14) ──────────────────────────────────────────────────────

export async function previewNlSegment(
  prompt: string
): Promise<{ criteria: SegmentCriteria; rationale: string }> {
  const data = await request<{ data: { criteria: SegmentCriteria; rationale: string } }>(
    '/segments/preview-nl',
    { method: 'POST', body: JSON.stringify({ prompt }) }
  );
  return data.data;
}

export async function askAnalyst(
  campaignId: string,
  question: string
): Promise<{ diagnosis: string; suggestions: string[]; answer: string }> {
  const data = await request<{ data: { diagnosis: string; suggestions: string[]; answer: string } }>(
    `/campaigns/${encodeURIComponent(campaignId)}/ask`,
    { method: 'POST', body: JSON.stringify({ question }) }
  );
  return data.data;
}

// ── Cockpit (specs/011) ─────────────────────────────────────────────────────
import type {
  CockpitHome,
  CockpitWake,
  CertificateVerdict,
  ReputationBalance,
  ReputationEvent,
} from './types';

/** Home do mordomo: sugestões, saldo, pausa global e campanha ativa. */
export async function fetchCockpitHome(): Promise<CockpitHome> {
  const data = await request<{ data: CockpitHome }>('/cockpit/home');
  return data.data;
}

/** Despertares do Contrato de Autonomia. */
export async function fetchCockpitWakes(): Promise<CockpitWake[]> {
  const data = await request<{ data: CockpitWake[] }>('/cockpit/wakes');
  return data.data ?? [];
}

export async function ackCockpitWake(id: string): Promise<void> {
  await request(`/cockpit/wakes/${encodeURIComponent(id)}/ack`, { method: 'POST', body: JSON.stringify({}) });
}

/** Painel de Saldo: valor corrente por canal + eventos explicados (FR-20). */
export async function fetchReputation(): Promise<{ balances: ReputationBalance[]; events: ReputationEvent[]; paused: boolean }> {
  const data = await request<{ data: { balances: ReputationBalance[]; events: ReputationEvent[]; paused: boolean } }>('/reputation');
  return data.data;
}

/** Pausa global de emergência 1-clique (FR-19); retomada exige ação explícita. */
export async function setSendPause(paused: boolean, reason?: string): Promise<{ paused: boolean }> {
  const data = await request<{ data: { paused: boolean } }>('/reputation/pause', {
    method: 'POST',
    body: JSON.stringify({ paused, ...(reason ? { reason } : {}) }),
  });
  return data.data;
}

/** Verificação DNS do domínio de envio (AD-8) — sob demanda. */
export async function verifySendingDomain(): Promise<{ status: string; domain?: string }> {
  const data = await request<{ data: { status: string; domain?: string } }>('/reputation/verify-domain', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return data.data;
}

/** Certificado de Segurança da campanha (FR-27). */
export async function fetchCertificate(id: string): Promise<CertificateVerdict> {
  const data = await request<{ data: CertificateVerdict }>(
    `/campaigns/${encodeURIComponent(id)}/certificate`
  );
  return data.data;
}

/** Consentimento WhatsApp do lead (FR-35) — caminho para consentir. */
export async function grantLeadConsent(
  prospectId: string,
  input: { source?: 'email_reply' | 'opt_in' | 'manual'; confirm?: boolean; note?: string }
): Promise<{ replayed: boolean }> {
  const data = await request<{ data: { replayed: boolean } }>(
    `/leads/${encodeURIComponent(prospectId)}/consent`,
    { method: 'POST', body: JSON.stringify(input) }
  );
  return data.data;
}

/** Chip-ação: executa uma action semântica idempotente (FR-9). `actionId` é
 *  opcional — sem ele, a idempotência é por hash de params (chips de
 *  recuperação do chat, Epic 1 FR6/FR15: duplo toque é replay no backend). */
export async function runCampaignAction(
  id: string,
  input: { type: string; actionId?: string; params?: Record<string, unknown> }
): Promise<{ card: { type: string; label: string; detail?: string }; campaignStatus: string }> {
  const data = await request<{ data: { card: { type: string; label: string; detail?: string }; campaignStatus: string } }>(
    `/campaigns/${encodeURIComponent(id)}/actions`,
    { method: 'POST', body: JSON.stringify(input) }
  );
  return data.data;
}

// ── Marca: perfil + assets (logo, materiais de marketing, contexto) ─────────

export interface BrandAsset {
  id: string;
  kind: 'logo' | 'material' | 'context';
  fileName: string;
  originalName: string;
  mime: string;
  size: number;
  url: string;
  createdAt: string;
}

export interface BrandProfilePayload {
  voice?: { toneNotes?: string; doExamples?: string[]; dontExamples?: string[] };
  kit?: { logoUrl?: string; colors?: Record<string, string>; fonts?: string; assets?: BrandAsset[] };
}

export async function fetchBrand(): Promise<Required<Pick<BrandProfilePayload, 'voice' | 'kit'>> & { id?: string }> {
  const data = await request<{ data: BrandProfilePayload & { id?: string } }>('/brand');
  return { id: data.data?.id, voice: data.data?.voice || {}, kit: data.data?.kit || {} };
}

export async function saveBrand(input: BrandProfilePayload): Promise<BrandProfilePayload> {
  const data = await request<{ data: BrandProfilePayload }>('/brand', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  return data.data;
}

export async function uploadBrandAsset(file: File, kind: BrandAsset['kind']): Promise<BrandAsset> {
  const form = new FormData();
  form.append('kind', kind);
  form.append('file', file);
  // multipart: sem Content-Type manual (boundary é do FormData)
  const res = await fetch('/api/studio/brand/assets', { method: 'POST', body: form });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.success) {
    throw new StudioRequestError(payload.error || 'UPLOAD_FAILED', res.status, payload.message);
  }
  return payload.asset as BrandAsset;
}

export async function deleteBrandAsset(id: string): Promise<void> {
  await request(`/brand/assets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── Audiência: leads do snapshot ativo, agrupados para seleção ──────────────

export interface AudienceLead {
  id: string;
  name: string;
  company: string;
  industry: string | null;
  city: string | null;
  state: string | null;
  employees: number | null;
  cnpj: string | null;
  score: number;
}

export interface AudienceLeadGroup {
  key: string;
  count: number;
  subs: Array<{
    key: string;
    count: number;
    subs: Array<{ key: string; count: number; leadIds: string[] }>;
  }>;
}

export async function fetchAudienceLeads(
  id: string,
  source: 'snapshot' | 'base' = 'snapshot'
): Promise<{
  total: number;
  leads: AudienceLead[];
  groups: AudienceLeadGroup[];
  selectedIds: string[];
}> {
  const data = await request<{
    data: { total: number; leads: AudienceLead[]; groups: AudienceLeadGroup[]; selectedIds: string[] };
  }>(`/campaigns/${encodeURIComponent(id)}/audience/leads${source === 'base' ? '?source=base' : ''}`);
  return data.data;
}

// ── Histórico de contatos com um lead (timeline da campanha) ────────────────

export interface LeadHistoryEvent {
  at: string;
  channel: 'email' | 'whatsapp';
  type: string;
  status: string;
  content?: string | null;
}

export interface LeadHistoryEmailContact {
  status: string;
  sequence: number;
  replyCount: number;
  lastReplyAt: string | null;
  unsubscribed: boolean;
  cancelReason: string | null;
}

export interface LeadHistory {
  prospect: {
    id: string;
    companyName: string;
    contactName: string | null;
    cnpjEmail: string | null;
    city: string | null;
    state: string | null;
  };
  emailContact: LeadHistoryEmailContact | null;
  events: LeadHistoryEvent[];
}

export async function fetchLeadHistory(campaignId: string, prospectId: string): Promise<LeadHistory> {
  const data = await request<{ data: LeadHistory }>(
    `/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(prospectId)}/history`
  );
  return data.data;
}
