/**
 * CampaignMonitorView — página de monitoramento da campanha (fix 5, 2026-09-28).
 *
 * Destino do botão "Acompanhar disparos" do resumo pós-lançamento: o cliente
 * vê a evolução real dos disparos em um lugar — funil (envios, entregas,
 * aberturas, cliques, respostas, conversões), fila por lead com nome da
 * empresa e agenda. Dados: GET /analytics (rollup diário), GET /queue
 * (contatos por execução de canal) e o detalhe da campanha.
 *
 * Atualiza sozinho a cada 20s enquanto a campanha está em voo; refresh
 * manual sempre disponível.
 */
import { useCallback, useEffect, useState } from 'react';
import { Activity, CalendarClock, ChevronDown, History, Mail, MessageSquare, RefreshCw, Users, X } from 'lucide-react';
import {
  fetchCampaign,
  fetchCampaignAnalytics,
  fetchCampaigns,
  fetchLeadHistory,
  fetchQueue,
  StudioRequestError,
  type CampaignFunnel,
  type LeadHistory,
  type QueueRow,
} from '../api';
import type { StudioCampaignDetail, StudioCampaignSummary } from '../types';

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Rascunho', cls: 'bg-[#160211]/5 text-muted-foreground' },
  in_review: { label: 'Em revisão', cls: 'bg-amber-100 text-amber-800' },
  approved: { label: 'Aprovada', cls: 'bg-emerald-100 text-emerald-800' },
  scheduled: { label: 'Agendada', cls: 'bg-violet-100 text-violet-800' },
  running: { label: 'Em voo', cls: 'bg-emerald-100 text-emerald-800' },
  paused: { label: 'Pausada', cls: 'bg-rose-100 text-rose-800' },
  completed: { label: 'Concluída', cls: 'bg-[#160211]/5 text-muted-foreground' },
  cancelled: { label: 'Cancelada', cls: 'bg-[#160211]/5 text-muted-foreground' },
};

const QUEUE_STATUS_LABEL: Record<string, string> = {
  QUEUED: 'Na fila',
  SELECTED: 'Selecionado',
  SENT: 'Enviado',
  SCHEDULED: 'Agendado',
  REPLIED: 'Respondeu',
  CANCELLED: 'Cancelado',
  FAILED: 'Falhou',
};

/** Por que o lead saiu da fila — "Cancelado" seco deixa o dono sem resposta. */
const CANCEL_REASON_LABEL: Record<string, string> = {
  no_phone: 'sem telefone no cadastro — atualize o número para o WhatsApp sair',
  do_not_contact: 'marcado como não-contactar',
  removido_da_selecao: 'removido da seleção da audiência',
  cancelled: 'cancelado manualmente',
  sem_consentimento: 'sem consentimento WhatsApp (LGPD)',
};

/** Rótulos da timeline de histórico (tipos de OutreachEvent + WhatsApp). */
const EVENT_LABEL: Record<string, string> = {
  email_scheduled: 'E-mail agendado',
  email_sent: 'E-mail enviado',
  email_delivered_inferred: 'Entrega inferida',
  email_opened_inferred: 'Abertura inferida',
  email_replied: 'Lead respondeu',
  email_bounced: 'Bounce',
  email_failed: 'Falha no envio',
  email_unsubscribed: 'Descadastro',
  email_cancelled: 'Cancelado',
  followup_scheduled: 'Follow-up agendado',
  followup_sent: 'Follow-up enviado',
  wa_outbound: 'WhatsApp enviado',
  wa_inbound: 'WhatsApp recebido',
};

const FLOW_LABEL: Record<string, string> = {
  flowing: 'Fila fluindo',
  not_started: 'Não iniciada',
  outside_window: 'Fora da janela de envio',
  first_batch_pending: '1º lote aguardando sua aprovação',
  paused: 'Pausada',
  paused_anomaly: 'Pausada por anomalia',
};

function channelIcon(channel: string) {
  return channel === 'email' ? <Mail className="h-3 w-3" /> : <MessageSquare className="h-3 w-3" />;
}

function FunnelCard({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="cockpit-glass rounded-xl p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold text-foreground">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function CampaignMonitorView({ initialCampaignId }: { initialCampaignId?: string | null }) {
  const [campaigns, setCampaigns] = useState<StudioCampaignSummary[]>([]);
  const [campaignId, setCampaignId] = useState<string | null>(initialCampaignId || null);
  const [detail, setDetail] = useState<StudioCampaignDetail | null>(null);
  const [funnel, setFunnel] = useState<CampaignFunnel | null>(null);
  const [queue, setQueue] = useState<Awaited<ReturnType<typeof fetchQueue>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyLead, setHistoryLead] = useState<{ prospectId: string; companyName: string | null } | null>(null);
  const [history, setHistory] = useState<LeadHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const openHistory = useCallback(
    async (r: QueueRow) => {
      setHistoryLead({ prospectId: r.prospectId, companyName: r.companyName || null });
      setHistory(null);
      setHistoryError(null);
      setHistoryLoading(true);
      try {
        setHistory(await fetchLeadHistory(campaignId as string, r.prospectId));
      } catch (err) {
        setHistoryError(err instanceof StudioRequestError ? err.message : 'Falha ao carregar o histórico');
      } finally {
        setHistoryLoading(false);
      }
    },
    [campaignId]
  );

  const load = useCallback(async () => {
    if (!campaignId) {
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const [d, a, q] = await Promise.all([
        fetchCampaign(campaignId),
        fetchCampaignAnalytics(campaignId).catch(() => null),
        fetchQueue(campaignId).catch(() => ({ rows: [], flowStatus: 'flowing' })),
      ]);
      setDetail(d);
      setFunnel(a?.funnel ?? null);
      setQueue(q);
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao carregar o monitor');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void (async () => {
      try {
        const list = await fetchCampaigns();
        // Campanhas em voo primeiro; a ativa do cockpit entra na frente.
        const sorted = [...list].sort((x, y) => {
          const flying = (c: StudioCampaignSummary) => (c.status === 'running' || c.status === 'scheduled' ? 0 : 1);
          return flying(x) - flying(y) || new Date(y.updatedAt).getTime() - new Date(x.updatedAt).getTime();
        });
        setCampaigns(sorted);
        if (!campaignId) {
          const preferred = sorted.find((c) => c.id === initialCampaignId) || sorted[0];
          if (preferred) setCampaignId(preferred.id);
        }
      } catch (_) {
        /* a lista falhou: o load() do id inicial ainda tenta */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Em voo: acompanha sozinho (20s); fora do voo, refresh manual.
  const flying = detail?.status === 'running' || detail?.status === 'scheduled';
  useEffect(() => {
    if (!flying) return;
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [flying, load]);

  const summary = campaigns.find((c) => c.id === campaignId);
  // UX-DR5: "pendente de envio" aparece POR NOME (approved + NO_CHANNEL_CONNECTED).
  const pendingShipment =
    (detail?.status === 'approved' || detail?.status === 'scheduled') && detail?.statusReason === 'NO_CHANNEL_CONNECTED';
  const status = pendingShipment
    ? { label: 'Pendente de envio', cls: 'bg-amber-100 text-amber-800' }
    : STATUS_LABEL[detail?.status || ''] || { label: detail?.status || '—', cls: 'bg-[#160211]/5 text-muted-foreground' };
  const rows = [...(queue?.rows || [])].sort(
    (a, b) => new Date(b.sentAt || b.scheduledAt || 0).getTime() - new Date(a.sentAt || a.scheduledAt || 0).getTime()
  );
  // Epic 3 (Story 3.3): divergência audiência×fila na janela de sincronização.
  const divergence = queue?.divergence && queue.divergence.count > 0 ? queue.divergence : null;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-2">
        <Activity className="h-5 w-5 text-foreground" />
        <h1 className="text-lg font-semibold tracking-tight text-foreground">Monitor da campanha</h1>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <select
              value={campaignId || ''}
              onChange={(e) => setCampaignId(e.target.value)}
              aria-label="Escolher campanha monitorada"
              className="appearance-none rounded-full border border-[#160211]/10 bg-white/70 py-2 pl-3.5 pr-8 text-xs font-medium text-foreground outline-none hover:bg-white"
            >
              {campaigns.length === 0 && <option value="">Nenhuma campanha</option>}
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="flex items-center gap-1.5 rounded-full border border-[#160211]/10 bg-white/70 px-3 py-2 text-xs font-medium text-foreground hover:bg-white"
            title="Atualizar agora"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>
      </header>

      {error && (
        <p role="alert" className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {error}
        </p>
      )}

      {!campaignId && !loading && (
        <p className="cockpit-glass rounded-2xl p-6 text-center text-sm text-muted-foreground">
          Nenhuma campanha para monitorar ainda — crie uma no Cockpit e coloque em voo.
        </p>
      )}

      {campaignId && (
        <>
          {/* Cabeçalho da campanha: identidade + agenda + fila. */}
          <section className="cockpit-glass rounded-2xl p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground">{detail?.name || summary?.name || '…'}</h2>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${status.cls}`}>{status.label}</span>
              {detail?.channels.map((ch) => (
                <span key={ch} className="flex items-center gap-1 rounded-full bg-[#160211]/5 px-2 py-0.5 text-[10px] capitalize text-muted-foreground">
                  {channelIcon(ch)} {ch}
                </span>
              ))}
              {/* B8/UX-DR4: edição em voo registrada em linguagem leiga — "houve
                  edição e a partir de quando vale", sem termo técnico. */}
              {(() => {
                const edits = (detail?.approval as { contentEdits?: Array<{ at?: string }> } | undefined)?.contentEdits;
                const last = Array.isArray(edits) && edits.length > 0 ? edits[edits.length - 1] : null;
                if (!last?.at) return null;
                return (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                    Conteúdo editado em voo — vale a partir de {new Date(last.at).toLocaleString('pt-BR')} para o que ainda não saiu
                  </span>
                );
              })()}
              {queue && (
                <span
                  className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    queue.flowStatus === 'flowing'
                      ? 'bg-emerald-100 text-emerald-800'
                      : queue.flowStatus === 'not_started'
                        ? 'bg-[#160211]/5 text-muted-foreground'
                        : 'bg-amber-100 text-amber-800'
                  }`}
                  title="Estado global da fila de disparo"
                >
                  {FLOW_LABEL[queue.flowStatus] || queue.flowStatus}
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
              {detail?.objective && (
                <span className="min-w-0 truncate">
                  <strong className="text-foreground/70">Objetivo:</strong> {detail.objective}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Users className="h-3.5 w-3.5" />
                {(detail?.audience?.includedCount ?? summary?.audienceCount ?? 0).toLocaleString('pt-BR')} lead(s) na audiência
              </span>
              {detail?.schedule?.hourlyLimit ? (
                <span className="flex items-center gap-1">
                  <CalendarClock className="h-3.5 w-3.5" />
                  {detail.schedule.hourlyLimit}/hora
                  {detail.schedule.dailyLimit ? ` · ${detail.schedule.dailyLimit}/dia` : ''}
                  {detail.schedule.windows?.[0] ? ` · ${detail.schedule.windows[0].startHour}h–${detail.schedule.windows[0].endHour}h` : ''}
                </span>
              ) : null}
            </div>
          </section>

          {/* Epic 3 (Story 3.3): divergência audiência×fila — quantos e por
              quê, sem jargão; some quando a conta fecha (a fila sincronizada
              zera a divergência). */}
          {divergence && (
            <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {divergence.count} contato(s) da fila saíram da sua seleção — {divergence.reason || 'eles não recebem nada'}. A
              sincronização remove quem ainda não recebeu.
            </p>
          )}

          {/* Funil — cada etapa do disparo com número grande e taxa de apoio. */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Evolução dos disparos</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <FunnelCard label="Enviados" value={funnel == null ? '—' : (funnel.sent ?? summary?.sentCount ?? 0).toLocaleString('pt-BR')} />
              <FunnelCard
                label="Entregues"
                value={funnel == null ? '—' : (funnel.delivered ?? 0).toLocaleString('pt-BR')}
                hint={funnel?.rates.deliveredRate ? `${Math.round(funnel.rates.deliveredRate * 100)}%` : undefined}
              />
              <FunnelCard
                label="Aberturas"
                value={funnel == null ? '—' : (funnel.opens ?? 0).toLocaleString('pt-BR')}
                hint={funnel?.rates.openRate ? `${Math.round(funnel.rates.openRate * 100)}% das entregas` : undefined}
              />
              <FunnelCard
                label="Cliques"
                value={funnel == null ? '—' : (funnel.clicks ?? 0).toLocaleString('pt-BR')}
                hint={funnel?.rates.clickRate ? `${Math.round(funnel.rates.clickRate * 100)}% das entregas` : undefined}
              />
              <FunnelCard label="Respostas" value={funnel == null ? '—' : (funnel.replies ?? 0).toLocaleString('pt-BR')} />
              <FunnelCard label="Conversões" value={funnel == null ? '—' : (funnel.conversions ?? 0).toLocaleString('pt-BR')} />
              <FunnelCard label="Bounces" value={funnel == null ? '—' : (funnel.bounces ?? 0).toLocaleString('pt-BR')} />
              <FunnelCard label="Descadastros" value={funnel == null ? '—' : (funnel.unsubs ?? 0).toLocaleString('pt-BR')} />
            </div>
            {funnel?.estimated && (
              <p className="mt-1.5 text-[10px] text-muted-foreground">
                Entregas/aberturas estimadas pelo provedor de envio quando o evento exato não é reportado.
              </p>
            )}
          </section>

          {/* Fila por lead — QUEM foi/será contactado, mais recente primeiro. */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Fila por lead ({rows.length})
            </h3>
            <div className="cockpit-glass overflow-hidden rounded-2xl">
              {rows.length === 0 ? (
                <p className="p-4 text-center text-xs text-muted-foreground">
                  Nenhum contato na fila ainda — aprovar a campanha e chegar a janela de envio povoa a fila.
                </p>
              ) : (
                <ul className="divide-y divide-[#160211]/5">
                  {rows.slice(0, 25).map((r, i) => (
                    <li key={`${r.prospectId}-${r.channel}-${i}`}>
                      <button
                        type="button"
                        onClick={() => void openHistory(r)}
                        title="Ver todos os contatos desta campanha com este lead"
                        className="flex w-full flex-wrap items-center gap-2 px-3.5 py-2 text-xs text-left hover:bg-[#160211]/[0.03]"
                      >
                        <span className="flex items-center gap-1 rounded-full bg-[#160211]/5 px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
                          {channelIcon(r.channel)} {r.channel}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                          {r.companyName || r.prospectId}
                        </span>
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                            r.status === 'SENT' || r.status === 'REPLIED'
                              ? 'bg-emerald-100 text-emerald-800'
                              : r.status === 'FAILED' || r.cancelReason
                                ? 'bg-rose-100 text-rose-800'
                                : 'bg-[#160211]/5 text-muted-foreground'
                          }`}
                        >
                          {QUEUE_STATUS_LABEL[r.status] || r.status}
                        </span>
                        {/* O PORQUÊ do cancelamento — "Cancelado" seco não explica nada (QA 2026-10-08). */}
                        {r.status === 'CANCELLED' && r.cancelReason && (
                          <span className="text-[10px] text-rose-700">{CANCEL_REASON_LABEL[r.cancelReason] || r.cancelReason}</span>
                        )}
                        <span className="w-32 text-right text-[10px] text-muted-foreground">
                          {r.sentAt
                            ? `enviado ${new Date(r.sentAt).toLocaleString('pt-BR')}`
                            : r.scheduledAt
                              ? `agenda ${new Date(r.scheduledAt).toLocaleString('pt-BR')}`
                              : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {rows.length > 25 && (
              <p className="mt-1 text-[10px] text-muted-foreground">Mostrando os 25 mais recentes de {rows.length}.</p>
            )}
          </section>
        </>
      )}

      {/* Histórico de contatos com o lead — drill-down da fila (timeline). */}
      {historyLead && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Histórico de contatos">
          <div className="absolute inset-0 bg-black/40" onClick={() => setHistoryLead(null)} />
          <div className="cockpit-glass-strong relative flex h-full w-full max-w-md flex-col border-l border-[#160211]/10 shadow-2xl">
            <header className="flex items-center justify-between border-b border-[#160211]/10 px-4 py-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <History className="h-4 w-4" /> Histórico do contato
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {historyLead.companyName || historyLead.prospectId}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHistoryLead(null)}
                aria-label="Fechar histórico"
                className="rounded-lg border border-border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-xs">
              {historyLoading && <p className="text-muted-foreground">Carregando histórico…</p>}
              {historyError && (
                <p role="alert" className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-rose-800">
                  {historyError}
                </p>
              )}
              {!historyLoading && !historyError && history && (
                <>
                  {history.emailContact ? (
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      <span className="rounded-full bg-[#160211]/5 px-2 py-0.5 text-[10px] text-muted-foreground">
                        e-mail: {QUEUE_STATUS_LABEL[history.emailContact.status] || history.emailContact.status}
                      </span>
                      {history.emailContact.replyCount > 0 && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
                          {history.emailContact.replyCount} resposta(s)
                        </span>
                      )}
                      {history.emailContact.unsubscribed && (
                        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-800">
                          descadastro
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="mb-3 text-muted-foreground">
                      Este lead ainda não entrou na execução de e-mail da campanha.
                    </p>
                  )}
                  {history.events.length === 0 ? (
                    <p className="rounded-xl border border-[#160211]/10 bg-white/60 px-3 py-4 text-center text-muted-foreground">
                      Nenhum contato registrado ainda — a timeline aparece aqui no primeiro disparo.
                    </p>
                  ) : (
                    <ol className="space-y-0 border-l border-[#160211]/10 pl-3">
                      {history.events.map((e, i) => (
                        <li key={`${e.type}-${i}`} className="relative pb-3 pl-3">
                          <span
                            className={`absolute -left-[5px] top-1 h-2 w-2 rounded-full ${
                              e.channel === 'whatsapp'
                                ? 'bg-emerald-500'
                                : e.type.includes('replied')
                                  ? 'bg-violet-500'
                                  : e.type.includes('bounced') || e.type.includes('failed')
                                    ? 'bg-rose-500'
                                    : 'bg-[#160211]/30'
                            }`}
                          />
                          <p className="font-medium text-foreground">{EVENT_LABEL[e.type] || e.type}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {new Date(e.at).toLocaleString('pt-BR')} · {e.channel}
                            {e.status ? ` · ${e.status}` : ''}
                          </p>
                          {e.content && (
                            <p className="mt-1 rounded-lg bg-white/70 px-2 py-1 text-[11px] text-foreground/80">{e.content}</p>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
