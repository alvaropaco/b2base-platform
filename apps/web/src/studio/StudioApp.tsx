/**
 * StudioApp — o Cockpit (specs/011, CAP-1/2/3/7).
 *
 * Rota ÚNICA `/studio` (FR-1): uma coluna de conversa — o Briefing do Mordomo
 * na abertura, chips que são ações, Rail das 5 luzes só quando existe
 * campanha (FR-3), cards dentro do thread, Gaveta "Avançado" sob demanda
 * (FR-5), pausa global 1-clique (FR-19) e Despertares do Contrato de
 * Autonomia. Dark herda os tokens `.dark`; movimento é CSS nativo com
 * `prefers-reduced-motion` honrado; zero dependência nova (constituição VI).
 *
 * Rotas antigas do Studio (`/studio/campaigns`, `/studio/agent`, …)
 * redirecionam para `/studio` (FR-1).
 */
import { Bell } from 'lucide-react';
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
import { CampaignsListView } from './views/CampaignsListView';
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

/** Luz acesa = etapa corrente da máquina de estados (FR-3). */
function currentRailStep(detail: {
  objective?: string | null;
  audienceCount?: number;
  contents?: Array<Record<string, unknown>>;
  schedule?: { hourlyLimit?: number } | null;
  status?: string;
}): RailKey | null {
  if (!detail.objective) return 'objective';
  if (detail.audienceCount == null || detail.audienceCount === 0) return 'audience';
  if (!detail.contents || detail.contents.length === 0) return 'message';
  if (!detail.schedule?.hourlyLimit) return 'schedule';
  if (detail.status === 'scheduled' || detail.status === 'running') return 'balance';
  return 'schedule';
}

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
  const [drawer, setDrawer] = useState<'none' | 'campaigns' | 'agent' | 'brand'>('none');
  const [paused, setPaused] = useState(false);
  const [busyPause, setBusyPause] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [demo, setDemo] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const prevStatusRef = useRef<string | null>(null);

  const loadHome = useCallback(async () => {
    try {
      const data = await fetchCockpitHome();
      if (!data) return; // home vazia/indisponível: mantém estado, sem setHome(null-data)
      setHome(data);
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

  const startCampaign = async () => {
    setCreating(true);
    setError(null);
    try {
      const campaign = await createCampaign({
        name: `Campanha ${new Date().toLocaleDateString('pt-BR')}`,
        channels: ['email'],
        origin: 'manual',
      });
      await loadHome();
      // Abre o diálogo já no thread da campanha criada.
      window.history.replaceState(null, '', '/studio');
      setHome((prev) => (prev ? { ...prev, activeCampaignId: campaign.id, activeCampaignName: campaign.name } : prev));
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao criar campanha');
    } finally {
      setCreating(false);
    }
  };

  const railCurrent = campaignDetail ? currentRailStep(campaignDetail) : null;

  // Acessibilidade da Gaveta: foco no diálogo ao abrir + foco preso (Tab
  // cicla dentro) + Escape fecha (AA/teclado).
  useEffect(() => {
    if (drawer !== 'none') {
      drawerRef.current?.focus();
    }
  }, [drawer]);
  const onDrawerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setDrawer('none');
      return;
    }
    if (e.key === 'Tab' && drawerRef.current) {
      const focusables = drawerRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  const hasCampaign = Boolean(home?.activeCampaignId);
  const exitStudio = useCallback(() => {
    if (onExit) {
      onExit();
      return;
    }
    window.history.replaceState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, [onExit]);

  return (
    <div className="cockpit-scope dark min-h-screen bg-background text-foreground">
      <div className="cockpit-bloom" aria-hidden />
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col">
        {/* Header mínimo — zero chrome, identidade + pausa + despertares */}
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground">
              S
            </div>
            <div className="leading-tight">
              <h1 className="text-sm font-semibold tracking-tight">Cockpit</h1>
              <p className="text-[11px] text-muted-foreground">{userName || 'sua operação'}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {/* Saldo — luz com significado: só brilha saudável */}
            {balances.length > 0 && (
              <button
                type="button"
                onClick={() => void openSaldo()}
                aria-expanded={saldoOpen}
                aria-controls="cockpit-saldo"
                className="rounded-full border border-border px-2.5 py-1 hover:bg-accent"
                title="Painel de saldo"
              >
                {balances.map((b) => (
                  <span key={b.channel} className="mr-1.5 inline-flex items-center gap-1">
                    <span
                      aria-hidden="true"
                      className={`inline-block h-2 w-2 rounded-full ${b.available > 0 ? 'cockpit-glow-on bg-violet-500' : 'bg-muted-foreground/40'}`}
                    />
                    {b.available}
                  </span>
                ))}
                saldo
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setWakesOpen((v) => !v);
                setSaldoOpen(false);
              }}
              aria-expanded={wakesOpen}
              aria-controls="cockpit-wakes"
              className="relative rounded-full border border-border px-2.5 py-1 hover:bg-accent"
              title="Despertares"
            >
              <Bell className="h-4 w-4" />
              {(home?.wakes?.length ?? 0) > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-white">
                  {home?.wakes.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => void togglePause()}
              disabled={busyPause}
              className={`rounded-full px-2.5 py-1 font-medium ${
                paused ? 'bg-destructive text-white' : 'border border-border hover:bg-accent'
              } disabled:opacity-40`}
              title={paused ? 'Envios pausados — toque para retomar' : 'Pausar todos os envios agora'}
            >
              {paused ? 'Pausado' : 'Pausar'}
            </button>
            <button
              type="button"
              onClick={exitStudio}
              className="rounded-full border border-border px-2.5 py-1 hover:bg-accent"
              title="Sair do Cockpit"
            >
              Sair
            </button>
          </div>
        </header>

        {paused && (
          <p role="alert" className="bg-destructive/10 px-4 py-1.5 text-center text-xs text-destructive">
            Envios pausados nesta organização — nada sai até você retomar.
          </p>
        )}
        {error && (
          <p role="alert" className="bg-destructive/10 px-4 py-1.5 text-center text-xs text-destructive">
            {error}
          </p>
        )}

        {/* FR-3: o Rail existe só quando há campanha; luz acesa = etapa corrente. */}
        {hasCampaign && (
          <nav aria-label="Etapas da campanha" className="border-b border-border px-4 py-2">
            <ol className="flex items-center gap-1 overflow-x-auto text-[11px]">
              {RAIL_STEPS.map((step, i) => {
                const lit = railCurrent === step.key;
                const done = railCurrent ? RAIL_STEPS.findIndex((s) => s.key === railCurrent) > i : false;
                return (
                  <li key={step.key} className="flex items-center gap-1" aria-current={lit ? 'step' : undefined}>
                    {i > 0 && <span aria-hidden="true" className="mx-0.5 text-muted-foreground/50">→</span>}
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 whitespace-nowrap ${
                        lit ? 'cockpit-glow-on bg-primary/15 font-semibold text-primary' : done ? 'text-muted-foreground' : 'text-muted-foreground/50'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`inline-block h-1.5 w-1.5 rounded-full ${lit ? 'cockpit-glow-on bg-violet-500' : done ? 'bg-violet-500/50' : 'bg-muted-foreground/30'} ${sweeping && lit ? 'cockpit-rail-sweep' : ''}`}
                      />
                      {step.label}
                    </span>
                  </li>
                );
              })}
            </ol>
          </nav>
        )}

        {/* Painéis secundários (saldo / despertares) — superfícies sob demanda. */}
        {saldoOpen && (
          <aside id="cockpit-saldo" className="cockpit-rise border-b border-border px-4 py-3 text-xs">
            <h2 className="mb-2 font-semibold">Saldo por canal</h2>
            <div className="space-y-1.5">
              {balances.map((b) => (
                <p key={b.channel}>
                  <strong className="capitalize">{b.channel === 'email' ? 'E-mail' : 'WhatsApp'}</strong>:{' '}
                  {b.available} unidades livres de {b.ceiling} · domínio{' '}
                  {b.domainAuthStatus === 'verified' ? 'verificado' : 'não verificado'}
                </p>
              ))}
            </div>
            <h3 className="mb-1 mt-3 font-semibold">Movimentos recentes</h3>
            <ul className="space-y-1">
              {events.slice(0, 6).map((ev) => (
                <li key={ev.id} className="text-muted-foreground">
                  {ev.type === 'credit' ? '+' : '−'}
                  {ev.amount} · {ev.reason || ev.type} · {new Date(ev.createdAt).toLocaleString('pt-BR')}
                </li>
              ))}
              {events.length === 0 && <li className="text-muted-foreground">Nenhum movimento ainda.</li>}
            </ul>
          </aside>
        )}
        {wakesOpen && (
          <aside id="cockpit-wakes" className="cockpit-rise border-b border-border px-4 py-3 text-xs">
            <h2 className="mb-2 font-semibold">Despertares</h2>
            <ul className="space-y-2">
              {(home?.wakes ?? []).map((wake) => (
                <li key={wake.dedupKey} className="flex items-start justify-between gap-2 rounded-md border border-border p-2">
                  <span>
                    <strong>{wake.title}</strong>
                    <span className="block text-muted-foreground">{new Date(wake.createdAt).toLocaleString('pt-BR')}</span>
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
                    className="rounded-md border border-border px-2 py-0.5 hover:bg-accent"
                  >
                    Ok
                  </button>
                </li>
              ))}
              {(home?.wakes?.length ?? 0) === 0 && <li className="text-muted-foreground">Nada urgente — está tudo em dia.</li>}
            </ul>
            {/* FR-7: pausa global operável no mobile, junto dos Despertares. */}
            <button
              type="button"
              onClick={() => void togglePause()}
              disabled={busyPause}
              className={`mt-3 w-full rounded-md px-3 py-2 text-sm font-medium disabled:opacity-40 ${
                paused ? 'border border-border' : 'bg-destructive text-white'
              }`}
            >
              {paused ? 'Retomar envios (ação consciente)' : 'Pausar todos os envios'}
            </button>
          </aside>
        )}

        {/* Rota única: thread central. Home = Briefing do Mordomo (FR-2). */}
        <main className="flex flex-1 flex-col">
          {demo && !hasCampaign ? (
            /* FR-23: demonstração passiva com dados fictícios (fixtures), sem
               campanha e sem tocar ativos reais de envio (LGPD). */
            <section className="flex flex-1 flex-col justify-center px-6 py-8">
              <div className="mx-auto w-full max-w-md space-y-3">
                {[
                  { role: 'assistant', text: 'Bem-vindo! Esta é uma demonstração com leads fictícios — nada aqui toca nos seus ativos de envio.' },
                  { role: 'assistant', text: 'Imagine que você vende ERP para indústrias. Eu encontraria 1.240 leads enriquecidos e citaria a origem: “Founders: José e Maria · CNAE 6201”.' },
                  { role: 'user', text: 'E o disparo?' },
                  { role: 'assistant', text: 'Antes de qualquer envio eu confiro o Certificado: saldo, domínio autenticado, descadastro e consentimento. Só autorizo com tudo verde.' },
                ].map((turn, i) => (
                  <div key={i} className={`cockpit-rise flex ${turn.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                        turn.role === 'user' ? 'rounded-br-sm bg-primary text-primary-foreground' : 'rounded-bl-sm bg-muted/60'
                      }`}
                    >
                      {turn.text}
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setDemo(false)}
                  className="w-full rounded-full border border-border px-4 py-2 text-sm hover:bg-accent"
                >
                  Sair da demonstração
                </button>
              </div>
            </section>
          ) : hasCampaign && home?.activeCampaignId ? (
            <CampaignChat
              campaignId={home.activeCampaignId}
              suggestions={home.chips}
              onStateChange={() => {
                void loadHome();
                if (home.activeCampaignId) {
                  fetchCampaign(home.activeCampaignId).then(setCampaignDetail).catch(() => {});
                }
              }}
            />
          ) : (
            <section className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-12 text-center">
              {home === null ? (
                <p className="text-sm text-muted-foreground">Abrindo o Cockpit…</p>
              ) : (
                <>
                  <div className="cockpit-glow-on flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-2xl">
                    ✦
                  </div>
                  <h2 className="text-lg font-semibold">
                    {home.diaZero ? 'O que você quer conquistar hoje?' : 'As coisas mais importantes da sua operação hoje'}
                  </h2>
                  {home.chips.length > 0 ? (
                    <div className="cockpit-stagger flex w-full max-w-md flex-col gap-2">
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
                              setHome((prev) =>
                                prev ? { ...prev, activeCampaignId: chip.campaignId!, activeCampaignName: null } : prev
                              );
                              return;
                            }
                            void startCampaign();
                          }}
                          className="rounded-xl border border-border bg-background px-4 py-3 text-left text-sm transition-colors hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                        >
                          <span className="font-medium">{chip.label}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">{chip.motivo}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="max-w-sm text-sm text-muted-foreground">
                      Tudo em dia. Quando houver algo urgente, eu te desperto — e o convite continua aqui.
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => void startCampaign()}
                    disabled={creating}
                    className="cockpit-glow-approve rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-40"
                  >
                    {creating ? 'Abrindo…' : 'Começar uma campanha'}
                  </button>
                </>
              )}
            </section>
          )}
        </main>

        {/* Gaveta "Avançado" (FR-5): superfície secundária, nunca menu permanente. */}
        <div className="border-t border-border px-4 py-2 text-center">
          <button
            type="button"
            onClick={() => setDrawer(drawer === 'none' ? 'campaigns' : 'none')}
            aria-expanded={drawer !== 'none'}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Avançado — campanhas, agente e marca
          </button>
        </div>
        {drawer !== 'none' && (
          <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={() => setDrawer('none')} onKeyDown={onDrawerKeyDown}>
            <div
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Gaveta avançada"
              tabIndex={-1}
              className="cockpit-rise h-full w-full max-w-2xl overflow-y-auto border-l border-border bg-background p-4 focus:outline-none"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Avançado</h2>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  {(['campaigns', 'agent', 'brand'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setDrawer(tab)}
                      aria-current={drawer === tab ? 'page' : undefined}
                      className={`rounded-md px-2 py-1 ${drawer === tab ? 'bg-accent font-medium' : 'hover:bg-accent'}`}
                    >
                      {tab === 'campaigns' ? 'Campanhas' : tab === 'agent' ? 'Agente IA' : 'Marca'}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setDrawer('none')}
                    className="rounded-md border border-border px-2 py-1"
                  >
                    Fechar
                  </button>
                </div>
              </div>
              {drawer === 'campaigns' && (
                <CampaignsListView
                  onOpenCampaign={(c) => {
                    setDrawer('none');
                    setHome((prev) => (prev ? { ...prev, activeCampaignId: c.id, activeCampaignName: c.name } : prev));
                  }}
                />
              )}
              {drawer === 'agent' && <AgentPanel />}
              {drawer === 'brand' && <BrandSettings />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
