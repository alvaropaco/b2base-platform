/**
 * AgentPanel — AI Campaign Agent (US9, T095): objetivo em linguagem natural →
 * plano revisável item a item. Conversão cria campanha em REVISÃO — o agente
 * nunca ativa disparo (FR-058). Inclui fila de recomendações pendentes.
 */
import { useCallback, useEffect, useState } from 'react';
import { StudioRequestError } from '../api';

interface Proposal {
  id: string;
  status: string;
  plan: {
    audience?: { criteria?: unknown; rationale?: string };
    strategy?: { channels?: string[]; timing?: string };
    contents?: Array<{ channel: string; subject?: string; text?: string }>;
    tracking?: unknown;
    error?: string;
  };
  campaignId?: string | null;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/studio${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json();
  if (!res.ok) throw new StudioRequestError(payload.error || 'ERROR', res.status, payload.message);
  return payload.data as T;
}

export function AgentPanel() {
  const [prompt, setPrompt] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [decisions, setDecisions] = useState<Record<string, 'accepted' | 'rejected'>>({
    audience: 'accepted',
    strategy: 'accepted',
    contents: 'accepted',
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const propose = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/studio/agent/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const body = await res.json();
      if (!res.ok) throw new StudioRequestError(body.error, res.status, body.message);
      const proposalId = body.data.proposalId;
      // Polling até o plano ficar pronto (execução inline no servidor).
      // O servidor nasce com status "planning" e só vira "proposed" quando o
      // plano completo (ou o erro) está no banco.
      let last: Proposal | null = null;
      for (let i = 0; i < 120; i++) {
        // Assinatura do helper: api(method, path) — ordem certa aqui.
        last = await api<Proposal>('GET', `/agent/proposals/${proposalId}`);
        if (!last) break;
        if (last.status !== 'planning') break;
        await new Promise((r) => setTimeout(r, 400));
      }
      if (last && last.status === 'proposed') {
        setProposal(last);
      } else if (last?.plan?.error) {
        setError(`O agente não conseguiu montar o plano: ${last.plan.error}`);
      } else {
        setError('A geração do plano demorou mais que o esperado. Tente novamente em instantes.');
      }
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao propor campanha');
    } finally {
      setBusy(false);
    }
  };

  const decide = async () => {
    if (!proposal) return;
    setBusy(true);
    setError(null);
    try {
      const items = Object.entries(decisions).map(([key, decision]) => ({ key, decision }));
      const data = await api<{ campaignId?: string }>(
        `/agent/proposals/${proposal.id}/decide`,
        'POST',
        { items, confirm: true }
      );
      setNotice(
        data.campaignId
          ? `Campanha criada em REVISÃO (${data.campaignId}) — aprove no detalhe da campanha.`
          : 'Decisão registrada.'
      );
      setProposal(null);
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha na decisão');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="rounded-xl border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          {notice}
        </p>
      )}
      <div className="space-y-2">
        <label htmlFor="agent-prompt" className="block text-sm font-medium">
          Descreva o objetivo da campanha
        </label>
        <textarea
          id="agent-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="Ex.: quero vender software ERP para empresas industriais de SP"
          className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-violet-400/50 focus-visible:ring-1 focus-visible:ring-violet-400/40"
        />
        <button
          type="button"
          onClick={propose}
          disabled={busy || !prompt.trim()}
          className="h-10 rounded-xl bg-gradient-to-r from-violet-500 to-violet-700 px-4 text-sm font-medium text-white shadow-lg shadow-violet-900/40 transition-transform hover:brightness-110 disabled:opacity-40"
        >
          {busy ? 'Planejando…' : 'Propor campanha'}
        </button>
      </div>

      {proposal && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Plano proposto — avalie item a item</h3>
          {[
            { key: 'audience', title: 'Audiência', detail: proposal.plan.audience?.rationale || 'segmento sugerido' },
            { key: 'strategy', title: 'Estratégia', detail: `${(proposal.plan.strategy?.channels || []).join(' + ')} · ${proposal.plan.strategy?.timing || ''}` },
            { key: 'contents', title: 'Conteúdos', detail: (proposal.plan.contents || []).map((c) => c.channel).join(', ') },
          ].map((item) => (
            <div key={item.key} className="cockpit-glass rounded-2xl p-3.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium text-foreground">{item.title}</p>
                <span className="flex gap-1">
                  {(['accepted', 'rejected'] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={decisions[item.key] === d}
                      onClick={() => setDecisions({ ...decisions, [item.key]: d })}
                      className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                        decisions[item.key] === d
                          ? d === 'accepted'
                            ? 'bg-violet-500/25 text-violet-100'
                            : 'bg-rose-500/20 text-rose-200'
                          : 'border border-white/10 text-muted-foreground hover:bg-white/5'
                      }`}
                    >
                      {d === 'accepted' ? 'Aceitar' : 'Rejeitar'}
                    </button>
                  ))}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
            </div>
          ))}
          <button
            type="button"
            onClick={decide}
            disabled={busy}
            className="h-10 rounded-xl bg-gradient-to-r from-violet-500 to-violet-700 px-4 text-sm font-medium text-white shadow-lg shadow-violet-900/40 transition-transform hover:brightness-110 disabled:opacity-40"
          >
            {busy ? 'Convertendo…' : 'Criar campanha a partir do plano'}
          </button>
        </div>
      )}
    </div>
  );
}
