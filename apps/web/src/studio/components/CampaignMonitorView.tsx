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
import { Activity, CalendarClock, ChevronDown, Mail, MessageSquare, RefreshCw, Users } from 'lucide-react';
import {
  fetchCampaign,
  fetchCampaignAnalytics,
  fetchCampaigns,
  fetchQueue,
  StudioRequestError,
  type CampaignFunnel,
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

const FLOW_LABEL: Record<string, string> = {
  flowing: 'Fila fluindo',
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
  const [queue, setQueue] = useState<{ rows: QueueRow[]; flowStatus: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
  const status = STATUS_LABEL[detail?.status || ''] || { label: detail?.status || '—', cls: 'bg-[#160211]/5 text-muted-foreground' };
  const rows = [...(queue?.rows || [])].sort(
    (a, b) => new Date(b.sentAt || b.scheduledAt || 0).getTime() - new Date(a.sentAt || a.scheduledAt || 0).getTime()
  );

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
              {queue && (
                <span
                  className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    queue.flowStatus === 'flowing' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
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

          {/* Funil — cada etapa do disparo com número grande e taxa de apoio. */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Evolução dos disparos</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <FunnelCard label="Enviados" value={(funnel?.sent ?? summary?.sentCount ?? 0).toLocaleString('pt-BR')} />
              <FunnelCard
                label="Entregues"
                value={(funnel?.delivered ?? 0).toLocaleString('pt-BR')}
                hint={funnel?.rates.deliveredRate ? `${Math.round(funnel.rates.deliveredRate * 100)}%` : undefined}
              />
              <FunnelCard
                label="Aberturas"
                value={(funnel?.opens ?? 0).toLocaleString('pt-BR')}
                hint={funnel?.rates.openRate ? `${Math.round(funnel.rates.openRate * 100)}% das entregas` : undefined}
              />
              <FunnelCard
                label="Cliques"
                value={(funnel?.clicks ?? 0).toLocaleString('pt-BR')}
                hint={funnel?.rates.clickRate ? `${Math.round(funnel.rates.clickRate * 100)}% das entregas` : undefined}
              />
              <FunnelCard label="Respostas" value={(funnel?.replies ?? 0).toLocaleString('pt-BR')} />
              <FunnelCard label="Conversões" value={(funnel?.conversions ?? 0).toLocaleString('pt-BR')} />
              <FunnelCard label="Bounces" value={(funnel?.bounces ?? 0).toLocaleString('pt-BR')} />
              <FunnelCard label="Descadastros" value={(funnel?.unsubs ?? 0).toLocaleString('pt-BR')} />
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
                    <li key={`${r.prospectId}-${r.channel}-${i}`} className="flex flex-wrap items-center gap-2 px-3.5 py-2 text-xs">
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
                      <span className="w-32 text-right text-[10px] text-muted-foreground">
                        {r.sentAt
                          ? `enviado ${new Date(r.sentAt).toLocaleString('pt-BR')}`
                          : r.scheduledAt
                            ? `agenda ${new Date(r.scheduledAt).toLocaleString('pt-BR')}`
                            : ''}
                      </span>
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
    </div>
  );
}
