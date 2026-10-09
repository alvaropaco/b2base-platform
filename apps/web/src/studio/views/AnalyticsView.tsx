/**
 * AnalyticsView — dashboard da campanha (US11, T110): funil completo com
 * flags "estimado", séries diárias (recharts), ROI declarado vs medido,
 * timeline do lead e visão consolidada (FR-064–FR-069).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface FunnelData {
  sent: number;
  delivered: number;
  opens: number;
  clicks: number;
  replies: number;
  conversions: number;
  bounces: number;
  unsubs: number;
  estimated: boolean;
  rates: { deliveredRate: number; openRate: number; clickRate: number; replyRate: number };
}

async function get<T>(path: string): Promise<T | null> {
  const res = await fetch(`/api/studio${path}`);
  if (!res.ok) return null;
  const body = await res.json();
  return body.data ?? null;
}

export function AnalyticsView({ campaignId }: { campaignId: string }) {
  const [funnel, setFunnel] = useState<FunnelData | null>(null);
  const [roi, setRoi] = useState<{ declaredRevenue: number; measured: { conversions: number; sent: number } } | null>(null);
  const [daily, setDaily] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      await fetch(`/api/studio/campaigns/${campaignId}/analytics/refresh`, { method: 'POST' });
      const data = await get<any>(`/campaigns/${campaignId}/analytics`);
      if (data) {
        setFunnel(data.funnel);
        setRoi(data.roi);
      }
      const series = await get<any[]>(`/campaigns/${campaignId}/analytics/daily`);
      setDaily(
        (series || []).map((r) => ({
          day: new Date(r.day).toLocaleDateString('pt-BR', { timeZone: 'UTC' }), // bucket é meia-noite UTC
          enviados: r.sent,
          aberturas: r.opens,
          cliques: r.clicks,
          respostas: r.replies,
        }))
      );
    } catch {
      setError('Falha ao carregar analytics');
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;

  const funnelBars = funnel
    ? [
        { etapa: 'Enviados', n: funnel.sent },
        { etapa: 'Entregues', n: funnel.delivered },
        { etapa: 'Aberturas*', n: funnel.opens },
        { etapa: 'Cliques', n: funnel.clicks },
        { etapa: 'Respostas', n: funnel.replies },
        { etapa: 'Conversões', n: funnel.conversions },
      ]
    : [];

  const [question, setQuestion] = useState('');
  const [analysis, setAnalysis] = useState<{ diagnosis: string; suggestions: string[] } | null>(null);
  const handleAsk = async () => {
    if (!question.trim()) return;
    try {
      const res = await fetch(`/api/studio/campaigns/${campaignId}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const body = await res.json();
      setAnalysis(body.data || null);
    } catch {
      setError('Falha ao consultar o analista');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Pergunte: por que essa campanha está performando mal?"
          className="h-9 flex-1 rounded-md border border-input bg-transparent px-3 text-sm"
        />
        <button
          type="button"
          onClick={handleAsk}
          className="h-9 rounded-md border border-border px-3 text-sm hover:bg-accent"
        >
          Perguntar à IA
        </button>
      </div>
      {analysis && (
        <div className="rounded-lg border border-border p-3 text-sm">
          <p className="font-medium">{analysis.diagnosis}</p>
          <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
            {analysis.suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
      {funnel && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>Enviados: <strong>{funnel.sent}</strong></span>
          <span>Entrega: <strong>{(funnel.rates.deliveredRate * 100).toFixed(1)}%</strong></span>
          <span>Abertura: <strong>{(funnel.rates.openRate * 100).toFixed(1)}%</strong>{funnel.estimated && <em className="ml-1 text-xs text-muted-foreground">(estimada)</em>}</span>
          <span>Clique: <strong>{(funnel.rates.clickRate * 100).toFixed(1)}%</strong></span>
          <span>Resposta: <strong>{(funnel.rates.replyRate * 100).toFixed(1)}%</strong></span>
          <span>Bounce: <strong>{funnel.bounces}</strong></span>
          <span>Descadastros: <strong>{funnel.unsubs}</strong></span>
        </div>
      )}

      {funnelBars.length > 0 && (
        <div style={{ height: 260 }}>
          <ResponsiveContainer>
            <BarChart data={funnelBars}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="etapa" stroke="#94a3b8" fontSize={12} />
              <YAxis stroke="#94a3b8" fontSize={12} />
              <Tooltip />
              <Bar dataKey="n" fill="#4f46e5" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {daily.length > 0 && (
        <div style={{ height: 220 }}>
          <ResponsiveContainer>
            <BarChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="day" stroke="#94a3b8" fontSize={12} />
              <YAxis stroke="#94a3b8" fontSize={12} />
              <Tooltip />
              <Bar dataKey="enviados" fill="#0ea5e9" />
              <Bar dataKey="respostas" fill="#10b981" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {roi && (
        <div className="rounded-lg border border-border p-3 text-sm">
          <p className="font-semibold">ROI (declarado pelo usuário)</p>
          <p className="mt-1 text-muted-foreground">
            Receita atribuída: <strong>R$ {(roi.declaredRevenue / 100).toLocaleString('pt-BR')}</strong> ·{' '}
            {roi.measured.conversions} conversão(ões) em {roi.measured.sent} envios —{' '}
            <em>valor declarado ≠ métrica medida</em> (FR-068).
          </p>
        </div>
      )}
    </div>
  );
}
