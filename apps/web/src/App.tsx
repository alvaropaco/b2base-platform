import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { Layout } from '@/components/layout/Layout';
import { ExecutiveDashboardView } from '@/components/views/ExecutiveDashboardView';
import { ProspectsDirectoryView } from '@/components/views/ProspectsDirectoryView';
import { PipelineKanbanView } from '@/components/views/PipelineKanbanView';
import { CreditRiskView } from '@/components/views/CreditRiskView';
import { WorkflowsView } from '@/components/views/WorkflowsView';
import { CnpjEnrichmentView } from '@/components/views/CnpjEnrichmentView';
import { OutreachView } from '@/components/views/OutreachView';
import { DispatchHistoryView } from '@/components/views/DispatchHistoryView';
import { WhatsAppView } from '@/components/views/WhatsAppView';
import { SettingsView } from '@/components/views/SettingsView';
import { AvaOnboarding } from '@/components/onboarding/ava/AvaOnboarding';
import { ProspectModal } from '@/components/modals/ProspectModal';
// Lazy: a tela de detalhe (com @xyflow/react e maplibre-gl) sai do bundle
// principal — abre apenas quando o operador clica num lead (SC-001).
const LeadDetailScreen = lazy(() =>
  import('@/components/lead/LeadDetailScreen').then((m) => ({ default: m.LeadDetailScreen }))
);
import { ActiveTab, Prospect, PipelineAnalytics, OperationalAnalytics, CommercialProfile } from '@/types';
import type { OnboardingResult } from '@/types/onboarding';
import { fetchProspects, fetchPipelineAnalytics, fetchOperationalAnalytics, deleteProspect, fetchCommercialProfile, saveCommercialProfile } from '@/services/api';
import { buildCommercialProfilePayload, DONE_STORAGE_KEY } from '@/services/onboarding';
import { createSession, getSession, logoutSession, type SessionUser } from '@/services/auth';
import { getFirebaseRedirectResult, signOutFirebase } from '@/services/firebase';
import { getAuthErrorMessage } from '@/services/authErrors';
import { LoginView } from '@/components/auth/LoginView';
import { LandingView } from '@/components/auth/LandingView';
import { crmBadgeState } from '@/lib/crmBadge';
import { useSeo } from '@/hooks/useSeo';
import { StudioApp } from '@/studio/StudioApp';

// 009: fallback do sync de perfil quando o fetch inicial falhou — o payload do
// onboarding é autocontido e o merge simplesmente não tem campos a preservar.
const EMPTY_COMMERCIAL_PROFILE: CommercialProfile = {
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
};

// Map a URL path to a tab id so direct navigation (e.g. the Gmail OAuth
// redirect back to /settings?gmail_connected=...) lands on the right view
// instead of always reopening on the dashboard.
const TAB_FROM_PATH: Record<string, ActiveTab> = {
  '/': 'dashboard',
  '/dashboard': 'dashboard',
  '/prospects': 'prospects',
  '/pipeline': 'pipeline',
  '/risk': 'risk',
  '/workflows': 'workflows',
  '/enrichment': 'enrichment',
  '/outreach': 'outreach',
  '/whatsapp': 'whatsapp',
  '/history': 'history',
  '/settings': 'settings',
};

function tabFromPath(path: string): ActiveTab {
  const first = path.split('/')[1] || '';
  const key = first ? `/${first}` : '/';
  return TAB_FROM_PATH[key] || 'dashboard';
}

// Tela dedicada de detalhe do lead (feature 002): /leads/:id
function leadIdFromPath(path: string): string | null {
  const match = path.match(/^\/leads\/([\w-]+)\/?$/);
  return match ? match[1] : null;
}

export function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => tabFromPath(window.location.pathname));
  const [isDark, setIsDark] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [analytics, setAnalytics] = useState<PipelineAnalytics>({
    total_prospects: 0,
    qualified: 0,
    prospects: 0,
    deep_analysis: 0,
    discarded: 0,
    qualification_rate: 0,
    closure_rate: 0,
  });
  const [operational, setOperational] = useState<OperationalAnalytics>({
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
  });

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [commercialProfile, setCommercialProfile] = useState<CommercialProfile | null>(null);
  const [isLoadingProfile, setIsLoadingProfile] = useState(true);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  // Onboarding conversacional (feature 004): resultado da conversa com a Ava.
  // Nesta iteração vive no estado do app + sessionStorage (FR-018/FR-019).
  const [onboardingResult, setOnboardingResult] = useState<OnboardingResult | null>(null);

  // Tela dedicada de detalhe do lead: o id vem da URL (deep link /leads/:id).
  const [leadDetailId, setLeadDetailId] = useState<string | null>(() => leadIdFromPath(window.location.pathname));
  // true quando a entrada na tela foi via pushState — o botão Voltar usa history.back()
  const pushedDetailRef = useRef(false);

  const openLeadDetail = (id: string) => {
    pushedDetailRef.current = true;
    window.history.pushState(null, '', `/leads/${id}`);
    setLeadDetailId(id);
  };

  const closeLeadDetail = () => {
    if (pushedDetailRef.current) {
      window.history.back(); // popstate limpa o estado
      return;
    }
    // deep link direto (sem histórico interno): volta para a lista de leads
    pushedDetailRef.current = false;
    window.history.replaceState(null, '', '/prospects');
    setActiveTab('prospects');
    setLeadDetailId(null);
  };

  // Navegação do browser (Voltar/Avançar) sincroniza a tela de detalhe
  useEffect(() => {
    const onPopState = () => {
      const id = leadIdFromPath(window.location.pathname);
      pushedDetailRef.current = false;
      setLeadDetailId(id);
      if (!id) setActiveTab(tabFromPath(window.location.pathname));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Sai da tela de detalhe navegando para uma tab (sidebar ou atalhos)
  const navigateToTab = (tab: ActiveTab) => {
    if (leadDetailId) {
      pushedDetailRef.current = false;
      window.history.replaceState(null, '', `/${tab}`);
      setLeadDetailId(null);
    }
    setActiveTab(tab);
  };

  const [session, setSession] = useState<SessionUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(false);

  const VIEW_SEO: Record<ActiveTab, { title: string; description: string }> = {
    dashboard: {
      title: 'Dashboard',
      description: 'Visão geral comercial: leads disponíveis, contatos por WhatsApp e email, respostas e conversas ativas.',
    },
    prospects: {
      title: 'Prospecção e CRM',
      description: 'Diretório de prospectos B2B com dados de CNPJ, enriquecimento e qualificação de leads.',
    },
    pipeline: {
      title: 'Pipeline de vendas',
      description: 'Gestão visual do funil comercial com estágios, qualificação e priorização de oportunidades.',
    },
    risk: {
      title: 'Análise de risco',
      description: 'Regras comerciais e análise de risco de crédito para priorizar contatos e oportunidades.',
    },
    workflows: {
      title: 'Workflows automáticos',
      description: 'Automação de ações comerciais baseadas em regras, sinais de lead e mudanças de estágio.',
    },
    enrichment: {
      title: 'Enriquecimento de CNPJ',
      description: 'Consulte e enriqueça dados empresariais a partir de fontes oficiais e públicas.',
    },
    outreach: {
      title: 'Outreach automatizado',
      description: 'Crie e lance campanhas de e-mail por Gmail com controle de cadência, rate limits e supressão.',
    },
    studio: {
      // Nunca renderiza como tab (o clique na sidebar redireciona para /studio).
      title: 'Studio',
      description: 'Cockpit de campanhas com IA: briefing por chat, criação, disparo e monitoramento.',
    },
    whatsapp: {
      title: 'Prospecção via WhatsApp',
      description: 'Conecte seu WhatsApp, crie campanhas de prospecção e atenda conversas em um só lugar.',
    },
    history: {
      title: 'Histórico de disparos',
      description: 'Auditoria de todos os envios de email e WhatsApp das campanhas e suítes de outreach.',
    },
    settings: {
      title: 'Configurações',
      description: 'Configure seu perfil comercial, conecte contas do Gmail e gerencie integrações.',
    },
  };

  // Keep the public landing page's strong marketing SEO when unauthenticated;
  // only switch to per-route titles once the user enters the authenticated app.
  const LANDING_SEO = {
    title: 'B2Base | Inteligência de CNPJ, Prospecção, CRM e Pipeline B2B',
    description:
      'Plataforma B2B para descobrir e qualificar empresas via dados de CNPJ, organizar prospecção e CRM, gerir pipeline de vendas, avaliar risco e automatizar outreach por e-mail.',
    canonical: '/',
  };

  // Enquanto a tela de detalhe do lead está ativa, o SEO dela é quem manda —
  // o App fica em silêncio (undefined) para não sobrescrever o título do lead.
  useSeo(!session ? LANDING_SEO : leadDetailId ? undefined : VIEW_SEO[activeTab]);

  const loadData = async () => {
    try {
      const [prospectsData, analyticsData, operationalData, profileData] = await Promise.all([
        fetchProspects(),
        fetchPipelineAnalytics(),
        fetchOperationalAnalytics(),
        fetchCommercialProfile(),
      ]);
      setProspects(prospectsData);
      setAnalytics(analyticsData);
      setOperational(operationalData);
      setCommercialProfile(profileData);
    } catch (err) {
      console.error('Error loading data:', err);
    } finally {
      setIsLoadingProfile(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1) Complete a Firebase OAuth redirect (Google). After the
      // provider sends the browser back to the app, the SDK exposes the result
      // here; we exchange the ID token for a persistent backend session.
      try {
        const idToken = await getFirebaseRedirectResult();
        if (idToken) {
          const user = await createSession(idToken);
          if (!cancelled) {
            setSession(user);
            setAuthLoading(false);
          }
          return;
        }
      } catch (err) {
        console.error('Error completing Firebase redirect sign-in:', err);
        if (!cancelled) {
          setLoginError(getAuthErrorMessage(err));
        }
      }

      // 2) Persistent session: on subsequent visits the httpOnly cookie is sent
      // automatically and resolves the user without any re-login.
      try {
        const user = await getSession();
        if (!cancelled) {
          setSession(user);
          setAuthLoading(false);
        }
      } catch {
        if (!cancelled) {
          setSession(null);
          setAuthLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (session) {
      loadData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    const handleUnauthorized = () => setSession(null);
    window.addEventListener('b2base:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('b2base:unauthorized', handleUnauthorized);
  }, []);

  const handleLogout = async () => {
    await signOutFirebase();
    await logoutSession();
    setSession(null);
  };

  const handleDeleteProspect = async (id: string) => {
    if (!confirm('Deseja realmente excluir este prospecto?')) return;
    await deleteProspect(id);
    await loadData();
  };

  const handleSaveCommercialProfile = async (profile: CommercialProfile) => {
    setIsSavingProfile(true);
    try {
      const saved = await saveCommercialProfile(profile);
      setCommercialProfile(saved);
      await loadData();
    } finally {
      setIsSavingProfile(false);
    }
  };

  // Onboarding conversacional (feature 004): critério único de entrada — conta
  // com onboarding ainda não concluído (inclui a base existente) e sem conclusão
  // nesta sessão (flag em sessionStorage). Fail-closed (FR-001): se o perfil
  // não carrega (fetch falha), tratamos como pendente em vez de pular a Ava.
  const avaOnboardingGate =
    !!session &&
    !isLoadingProfile &&
    commercialProfile?.onboardingCompleted !== true &&
    !onboardingResult &&
    sessionStorage.getItem(DONE_STORAGE_KEY) !== '1';

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm font-semibold text-slate-400">
        <span className="animate-pulse">Carregando sessão…</span>
      </div>
    );
  }

  if (!session) {
    return showLogin ? (
      <LoginView
        onAuthenticated={(user) => {
          setLoginError(null);
          setSession(user);
        }}
        initialError={loginError}
      />
    ) : (
      <LandingView onLogin={() => setShowLogin(true)} />
    );
  }

  // Onboarding conversacional: fullscreen, sem sidebar — só volta ao app
  // (dashboard) quando a conversa termina (FR-001/FR-015).
  if (avaOnboardingGate) {
    return (
      <AvaOnboarding
        prefill={{
          firstName: session.name?.split(' ')[0] || undefined,
          companyName: commercialProfile?.companyName || undefined,
          email: session.email?.includes('@b2base.local') ? undefined : session.email,
        }}
        // 009 (FR-001/FR-002): a conta nasce configurada — as respostas são
        // salvas no perfil comercial ANTES da despedida; falha → retry (FR-005).
        onPersist={async (result) => {
          const saved = await saveCommercialProfile(
            buildCommercialProfilePayload(result, commercialProfile ?? EMPTY_COMMERCIAL_PROFILE)
          );
          setCommercialProfile(saved);
        }}
        onComplete={setOnboardingResult}
      />
    );
  }

  // Campaign Studio (feature 010): área separada com shell próprio em tema
  // dark — rota /studio renderizada FORA do shell de tabs. Entrada direta por
  // URL (deep link); o Studio usa pushState interno e o popstate existente
  // devolve o controle para o shell padrão.
  if (window.location.pathname === '/studio' || window.location.pathname.startsWith('/studio/')) {
    return <StudioApp userName={session.name || session.email} />;
  }

  return (
    <Layout
      activeTab={activeTab}
      setActiveTab={navigateToTab}
      isDark={isDark}
      setIsDark={setIsDark}
      totalProspectsCount={prospects.length}
      searchQuery={searchQuery}
      setSearchQuery={setSearchQuery}
      onOpenCreateModal={() => navigateToTab('prospects')}
      onOpenQualifyModal={() => navigateToTab('risk')}
      userName={session.name || session.phone || session.email}
      userEmail={session.phone || session.email}
      onLogout={handleLogout}
      // Pós-onboarding (feature 004 + 009): workspace e CRM refletem a conta —
      // resultado efêmero imediato com fallback no perfil SALVO (FR-010 009),
      // para que recarregar não desligue o badge nem o workspace.
      companyName={onboardingResult?.companyName || commercialProfile?.companyName || undefined}
      workspaceEmail={onboardingResult?.userEmail || (session.email.includes('@b2base.local') ? undefined : session.email)}
      crmBadge={crmBadgeState(
        commercialProfile?.crmName
          ? { name: commercialProfile.crmName, connected: true }
          : onboardingResult?.crm
      )}
    >
      {/* As views PERMANECEM MONTADAS (ocultas via CSS) enquanto a tela de
          detalhe está ativa — voltar preserva filtros e scroll das listas
          (FR-003/US1-AC3). */}
      <div className={leadDetailId ? 'hidden' : 'contents'}>
        {activeTab === 'dashboard' && (
          <ExecutiveDashboardView
            prospects={prospects}
            analytics={analytics}
            operational={operational}
            onSelectProspect={(p) => openLeadDetail(p.id)}
            onNavigateToTab={navigateToTab}
          />
        )}

        {activeTab === 'prospects' && (
          <ProspectsDirectoryView
            prospects={prospects}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            onSelectProspect={(p) => openLeadDetail(p.id)}
            onDeleteProspect={handleDeleteProspect}
            onRefresh={loadData}
            commercialProfile={commercialProfile}
            onOpenSettings={() => navigateToTab('settings')}
          />
        )}

        {activeTab === 'pipeline' && (
          <PipelineKanbanView
            prospects={prospects}
            onSelectProspect={(p) => openLeadDetail(p.id)}
            onRefresh={loadData}
            onNavigateToTab={navigateToTab}
          />
        )}

        {activeTab === 'risk' && <CreditRiskView />}

        {activeTab === 'workflows' && <WorkflowsView />}

        {activeTab === 'enrichment' && <CnpjEnrichmentView />}

        {activeTab === 'outreach' && <OutreachView prospects={prospects} />}

        {activeTab === 'whatsapp' && <WhatsAppView prospects={prospects} />}

        {activeTab === 'history' && <DispatchHistoryView />}

        {activeTab === 'settings' && <SettingsView profile={commercialProfile} onSave={handleSaveCommercialProfile} isSaving={isSavingProfile} />}
      </div>

      {/* Tela dedicada de detalhe do lead sobrepõe as views quando ativa */}
      {leadDetailId && (
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-24 text-sm font-semibold text-muted-foreground">
              <span className="animate-pulse">Abrindo perfil do lead…</span>
            </div>
          }
        >
          <LeadDetailScreen leadId={leadDetailId} onBack={closeLeadDetail} onNavigateToTab={navigateToTab} />
        </Suspense>
      )}

      {/* Modals */}
      <ProspectModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={loadData}
      />
    </Layout>
  );
}

export default App;
