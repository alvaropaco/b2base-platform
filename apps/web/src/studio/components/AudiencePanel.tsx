/**
 * AudiencePanel — revisão e seleção dos leads da audiência (2026-09-27).
 *
 * Lista os leads incluídos no snapshot ativo agrupados hierarquicamente
 * (indústria › cidade/UF › porte), com busca, seleção global e por grupo —
 * o cliente vê EXATAMENTE quem será atingido e ajusta sem sair do passo
 * Audiência. Aplicar a seleção re-materializa a audiência (POST /audience
 * com prospectIds — leads de fora são excluídos no snapshot novo).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Search, Users } from 'lucide-react';
import { fetchAudienceLeads, setManualAudience, StudioRequestError, type AudienceLead } from '../api';

function initials(lead: AudienceLead): string {
  const source = String(lead.company || lead.name || '?');
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

function locality(lead: AudienceLead): string {
  const parts = [lead.city || 'Cidade não informada', lead.state].filter(Boolean);
  return parts.join(' — ');
}

function sizeBand(lead: AudienceLead): string {
  const e = lead.employees;
  if (e == null) return 'Porte não informado';
  if (e <= 10) return 'Micro (1–10)';
  if (e <= 50) return 'Pequena (11–50)';
  if (e <= 200) return 'Média (51–200)';
  return 'Grande (200+)';
}

export interface AudiencePanelProps {
  campaignId: string;
  /** Recarrega o estado da campanha após aplicar a seleção. */
  onApplied?: () => void;
}

export function AudiencePanel({ campaignId, onApplied }: AudiencePanelProps) {
  const [leads, setLeads] = useState<AudienceLead[]>([]);
  const [groups, setGroups] = useState<Array<{ key: string; count: number; subs: Array<{ key: string; count: number; subs: Array<{ key: string; count: number; leadIds: string[] }> }> }>>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Sempre da BASE: todos os leads da organização com os da audiência
      // atual pré-marcados — revisar e selecionar são o mesmo gesto.
      const data = await fetchAudienceLeads(campaignId, 'base');
      setLeads(data.leads);
      setGroups(data.groups);
      setTotal(data.total);
      setSelected(new Set(data.selectedIds || []));
      setOpenGroups(new Set(data.groups.slice(0, 2).map((g) => g.key))); // 2 primeiras abertas
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao carregar os leads');
    } finally {
      setIsLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return leads;
    return leads.filter((l) =>
      [l.company, l.name, l.industry, l.city, l.state].some((v) => String(v || '').toLowerCase().includes(q))
    );
  }, [leads, query]);

  const toggleLead = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const leadIdsInGroup = useCallback(
    (groupKey: string, subKey?: string) => {
      const group = groups.find((g) => g.key === groupKey);
      if (!group) return [];
      if (subKey == null) return group.subs.flatMap((s) => s.subs.flatMap((leaf) => leaf.leadIds));
      const sub = group.subs.find((s) => s.key === subKey);
      if (!sub) return [];
      return sub.subs.flatMap((leaf) => leaf.leadIds);
    },
    [groups]
  );

  const setMany = (ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const apply = async () => {
    setApplying(true);
    setError(null);
    setNotice(null);
    try {
      await setManualAudience(campaignId, leads.filter((l) => selected.has(l.id)).map((l) => l.id));
      await load();
      onApplied?.();
      setNotice('Audiência atualizada — quem recebe é exatamente a sua seleção.');
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao aplicar a seleção');
    } finally {
      setApplying(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando leads da audiência…
      </div>
    );
  }

  if (total === 0) {
    return (
      <aside className="cockpit-rise border-b border-[#160211]/10 bg-white/50 px-4 py-3 text-xs">
        <p className="font-semibold">Selecione quem vai receber</p>
        <p className="mt-1 text-muted-foreground">
          Sua base ainda não tem leads. Importe ou descubra empresas na aba Descobrir — depois volte aqui e eu monto a
          campanha para eles.
        </p>
      </aside>
    );
  }

  const visibleIds = new Set(filtered.map((l) => l.id));
  const selectedVisible = filtered.filter((l) => selected.has(l.id)).length;

  return (
    <aside className="cockpit-rise border-b border-[#160211]/10 bg-white/50 px-4 py-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold">
          <Users className="h-4 w-4" /> Quem vai receber a campanha
          <span className="rounded-full bg-[#160211]/5 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {selected.size} selecionados de {total} da sua base
          </span>
        </p>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setMany(leads.map((l) => l.id), true)}
            className="rounded-full border border-[#160211]/10 bg-white/70 px-2.5 py-1 font-medium text-foreground hover:bg-white"
          >
            Selecionar todos
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="rounded-full border border-[#160211]/10 bg-white/70 px-2.5 py-1 font-medium text-foreground hover:bg-white"
          >
            Limpar seleção
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-2 rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1.5 text-rose-800">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-2 rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-emerald-800">{notice}</p>
      )}

      <div className="mt-2 flex items-center gap-2 rounded-xl border border-[#160211]/10 bg-white/70 px-2.5 py-1.5">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por empresa, contato, cidade…"
          className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          aria-label="Buscar leads"
        />
        {query && (
          <span className="whitespace-nowrap text-[10px] text-muted-foreground">
            {filtered.length} de {total}
          </span>
        )}
      </div>

      <div className="mt-2 max-h-72 space-y-1.5 overflow-y-auto pr-1">
        {groups.map((group) => {
          const groupLeads = leads.filter((l) => visibleIds.has(l.id) && (l.industry || 'Sem categoria') === group.key);
          if (query && groupLeads.length === 0) return null;
          const groupIds = leadIdsInGroup(group.key);
          const groupSelected = groupIds.filter((id) => selected.has(id)).length;
          const open = openGroups.has(group.key);
          return (
            <div key={group.key} className="rounded-xl border border-[#160211]/10 bg-white/70">
              <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                <button
                  type="button"
                  onClick={() =>
                    setOpenGroups((prev) => {
                      const next = new Set(prev);
                      if (next.has(group.key)) next.delete(group.key);
                      else next.add(group.key);
                      return next;
                    })
                  }
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  aria-expanded={open}
                >
                  {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  <span className="truncate font-semibold text-foreground">{group.key}</span>
                  <span className="rounded-full bg-[#160211]/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {group.count}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const ids = groupLeads.length ? groupLeads.map((l) => l.id) : groupIds;
                    const allOn = ids.every((id) => selected.has(id));
                    setMany(ids, !allOn);
                  }}
                  className="whitespace-nowrap rounded-full border border-[#160211]/10 px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-[#160211]/5"
                >
                  {groupIds.every((id) => selected.has(id)) ? 'Desmarcar grupo' : 'Marcar grupo'}
                </button>
              </div>
              {open && (
                <div className="space-y-1 border-t border-[#160211]/10 px-2.5 py-1.5">
                  {group.subs.map((sub) => {
                    const subLeads = groupLeads.filter((l) => {
                      const loc = `${l.city || 'Cidade não informada'}${l.state ? ` — ${l.state}` : ''}`;
                      return loc === sub.key;
                    });
                    if (query && subLeads.length === 0) return null;
                    const subIds = subLeads.length ? subLeads.map((l) => l.id) : leadIdsInGroup(group.key, sub.key);
                    const subSelected = subIds.filter((id) => selected.has(id)).length;
                    return (
                      <div key={sub.key} className="rounded-lg bg-white/70">
                        <div className="flex items-center justify-between gap-2 px-2 py-1">
                          <span className="truncate text-[11px] font-medium text-foreground/80">{sub.key}</span>
                          <span className="flex items-center gap-1.5">
                            <span className="text-[10px] text-muted-foreground">{sub.count}</span>
                            <button
                              type="button"
                              onClick={() => {
                                const allOn = subIds.every((id) => selected.has(id));
                                setMany(subIds, !allOn);
                              }}
                              className="whitespace-nowrap rounded-full border border-[#160211]/10 px-1.5 py-0.5 text-[10px] text-foreground hover:bg-[#160211]/5"
                            >
                              {subSelected === subIds.length ? 'Desmarcar' : 'Marcar'}
                            </button>
                          </span>
                        </div>
                        <ul className="divide-y divide-[#160211]/5">
                          {(subLeads.length ? subLeads : leads.filter((l) => sub.subs.some((leaf) => leaf.leadIds.includes(l.id)))).map(
                            (lead) => (
                              <li key={lead.id}>
                                <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-[#160211]/[0.03]">
                                  <input
                                    type="checkbox"
                                    checked={selected.has(lead.id)}
                                    onChange={() => toggleLead(lead.id)}
                                    className="h-3.5 w-3.5 accent-violet-600"
                                  />
                                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#160211]/5 text-[9px] font-bold text-foreground">
                                    {initials(lead)}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[11px] font-medium text-foreground">{lead.company}</span>
                                    <span className="block truncate text-[10px] text-muted-foreground">
                                      {[lead.name !== lead.company ? lead.name : null, locality(lead), sizeBand(lead)]
                                        .filter(Boolean)
                                        .join(' · ')}
                                    </span>
                                  </span>
                                  {lead.score > 0 && (
                                    <span className="shrink-0 rounded-full bg-[#160211]/5 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                                      score {lead.score}
                                    </span>
                                  )}
                                </label>
                              </li>
                            )
                          )}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {selectedVisible} de {filtered.length} visíveis selecionados · aplicar atualiza quem recebe esta campanha
        </span>
        <button
          type="button"
          onClick={() => void apply()}
          disabled={applying || selected.size === 0}
          className="rounded-full bg-[#160211] px-3.5 py-1.5 text-xs font-medium text-white shadow-sm disabled:opacity-40"
        >
          {applying ? 'Aplicando…' : `Aplicar seleção (${selected.size})`}
        </button>
      </div>
    </aside>
  );
}
