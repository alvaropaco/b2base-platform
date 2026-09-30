/**
 * WhatsAppPreview — preview realista da conversa (US6, T069) + fila de
 * revisão de respostas classificadas pela IA (T070). A prévia usa a amostra
 * real do Studio (mesma resolução de variáveis do envio).
 */
import { useCallback, useEffect, useState } from 'react';
import { confirmReplyLabel, fetchCampaignSample, fetchRepliesForReview, StudioRequestError } from '../api';
import type { ReplyClassification } from '../api';
import type { StudioCampaignDetail } from '../types';

const LABEL_LABEL: Record<string, string> = {
  interested: 'Interessado',
  not_interested: 'Não interessado',
  doubt: 'Dúvida',
  meeting_request: 'Quer reunião',
  opt_out: 'Opt-out',
  out_of_scope: 'Fora de escopo',
  unclassified: 'Sem classificação',
};

export interface WhatsAppPreviewProps {
  campaign: StudioCampaignDetail;
}

export function WhatsAppPreview({ campaign }: WhatsAppPreviewProps) {
  const [rows, setRows] = useState<Array<{ prospectId: string; companyName: string | null; renders: Array<{ channel: string; text?: string }> }>>([]);

  useEffect(() => {
    void fetchCampaignSample(campaign.id, 5)
      .then((sample) =>
        setRows(
          sample.map((s) => ({
            prospectId: s.prospectId,
            companyName: s.companyName,
            // E14: bolha só com texto REAL — `text` vazio não vira bolha vazia.
            renders: s.renders.filter((r) => r.channel === 'whatsapp' && r.text && r.text.trim()),
          }))
        )
      )
      .catch(() => setRows([]));
  }, [campaign.id]);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Preview realista — WhatsApp</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Defina a audiência para ver a prévia por lead.</p>
      ) : (
        rows.map((row) => (
          <div key={row.prospectId} className="rounded-lg border border-border p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">{row.companyName || row.prospectId}</p>
            {row.renders.map((render, i) => (
              <div key={i} className="flex justify-end">
                <div className="max-w-[75%] rounded-2xl rounded-br-sm bg-[#005c4b] px-3 py-2 text-sm text-white">
                  {render.text}
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/** Fila de revisão humana das respostas classificadas com baixa confiança. */
export function RepliesReview() {
  const [replies, setReplies] = useState<ReplyClassification[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void fetchRepliesForReview().then(setReplies).catch(() => setReplies([]));
  }, []);
  useEffect(load, [load]);

  const confirm = async (id: string, label: string) => {
    try {
      await confirmReplyLabel(id, label);
      load();
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao confirmar');
    }
  };

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Respostas aguardando revisão</h3>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {replies.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma resposta pendente de revisão.</p>
      ) : (
        <ul className="space-y-2">
          {replies.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <span>
                {r.prospectId} · {r.channel} ·{' '}
                <strong>{LABEL_LABEL[r.label] || r.label}</strong> (confiança {(r.confidence * 100).toFixed(0)}%)
              </span>
              <span className="flex gap-1">
                {['interested', 'meeting_request', 'not_interested', 'opt_out'].map((label) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => confirm(r.id, label)}
                    className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent"
                  >
                    {LABEL_LABEL[label]}
                  </button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
