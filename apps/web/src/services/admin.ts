// ─── Serviço da área administrativa (admin) ───────────────────────────────
// Autenticação BÁSICA (login/senha do Infisical), independente do Firebase.
const API_BASE = '/api/admin';

export interface AdminMe {
  username: string;
}

export interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  role: string;
  sessionVersion: number;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string | null;
  blockedAt: string | null;
  orgId: string;
  organization: {
    id: string;
    name: string;
    plan: 'trial' | 'premium';
    cnpj: string | null;
  } | null;
}

export interface AdminOrgRow {
  id: string;
  name: string;
  cnpj: string | null;
  plan: 'trial' | 'premium';
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePlanStatus: string | null;
  createdAt: string;
  updatedAt: string;
  _count: { users: number; prospects: number };
  users: Array<{ id: string; email: string; name: string | null }>;
  billingLive?: StripeBillingSnapshot;
  balance?: number;
}

export interface AdminSummary {
  users: number;
  orgs: number;
  trials: number;
  premiums: number;
  prospects: number;
  billingConfigured?: boolean;
}

// ── Status de pagamento via Stripe (admin) ────────────────────────────────
export interface StripeBillingSnapshot {
  configured: boolean;
  hasSubscription: boolean;
  snapshot?: {
    subscriptionId: string;
    status: string; // active | trialing | past_due | canceled | unpaid | incomplete…
    cancelAtPeriodEnd: boolean;
    currentPeriod: { start: string | null; end: string | null };
    plan: { amount: number | null; currency: string; interval: string | null; nickname: string | null };
    paymentMethod: {
      brand: string | null;
      last4: string | null;
      expMonth: number | null;
      expYear: number | null;
    } | null;
    lastInvoice: {
      id: string;
      number: string | null;
      status: string;
      amountDue: number | null;
      amountPaid: number | null;
      currency: string;
      created: string | null;
      hostedInvoiceUrl: string | null;
    } | null;
    customer: { delinquent: boolean } | null;
  } | null;
  error?: string;
}

export interface Paged<T> {
  data: T[];
  meta: { total: number; limit: number; skip: number };
}

/** Configura estado "não autenticado/no admin" e evita o guard global pular. */
export async function adminLogin(
  username: string,
  password: string
): Promise<void> {
  const res = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username, password }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Falha no login do admin. Verifique usuário e senha.');
  }
}

export async function adminLogout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/logout`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // best effort
  }
}

export async function adminMe(): Promise<AdminMe | null> {
  try {
    const res = await fetch(`${API_BASE}/me`, { credentials: 'include' });
    if (!res.ok) return null;
    const json = await res.json();
    return json.success ? (json.data as AdminMe) : null;
  } catch {
    return null;
  }
}

export async function adminSummary(): Promise<AdminSummary> {
  const res = await fetch(`${API_BASE}/summary`, { credentials: 'include' });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao carregar resumo');
  return json.data as AdminSummary;
}

export async function adminUsers(q = '', limit = 200): Promise<Paged<AdminUserRow>> {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  params.set('limit', String(limit));
  const res = await fetch(`${API_BASE}/users?${params.toString()}`, { credentials: 'include' });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao carregar usuários');
  return json as Paged<AdminUserRow>;
}

export async function adminOrgs(q = '', plan = '', limit = 200): Promise<Paged<AdminOrgRow>> {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (plan) params.set('plan', plan);
  params.set('limit', String(limit));
  const res = await fetch(`${API_BASE}/orgs?${params.toString()}`, { credentials: 'include' });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao carregar contas');
  return json as Paged<AdminOrgRow>;
}

export async function adminSetOrgPlan(
  orgId: string,
  plan: 'trial' | 'premium'
): Promise<AdminOrgRow> {
  const res = await fetch(`${API_BASE}/orgs/${encodeURIComponent(orgId)}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ plan }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao alterar o plano');
  return json.data as AdminOrgRow;
}

/** Bloqueia ou desbloqueia um usuário. Retorna o usuário atualizado. */
export async function adminSetUserBlocked(
  userId: string,
  blocked: boolean
): Promise<AdminUserRow> {
  const action = blocked ? 'block' : 'unblock';
  const res = await fetch(`${API_BASE}/users/${encodeURIComponent(userId)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao alterar bloqueio');
  return json.data as AdminUserRow;
}

/** Adiciona saldo de disparo à carteira da org. Retorna crédito e novo saldo. */
export async function adminAddOrgBalance(
  orgId: string,
  amount: number,
  reason = ''
): Promise<{ credited: number; balance: number }> {
  const res = await fetch(`${API_BASE}/orgs/${encodeURIComponent(orgId)}/balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ amount, reason }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao adicionar saldo');
  return json.data as { credited: number; balance: number };
}

/** Busca o status de pagamento AO VIVO do Stripe de um org específico. */
export async function adminOrgBilling(orgId: string): Promise<{
  org: Pick<AdminOrgRow, 'id' | 'name' | 'plan' | 'stripeSubscriptionId' | 'stripePlanStatus'>;
  billing: StripeBillingSnapshot;
}> {
  const res = await fetch(`${API_BASE}/orgs/${encodeURIComponent(orgId)}/billing`, {
    credentials: 'include',
  });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao consultar billing');
  return json.data;
}
