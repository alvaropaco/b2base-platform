/**
 * Tipos do domínio Campaign Studio (specs/010).
 * Espelham data-model.md e contracts/rest-api.md. Crescem por story.
 */

export type StudioCampaignStatus =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'retained';

export type StudioChannel = 'email' | 'whatsapp' | 'linkedin_text';

export type StudioOrigin =
  | 'manual'
  | 'ai_prompt'
  | 'material'
  | 'url'
  | 'company_data'
  | 'duplicate'
  | 'template'
  | 'agent';

export type FunnelStage = 'top' | 'middle' | 'bottom';

export interface StudioSchedule {
  mode: 'immediate' | 'scheduled';
  startAt?: string | null;
  windows: Array<{ days: number[]; startHour: number; endHour: number }>;
  hourlyLimit: number;
  dailyLimit: number;
  timezone: string;
  useLeadTimezone: boolean;
}

export interface StudioCampaignSummary {
  id: string;
  name: string;
  description?: string | null;
  status: StudioCampaignStatus;
  statusReason?: string | null;
  origin: StudioOrigin;
  channels: StudioChannel[];
  funnelStage: FunnelStage;
  audienceCount?: number;
  sentCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface StudioCampaignDetail extends StudioCampaignSummary {
  objective?: string | null;
  offer?: string | null;
  schedule: StudioSchedule;
  approvedAt?: string | null;
  journeyEnabled: boolean;
  emailExecutionId?: string | null;
  whatsappExecutionId?: string | null;
  /** Canais de envio CONECTADOS na org (Story 3.1 — CTA do Pré-voo por estado). */
  connectedChannels?: { email: boolean; whatsapp: boolean };
  approval?: { automation?: boolean; complianceLevel?: string | null } & Record<string, unknown>;
  contents?: Array<Record<string, unknown>>;
  /** Snapshot ativo da audiência (GET /campaigns/:id) — null = nunca montada. */
  audience?: { id: string; totalCount: number; includedCount: number; excludedCount: number } | null;
}

/** Anexo que sai JUNTO na mensagem (Story 2.1, FR6) — e-mail e/ou WhatsApp. */
export interface StudioAttachment {
  id: string;
  orgId?: string;
  campaignId?: string | null;
  fileName: string;
  originalName: string;
  mimeType?: string | null;
  sizeBytes: number;
  /** Canal destino: email | whatsapp | both. */
  channels: 'email' | 'whatsapp' | 'both';
  createdAt?: string;
}

export interface StudioApiError {
  error: string;
  message?: string;
}

// ── Cockpit (specs/011) ─────────────────────────────────────────────────────

/** Carteira ÚNICA de envios (2026-10-08 — e-mail + WhatsApp no mesmo pool;
 *  cada canal mantém teto diário de ritmo e requisito próprio). */
export interface ReputationBalance {
  channel: 'unified';
  balance: number;
  available: number;
  floor: number;
  ceiling: number;
  rampStage: number;
  caps: { email: number; whatsapp: number };
  usedToday: { email: number; whatsapp: number };
  domainAuthStatus: 'unverified' | 'verified' | 'prewarmed' | 'failed';
  domainAuthCheckedAt?: string | null;
  /** true quando balance ≤ 25% do teto (pop-up "saldo acabando"). */
  lowBalance: boolean;
  threshold: number;
  updatedAt?: string;
}

/** Evento do ledger — toda variação de saldo é atribuível (FR-20). */
export interface ReputationEvent {
  id: string;
  channel: string;
  type: 'debit' | 'credit' | 'block';
  amount: number;
  balanceAfter: number;
  reason?: string | null;
  refType?: string | null;
  refId?: string | null;
  createdAt: string;
}

/** Chip do Briefing do Mordomo — carrega o dado que o motivou (FR-21). */
export interface CockpitChip {
  kind: string;
  label: string;
  motivo: string;
  prompt?: string;
  campaignId?: string;
  createCampaign?: boolean;
  demo?: boolean;
  count?: number;
  /** Ação semântica real (FR-9) — dispara POST /campaigns/:id/actions. */
  action?: { type: string; params?: Record<string, unknown> };
}

/** Despertar do Contrato de Autonomia (FR-31). */
export interface CockpitWake {
  dedupKey: string;
  kind: string;
  severity: string;
  title: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

/** Home do Cockpit: estado único de abertura. */
export interface CockpitHome {
  diaZero: boolean;
  chips: CockpitChip[];
  balances: ReputationBalance[];
  paused: boolean;
  activeCampaignId: string | null;
  activeCampaignName: string | null;
  wakes: CockpitWake[];
}

/** Item do Certificado/Checklist de prontidão (FR-27 + onda 2026-09-29). */
export interface CertificateItem {
  key: string;
  label: string;
  /** `pending` = destrava por ação/tempo; `warning` = atenção; `block` = só no disparo (gate). */
  level: 'ok' | 'warning' | 'pending' | 'block';
  detail: string;
  /** O que destrava (caminho em tom mordomo — UX-DR1). */
  howToFix?: string;
  /** Quando libera (ex.: "reposição diária às 07:00 (horário local)"). */
  whenUnblocks?: string;
}

export interface CertificateVerdict {
  /** Onda 2026-09-29: 'amber' = pronto para criar, com pendências de disparo. */
  level: 'green' | 'amber' | 'blocked';
  items: CertificateItem[];
  requiredUnits: number;
  evaluatedAt: string;
  /** Modo da avaliação: criação (default) ou disparo (só o gate consome). */
  mode?: 'creation' | 'dispatch';
}
