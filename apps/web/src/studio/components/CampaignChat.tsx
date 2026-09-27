/**
 * CampaignChat — o Diálogo de Briefing do Cockpit (specs/010 + specs/011).
 *
 * Rota única `/studio`: a conversa cresce no thread central; cards de
 * resultado (audiência, conteúdo, agenda, Certificado) nascem DENTRO do
 * thread (FR-4) — nunca em painel lateral. Chips-ação disparam ações reais e
 * idempotentes do orquestrador (FR-9); texto livre segue o fluxo normal
 * (FR-10). Progresso ao vivo reusa o transporte SSE do 010 (FR-13).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { StudioRequestError, fetchCertificate, runCampaignAction } from '../api';
import type { CertificateVerdict, CockpitChip } from '../types';

interface ChatCard {
  type: string;
  label: string;
  detail?: string;
  replayed?: boolean;
  /** FR-26: campos de dados citados (ex. "Founders: José e Maria · CNAE 6201"). */
  sources?: string[];
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  cards: ChatCard[];
  createdAt: string;
}

interface PendingTurn {
  reply: string | null;
  statuses: string[];
  cards: ChatCard[];
}

interface CampaignState {
  campaign: {
    id: string;
    name: string;
    status: string;
    objective?: string | null;
    offer?: string | null;
    channels: string[];
    schedule?: { hourlyLimit?: number; dailyLimit?: number; windows?: Array<{ startHour: number; endHour: number }> };
  };
  extras: {
    audienceCount: number | null;
    contentSummary: Array<{ channel: string; tone?: string | null; subject?: string | null }>;
    materials: Array<{ id: string; kind: string; status: string; confirmed: boolean; product?: string | null }>;
  };
}

export interface CampaignChatProps {
  campaignId: string;
  /** Chips do mordomo (home) que iniciam o diálogo correspondente (FR-25). */
  suggestions?: CockpitChip[];
  onStateChange?: () => void;
  onApproved?: () => void;
}

/** Próximas ações válidas da máquina de estados (FR-3/FR-8) → chips. */
function nextStepChips(state: CampaignState | null): Array<{ key: string; label: string; prompt: string }> {
  if (!state) return [];
  const { campaign, extras } = state;
  const chips: Array<{ key: string; label: string; prompt: string }> = [];
  if (!campaign.objective) chips.push({ key: 'objective', label: 'Definir objetivo', prompt: 'Quero definir o objetivo e a oferta da campanha.' });
  if (extras.audienceCount == null || extras.audienceCount === 0) chips.push({ key: 'audience', label: 'Montar audiência', prompt: 'Monte a audiência comigo — quem deve receber?' });
  if (extras.contentSummary.length === 0) chips.push({ key: 'content', label: 'Gerar conteúdo', prompt: 'Gere o conteúdo da campanha para eu revisar.' });
  if (!campaign.schedule?.hourlyLimit) chips.push({ key: 'schedule', label: 'Definir quando enviar', prompt: 'Vamos definir quando e em que ritmo a campanha envia.' });
  if (campaign.status === 'in_review') chips.push({ key: 'approve', label: 'Revisar e aprovar', prompt: 'Revise a campanha comigo para eu aprovar com segurança.' });
  return chips.slice(0, 3);
}

export function CampaignChat({ campaignId, suggestions, onStateChange, onApproved }: CampaignChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [state, setState] = useState<CampaignState | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [certificate, setCertificate] = useState<CertificateVerdict | null>(null);
  const [certificateLoading, setCertificateLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [history, currentState] = await Promise.all([
        jsonFetch<ChatMessage[]>('GET', `/campaigns/${campaignId}/chat`),
        jsonFetch<CampaignState>('GET', `/campaigns/${campaignId}/state`),
      ]);
      setMessages(history);
      setState(currentState);
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao carregar conversa');
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending, certificate]);

  const send = async (text: string) => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    setCertificate(null);
    // Mensagem do usuário aparece na hora (o POST persiste e responde).
    setMessages((prev) => [
      ...prev,
      { id: `tmp-${Date.now()}`, role: 'user', text, cards: [], createdAt: new Date().toISOString() },
    ]);
    setInput('');
    // Turno via SSE: progresso ao vivo (pensando → etapas → cards → done).
    setPending({ reply: null, statuses: ['Pensando…'], cards: [] });
    try {
      const res = await fetch(`/api/studio/campaigns/${campaignId}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new StudioRequestError(body.error || 'CHAT_FAILED', res.status, body.message);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = frame.match(/^event: (.+)$/m)?.[1];
          const dataRaw = frame.match(/^data: (.+)$/m)?.[1];
          if (!event) continue;
          const data = dataRaw ? JSON.parse(dataRaw) : {};
          setPending((prev) => {
            if (!prev) return prev;
            if (event === 'status') {
              const label = data.phase === 'thinking' ? 'Pensando…' : data.label;
              if (!label) return prev;
              return { ...prev, statuses: [...prev.statuses.filter((s) => s !== 'Pensando…' || data.phase === 'thinking'), label] };
            }
            if (event === 'reply') return { ...prev, reply: data.text };
            if (event === 'card' || event === 'card_error') {
              return { ...prev, cards: [...prev.cards, data.card] };
            }
            if (event === 'error') {
              setError(data.message);
              return { ...prev, statuses: [] };
            }
            if (event === 'done') finished = true;
            return prev;
          });
        }
      }
      await load();
      onStateChange?.();
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao enviar mensagem');
    } finally {
      setPending(null);
      setSending(false);
    }
  };

  const handleAttach = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/studio/materials', { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new StudioRequestError(body.error || 'UPLOAD_FAILED', res.status, body.message);
      await send(`Analise o material que acabei de anexar (${file.name}) e extraia produto, oferta e público.`);
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha no upload');
    } finally {
      setUploading(false);
    }
  };

  const handleApprove = async () => {
    setError(null);
    try {
      await jsonFetch('POST', `/campaigns/${campaignId}/approve`, { confirm: true });
      await load();
      onStateChange?.();
      onApproved?.();
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao aprovar');
    }
  };

  /** Chip-ação "Colocar em voo": agenda imediato via action idempotente. */
  const handleLaunch = async () => {
    setError(null);
    setLaunching(true);
    try {
      await runCampaignAction(campaignId, {
        type: 'set_schedule',
        // Nonce por disparo: autorizar de novo é um pedido NOVO (não replaya
        // um agendamento antigo); duplo toque é protegido pelo backend.
        actionId: `launch-${campaignId}-${Date.now()}`,
        params: { mode: 'immediate' },
      });
      await load();
      onStateChange?.();
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Não deu para colocar em voo — verifique o saldo e o Certificado.');
    } finally {
      setLaunching(false);
    }
  };

  /** Certificado de Segurança como card rico do thread (FR-4/FR-27). */
  const handleCertificate = async () => {
    setCertificateLoading(true);
    setError(null);
    try {
      const verdict = await fetchCertificate(campaignId);
      setCertificate(verdict);
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao obter o Certificado');
    } finally {
      setCertificateLoading(false);
    }
  };

  const status: string | undefined = state?.campaign.status;
  const isRunning = status === 'running';
  const canFly = status === 'approved' || status === 'scheduled' || status === 'in_review';
  const stepChips = nextStepChips(state);
  const chips = (suggestions && suggestions.length > 0 ? suggestions : stepChips).slice(0, 3);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col">
      {/* Thread — a conversa cresce do centro; cards vivem aqui (FR-4). */}
      <div className="flex-1 space-y-3 overflow-y-auto p-4" style={{ minHeight: 320, maxHeight: '60vh' }}>
        {messages.length === 0 && (
          <div className="cockpit-rise rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Vamos montar sua campanha juntos.</p>
            <p className="mt-1">
              Me conta o que você quer vender e para quem. Você pode colar um link, anexar um material e me dizer como
              quer o disparo.
            </p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`cockpit-rise flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                m.role === 'user' ? 'rounded-br-sm bg-primary text-primary-foreground' : 'rounded-bl-sm bg-muted/60'
              }`}
            >
              {m.role === 'assistant' ? (
                <div className="space-y-2 [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-1.5 [&_p:last-child]:mb-0 [&_strong]:font-semibold">
                  <ReactMarkdown>{m.text}</ReactMarkdown>
                </div>
              ) : (
                <p className="whitespace-pre-wrap">{m.text}</p>
              )}
              {m.cards?.map((card, i) => (
                <div key={i} className="mt-2 rounded-lg border border-border bg-background/80 p-2 text-xs">
                  <p className="font-semibold">
                    {card.label}
                    {card.replayed && <span className="ml-1 text-muted-foreground">(já feito — nada duplicado)</span>}
                  </p>
                  {card.detail && <p className="mt-0.5 text-muted-foreground">{card.detail}</p>}
                  {card.sources && card.sources.length > 0 && (
                    <p className="mt-1 text-muted-foreground">
                      <span className="font-medium text-foreground">Fontes dos dados:</span> {card.sources.join(' · ')}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        {pending && (
          <div className="cockpit-rise flex justify-start">
            <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted/60 px-3 py-2 text-sm">
              {pending.reply ? (
                <div className="space-y-2 [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-1.5 [&_p:last-child]:mb-0 [&_strong]:font-semibold">
                  <ReactMarkdown>{pending.reply}</ReactMarkdown>
                </div>
              ) : null}
              {pending.statuses.length > 0 && (
                <div className="mt-1 space-y-1">
                  {pending.statuses.map((label, i) => (
                    <p key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className={i === pending.statuses.length - 1 ? 'animate-pulse' : ''}>●</span>
                      {label}
                    </p>
                  ))}
                </div>
              )}
              {pending.cards.map((card, i) => (
                <div key={i} className={`mt-2 rounded-lg border p-2 text-xs ${card.type === 'error' ? 'border-destructive/40 bg-destructive/10' : 'border-border bg-background/80'}`}>
                  <p className="font-semibold">{card.label}</p>
                  {card.detail && <p className="mt-0.5 text-muted-foreground">{card.detail}</p>}
                  {card.sources && card.sources.length > 0 && (
                    <p className="mt-1 text-muted-foreground">
                      <span className="font-medium text-foreground">Fontes dos dados:</span> {card.sources.join(' · ')}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Certificado de Segurança renderizado como mensagem rica do thread */}
        {certificate && (
          <div className="cockpit-rise flex justify-start">
            <div
              role="status"
              aria-label={`Certificado de segurança: ${certificate.level === 'green' ? 'tudo certo' : 'com pendências'}`}
              className={`max-w-[85%] rounded-2xl rounded-bl-sm border p-3 text-sm ${
                certificate.level === 'green' ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-destructive/40 bg-destructive/10'
              }`}
            >
              <p className="font-semibold">
                {certificate.level === 'green' ? 'Certificado verde — pode voar' : 'Certificado com pendências'}
              </p>
              <ul className="mt-2 space-y-1.5">
                {certificate.items.map((item) => (
                  <li key={item.key} className="flex gap-2 text-xs">
                    <span aria-hidden="true">
                      {item.level === 'ok' ? '●' : item.level === 'warning' ? '▲' : '✕'}
                    </span>
                    <span>
                      <strong>{item.label}</strong>
                      {item.level !== 'ok' && <span className="text-muted-foreground"> ({item.level === 'block' ? 'bloqueia' : 'atenção'})</span>}
                      <span className="block text-muted-foreground">{item.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Chips-ação: executam/passos reais, nunca texto decorativo (FR-9) */}
        {!pending && chips.length > 0 && (
          <div className="cockpit-stagger flex flex-wrap gap-2 pt-1">
            {suggestions && suggestions.length > 0
              ? suggestions.map((chip) => (
                  <button
                    key={chip.kind}
                    type="button"
                    title={chip.motivo}
                    onClick={() => {
                      // Chip com action: POST /campaigns/:id/actions (FR-9),
                      // idempotente — nunca send livre.
                      if (chip.action) {
                        runCampaignAction(campaignId, {
                          type: chip.action.type,
                          actionId: `chip-${chip.kind}`,
                          params: chip.action.params,
                        })
                          .then(() => load())
                          .catch((err) =>
                            setError(err instanceof StudioRequestError ? err.message : 'Falha ao executar a ação')
                          );
                        return;
                      }
                      void send(chip.prompt || chip.label);
                    }}
                    className="rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-left text-xs font-medium text-primary transition-colors hover:bg-primary/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    {chip.label}
                    {chip.motivo && (
                      <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                        {chip.motivo}
                      </span>
                    )}
                  </button>
                ))
              : stepChips.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    onClick={() => void send(chip.prompt)}
                    className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    {chip.label}
                  </button>
                ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <p role="alert" className="mx-4 mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {/* Ações de confiança: Certificado → Aprovar → Colocar em voo (FR-27). */}
      {(canFly || status === 'in_review') && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2">
          <button
            type="button"
            onClick={() => void handleCertificate()}
            disabled={certificateLoading}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-40"
          >
            {certificateLoading ? 'Conferindo…' : 'Ver Certificado'}
          </button>
          {status === 'in_review' && (
            <button
              type="button"
              onClick={() => void handleApprove()}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
              title="Aprova a campanha — a audiência congela aqui"
            >
              Aprovar campanha
            </button>
          )}
          {status !== 'in_review' && (
            <button
              type="button"
              onClick={() => void handleLaunch()}
              disabled={launching || isRunning}
              className={`rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40 ${isRunning ? '' : 'cockpit-glow-approve'}`}
              title="Confere o Certificado e o saldo antes de autorizar"
            >
              {isRunning ? 'Em voo' : launching ? 'Autorizando…' : 'Colocar em voo'}
            </button>
          )}
        </div>
      )}

      {/* Input grande no rodapé — o placeholder instrui (FR-2). */}
      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <label
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent"
            title="Anexar PDF, imagem ou documento"
          >
            {uploading ? '…' : '+'}
            <input
              type="file"
              className="hidden"
              accept=".pdf,.docx,.pptx,.png,.jpg,.jpeg,.webp"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleAttach(file);
                e.target.value = '';
              }}
            />
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={1}
            aria-label="Mensagem para o piloto"
            placeholder="Conte o que você quer alcançar…"
            className="max-h-32 flex-1 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={() => void send(input)}
            disabled={sending || !input.trim()}
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-40"
          >
            Enviar
          </button>
        </div>
      </div>
    </div>
  );
}

async function jsonFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/studio${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new StudioRequestError(payload.error || 'ERROR', res.status, payload.message);
  return payload.data as T;
}
