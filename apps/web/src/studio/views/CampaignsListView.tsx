/**
 * CampaignsListView — lista de campanhas do Studio (T013).
 * Estados de carregamento/erro/vazio explícitos; criação inline (US1 usa o
 * mesmo endpoint — toda campanha nasce `draft`, FR-002).
 */
import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  createCampaign,
  deleteCampaign,
  fetchCampaigns,
  StudioRequestError,
} from '../api';
import type { StudioCampaignSummary } from '../types';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Rascunho',
  in_review: 'Aguardando revisão',
  approved: 'Aprovada',
  scheduled: 'Agendada',
  running: 'Em execução',
  paused: 'Pausada',
  completed: 'Concluída',
  cancelled: 'Cancelada',
  retained: 'Retida',
};

const ORIGIN_LABEL: Record<string, string> = {
  manual: 'Manual',
  ai_prompt: 'IA · prompt',
  material: 'IA · material',
  url: 'IA · URL',
  company_data: 'IA · dados da conta',
  duplicate: 'Duplicada',
  template: 'Template',
  agent: 'Agente IA',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] || status;
}

export function originLabel(origin: string): string {
  return ORIGIN_LABEL[origin] || origin;
}

export interface CampaignsListViewProps {
  onOpenCampaign: (campaign: StudioCampaignSummary) => void;
}

export function CampaignsListView({ onOpenCampaign }: CampaignsListViewProps) {
  const [campaigns, setCampaigns] = useState<StudioCampaignSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setCampaigns(await fetchCampaigns());
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao carregar campanhas');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    const name = newName.trim() || `Campanha ${new Date().toLocaleDateString('pt-BR')}`;
    setIsCreating(true);
    try {
      const created = await createCampaign({ name, channels: ['email', 'whatsapp'] });
      setNewName('');
      onOpenCampaign({ ...created, audienceCount: 0, sentCount: 0 });
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao criar campanha');
    } finally {
      setIsCreating(false);
    }
  };

  const handleDelete = async (c: StudioCampaignSummary) => {
    if (!window.confirm(`Remover a campanha “${c.name}”? Isso apaga conteúdo, conversa e audiência dela.`)) return;
    try {
      await deleteCampaign(c.id);
      setCampaigns((prev) => prev.filter((x) => x.id !== c.id));
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao remover campanha');
    }
  };

  return (
    <section aria-label="Campanhas">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Campanhas</h2>
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:max-w-md sm:flex-none">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleCreate();
              }
            }}
            placeholder="Nome da nova campanha"
            className="h-10 min-w-0 flex-1 rounded-xl border border-[#160211]/10 bg-white/70 px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-[#160211]/40 focus-visible:ring-1 focus-visible:ring-[#160211]/30"
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={isCreating}
            className="h-10 shrink-0 rounded-xl bg-[#160211] px-4 text-sm font-medium text-white shadow-md transition-transform hover:brightness-110 disabled:opacity-50"
          >
            {isCreating ? 'Criando…' : 'Nova'}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-3 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando campanhas…</p>
      ) : campaigns.length === 0 ? (
        <div className="cockpit-glass rounded-2xl p-10 text-center">
          <p className="text-sm font-medium">Nenhuma campanha ainda</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Crie sua primeira campanha acima — ela nasce em rascunho e só dispara
            após revisão e aprovação.
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {campaigns.map((c) => (
            <li key={c.id}>
              <div className="cockpit-glass flex w-full items-center gap-2 rounded-2xl pr-2 transition-colors hover:border-[#160211]/25">
                <button
                  type="button"
                  onClick={() => onOpenCampaign(c)}
                  className="flex min-w-0 flex-1 items-center justify-between gap-4 px-4 py-3.5 text-left"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{c.name}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {originLabel(c.origin)} · {(c.channels || []).join(' + ') || 'sem canal'} ·{' '}
                      {c.audienceCount ?? 0} leads · {c.sentCount ?? 0} disparos
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${
                      c.status === 'running'
                        ? 'bg-emerald-100 text-emerald-800'
                        : c.status === 'in_review'
                          ? 'bg-amber-100 text-amber-800'
                          : c.status === 'completed'
                            ? 'bg-[#160211]/5 text-foreground'
                            : 'bg-[#160211]/5 text-muted-foreground'
                    }`}
                  >
                    {statusLabel(c.status)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(c)}
                  className="shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-rose-50 hover:text-rose-700"
                  title={`Remover “${c.name}”`}
                  aria-label={`Remover campanha ${c.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
