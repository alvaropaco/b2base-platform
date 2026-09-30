/**
 * StudioApp — o Cockpit (specs/011, CAP-1/2/3/7).
 *
 * Rota ÚNICA `/studio` (FR-1): sidebar de navegação + área central com a
 * conversa — o Briefing do Mordomo na abertura, chips que são ações, Rail das
 * 5 luzes só quando existe campanha (FR-3), cards dentro do thread, painéis
 * "Avançado" sob demanda (FR-5), pausa global 1-clique (FR-19) e Despertares
 * do Contrato de Autonomia. Dark herda os tokens `.dark`; movimento é CSS
 * nativo com `prefers-reduced-motion` honrado; zero dependência nova
 * (constituição VI).
 *
 * Linguagem visual (2026-09-27, ref. Zyricon/Dribbble 26578109): noite
 * arroxeada com bloom radial, superfícies glass, orbe na abertura e composer
 * em cartão com envio circular em gradiente violeta.
 *
 * Rotas antigas do Studio (`/studio/campaigns`, `/studio/agent`, …)
 * redirecionam para `/studio` (FR-1).
 */
import {
  Activity,
  ArrowUp,
  Bell,
  Bot,
  ChevronLeft,
  Mail,
  Megaphone,
  Menu,
  MessageCircle,
  MessageSquare,
  Palette,
  Play,
  Plus,
  Rocket,
  ShieldCheck,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  StudioRequestError,
  ackCockpitWake,
  createCampaign,
  fetchCampaign,
  fetchCockpitHome,
  fetchReputation,
  runCampaignAction,
  setSendPause,
} from './api';
import type { CockpitHome, ReputationBalance, ReputationEvent } from './types';
import { CampaignChat } from './components/CampaignChat';
import { CampaignMonitorView } from './components/CampaignMonitorView';
import { CampaignsListView } from './views/CampaignsListView';
import { PreFlightView } from './views/PreFlightView';
import { AgentPanel } from './components/AgentPanel';
import { BrandSettings } from './components/BrandSettings';

const RAIL_STEPS = [
  { key: 'objective', label: 'Objetivo' },
  { key: 'audience', label: 'Audiência' },
  { key: 'message', label: 'Mensagem' },
  { key: 'schedule', label: 'Agenda' },
  { key: 'balance', label: 'Saldo' },
] as const;

type RailKey = (typeof RAIL_STEPS)[number]['key'];

/** Luz acesa = etapa corrente da máquina de estados (FR-3).
 *  2026-09-28 (fix 2): o Rail deve CAMINHAR com a campanha. O detalhe
 *  (`GET /campaigns/:id`) devolve `audience: { includedCount } | null` —
 *  o código antigo lia `audienceCount` (sempre undefined) e congelava em
 *  "Audiência". Snapshot existe (mesmo com 0 leads) = etapa feita. */
function currentRailStep(detail: {
  objective?: string | null;
  audienceCount?: number | null;
  audience?: { includedCount: number } | null;
  contents?: Array<Record<string, unknown>>;
  schedule?: { hourlyLimit?: number } | null;
  status?: string;
}): RailKey | null {
  if (!detail.objective) return 'objective';
  const audienceCount = detail.audienceCount ?? detail.audience?.includedCount ?? null;
  if (audienceCount == null) return 'audience';
  if (!detail.contents || detail.contents.length === 0) return 'message';
  if (!detail.schedule?.hourlyLimit) return 'schedule';
  return 'balance';
}

/** Canal saudável = acima do piso do Orçamento de Reputação (FR-14). */
function channelHealthy(b: ReputationBalance): boolean {
  return b.available > b.floor;
}

const CHANNEL_ICON = { email: Mail, whatsapp: MessageSquare } as const;

const CHIP_ICON: Record<string, typeof Wand2> = {
  demo: MessageCircle,
  first_campaign: Wand2,
  domain_auth: ShieldCheck,
};

export interface StudioAppProps {
  userName?: string | null;
  onExit?: () => void;
}

export function StudioApp({ userName, onExit }: StudioAppProps) {
  const [home, setHome] = useState<CockpitHome | null>(null);
  const [campaignDetail, setCampaignDetail] = useState<Awaited<ReturnType<typeof fetchCampaign>> | null>(null);
  const [balances, setBalances] = useState<ReputationBalance[]>([]);
  const [saldoOpen, setSaldoOpen] = useState(false);
  const [events, setEvents] = useState<ReputationEvent[]>([]);
  const [wakesOpen, setWakesOpen] = useState(false);
  // FR-1/Story 3.1: 'preflight' é o destino do fim da criação (redirect
  // automático via onApproved) e painel de ajuste fino pré-lançamento.
  const [pane, setPane] = useState<'home' | 'campaigns' | 'agent' | 'brand' | 'monitor' | 'preflight'>('home');
  const [navOpen, setNavOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [busyPause, setBusyPause] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [demo, setDemo] = useState(false);
  const [draft, setDraft] = useState('');
  const [sweeping, setSweeping] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  const prevStatusRef = useRef<string | null>(null);

  const loadHome = useCallback(async () => {
    try {
      const data = await fetchCockpitHome();
      if (!data) return; // home vazia/indisponível: mantém estado, sem setHome(null-data)
      // A escolha LOCAL de campanha ativa vence o default do servidor: refetches
      // de estado (apply da gaveta de leads, actions do chat) não podem trocar
      // de campanha e desviar mensagens para outro thread (bug QA E2E 2026-09-28).
      // Nome viaja junto — senão o topo mostra o título de OUTRA campanha.
      setHome((prev) =>
        prev && prev.activeCampaignId
          ? { ...data, activeCampaignId: prev.activeCampaignId, activeCampaignName: prev.activeCampaignName }
          : data
      );
      setPaused(data.paused);
      setBalances(data.balances || []);
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao abrir o Cockpit');
    }
  }, []);

  useEffect(() => {
    void loadHome();
  }, [loadHome]);

  // FR-1: rotas antigas do Studio redirecionam para a rota única. Deep link
  // /studio/campaigns/:id abre a campanha CERTA (mapeia o id antes de limpar).
  useEffect(() => {
    const deepLink = window.location.pathname.match(/^\/studio\/campaigns\/([\w-]+)\/?$/);
    if (deepLink) {
      window.history.replaceState(null, '', '/studio');
      fetchCampaign(deepLink[1])
        .then((detail) =>
          setHome((prev) => (prev ? { ...prev, activeCampaignId: detail.id, activeCampaignName: detail.name } : prev))
        )
        .catch(() => {
          setError('Campanha do link não encontrada — abrindo a home.');
        });
      return;
    }
    if (window.location.pathname !== '/studio') {
      window.history.replaceState(null, '', '/studio');
    }
  }, []);

  // Rail precisa do estado da campanha ativa (luz acesa = etapa corrente).
  useEffect(() => {
    if (!home?.activeCampaignId) {
      setCampaignDetail(null);
      return;
    }
    fetchCampaign(home.activeCampaignId)
      .then(setCampaignDetail)
      .catch(() => setCampaignDetail(null));
  }, [home?.activeCampaignId]);

  // Momento-assinatura (FR-6): autorização → a luz percorre o Rail e assenta.
  useEffect(() => {
    const status = campaignDetail?.status ?? null;
    if (prevStatusRef.current && prevStatusRef.current !== 'running' && status === 'running') {
      setSweeping(true);
      const t = setTimeout(() => setSweeping(false), 1000);
      prevStatusRef.current = status;
      return () => clearTimeout(t);
    }
    prevStatusRef.current = status;
  }, [campaignDetail?.status]);

  const openSaldo = async () => {
    setSaldoOpen((v) => !v);
    setWakesOpen(false);
    setNavOpen(false); // mobile: painel atrás do overlay ficaria inalcançável
    if (!saldoOpen) {
      try {
        const data = await fetchReputation();
        setEvents(data.events || []);
        setBalances(data.balances || []);
      } catch (_) {
        /* painel mantém o último estado */
      }
    }
  };

  /** FR-19: pausa 1-clique; retomada exige ação consciente (confirm). */
  const togglePause = async () => {
    setBusyPause(true);
    setError(null);
    try {
      if (paused) {
        const resume = window.confirm('Retomar todos os envios da organização?');
        if (!resume) return;
      }
      const result = await setSendPause(!paused, paused ? undefined : 'pausa global acionada pelo usuário');
      setPaused(result.paused);
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao mudar a pausa');
    } finally {
      setBusyPause(false);
    }
  };

  const startCampaign = async (description?: string) => {
    setCreating(true);
    setError(null);
    try {
      const campaign = await createCampaign({
        // Hora no nome: "Campanha 28/09/2026" colidia no mesmo dia e deixava a
        // lista e o seletor do Monitor ambíguos (QA E2E 2026-09-28, U2).
        name: `Campanha ${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`,
        description: description?.trim() || undefined,
        channels: ['email'],
        origin: 'manual',
      });
      await loadHome();
      // Abre o diálogo já no thread da campanha criada.
      window.history.replaceState(null, '', '/studio');
      setPane('home');
      setDraft('');
      setHome((prev) => (prev ? { ...prev, activeCampaignId: campaign.id, activeCampaignName: campaign.name } : prev));
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao criar campanha');
    } finally {
      setCreating(false);
    }
  };

  // Acessibilidade da navegação mobile: foco ao abrir + Escape fecha (AA/teclado).
  useEffect(() => {
    if (navOpen) {
      navRef.current?.querySelector<HTMLElement>('button')?.focus();
    }
  }, [navOpen]);

  const onNavKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setNavOpen(false);
    }
  };

  const railCurrent = campaignDetail ? currentRailStep(campaignDetail) : null;
  const [lastCampaign, setLastCampaign] = useState<{ id: string; name: string } | null>(null);
  const railRef = useRef<HTMLOListElement>(null);
  // Rail no mobile: o passo CORRENTE é o que importa — centraliza-o na faixa
  // scrollável em vez de deixar cortado sob a máscara de fade.
  useEffect(() => {
    railRef.current
      ?.querySelector('[data-current="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [railCurrent]);
  const hasCampaign = Boolean(home?.activeCampaignId);
  const wakes = home?.wakes ?? [];
  const exitStudio = useCallback(() => {
    if (onExit) {
      onExit();
      return;
    }
    window.history.replaceState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, [onExit]);

  const navigate = (target: typeof pane) => {
    setPane(target);
    setNavOpen(false);
    setSaldoOpen(false);
    setWakesOpen(false);
  };

  /** "Salvar rascunho e sair": volta ao briefing; a campanha continua salva. */
  const exitToBriefing = useCallback(() => {
    setHome((prev) => {
      if (prev?.activeCampaignId) {
        setLastCampaign({ id: prev.activeCampaignId, name: prev.activeCampaignName || 'Campanha em andamento' });
      }
      return prev ? { ...prev, activeCampaignId: null, activeCampaignName: null } : prev;
    });
    setPane('home');
  }, []);

  const resumeCampaign = useCallback((id: string, name?: string) => {
    setLastCampaign(null);
    setHome((prev) => (prev ? { ...prev, activeCampaignId: id, activeCampaignName: name || null } : prev));
    setPane('home');
  }, []);

  const navItems: Array<{ key: typeof pane; label: string; icon: typeof Bot }> = [
    { key: 'home', label: 'Cockpit', icon: MessageCircle },
    { key: 'campaigns', label: 'Campanhas', icon: Megaphone },
    { key: 'monitor', label: 'Monitor', icon: Activity },
    { key: 'preflight', label: 'Pré-voo', icon: Rocket },
    { key: 'agent', label: 'Agente IA', icon: Bot },
    { key: 'brand', label: 'Marca', icon: Palette },
  ];

  const sidebar = (
    <>
      {/* Identidade + ação primária (ref: logo row + New Chat). */}
      <div className="flex items-center gap-2.5 px-3 pb-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#160211] text-white shadow-md">
          <Sparkles className="h-[18px] w-[18px]" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold tracking-tight text-foreground">b2base</p>
          <p className="text-[11px] text-muted-foreground">Cockpit</p>
        </div>
        <button
          type="button"
          onClick={() => setNavOpen(false)}
          className="ml-auto rounded-lg border border-border p-1.5 text-muted-foreground hover:bg-accent lg:hidden"
          title="Fechar navegação"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <button
        type="button"
        onClick={() => {
          setNavOpen(false);
          void startCampaign();
        }}
        disabled={creating}
        className="mx-3 mb-5 flex items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-[#160211] px-3 py-2.5 text-sm font-medium text-white shadow-md transition-transform hover:brightness-110 disabled:opacity-40"
      >
        <Plus className="h-4 w-4" />
        {creating ? 'Abrindo…' : 'Nova campanha'}
      </button>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3" aria-label="Navegação do Cockpit">
        <div>
          <p className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Operação
          </p>
          <ul className="space-y-0.5">
            {navItems.map((item) => {
              const active = pane === item.key;
              const Icon = item.icon;
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    onClick={() => navigate(item.key)}
                    aria-current={active ? 'page' : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                      active
                        ? 'bg-white/70 text-foreground shadow-[inset_0_0_0_1px_rgba(22,2,17,0.12)]'
                        : 'text-muted-foreground hover:bg-white/60 hover:text-foreground'
                    }`}
                  >
                    <Icon className={`h-4 w-4 ${active ? 'text-foreground' : ''}`} />
                    {item.label}
                    {item.key === 'home' && wakes.length > 0 && (
                      <span className="ml-auto rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">
                        {wakes.length}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Canais do Orçamento de Reputação — luz semântica por saúde (FR-14). */}
        {balances.length > 0 && (
          <div>
            <p className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
              Canais
            </p>
            <ul className="space-y-0.5">
              {balances.map((b) => {
                const Icon = CHANNEL_ICON[b.channel] ?? MessageSquare;
                const healthy = channelHealthy(b);
                return (
                  <li key={b.channel}>
                    <button
                      type="button"
                      onClick={() => void openSaldo()}
                      aria-expanded={saldoOpen}
                      aria-controls="cockpit-saldo"
                      title={
                        healthy
                          ? `${b.available} unidades livres · domínio ${b.domainAuthStatus === 'verified' ? 'verificado' : 'não verificado'}`
                          : `Abaixo do piso (${b.available}/${b.floor}) — envio bloqueado`
                      }
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
                    >
                      <Icon className="h-4 w-4" />
                      <span className="capitalize">{b.channel === 'email' ? 'E-mail' : 'WhatsApp'}</span>
                      <span className="ml-auto flex items-center gap-1.5 text-[13px] text-foreground/80">
                        {b.available}
                        <span
                          aria-hidden="true"
                          className={`inline-block h-2 w-2 rounded-full ${
                            healthy ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]' : 'bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.5)]'
                          }`}
                        />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </nav>

      {/* Rodapé: resumo do Orçamento de Reputação (ref: upgrade card). */}
      {balances.length > 0 && (
        <div className="cockpit-glass m-3 rounded-xl p-3">
          <p className="text-xs font-semibold text-foreground">Orçamento de Reputação</p>
          <p
            className={`mt-1 text-[11px] leading-relaxed ${
              balances.every(channelHealthy) ? 'text-muted-foreground' : 'text-rose-700'
            }`}
          >
            {balances.every(channelHealthy)
              ? 'Todos os canais saudáveis — glow verde significa autorizado.'
              : 'Canal abaixo do piso: disparos bloqueados até recarregar.'}
          </p>
          <button
            type="button"
            onClick={() => void openSaldo()}
            className="mt-2 w-full rounded-lg border border-[#160211]/15 bg-white/60 px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-white"
          >
            Ver movimentos
          </button>
        </div>
      )}
    </>
  );

  return (
    <div className="cockpit-scope relative flex h-dvh overflow-hidden bg-background text-foreground">
      <div className="cockpit-bloom" aria-hidden />

      {/* Sidebar (desktop permanente; mobile: overlay). */}
      <aside className="hidden w-[264px] shrink-0 flex-col border-r border-[#160211]/10 bg-white/60 backdrop-blur-xl lg:flex">
        {sidebar}
      </aside>
      {navOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navegação">
          <div className="absolute inset-0 bg-black/60" onClick={() => setNavOpen(false)} />
          <div
            ref={navRef}
            className="cockpit-glass-strong absolute inset-y-0 left-0 flex w-[280px] flex-col p-3 focus:outline-none"
            onKeyDown={onNavKeyDown}
            tabIndex={-1}
          >
            {sidebar}
          </div>
        </div>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Topbar mínima — identidade da campanha + controles de confiança. */}
        <header className="flex items-center gap-2 border-b border-[#160211]/10 px-4 py-3">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-accent lg:hidden"
            aria-label="Abrir navegação"
          >
            <Menu className="h-4 w-4" />
          </button>
          {pane === 'home' && hasCampaign ? (
            <button
              type="button"
              onClick={exitToBriefing}
              className="cockpit-glass flex min-w-0 items-center gap-1.5 rounded-full px-3 py-2 text-xs transition-colors hover:border-[#160211]/25"
              title="Voltar ao briefing — a campanha fica salva como rascunho"
            >
              <ChevronLeft className="h-3.5 w-3.5 shrink-0 text-foreground" />
              <span className="truncate font-medium text-foreground">{home?.activeCampaignName || 'Campanha'}</span>
            </button>
          ) : (
            <div className="cockpit-glass flex min-w-0 items-center gap-2 rounded-full px-3 py-1.5 text-xs">
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-foreground" />
              <span className="truncate font-medium text-foreground">
                {pane === 'home' ? 'Briefing do Mordomo' : navItems.find((n) => n.key === pane)?.label}
              </span>
            </div>
          )}
          <p className="ml-1 hidden truncate text-xs text-muted-foreground sm:block">{userName || 'sua operação'}</p>
          <div className="ml-auto flex items-center gap-1.5 text-xs">
            <button
              type="button"
              onClick={() => {
                setWakesOpen((v) => !v);
                setSaldoOpen(false);
              }}
              aria-expanded={wakesOpen}
              aria-controls="cockpit-wakes"
              className="relative rounded-full border border-border p-2.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Despertares"
            >
              <Bell className="h-4 w-4" />
              {wakes.length > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold text-white">
                  {wakes.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => void togglePause()}
              disabled={busyPause}
              aria-live="polite"
              className={`rounded-full px-3.5 py-2.5 font-medium transition-colors disabled:opacity-40 ${
                paused
                  ? 'border border-rose-300 bg-rose-100 text-rose-800'
                  : 'border border-border text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
              title={paused ? 'Envios pausados — toque para retomar' : 'Pausar todos os envios agora'}
            >
              {paused ? 'Pausado' : 'Pausar'}
            </button>
            <button
              type="button"
              onClick={exitStudio}
              className="rounded-full border border-border px-3.5 py-2.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Sair do Cockpit"
            >
              Sair
            </button>
          </div>
        </header>

        {paused && (
          <p role="alert" className="bg-rose-100/80 px-4 py-1.5 text-center text-xs text-rose-800">
            Envios pausados nesta organização — nada sai até você retomar.
          </p>
        )}
        {error && (
          <p role="alert" className="bg-rose-100/80 px-4 py-1.5 text-center text-xs text-rose-800">
            {error}
          </p>
        )}

        {/* FR-3: o Rail existe só quando há campanha; luz acesa = etapa corrente. */}
        {hasCampaign && pane === 'home' && (
          <nav aria-label="Etapas da campanha" className="border-b border-[#160211]/10 px-4 py-2.5">
            <ol ref={railRef} className="cockpit-rail-scroll flex items-center gap-1 overflow-x-auto pb-0.5 text-[11px]">
              {RAIL_STEPS.map((step, i) => {
                const lit = railCurrent === step.key;
                const done = railCurrent ? RAIL_STEPS.findIndex((s) => s.key === railCurrent) > i : false;
                return (
                  <li key={step.key} className="flex items-center gap-1" aria-current={lit ? 'step' : undefined}>
                    {i > 0 && <span aria-hidden="true" className="mx-0.5 text-muted-foreground/60">→</span>}
                    <span
                      data-current={lit ? 'true' : undefined}
                      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 transition-colors ${
                        lit
                          ? 'bg-[#160211] font-semibold text-white'
                          : done
                            ? 'text-muted-foreground'
                            : 'text-muted-foreground/90'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          lit ? 'bg-white' : done ? 'bg-[#160211]/40' : 'bg-muted-foreground/40'
                        } ${sweeping && lit ? 'cockpit-rail-sweep' : ''}`}
                      />
                      {step.label}
                    </span>
                  </li>
                );
              })}
            </ol>
          </nav>
        )}

        {/* Painéis secundários (saldo / despertares) — superfícies sob demanda.
            Saldo em linguagem clara: status por canal + PASSO A PASSO para
            liberar disparos (o box críptico "unidades" morreu). */}
        {saldoOpen && (
          <aside id="cockpit-saldo" className="cockpit-rise border-b border-[#160211]/10 bg-white/50 px-4 py-3 text-xs">
            <h2 className="mb-2 font-semibold">Limites de envio — como liberar seus disparos</h2>
            <div className="space-y-3">
              {balances.map((b) => {
                const label = b.channel === 'email' ? 'E-mail' : 'WhatsApp';
                const blocked = !channelHealthy(b);
                const pendingDomain = b.channel === 'email' && b.domainAuthStatus !== 'verified';
                const state = blocked ? 'BLOQUEADO' : pendingDomain ? 'PENDENTE' : 'PRONTO';
                const steps: string[] = [];
                if (pendingDomain) {
                  steps.push('Autenticar seu domínio: publicar SPF, DKIM e DMARC no DNS — sem isso, e-mail não sai (peça no chat: "listar os registros DNS").');
                }
                if (blocked) {
                  steps.push(`Recarregar o saldo: há ${b.available} disponíveis e o piso é ${b.floor} — abaixo do piso os disparos param para proteger sua reputação.`);
                }
                if (b.channel === 'whatsapp') {
                  steps.push('Manter o WhatsApp conectado — se cair, peça no chat: "mostrar o QR do WhatsApp".');
                }
                if (steps.length === 0) steps.push('Nada a fazer — canal saudável e autorizado a disparar.');
                return (
                  <div key={b.channel} className="cockpit-glass rounded-xl p-3">
                    <p className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={`inline-block h-2 w-2 rounded-full ${blocked ? 'bg-rose-500' : pendingDomain ? 'bg-amber-500' : 'bg-emerald-500'}`}
                      />
                      <strong className="text-foreground">{label}</strong>
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                          blocked ? 'bg-rose-100 text-rose-800' : pendingDomain ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'
                        }`}
                      >
                        {state}
                      </span>
                      <span className="ml-auto text-muted-foreground">
                        {b.available} envios disponíveis de {b.ceiling}
                      </span>
                    </p>
                    <ol className="mt-1.5 list-decimal space-y-1 pl-9 text-muted-foreground [&_li::marker]:text-[#160211]/40">
                      {steps.map((s, i) => (
                        <li key={i} className="leading-relaxed">{s}</li>
                      ))}
                    </ol>
                  </div>
                );
              })}
            </div>
            <h3 className="mb-1 mt-3 font-semibold">Movimentos recentes</h3>
            <ul className="space-y-1">
              {events.slice(0, 6).map((ev) => (
                <li key={ev.id} className="text-muted-foreground">
                  <span className={ev.type === 'credit' ? 'text-emerald-300' : 'text-rose-300'}>
                    {ev.type === 'credit' ? '+' : '−'}
                    {ev.amount}
                  </span>{' '}
                  · {ev.reason || ev.type} · {new Date(ev.createdAt).toLocaleString('pt-BR')}
                </li>
              ))}
              {events.length === 0 && <li className="text-muted-foreground">Nenhum movimento ainda.</li>}
            </ul>
          </aside>
        )}

        {wakesOpen && (
          <aside id="cockpit-wakes" className="cockpit-rise border-b border-[#160211]/10 bg-white/50 px-4 py-3 text-xs">
            <h2 className="mb-2 font-semibold">Despertares</h2>
            <ul className="space-y-2">
              {wakes.map((wake) => (
                <li key={wake.dedupKey} className="flex items-start justify-between gap-3">
                  <span className="flex items-start gap-2">
                    <span
                      aria-hidden="true"
                      className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${
                        wake.severity === 'critical' ? 'bg-rose-500' : 'bg-amber-500'
                      }`}
                    />
                    <span>
                      <strong>{wake.title}</strong>
                      <span className="block text-muted-foreground">{new Date(wake.createdAt).toLocaleString('pt-BR')}</span>
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      ackCockpitWake(wake.dedupKey)
                        .then(() =>
                          setHome((prev) => (prev ? { ...prev, wakes: prev.wakes.filter((w) => w.dedupKey !== wake.dedupKey) } : prev))
                        )
                        .catch((err) =>
                          setError(err instanceof StudioRequestError ? err.message : 'Falha ao reconhecer o despertar')
                        );
                    }}
                    className="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                  >
                    Ok
                  </button>
                </li>
              ))}
              {wakes.length === 0 && <li className="text-muted-foreground">Nada urgente — está tudo em dia.</li>}
            </ul>
            {/* FR-7: pausa global operável no mobile, junto dos Despertares. */}
            <button
              type="button"
              onClick={() => void togglePause()}
              disabled={busyPause}
              className={`mt-3 w-full rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-40 ${
                paused
                  ? 'border border-rose-300 bg-rose-50 text-rose-800'
                  : 'bg-gradient-to-r from-rose-500 to-rose-600 text-white shadow-lg shadow-rose-900/30'
              }`}
            >
              {paused ? 'Retomar envios (ação consciente)' : 'Pausar todos os envios'}
            </button>
          </aside>
        )}

        {/* Rota única: área central. Home = Briefing do Mordomo (FR-2). */}
        <main className="relative flex-1 overflow-y-auto">
          {pane === 'campaigns' ? (
            <section className="mx-auto w-full max-w-3xl px-4 py-6">
              <CampaignsListView
                onOpenCampaign={(c) => {
                  setHome((prev) => (prev ? { ...prev, activeCampaignId: c.id, activeCampaignName: c.name } : prev));
                  navigate('home');
                }}
              />
            </section>
          ) : pane === 'monitor' ? (
            <section className="w-full px-4 py-6">
              <CampaignMonitorView initialCampaignId={home?.activeCampaignId || null} />
            </section>
          ) : pane === 'preflight' ? (
            hasCampaign && home?.activeCampaignId ? (
              <PreFlightView
                key={home.activeCampaignId}
                campaignId={home.activeCampaignId}
                onBackToChat={() => navigate('home')}
                onOpenMonitor={() => navigate('monitor')}
              />
            ) : (
              <section className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  Abra uma campanha no Cockpit para ver o Pré-voo — o fim da criação chega aqui sozinho.
                </p>
                <button
                  type="button"
                  onClick={() => navigate('campaigns')}
                  className="rounded-full border border-[#160211]/10 bg-white/60 px-3.5 py-2 text-xs font-medium text-foreground hover:bg-white"
                >
                  Ver campanhas
                </button>
              </section>
            )
          ) : pane === 'agent' ? (
            <section className="mx-auto w-full max-w-3xl px-4 py-6">
              <AgentPanel />
            </section>
          ) : pane === 'brand' ? (
            <section className="mx-auto w-full max-w-3xl px-4 py-6">
              <BrandSettings />
            </section>
          ) : demo && !hasCampaign ? (
            /* FR-23: demonstração passiva com dados fictícios (fixtures), sem
               campanha e sem tocar ativos reais de envio (LGPD). */
            <section className="flex flex-1 flex-col justify-center px-4 py-8">
              <div className="mx-auto w-full max-w-lg space-y-3">
                {[
                  { role: 'assistant', text: 'Bem-vindo! Esta é uma demonstração com leads fictícios — nada aqui toca nos seus ativos de envio.' },
                  { role: 'assistant', text: 'Imagine que você vende ERP para indústrias. Eu encontraria 1.240 leads enriquecidos e citaria a origem: “Founders: José e Maria · CNAE 6201”.' },
                  { role: 'user', text: 'E o disparo?' },
                  { role: 'assistant', text: 'Antes de qualquer envio eu confiro o Certificado: saldo, domínio autenticado, descadastro e consentimento. Só autorizo com tudo verde.' },
                ].map((turn, i) => (
                  <div key={i} className={`cockpit-rise flex ${turn.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                        turn.role === 'user'
                          ? 'cockpit-send rounded-br-md text-white'
                          : 'cockpit-glass rounded-bl-md text-foreground'
                      }`}
                    >
                      {turn.text}
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setDemo(false)}
                  className="w-full rounded-full border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  Sair da demonstração
                </button>
              </div>
            </section>
          ) : hasCampaign && home?.activeCampaignId ? (
            <CampaignChat
              campaignId={home.activeCampaignId}
              step={railCurrent}
              onExitToHome={exitToBriefing}
              onOpenMonitor={() => navigate('monitor')}
              // Story 3.2 (FR9): fim da criação → redirect automático ao
              // Pré-voo, sem pedir permissão e sem polling (gancho onApproved).
              onApproved={() => navigate('preflight')}
              // Story 1.5 (D5): "pendente de envio" abre o Pré-voo na hora.
              onOpenPreflight={() => navigate('preflight')}
              onStateChange={() => {
                void loadHome();
                if (home.activeCampaignId) {
                  fetchCampaign(home.activeCampaignId).then(setCampaignDetail).catch(() => {});
                }
              }}
            />
          ) : (
            <section className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-10 text-center">
              {home === null ? (
                <p className="text-sm text-muted-foreground">Abrindo o Cockpit…</p>
              ) : (
                <>
                  <div className="cockpit-orb" aria-hidden>
                    <svg viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="Sparkles">
                      <path d="M9.5 2.6c.14-.4.7-.4.84 0l1.02 2.9a4.9 4.9 0 0 0 3.03 3.02l2.9 1.02c.4.14.4.7 0 .84l-2.9 1.02a4.9 4.9 0 0 0-3.03 3.02l-1.02 2.9c-.14.4-.7.4-.84 0l-1.02-2.9a4.9 4.9 0 0 0-3.02-3.02l-2.9-1.02c-.4-.14-.4-.7 0-.84l2.9-1.02a4.9 4.9 0 0 0 3.02-3.02l1.02-2.9Z" />
                      <path d="M17.6 14.9c.1-.27.47-.27.57 0l.53 1.5c.16.47.53.84 1 1l1.5.53c.27.1.27.47 0 .57l-1.5.53c-.47.16-.84.53-1 1l-.53 1.5c-.1.27-.47.27-.57 0l-.53-1.5a1.6 1.6 0 0 0-1-1l-1.5-.53c-.27-.1-.27-.47 0-.57l1.5-.53c.47-.16.84-.53 1-1l.53-1.5Z" />
                    </svg>
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                      {home.diaZero ? 'O que você quer conquistar hoje?' : 'As coisas mais importantes da sua operação hoje'}
                    </h2>
                    <p className="mx-auto max-w-md text-sm text-muted-foreground">
                      Converse com o piloto: ele monta audiência, escreve, agenda e só dispara com o Certificado verde.
                    </p>
                  </div>

                  {/* Rascunho guardado: retomar é um clique (multi-campanhas). */}
                  {lastCampaign && (
                    <button
                      type="button"
                      onClick={() => resumeCampaign(lastCampaign.id, lastCampaign.name)}
                      className="cockpit-glass flex items-center gap-2 rounded-full px-4 py-2.5 text-sm text-foreground transition-colors hover:border-[#160211]/25"
                    >
                      <Play className="h-4 w-4 text-foreground" />
                      Continuar “{lastCampaign.name}”
                    </button>
                  )}

                  {/* Composer da abertura (ref: cartão de entrada do Zyricon). */}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void startCampaign(draft);
                    }}
                    className="cockpit-glass cockpit-composer w-full max-w-2xl rounded-2xl p-3 transition-shadow"
                  >
                    <div className="flex items-center gap-2.5">
                      <Sparkles className="h-4 w-4 shrink-0 text-foreground" aria-hidden />
                      <input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="Conte o que você quer alcançar…"
                        aria-label="Briefing para o piloto"
                        className="h-9 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
                      />
                    </div>
                    <div className="mt-2.5 flex items-center justify-between border-t border-[#160211]/10 pt-2.5">
                      <span className="pl-1 text-[11px] text-muted-foreground/80">Piloto B2 · dados da sua organização</span>
                      <button
                        type="submit"
                        disabled={creating}
                        aria-label="Começar campanha com este briefing"
                        className="cockpit-send flex h-9 w-9 items-center justify-center rounded-full text-white transition-transform disabled:opacity-40"
                      >
                        <ArrowUp className="h-4 w-4" />
                      </button>
                    </div>
                  </form>

                  {home.chips.length > 0 ? (
                    <div className="cockpit-stagger flex w-full max-w-2xl flex-wrap justify-center gap-2">
                      {home.chips.map((chip) => (
                        <button
                          key={chip.kind}
                          type="button"
                          title={chip.motivo}
                          onClick={() => {
                            // Demonstração: leads FICTÍCIOS, mensagens fixas —
                            // nunca cria campanha nem toca ativos reais (FR-23/LGPD).
                            if (chip.demo) {
                              setDemo(true);
                              return;
                            }
                            // Chip com action: executa a action semântica
                            // idempotente (FR-9) — não é send livre.
                            if (chip.campaignId && chip.action) {
                              runCampaignAction(chip.campaignId, {
                                type: chip.action.type,
                                actionId: `chip-${chip.kind}`,
                                params: chip.action.params,
                              })
                                .then(() => {
                                  setHome((prev) =>
                                    prev ? { ...prev, activeCampaignId: chip.campaignId!, activeCampaignName: null } : prev
                                  );
                                  return loadHome();
                                })
                                .catch((err) =>
                                  setError(err instanceof StudioRequestError ? err.message : 'Falha ao executar a ação')
                                );
                              return;
                            }
                            if (chip.campaignId) {
                              setHome((prev) => (prev ? { ...prev, activeCampaignId: chip.campaignId!, activeCampaignName: null } : prev));
                              return;
                            }
                            void startCampaign();
                          }}
                          className="rounded-full border border-[#160211]/10 bg-white/60 px-4 py-2 text-xs font-medium text-foreground transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                        >
                          {chip.label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="max-w-sm text-sm text-muted-foreground">
                      Tudo em dia. Quando houver algo urgente, eu te desperto — e o convite continua aqui.
                    </p>
                  )}

                  {/* Cards de entrada (ref: feature cards do Zyricon). */}
                  {home.chips.length > 0 && (
                    <div className="mt-3 grid w-full max-w-3xl gap-3 sm:grid-cols-3">
                      {home.chips.slice(0, 3).map((chip) => {
                        const Icon = CHIP_ICON[chip.kind] ?? Sparkles;
                        return (
                          <button
                            key={`card-${chip.kind}`}
                            type="button"
                            onClick={() => {
                              if (chip.demo) {
                                setDemo(true);
                                return;
                              }
                              if (chip.campaignId) {
                                setHome((prev) => (prev ? { ...prev, activeCampaignId: chip.campaignId!, activeCampaignName: null } : prev));
                                return;
                              }
                              void startCampaign();
                            }}
                            className="cockpit-glass group rounded-xl p-4 text-left transition-colors hover:border-[#160211]/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                          >
                            <div className="mb-2.5 flex h-8 w-8 items-center justify-center rounded-lg bg-[#160211]/5 text-foreground">
                              <Icon className="h-4 w-4" />
                            </div>
                            <p className="text-sm font-medium text-foreground">{chip.label}</p>
                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{chip.motivo}</p>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
