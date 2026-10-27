import React, { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, Compass, Settings, Sparkles, Mail, ExternalLink, Inbox, Crown, KeyRound, Server } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CommercialProfile, EmailAccount, PlanInfo } from '@/types';
import { CommercialProfileForm } from '@/components/settings/CommercialProfileForm';
import { PhotoSendCard } from '@/components/settings/PhotoSendCard';
import {
  fetchGmailAuthUrl,
  fetchGmailAccounts,
  disconnectGmailAccount,
  connectEmailAccount,
  fetchPlan,
  createBillingCheckout,
  createBillingPortal,
} from '@/services/api';

export function SettingsView({
  profile,
  onSave,
  isSaving,
}: {
  profile: CommercialProfile | null;
  onSave: (profile: CommercialProfile) => Promise<void> | void;
  isSaving: boolean;
}) {
  const completed = Boolean(profile?.onboardingCompleted);
  const segmentCount = (profile?.targetSegments?.length || 0) + (profile?.targetCnaes?.length || 0);
  const locationCount = profile?.targetLocations?.length || 0;

  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [gmailNotice, setGmailNotice] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [planLoading, setPlanLoading] = useState(true);
  const [planNotice, setPlanNotice] = useState<string | null>(null);
  const [checkoutStarting, setCheckoutStarting] = useState(false);
  const [portalStarting, setPortalStarting] = useState(false);

  const [showOtherProviders, setShowOtherProviders] = useState(false);
  const [connectingProvider, setConnectingProvider] = useState<'smtp' | 'resend' | null>(null);
  const [smtpForm, setSmtpForm] = useState({
    email: '',
    password: '',
    smtpHost: 'smtp.gmail.com',
    smtpPort: '587',
    fromName: '',
  });
  const [resendForm, setResendForm] = useState({ email: '', apiKey: '', fromName: '' });

  const loadPlan = async () => {
    try {
      setPlan(await fetchPlan());
    } catch {
      setPlan(null);
    } finally {
      setPlanLoading(false);
    }
  };

  const loadAccounts = async () => {
    setAccounts(await fetchGmailAccounts());
  };

  useEffect(() => {
    loadAccounts();
    void loadPlan();
    const params = new URLSearchParams(window.location.search);
    if (params.get('gmail_connected')) {
      setGmailNotice(`Gmail conectado: ${params.get('gmail_connected')}`);
    } else if (params.get('gmail_error')) {
      setGmailNotice('Não foi possível conectar a conta do Gmail.');
    } else if (params.get('checkout') === 'success') {
      // O plano é ativado pelo webhook do Stripe, que pode chegar alguns
      // segundos depois do redirect — reconsulta o plano com um pequeno atraso.
      setPlanNotice('Pagamento confirmado! Ativando o plano Premium…');
      setTimeout(() => void loadPlan(), 3000);
      setTimeout(() => void loadPlan(), 10000);
    } else if (params.get('checkout') === 'cancel') {
      setPlanNotice('Checkout cancelado — você continua no plano Trial.');
    } else if (params.get('plan') === 'upgrade') {
      setPlanNotice('Faça o upgrade para liberar leads ilimitados e exportação de dados.');
    }
    if (params.get('checkout')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const handleSubscribe = async () => {
    setCheckoutStarting(true);
    setPlanNotice(null);
    try {
      const { url } = await createBillingCheckout();
      window.location.href = url;
    } catch (err) {
      setPlanNotice(err instanceof Error ? err.message : 'Erro ao iniciar o checkout');
      setCheckoutStarting(false);
    }
  };

  const handleManageSubscription = async () => {
    setPortalStarting(true);
    setPlanNotice(null);
    try {
      const { url } = await createBillingPortal();
      window.location.href = url;
    } catch (err) {
      setPlanNotice(err instanceof Error ? err.message : 'Erro ao abrir o portal de assinatura');
      setPortalStarting(false);
    }
  };

  const connectedAccounts = accounts.filter((a) => a.status === 'connected');

  const handleConnectGmail = async () => {
    setConnecting(true);
    setGmailNotice(null);
    try {
      const url = await fetchGmailAuthUrl();
      window.location.href = url;
    } catch (err) {
      setGmailNotice(err instanceof Error ? err.message : 'Erro ao conectar o Gmail');
      setConnecting(false);
    }
  };

  const handleDisconnect = async (id: string) => {
    if (!confirm('Desconectar esta conta de email?')) return;
    await disconnectGmailAccount(id);
    await loadAccounts();
  };

  const handleConnectSmtp = async () => {
    setConnectingProvider('smtp');
    setGmailNotice(null);
    try {
      const port = Number(smtpForm.smtpPort) || 587;
      const acct = await connectEmailAccount({
        provider: 'smtp',
        email: smtpForm.email.trim(),
        password: smtpForm.password,
        smtpHost: smtpForm.smtpHost.trim() || 'smtp.gmail.com',
        smtpPort: port,
        smtpSecure: port === 465,
        fromName: smtpForm.fromName.trim() || undefined,
      });
      setGmailNotice(`Conta SMTP conectada: ${acct.email}`);
      setSmtpForm({ ...smtpForm, password: '' });
      await loadAccounts();
    } catch (err) {
      setGmailNotice(err instanceof Error ? err.message : 'Erro ao conectar a conta SMTP');
    } finally {
      setConnectingProvider(null);
    }
  };

  const handleConnectResend = async () => {
    setConnectingProvider('resend');
    setGmailNotice(null);
    try {
      const acct = await connectEmailAccount({
        provider: 'resend',
        email: resendForm.email.trim(),
        apiKey: resendForm.apiKey.trim() || undefined,
        fromName: resendForm.fromName.trim() || undefined,
      });
      setGmailNotice(`Conta Resend conectada: ${acct.email}`);
      setResendForm({ ...resendForm, apiKey: '' });
      await loadAccounts();
    } catch (err) {
      setGmailNotice(err instanceof Error ? err.message : 'Erro ao conectar a conta Resend');
    } finally {
      setConnectingProvider(null);
    }
  };

  const providerLabel = (acct: EmailAccount) => {
    if (acct.provider === 'gmail') return 'Gmail OAuth';
    if (acct.provider === 'resend') return 'Resend (API)';
    return acct.smtpHost ? `SMTP · ${acct.smtpHost}` : 'SMTP';
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      <section className="rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-950">
        <div className="flex flex-col justify-between gap-5 xl:flex-row xl:items-end">
          <div className="max-w-3xl space-y-3">
            <Badge variant="outline" className="border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-300">
              <Settings className="mr-1.5 h-3.5 w-3.5" /> Preferências comerciais
            </Badge>
            <h1 className="text-3xl font-black tracking-tight text-slate-950 dark:text-white md:text-4xl">
              Ajuste como a B2Base encontra oportunidades para o seu time.
            </h1>
            <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">
              Essas preferências orientam a descoberta de leads, os filtros principais e a priorização comercial. Você pode alterar tudo quando o perfil de cliente ideal mudar.
            </p>
          </div>
          <Badge variant={completed ? 'qualified' : 'outline'} className="w-fit rounded-full px-4 py-2 text-xs font-black">
            {completed ? 'Configuração concluída' : 'Configuração pendente'}
          </Badge>
        </div>
      </section>

      {/* Plano / assinatura (trial | premium) */}
      <Card className="border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-slate-950/70">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-amber-500/10 p-2 text-amber-500">
                <Crown className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base font-bold">Plano</CardTitle>
                <CardDescription>Seu plano de assinatura e limites de uso</CardDescription>
              </div>
            </div>
            {!planLoading && plan && plan.plan === 'premium' && (
              <Badge variant="qualified" className="rounded-full px-4 py-1 text-xs font-black">
                Premium
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {planNotice && (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-700 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-300">
              {planNotice}
            </div>
          )}

          {planLoading ? (
            <p className="text-sm text-slate-500">Carregando plano...</p>
          ) : plan ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Plano atual</p>
                <p className="mt-1 text-lg font-black capitalize text-slate-950 dark:text-white">{plan.plan}</p>
              </div>
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Leads captados</p>
                <p className="mt-1 text-lg font-black text-slate-950 dark:text-white">
                  {plan.leadLimit === null ? `${plan.leadCount} (ilimitado)` : `${plan.leadCount} / ${plan.leadLimit}`}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Exportação de dados</p>
                <p className="mt-1 text-lg font-black text-slate-950 dark:text-white">
                  {plan.canExport ? 'Liberada' : 'Bloqueada'}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Não foi possível carregar o plano.</p>
          )}

          {!planLoading && plan && plan.plan === 'trial' && (
            <div className="flex flex-col items-start justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/20 dark:bg-amber-500/10 sm:flex-row sm:items-center">
              <p className="text-sm text-amber-800 dark:text-amber-200">
                No plano Trial você pode captar até {plan.leadLimit} leads e não pode exportar dados. Assine o Premium para liberar tudo.
              </p>
              {plan.billing?.configured === false ? (
                <p className="shrink-0 text-xs font-semibold text-amber-700 dark:text-amber-300">
                  Pagamentos em breve
                </p>
              ) : (
                <Button variant="gradient" size="sm" onClick={handleSubscribe} disabled={checkoutStarting} className="gap-2">
                  <Crown className="h-4 w-4" /> {checkoutStarting ? 'Redirecionando…' : 'Assinar Premium'}
                </Button>
              )}
            </div>
          )}

          {!planLoading && plan && plan.plan === 'premium' && plan.billing?.hasSubscription && (
            <div className="flex flex-col items-start justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-white/5 sm:flex-row sm:items-center">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Assinatura Stripe {plan.billing.subscriptionStatus ? `· status: ${plan.billing.subscriptionStatus}` : ''}
                {plan.billing.subscriptionStatus === 'past_due' && ' — atualize o cartão para evitar o cancelamento.'}
              </p>
              <Button variant="outline" size="sm" onClick={handleManageSubscription} disabled={portalStarting} className="gap-2 shrink-0">
                {portalStarting ? 'Abrindo…' : 'Gerenciar assinatura'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-slate-950/70">
          <CardContent className="flex items-center justify-between p-5">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Foco de mercado</p>
              <p className="mt-2 text-2xl font-black text-slate-950 dark:text-white">{segmentCount}</p>
              <p className="mt-1 text-xs text-slate-500">segmentos ou CNAEs</p>
            </div>
            <Compass className="h-8 w-8 text-indigo-500" />
          </CardContent>
        </Card>
        <Card className="border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-slate-950/70">
          <CardContent className="flex items-center justify-between p-5">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Regiões</p>
              <p className="mt-2 text-2xl font-black text-slate-950 dark:text-white">{locationCount}</p>
              <p className="mt-1 text-xs text-slate-500">prioridades comerciais</p>
            </div>
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
          </CardContent>
        </Card>
        <Card className="border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-slate-950/70">
          <CardContent className="flex items-center justify-between p-5">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">Ciclo de venda</p>
              <p className="mt-2 text-lg font-black text-slate-950 dark:text-white">{profile?.salesCycle || 'A definir'}</p>
              <p className="mt-1 text-xs text-slate-500">usado para priorização</p>
            </div>
            <Clock3 className="h-8 w-8 text-amber-500" />
          </CardContent>
        </Card>
      </section>

      {/* Email sending accounts (Gmail OAuth · SMTP · Resend) */}
      <Card className="border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-slate-950/70">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-red-500/10 p-2 text-red-500">
                <Mail className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base font-bold">Envio de outreach (e-mail)</CardTitle>
                <CardDescription>Conecte a conta que enviará as campanhas de e-mail</CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowOtherProviders((v) => !v)}>
                <Server className="mr-1.5 h-4 w-4" /> SMTP / Resend
              </Button>
              <Button variant="gradient" size="sm" onClick={handleConnectGmail} disabled={connecting} className="gap-2">
                <ExternalLink className="h-4 w-4" /> {connectedAccounts.length > 0 ? 'Conectar outra conta' : 'Conectar Gmail'}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {gmailNotice && (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-700 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-300">
              {gmailNotice}
            </div>
          )}

          {showOtherProviders && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* SMTP (ex.: Gmail com App Password) */}
              <div className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-white/10">
                <div className="flex items-center gap-2">
                  <Server className="h-4 w-4 text-slate-500" />
                  <p className="text-sm font-bold text-slate-950 dark:text-white">SMTP (Gmail com App Password)</p>
                </div>
                <p className="text-xs leading-5 text-slate-500">
                  Não depende de aprovação do Google. Para Gmail: ative a verificação em 2 etapas e gere uma App Password
                  em <span className="font-mono">myaccount.google.com/apppasswords</span>.
                </p>
                <div className="space-y-2">
                  <Input
                    type="email"
                    placeholder="seu@gmail.com"
                    value={smtpForm.email}
                    onChange={(e) => setSmtpForm({ ...smtpForm, email: e.target.value })}
                  />
                  <Input
                    type="password"
                    placeholder="App Password (16 caracteres)"
                    value={smtpForm.password}
                    onChange={(e) => setSmtpForm({ ...smtpForm, password: e.target.value })}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      placeholder="Servidor (smtp.gmail.com)"
                      value={smtpForm.smtpHost}
                      onChange={(e) => setSmtpForm({ ...smtpForm, smtpHost: e.target.value })}
                    />
                    <Input
                      type="number"
                      placeholder="Porta (587)"
                      value={smtpForm.smtpPort}
                      onChange={(e) => setSmtpForm({ ...smtpForm, smtpPort: e.target.value })}
                    />
                  </div>
                  <Input
                    placeholder="Nome de exibição (opcional)"
                    value={smtpForm.fromName}
                    onChange={(e) => setSmtpForm({ ...smtpForm, fromName: e.target.value })}
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={handleConnectSmtp}
                  disabled={connectingProvider === 'smtp' || !smtpForm.email || !smtpForm.password}
                >
                  {connectingProvider === 'smtp' ? 'Validando credenciais…' : 'Conectar via SMTP'}
                </Button>
              </div>

              {/* Resend (API) */}
              <div className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-white/10">
                <div className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-slate-500" />
                  <p className="text-sm font-bold text-slate-950 dark:text-white">Resend (API)</p>
                </div>
                <p className="text-xs leading-5 text-slate-500">
                  Envia pela API do Resend com entregabilidade gerenciada. O domínio do endereço abaixo precisa estar
                  verificado no painel do Resend (SPF/DKIM).
                </p>
                <div className="space-y-2">
                  <Input
                    type="email"
                    placeholder="voce@seudominio.com.br"
                    value={resendForm.email}
                    onChange={(e) => setResendForm({ ...resendForm, email: e.target.value })}
                  />
                  <Input
                    type="password"
                    placeholder="API key (re_…)"
                    value={resendForm.apiKey}
                    onChange={(e) => setResendForm({ ...resendForm, apiKey: e.target.value })}
                  />
                  <Input
                    placeholder="Nome de exibição (opcional)"
                    value={resendForm.fromName}
                    onChange={(e) => setResendForm({ ...resendForm, fromName: e.target.value })}
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={handleConnectResend}
                  disabled={connectingProvider === 'resend' || !resendForm.email}
                >
                  {connectingProvider === 'resend' ? 'Validando API key…' : 'Conectar via Resend'}
                </Button>
              </div>
            </div>
          )}

          {connectedAccounts.length === 0 ? (
            <div className="flex items-start gap-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-500 dark:bg-white/[0.03] dark:text-slate-400">
              <Inbox className="mt-0.5 h-5 w-5 shrink-0" />
              <p>
                Nenhuma conta conectada. Conecte o Gmail (OAuth), um SMTP com App Password ou o Resend para habilitar as
                campanhas de outreach em "Outreach".
              </p>
            </div>
          ) : (
            connectedAccounts.map((acct) => (
              <div key={acct.id} className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-white/10 dark:bg-white/[0.03]">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-red-500/10 text-sm font-black text-red-500">
                    {acct.email.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-950 dark:text-white">{acct.email}</p>
                    <p className="text-xs text-slate-500">
                      {providerLabel(acct)} · Status: {acct.status}
                    </p>
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => handleDisconnect(acct.id)} className="text-red-500">
                  Desconectar
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Envio de fotos por Gmail (anexos reais) */}
      <PhotoSendCard
        gmailConnected={connectedAccounts.some((acct) => acct.provider === 'gmail' && acct.status === 'connected')}
        onConnectGmail={handleConnectGmail}
        connecting={connecting}
      />

      <div className="rounded-[1.5rem] border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-900 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-100">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Quanto mais específico for o perfil, melhores serão as recomendações de leads. Priorize nichos, regiões e características que realmente indicam chance de compra.
          </p>
        </div>
      </div>

      <CommercialProfileForm profile={profile} onSave={onSave} isSaving={isSaving} />
    </div>
  );
}
