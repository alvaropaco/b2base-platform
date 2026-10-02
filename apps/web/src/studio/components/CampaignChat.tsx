/**
 * CampaignChat — o Diálogo de Briefing do Cockpit (specs/010 + specs/011).
 *
 * Rota única `/studio`: a conversa cresce no thread central; cards de
 * resultado (audiência, conteúdo, agenda, Certificado) nascem DENTRO do
 * thread (FR-4) — nunca em painel lateral. Chips-ação disparam ações reais e
 * idempotentes do orquestrador (FR-9); texto livre segue o fluxo normal
 * (FR-10). Progresso ao vivo reusa o transporte SSE do 010 (FR-13).
 *
 * 2026-09-28 (feedback do dono): os chips genéricos de sugestão saíram do
 * rodapé (poluíam cada resposta — restam só os chips CONTEXTUAIS de próximo
 * passo); o painel de leads virou GAVETA lateral acessível em qualquer fase
 * (não nasce mais dentro do thread); e "Colocar em voo" termina com um
 * RESUMO da campanha + atalho chamativo para o Monitor.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ArrowUp, Paperclip, Rocket, Sparkles, Users, X } from 'lucide-react';
import { AudiencePanel } from './AudiencePanel';
import { StudioRequestError, fetchCertificate, runCampaignAction } from '../api';
import type { CertificateVerdict } from '../types';

export interface ChatCard {
  type: string;
  label: string;
  detail?: string;
  replayed?: boolean;
  /** FR-26: campos de dados citados (ex. "Founders: José e Maria · CNAE 6201"). */
  sources?: string[];
  /** Card de pareamento WhatsApp: QR como data-url + estado da sessão. */
  qrCode?: string;
  status?: string;
  /** Epic 1 (FR6): diagnóstico do porquê da audiência ter casado 0 leads. */
  diagnosis?: string;
  /** Epic 1 (FR6): proposta materialmente diferente — ação de 1 clique. */
  suggestedFilter?: {
    description: string;
    criteria?: unknown;
    /** Epic 2 (FR7): card de captura — ids dos leads capturados no lote. */
    prospectIds?: string[];
    matchedCount?: number;
  } | null;
  /** Epic 1 (FR15/F2): candidatos quando a confirmação de material é ambígua. */
  candidates?: Array<{ id: string; label: string }>;
  /** Gate de confirmação (QA 2026-10-02): a action a reenviar com o selo. */
  action?: { type: string; params?: Record<string, unknown> };
  /** Campanhas da organização (list_campaigns / create_campaign / duplicar). */
  campaigns?: Array<{ id: string; name: string; status: string; audienceCount?: number | null; current?: boolean }>;
  campaignId?: string;
  campaignName?: string;
}

/** Chip-ação derivada do card de 0-match (FR6): aplicar o filtro sugerido. */
export interface RecoveryChip {
  key: string;
  label: string;
  action: { type: string; params: Record<string, unknown> };
}

/**
 * Gate de confirmação (QA 2026-10-02, bug 5 do dono): card confirm_change
 * vira botão "Confirmar" que reenvia a MESMA action já com o selo de
 * aprovação — a IA nunca altera o que existe sem o gesto do usuário.
 */
export function confirmChangeChip(card: ChatCard): RecoveryChip | null {
  if (card.type !== 'confirm_change' || !card.action || !card.action.type) return null;
  return {
    key: 'confirm-change',
    label: 'Confirmar alteração',
    action: { type: card.action.type, params: { ...(card.action.params || {}), confirmed: true } },
  };
}

/**
 * Campanhas da organização (bug 1/2 do dono): atalhos de abertura nos cards
 * campaign_list / campaign_created — trocar de campanha sem sair do chat.
 */
export function campaignLinks(card: ChatCard): Array<{ id: string; label: string; current: boolean }> {
  if (card.type === 'campaign_list' && Array.isArray(card.campaigns)) {
    return card.campaigns
      .filter((c) => c && c.id)
      .map((c) => ({ id: c.id, label: c.name, current: Boolean(c.current) }));
  }
  if (card.type === 'campaign_created' && card.campaignId) {
    return [{ id: card.campaignId, label: card.campaignName || 'Abrir campanha', current: false }];
  }
  return [];
}

/** Decisão de render PURA: botão "Usar este filtro (N leads)" do 0-match. */
export function zeroMatchFilterChip(card: ChatCard): RecoveryChip | null {
  if (card.type !== 'audience' || !card.suggestedFilter || !card.suggestedFilter.criteria) return null;
  const filter = card.suggestedFilter;
  // Sem contagem confiável, o label não inventa número.
  const count = typeof filter.matchedCount === 'number' ? ` (${filter.matchedCount.toLocaleString('pt-BR')} leads)` : '';
  return {
    key: 'use-suggested-filter',
    label: `Usar este filtro${count}`,
    action: { type: 'set_audience', params: { description: filter.description, criteria: filter.criteria } },
  };
}

/**
 * Epic 2 (UX-DR3): chip "Materializar audiência" do card de captura — 1 clique
 * coloca os leads capturados no lote na audiência (mesma porta idempotente
 * select_leads do chat e do painel).
 */
export function captureLeadsChip(card: ChatCard): RecoveryChip | null {
  if (card.type !== 'capture' || card.status !== 'captured') return null;
  const raw = card.suggestedFilter?.prospectIds;
  const ids = Array.isArray(raw) ? raw.filter(Boolean) : [];
  if (ids.length === 0) return null;
  return {
    key: 'use-captured-leads',
    label: `Materializar audiência com os capturados (${ids.length.toLocaleString('pt-BR')} leads)`,
    action: { type: 'select_leads', params: { set: ids } },
  };
}

/** Decisão de render PURA: chips de desambiguação do material (FR15/F2). */
export function ambiguousMaterialChips(card: ChatCard): RecoveryChip[] {
  if (card.type !== 'material_ambiguous' || !Array.isArray(card.candidates)) return [];
  return card.candidates
    .filter((c) => c && c.id)
    .map((c) => ({
      key: `confirm-material-${c.id}`,
      label: c.label,
      action: { type: 'confirm_material', params: { materialId: c.id } },
    }));
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
    statusReason?: string | null;
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
  onStateChange?: () => void;
  /** Story 3.2: fim da criação → redirect automático ao Pré-voo (FR9). */
  onApproved?: () => void;
  /** "Pendente de envio" (Story 1.5/D5): abre o Pré-voo na mesma tela. */
  onOpenPreflight?: () => void;
  /** "Salvar rascunho e sair": volta ao briefing mantendo a campanha em draft. */
  onExitToHome?: () => void;
  /** Etapa corrente do Rail (ex.: 'audience') — liga painéis contextuais. */
  step?: string | null;
  /** Pós-lançamento: abre o Monitor desta campanha (fix 5, 2026-09-28). */
  onOpenMonitor?: () => void;
  /** Rail clicável (bug 3 do dono): { key, token } — token cresce a cada
   *  clique; o chat rola até o card da etapa ou pré-preenche a pergunta. */
  focusStep?: { key: string; token: number } | null;
  /** Atalho dos cards de campanha: abrir outra campanha da organização. */
  onOpenCampaign?: (id: string, name?: string) => void;
}

/** Rail step → tipos de card que "falam" daquela etapa (scroll no thread). */
const FOCUS_CARD_TYPES: Record<string, string[]> = {
  objective: ['objective'],
  audience: ['audience'],
  message: ['content_review', 'content', 'content_empty'],
  schedule: ['schedule'],
  balance: ['balance'],
};

/** Pergunta pré-preenchida quando a etapa ainda não tem card no thread. */
const FOCUS_DRAFT: Record<string, string> = {
  objective: 'Me mostra o objetivo da campanha',
  audience: 'Como está a audiência da campanha?',
  message: 'Me mostra a mensagem da campanha',
  schedule: 'Como está o agendamento?',
  balance: 'Como está meu saldo de envios?',
};

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

export function CampaignChat({ campaignId, onStateChange, onApproved, onOpenPreflight, onExitToHome, step, onOpenMonitor, focusStep, onOpenCampaign }: CampaignChatProps) {
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
  const [leadsOpen, setLeadsOpen] = useState(false);
  /** Resumo pós-lançamento (fix 5): nasce do estado recarregado após o voo. */
  const [launchSummary, setLaunchSummary] = useState<CampaignState | null>(null);
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

  // Rail clicável (bug 3 do dono): rola até o card da etapa clicada e o
  // destaca; sem card no thread, pré-preenche a pergunta no campo de input.
  useEffect(() => {
    if (!focusStep?.key) return;
    const types = FOCUS_CARD_TYPES[focusStep.key] || [];
    const nodes = document.querySelectorAll<HTMLElement>('[data-card-type]');
    let target: HTMLElement | null = null;
    for (const node of nodes) {
      if (types.includes(node.dataset.cardType || '')) target = node; // último
    }
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('cockpit-card-pulse');
      setTimeout(() => target?.classList.remove('cockpit-card-pulse'), 1600);
    } else {
      setInput(FOCUS_DRAFT[focusStep.key] || '');
    }
    // token: cada clique no Rail re-dispara o efeito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusStep?.token]);

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
            if (event === 'reply_delta') {
              // Streaming (bug 4 do dono): o reply cresce em tempo real — o
              // evento `reply` final é autoritativo e substitui o texto.
              return { ...prev, reply: (prev.reply || '') + String(data.text || '') };
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

  /** Chip-ação "Colocar em voo": agenda imediato via action idempotente.
   *  No sucesso, monta o RESUMO da campanha (fix 5) com atalho ao Monitor. */
  const handleLaunch = async () => {
    setError(null);
    setLaunching(true);
    try {
      await runCampaignAction(campaignId, {
        type: 'set_schedule',
        // Nonce por disparo: autorizar de novo é um pedido NOVO (não replaya
        // um agendamento antigo); duplo toque é protegido pelo backend.
        actionId: `launch-${campaignId}-${Date.now()}`,
        params: { mode: 'immediate', confirmed: true },
      });
      const fresh = await jsonFetch<CampaignState>('GET', `/campaigns/${campaignId}/state`);
      setLaunchSummary(fresh);
      setState(fresh);
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

  /** Chips de recuperação (Epic 1 FR6/FR15): mesmo caminho idempotente dos
   *  chips-ação (POST /actions). Sem actionId: duplo toque é protegido pelo
   *  hash de params no backend. */
  const applyRecoveryChip = async (chip: RecoveryChip) => {
    setError(null);
    try {
      // confirmed: true — chip é gesto direto do usuário (o gate de
      // confirmação do dono vale para a IA, não para cliques dele).
      await runCampaignAction(campaignId, {
        type: chip.action.type,
        params: { ...chip.action.params, confirmed: true },
      });
      await load();
      onStateChange?.();
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao aplicar a ação');
    }
  };

  const status: string | undefined = state?.campaign.status;
  const statusReason: string | null | undefined = state?.campaign.statusReason;
  const isRunning = status === 'running';
  const canFly = status === 'approved' || status === 'scheduled' || status === 'in_review';

  // Certificado pré-carregado (2026-09-27): os botões de decisão precisam
  // saber ANTES se há pendências — sem fetch automático o usuário aprovaria
  // cego. Re-avalia sempre que o estado muda (o send() limpa o certificado).
  const needsCertificate = canFly || status === 'in_review';
  useEffect(() => {
    if (!needsCertificate || certificate || certificateLoading) return;
    void handleCertificate();
    // certificate/certificateLoading fora de propósito: reage só à necessidade.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsCertificate]);
  // Chips contextuais do PRÓPRIO fluxo (fix 1, 2026-09-28): os chips genéricos
  // de sugestão da home saíram do rodapé do chat — poluíam cada resposta.
  const stepChips = nextStepChips(state);
  // Onda "criação sem bloqueios" (2026-09-29): pendências NUNCA desabilitam o
  // avanço — o Certificado é checklist de prontidão (estado + caminho + quando
  // libera). O que impede o disparo segue no gate, na hora do envio (AD-4).
  const hasPendencies = certificate ? certificate.items.some((i) => i.level !== 'ok') : false;

  /** Card do thread: glass padrão; QR do WhatsApp e saldo têm cor própria. */
  const renderCard = (card: ChatCard, i: number) => {
    if (card.type === 'whatsapp_qr') {
      return (
        <div key={i} className="cockpit-glass rounded-xl p-3 text-xs">
          <p className="font-semibold text-foreground">{card.label}</p>
          {card.detail && <p className="mt-0.5 leading-relaxed text-muted-foreground">{card.detail}</p>}
          {card.qrCode ? (
            <div className="mt-3 flex flex-col items-center gap-2">
              <div className="rounded-xl bg-white p-2.5 shadow-lg shadow-emerald-900/20">
                <img src={card.qrCode} alt="QR Code de pareamento do WhatsApp" className="h-44 w-44" />
              </div>
              <span className="text-[11px] text-muted-foreground">Escaneie pelo WhatsApp → Aparelhos conectados</span>
            </div>
          ) : (
            <p className="mt-2 rounded-lg bg-emerald-50 px-2 py-1.5 text-emerald-800">
              {card.status === 'connected' ? '✓ Sessão ativa — nada a fazer.' : 'Aguardando a sessão…'}
            </p>
          )}
        </div>
      );
    }
    if (card.type === 'balance') {
      return (
        <div key={i} className="cockpit-glass rounded-xl border-[#160211]/10 p-3 text-xs">
          <p className="font-semibold text-foreground">{card.label}</p>
          {card.detail && (
            <div className="mt-1.5 space-y-2">
              {card.detail.split('\n').map((line, j) => (
                <p key={j} className="leading-relaxed text-muted-foreground">
                  {/* O backend manda **negrito** nos rótulos dos canais — renderiza sem markdown cru. */}
                  {line.split(/(\*\*[^*]+\*\*)/g).map((part, k) =>
                    part.startsWith('**') && part.endsWith('**') ? (
                      <strong key={k} className="text-foreground">{part.slice(2, -2)}</strong>
                    ) : (
                      <span key={k}>{part}</span>
                    )
                  )}
                </p>
              ))}
            </div>
          )}
        </div>
      );
    }
    const filterChip = zeroMatchFilterChip(card);
    const materialChips = ambiguousMaterialChips(card);
    // Epic 2 (UX-DR3): chip do card de captura — 1 clique materializa a
    // audiência com o lote capturado.
    const captureChip = captureLeadsChip(card);
    // Gate de confirmação (bug 5) + atalhos de campanha (bugs 1/2).
    const confirmChipCard = confirmChangeChip(card);
    const links = campaignLinks(card);
    return (
      <div key={i} data-card-type={card.type} className="cockpit-glass rounded-xl p-3 text-xs">
        <p className="font-semibold text-foreground">
          {card.label}
          {card.replayed && <span className="ml-1 font-normal text-muted-foreground">(já feito — nada duplicado)</span>}
        </p>
        {card.detail && <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{card.detail}</p>}
        {links.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {links
              .filter((l) => !l.current)
              .map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => onOpenCampaign?.(l.id, l.label)}
                  className="rounded-full border border-[#160211]/10 bg-white px-3 py-1.5 text-[11px] font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
                >
                  Abrir “{l.label}”
                </button>
              ))}
          </div>
        )}
        {/* Epic 1 (FR6): diagnóstico do 0-match em linguagem simples. */}
        {card.diagnosis && <p className="mt-1.5 leading-relaxed text-muted-foreground">{card.diagnosis}</p>}
        {/* Epic 1 (FR6): proposta materialmente diferente — 1 clique aplica. */}
        {filterChip && (
          <button
            type="button"
            onClick={() => void applyRecoveryChip(filterChip)}
            className="mt-2 rounded-full bg-[#160211] px-3 py-1.5 text-[11px] font-medium text-white shadow-md transition-transform hover:brightness-110"
          >
            {filterChip.label}
          </button>
        )}
        {/* Epic 2 (FR7): lote capturado — 1 clique vira audiência. */}
        {captureChip && (
          <button
            type="button"
            onClick={() => void applyRecoveryChip(captureChip)}
            className="mt-2 rounded-full bg-[#160211] px-3 py-1.5 text-[11px] font-medium text-white shadow-md transition-transform hover:brightness-110"
          >
            {captureChip.label}
          </button>
        )}
        {/* Gate de confirmação (bug 5 do dono): 1 clique aprova a alteração. */}
        {confirmChipCard && (
          <button
            type="button"
            onClick={() => void applyRecoveryChip(confirmChipCard)}
            className="mt-2 rounded-full bg-[#160211] px-3 py-1.5 text-[11px] font-medium text-white shadow-md transition-transform hover:brightness-110"
          >
            {confirmChipCard.label}
          </button>
        )}
        {/* Epic 1 (FR15/F2): desambiguação — cada candidato é um chip vivo. */}
        {materialChips.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {materialChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => void applyRecoveryChip(chip)}
                className="rounded-full border border-[#160211]/10 bg-white px-3 py-1.5 text-[11px] font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
        {card.sources && card.sources.length > 0 && (
          <p className="mt-1.5 text-muted-foreground">
            <span className="font-medium text-foreground/70">Fontes dos dados:</span> {card.sources.join(' · ')}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col">
      {/* Thread — a conversa cresce do centro; cards vivem aqui (FR-4).
          Linguagem (ref. AI-Chatbot-UI): piloto em texto plano com avatar
          sparkle; usuário em card branco. O painel de leads NÃO mora mais
          aqui: virou gaveta lateral (fix 4, 2026-09-28). */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="cockpit-rise cockpit-glass rounded-2xl p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Vamos montar sua campanha juntos.</p>
            <p className="mt-1">
              Me conta o que você quer vender e para quem. Você pode colar um link, anexar um material e me dizer como
              quer o disparo.
            </p>
          </div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="cockpit-rise flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md border border-[#160211]/10 bg-white px-4 py-2.5 text-sm text-foreground shadow-sm">
                <p className="whitespace-pre-wrap">{m.text}</p>
              </div>
            </div>
          ) : (
            <div key={m.id} className="cockpit-rise flex justify-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/80 text-foreground shadow-[inset_0_0_0_1px_rgba(22,2,17,0.12)]">
                <Sparkles className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 max-w-[85%] space-y-2 text-sm">
                <div className="space-y-2 text-[15px] leading-relaxed [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-1.5 [&_p:last-child]:mb-0 [&_strong]:font-semibold">
                  <ReactMarkdown>{m.text}</ReactMarkdown>
                </div>
                {m.cards?.map(renderCard)}
              </div>
            </div>
          )
        )}
        {pending && (
          <div className="cockpit-rise flex justify-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/80 text-foreground shadow-[inset_0_0_0_1px_rgba(22,2,17,0.12)]">
              <Sparkles className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 max-w-[85%] space-y-2 text-sm">
              {pending.reply ? (
                <div className="space-y-2 text-[15px] leading-relaxed [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-1.5 [&_p:last-child]:mb-0 [&_strong]:font-semibold">
                  <ReactMarkdown>{pending.reply}</ReactMarkdown>
                </div>
              ) : null}
              {/* Status por ÚLTIMO (2026-10-02, bug 4 do dono): o que a IA está
                  fazendo AGORA (gerando conteúdo, criando audiência) fica
                  visível com os pontinhos — inclusive DEPOIS do texto. */}
              {pending.statuses.length > 0 && (
                <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <span className="cockpit-typing flex items-center gap-1" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  {pending.statuses[pending.statuses.length - 1]}
                </p>
              )}
              {pending.cards.map((card, i) =>
                card.type === 'error' ? (
                  <div key={i} className="rounded-xl border border-rose-400/40 bg-rose-500/10 p-3 text-xs">
                    <p className="font-semibold text-foreground">{card.label}</p>
                    {card.detail && <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{card.detail}</p>}
                  </div>
                ) : (
                  renderCard(card, i)
                )
              )}
            </div>
          </div>
        )}

        {/* Certificado como checklist de prontidão (onda 2026-09-29, UX-DR1):
            verde = tudo pronto; ÂMBAR quando houver `pending` (B5/B6 — nunca
            verde com pendências); rosa reservado ao que impede SOMENTE o
            disparo (nível `block` nunca chega na criação). */}
        {certificate && (
          <div className="cockpit-rise flex justify-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/80 text-foreground shadow-[inset_0_0_0_1px_rgba(22,2,17,0.12)]">
              <Sparkles className="h-3.5 w-3.5" />
            </div>
            <div
              role="status"
              aria-label={`Checklist de prontidão: ${certificate.level === 'green' ? 'tudo pronto' : certificate.level === 'amber' ? 'pronto, com pendências' : 'com o que impede o disparo'}`}
              className={`max-w-[85%] rounded-2xl rounded-bl-md border p-3.5 text-sm ${
                certificate.level === 'green'
                  ? 'border-emerald-300 bg-emerald-50'
                  : certificate.level === 'amber'
                    ? 'border-amber-300 bg-amber-50'
                    : 'border-rose-300 bg-rose-50'
              }`}
            >
              <p className="font-semibold">
                {certificate.level === 'green'
                  ? 'Tudo pronto — pode seguir'
                  : certificate.level === 'amber'
                    ? 'Checklist de prontidão — pode seguir criando'
                    : 'Checklist de prontidão'}
              </p>
              <ul className="mt-2 space-y-1.5">
                {certificate.items.map((item) => (
                  <li key={item.key} className="flex gap-2 text-xs">
                    <span
                      aria-hidden="true"
                      className={
                        item.level === 'ok'
                          ? 'text-emerald-600'
                          : item.level === 'block'
                            ? 'text-rose-600'
                            : 'text-amber-600'
                      }
                    >
                      {item.level === 'ok' ? '●' : item.level === 'block' ? '✕' : '▲'}
                    </span>
                    <span>
                      <strong>{item.label}</strong>
                      {item.level !== 'ok' && (
                        <span className="text-muted-foreground">
                          {' '}
                          ({item.level === 'block' ? 'impede o disparo' : item.level === 'pending' ? 'pendente' : 'atenção'})
                        </span>
                      )}
                      <span className="block text-muted-foreground">{item.detail}</span>
                      {(item.howToFix || item.whenUnblocks) && (
                        <span className="mt-0.5 block text-amber-800">
                          {item.howToFix ? `Caminho: ${item.howToFix}` : ''}
                          {item.howToFix && item.whenUnblocks ? ' · ' : ''}
                          {item.whenUnblocks ? `Quando libera: ${item.whenUnblocks}` : ''}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Resumo pós-lançamento (fix 5): o cliente vê TUDO que foi configurado
            e um atalho chamativo para acompanhar a campanha no Monitor. */}
        {launchSummary && (
          <div className="cockpit-rise flex justify-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/80 text-foreground shadow-[inset_0_0_0_1px_rgba(22,2,17,0.12)]">
              <Rocket className="h-4 w-4" />
            </div>
            <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-emerald-300 bg-emerald-50 p-4 text-sm">
              <p className="font-semibold text-foreground">🚀 Campanha em voo!</p>
              <ul className="mt-2 space-y-1 text-xs text-foreground/90">
                <li>
                  <strong>Objetivo:</strong> {launchSummary.campaign.objective || '—'}
                  {launchSummary.campaign.offer ? ` · Oferta: ${launchSummary.campaign.offer}` : ''}
                </li>
                <li>
                  <strong>Audiência:</strong>{' '}
                  {typeof launchSummary.extras.audienceCount === 'number'
                    ? `${launchSummary.extras.audienceCount.toLocaleString('pt-BR')} lead(s) selecionados`
                    : '—'}
                </li>
                <li>
                  <strong>Canais:</strong> {launchSummary.campaign.channels.join(', ')}
                </li>
                <li>
                  <strong>Disparo:</strong>{' '}
                  {launchSummary.campaign.schedule?.hourlyLimit
                    ? `${launchSummary.campaign.schedule.hourlyLimit}/hora${
                        launchSummary.campaign.schedule.dailyLimit ? ` · até ${launchSummary.campaign.schedule.dailyLimit}/dia` : ''
                      }`
                    : 'imediato'}
                  {launchSummary.campaign.schedule?.windows?.[0]
                    ? ` · janela ${launchSummary.campaign.schedule.windows[0].startHour}h–${launchSummary.campaign.schedule.windows[0].endHour}h`
                    : ''}
                </li>
                <li>
                  <strong>Segurança:</strong>{' '}
                  {certificate?.level === 'green'
                    ? 'Tudo pronto ✓'
                    : certificate?.level === 'amber'
                      ? 'Em voo — pendências de disparo ficam no checklist'
                      : 'confira o Checklist de prontidão no chat se algo pendear'}
                </li>
              </ul>
              {onOpenMonitor && (
                <button
                  type="button"
                  onClick={onOpenMonitor}
                  className="cockpit-glow-approve mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-[#160211] px-4 py-3 text-sm font-semibold text-white shadow-lg transition-transform hover:brightness-110"
                >
                  <Rocket className="h-4 w-4" />
                  Acompanhar disparos, respostas e leads no Monitor
                </button>
              )}
            </div>
          </div>
        )}

        {/* Chips-ação CONTEXTUAIS: só o que falta na campanha, nunca decorativo (FR-9) */}
        {!pending && stepChips.length > 0 && (
          <div className="cockpit-stagger flex flex-wrap gap-2 pt-1">
            {stepChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => void send(chip.prompt)}
                className="rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <p role="alert" className="mx-4 mb-2 rounded-xl border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-800">
          {error}
        </p>
      )}

      {/* Zona de decisão: pendências → seguir pra mensagem → voo (FR-27;
          rótulos e gating conforme feedback do dono, 2026-09-27). */}
      <div className="p-3 sm:p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {/* Gaveta de leads (fix 4): aberta em QUALQUER fase da campanha. */}
          <button
            type="button"
            onClick={() => setLeadsOpen(true)}
            className="flex items-center gap-1.5 rounded-full border border-[#160211]/10 bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-white"
            title="Ver e ajustar quem recebe esta campanha — em qualquer fase"
          >
            <Users className="h-3.5 w-3.5" />
            Leads
            {typeof state?.extras.audienceCount === 'number' && state.extras.audienceCount > 0
              ? ` (${state.extras.audienceCount.toLocaleString('pt-BR')})`
              : ''}
          </button>
          {/* Pendências: botão só existe quando há o que resolver — e é VIVO
              (B5/B6): reabre o checklist atualizado; a criação segue livre. */}
          {(canFly || status === 'in_review') && certificate === null && (
            <span className="rounded-full border border-[#160211]/10 bg-white/[0.04] px-3.5 py-2 text-xs text-muted-foreground">
              Conferindo pendências…
            </span>
          )}
          {certificate && hasPendencies && (
            <button
              type="button"
              onClick={() => void handleCertificate()}
              disabled={certificateLoading}
              className="rounded-full border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-40"
              title="O que falta para o disparo — a criação pode seguir"
            >
              {certificateLoading ? 'Conferindo…' : 'Ver pendências'}
            </button>
          )}
          {status === 'approved' && statusReason === 'NO_CHANNEL_CONNECTED' && onOpenPreflight && (
            <button
              type="button"
              onClick={onOpenPreflight}
              className="rounded-full border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100"
              title="A campanha está pronta — abra o Pré-voo e conecte um canal para disparar"
            >
              Pendente de envio — abrir Pré-voo
            </button>
          )}
          {status === 'in_review' && (
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  await handleApprove();
                  void send('Gere o conteúdo da campanha para eu revisar.');
                })();
              }}
              disabled={sending}
              className="rounded-full bg-[#160211] px-3.5 py-2 text-xs font-medium text-white shadow-md disabled:opacity-40"
              title="Aprova a audiência e segue para a Mensagem — pendências não travam a criação"
            >
              Seguir pra Mensagem
            </button>
          )}
          {canFly && status !== 'in_review' && (
            <button
              type="button"
              onClick={() => void handleLaunch()}
              disabled={launching || isRunning}
              className={`rounded-full bg-[#160211] px-3.5 py-2 text-xs font-medium text-white shadow-md disabled:opacity-40 ${isRunning ? '' : 'cockpit-glow-approve'}`}
              title="Confere o Certificado e o saldo antes de autorizar"
            >
              {isRunning ? 'Em voo' : launching ? 'Autorizando…' : 'Colocar em voo'}
            </button>
          )}
          {onExitToHome && (
            <button
              type="button"
              onClick={onExitToHome}
              className="ml-auto rounded-full border border-[#160211]/10 bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-white hover:text-foreground"
              title="A campanha fica salva como rascunho — retome quando quiser"
            >
              Salvar rascunho e sair
            </button>
          )}
        </div>
        <div className="cockpit-glass cockpit-composer rounded-2xl p-3 transition-shadow">
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
            className="max-h-32 w-full resize-none bg-transparent px-1 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="mt-2 flex items-center justify-between border-t border-[#160211]/10 pt-2.5">
            <label
              className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
              title="Anexar PDF, imagem ou documento"
            >
              <Paperclip className="h-3.5 w-3.5" />
              {uploading ? 'Enviando…' : 'Anexar'}
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
            <button
              type="button"
              onClick={() => void send(input)}
              disabled={sending || !input.trim()}
              aria-label="Enviar mensagem"
              className="cockpit-send flex h-9 w-9 items-center justify-center rounded-full text-white transition-transform disabled:opacity-40"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
      {/* Gaveta lateral de leads (fix 4, 2026-09-28): seleção e gestão em
          qualquer fase, sobreposta à conversa; o agente manipula a MESMA
          seleção via action select_leads. */}
      {leadsOpen && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Leads da campanha">
          <div className="absolute inset-0 bg-black/40" onClick={() => setLeadsOpen(false)} />
          <div className="cockpit-glass-strong relative flex h-full w-full max-w-md flex-col border-l border-[#160211]/10 shadow-2xl">
            <header className="flex items-center justify-between border-b border-[#160211]/10 px-4 py-3">
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Users className="h-4 w-4" /> Leads da campanha
              </p>
              <button
                type="button"
                onClick={() => setLeadsOpen(false)}
                aria-label="Fechar painel de leads"
                className="rounded-lg border border-border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <AudiencePanel
                campaignId={campaignId}
                onApplied={() => {
                  void load();
                  onStateChange?.();
                }}
              />
            </div>
          </div>
        </div>
      )}
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
