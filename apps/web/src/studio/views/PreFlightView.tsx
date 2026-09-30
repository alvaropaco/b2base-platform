/**
 * PreFlightView — tela Pré-voo (Story 3.1, FR9/UX-DR2 da onda "criação de
 * campanha sem bloqueios"): preview lado a lado do e-mail (render real ≡
 * envio — NFR7, mesmo endpoint `fetchPreview`) e do WhatsApp (bolhas do
 * `WhatsAppPreview`), edição inline de assunto/texto/anexos e CTA POR
 * ESTADO — draft/pausada/pendente de envio NUNCA dispara 409 genérico
 * (B12/E15). Cartões empilham em 375px (NFR8), headings próprios, dentro de
 * `.cockpit-scope` (D1 claro pastel), movimento CSS nativo.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Paperclip, Rocket, Send, ShieldCheck, Wifi } from 'lucide-react';
import {
  StudioRequestError,
  approveCampaign,
  controlCampaign,
  deleteAttachment,
  fetchAttachments,
  fetchCampaign,
  fetchCertificate,
  fetchPreview,
  patchCampaign,
  scheduleImmediate,
  uploadAttachment,
  type AttachmentChannel,
  type ContentPatchInput,
  type StudioAttachment,
  type StudioContent,
} from '../api';
import type { CertificateVerdict, StudioCampaignDetail } from '../types';
import { displayStatusLabel } from './CampaignsListView';
import { AttachmentChip } from '../components/AttachmentChip';
import { WhatsAppPreview } from '../components/WhatsAppPreview';

export interface PreFlightViewProps {
  campaignId: string;
  /** Nenhum dead-end: voltar ao chat é sempre possível (Story 3.2). */
  onBackToChat: () => void;
  onOpenMonitor?: () => void;
}

function baseContentByChannel(contents: Array<Record<string, unknown>> | undefined, channel: string): StudioContent | null {
  const found = (contents || []).find(
    (c) => c.channel === channel && c.kind === 'base' && c.stepIndex === 1
  ) as StudioContent | undefined;
  return found || null;
}

/** CTA do Pré-voo POR ESTADO (B12/E15) — puro para teste (I1). */
export type PreFlightCtaKind = 'chat' | 'resume' | 'approve' | 'monitor' | 'connect' | 'launch';

export function primaryCtaFor(
  status: string | undefined,
  hasConnectedChannel: boolean,
  busy: string | null
): { kind: PreFlightCtaKind; label: string; hint: string } {
  if (status === 'draft') {
    return { kind: 'chat', label: 'Continuar criação no chat', hint: 'A campanha ainda está em criação — nada dispara daqui.' };
  }
  if (status === 'paused') {
    return { kind: 'resume', label: 'Retomar campanha', hint: 'A campanha está pausada — retome para o disparo seguir.' };
  }
  if (status === 'running') {
    return { kind: 'monitor', label: 'Ver disparos no Monitor', hint: 'Campanha em voo.' };
  }
  if (status === 'in_review') {
    return { kind: 'approve', label: 'Revisar e aprovar', hint: 'Aprove para chegar ao Pré-voo de verdade.' };
  }
  if (status === 'approved' && !hasConnectedChannel) {
    // UX-DR2/DR5: no cenário pendente o CTA é CONECTAR CANAL — nunca o botão
    // de disparo (que viraria 409).
    return {
      kind: 'connect',
      label: 'Conectar canal para disparar',
      hint: 'A campanha está pronta — conectar o canal destrava o disparo sem refazer a criação.',
    };
  }
  return {
    kind: 'launch',
    label: busy === 'launch' ? 'Autorizando…' : 'Colocar em voo',
    hint: 'Confere o Certificado e o saldo antes de autorizar.',
  };
}

export function PreFlightView({ campaignId, onBackToChat, onOpenMonitor }: PreFlightViewProps) {
  const [campaign, setCampaign] = useState<StudioCampaignDetail | null>(null);
  const [certificate, setCertificate] = useState<CertificateVerdict | null>(null);
  const [attachments, setAttachments] = useState<StudioAttachment[]>([]);
  const [subject, setSubject] = useState('');
  const [whatsappText, setWhatsappText] = useState('');
  const [html, setHtml] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploadChannel, setUploadChannel] = useState<AttachmentChannel>('both');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const detail = await fetchCampaign(campaignId);
      setCampaign(detail);
      const email = baseContentByChannel(detail.contents, 'email');
      const wa = baseContentByChannel(detail.contents, 'whatsapp');
      setSubject(email?.subject || '');
      setWhatsappText(wa?.whatsappText || '');
      if (email) {
        const preview = await fetchPreview(campaignId, email.id).catch(() => null);
        setHtml(preview?.html || '');
      } else {
        setHtml('');
      }
      setAttachments(await fetchAttachments(campaignId).catch(() => []));
      setCertificate(await fetchCertificate(campaignId).catch(() => null));
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao abrir o Pré-voo');
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha na operação');
    } finally {
      setBusy(null);
    }
  };

  const saveContentField = (content: StudioContent, field: 'subject' | 'whatsappText', value: string) =>
    run(`save-${field}`, () =>
      patchCampaign(campaignId, { contents: [{ id: content.id, [field]: value } as ContentPatchInput] })
    );

  const handleUpload = async (file: File) => {
    await run('upload', async () => {
      await uploadAttachment(campaignId, file, uploadChannel);
    });
  };

  const status = campaign?.status;
  const pendencias = (certificate?.items || []).filter((i) => i.level === 'pending' || i.level === 'warning');
  const emailContent = baseContentByChannel(campaign?.contents, 'email');
  const waContent = baseContentByChannel(campaign?.contents, 'whatsapp');
  // Fallback COMPLETO por execução existente (nunca hardcodar um canal como
  // falso quando o endpoint não mandou connectedChannels).
  const connected = campaign?.connectedChannels || {
    email: Boolean(campaign?.emailExecutionId),
    whatsapp: Boolean(campaign?.whatsappExecutionId),
  };
  const declared = (campaign?.channels || []).filter((c) => c === 'email' || c === 'whatsapp');
  // Só há canal de fato quando há canal DECLARÁVEL conectado (channels vazio
  // ou só linkedin_text = pendente de envio, nunca CTA de voo).
  const hasConnectedChannel = declared.length > 0 && declared.some((c) => connected[c as 'email' | 'whatsapp']);
  // CTA POR ESTADO (B12/E15): draft/pausada/pendente nunca dá 409 genérico.
  const cta = primaryCtaFor(status, hasConnectedChannel, busy);
  const CTA_ICON: Record<PreFlightCtaKind, typeof Rocket> = {
    chat: ArrowLeft,
    resume: Rocket,
    approve: ShieldCheck,
    monitor: Rocket,
    connect: Wifi,
    launch: Rocket,
  };
  const CTA_ACTION: Record<PreFlightCtaKind, () => void> = {
    chat: onBackToChat,
    resume: () => run('resume', () => controlCampaign(campaignId, 'resume')),
    approve: () => run('approve', () => approveCampaign(campaignId)),
    monitor: onOpenMonitor || onBackToChat,
    connect: onBackToChat,
    launch: () => run('launch', () => scheduleImmediate(campaignId)),
  };
  const CtaIcon = CTA_ICON[cta.kind];

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onBackToChat}
          className="cockpit-glass flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-[#160211]/25"
          title="Voltar à conversa de criação"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Chat da campanha
        </button>
        <h1 className="text-lg font-semibold tracking-tight text-foreground">Pré-voo</h1>
        {campaign && (
          <span className="rounded-full bg-[#160211]/5 px-2.5 py-1 text-[11px] font-medium text-foreground/80">
            {displayStatusLabel(campaign)}
          </span>
        )}
      </header>

      {error && (
        <p role="alert" className="mb-3 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {error}
        </p>
      )}

      {/* Banner âmbar de pendências com caminho e AÇÃO embutida (UX-DR2). */}
      {pendencias.length > 0 && (
        <aside role="status" className="cockpit-rise mb-4 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm">
          <p className="font-semibold text-foreground">Prontidão do disparo — pode seguir ajustando</p>
          <ul className="mt-2 space-y-2">
            {pendencias.map((item) => (
              <li key={item.key} className="text-xs leading-relaxed">
                <strong>{item.label}:</strong> {item.detail}
                {item.howToFix && (
                  <span className="mt-1 block text-amber-800">
                    Caminho: {item.howToFix}
                    {item.whenUnblocks ? ` · quando libera: ${item.whenUnblocks}` : ''}
                  </span>
                )}
                {item.key === 'canal' && (
                  <button
                    type="button"
                    onClick={onBackToChat}
                    className="mt-1.5 rounded-full border border-amber-400 bg-white/70 px-3 py-1.5 text-[11px] font-medium text-amber-900 transition-colors hover:bg-white"
                  >
                    Conectar canal
                  </button>
                )}
              </li>
            ))}
          </ul>
        </aside>
      )}

      {/* Dois cartões de vidro lado a lado; em 375px empilham (NFR8). */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <section aria-label="Prévia do e-mail" className="cockpit-glass rounded-2xl p-4">
          <h2 className="text-sm font-semibold text-foreground">E-mail</h2>
          <label className="mt-3 block text-xs font-medium text-muted-foreground" htmlFor="preflight-subject">
            Assunto
          </label>
          <input
            id="preflight-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={!emailContent || busy !== null}
            onBlur={() => {
              if (emailContent && subject !== (emailContent.subject || '')) {
                void saveContentField(emailContent, 'subject', subject);
              }
            }}
            className="mt-1 w-full rounded-xl border border-[#160211]/10 bg-white/70 px-3 py-2 text-sm text-foreground outline-none focus:border-[#160211]/30 disabled:opacity-50"
            placeholder="Defina o conteúdo do e-mail no chat para editar aqui"
          />
          <div className="mt-3 overflow-hidden rounded-xl border border-[#160211]/10 bg-white">
            {html ? (
              <iframe title="Prévia real do e-mail (mesmo render do envio)" srcDoc={html} className="h-[420px] w-full" />
            ) : (
              <p className="p-6 text-sm text-muted-foreground">
                {emailContent ? 'Carregando prévia…' : 'Sem conteúdo de e-mail ainda — gere no chat.'}
              </p>
            )}
          </div>
        </section>

        <section aria-label="Prévia do WhatsApp" className="cockpit-glass rounded-2xl p-4">
          <h2 className="text-sm font-semibold text-foreground">WhatsApp</h2>
          <label className="mt-3 block text-xs font-medium text-muted-foreground" htmlFor="preflight-wa">
            Texto da mensagem
          </label>
          <textarea
            id="preflight-wa"
            value={whatsappText}
            onChange={(e) => setWhatsappText(e.target.value)}
            disabled={!waContent || busy !== null}
            rows={3}
            className="mt-1 w-full resize-none rounded-xl border border-[#160211]/10 bg-white/70 px-3 py-2 text-sm text-foreground outline-none focus:border-[#160211]/30 disabled:opacity-50"
            placeholder="Defina o conteúdo do WhatsApp no chat para editar aqui"
          />
          {waContent && whatsappText !== (waContent.whatsappText || '') && (
            <button
              type="button"
              onClick={() => void saveContentField(waContent, 'whatsappText', whatsappText)}
              disabled={busy !== null}
              className="mt-2 rounded-full bg-[#160211] px-3.5 py-2 text-xs font-medium text-white shadow-md disabled:opacity-40"
            >
              Salvar texto
            </button>
          )}
          <div className="mt-3 rounded-xl border border-[#160211]/10 bg-white/60 p-3">
            {campaign && waContent ? (
              <WhatsAppPreview campaign={campaign} />
            ) : (
              <p className="text-sm text-muted-foreground">Sem conteúdo de WhatsApp ainda — o que você gerar fica salvo aqui.</p>
            )}
          </div>
        </section>
      </div>

      {/* Anexos (FR6/UX-DR3): edição inline com canal destino e limites visíveis. */}
      <section aria-label="Anexos da mensagem" className="cockpit-glass mt-4 rounded-2xl p-4">
        <h2 className="text-sm font-semibold text-foreground">Anexos que saem na mensagem</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Imagens e documentos vão JUNTOS no e-mail (até 10MB no total) e no WhatsApp (1 mídia por mensagem). Limite por
          arquivo: 5MB no trial / 25MB no premium.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            aria-label="Canal destino do anexo"
            value={uploadChannel}
            onChange={(e) => setUploadChannel(e.target.value as AttachmentChannel)}
            className="rounded-full border border-[#160211]/10 bg-white/70 px-3 py-2 text-xs text-foreground outline-none"
          >
            <option value="both">E-mail + WhatsApp</option>
            <option value="email">Só e-mail</option>
            <option value="whatsapp">Só WhatsApp</option>
          </select>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy === 'upload'}
            className="flex items-center gap-1.5 rounded-full border border-[#160211]/10 bg-white/60 px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-white disabled:opacity-40"
          >
            <Paperclip className="h-3.5 w-3.5" /> {busy === 'upload' ? 'Enviando…' : 'Anexar arquivo'}
          </button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".pdf,.docx,.pptx,.png,.jpg,.jpeg,.webp,.gif,.csv,.txt,.mp4,.mov,.webm"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
              e.target.value = '';
            }}
          />
        </div>
        {attachments.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2" aria-label="Anexos da campanha">
            {attachments.map((a) => (
              <li key={a.id}>
                <AttachmentChip
                  attachment={a}
                  removing={busy === `rm-${a.id}`}
                  onRemove={(att) => void run(`rm-${att.id}`, () => deleteAttachment(campaignId, att.id))}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* CTA por estado + caminho de destravamento (UX-DR2/DR5). */}
      <div className="cockpit-glass mt-4 rounded-2xl p-4">
        <p className="text-xs text-muted-foreground">{cta.hint}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={CTA_ACTION[cta.kind]}
            disabled={busy !== null}
            className="flex items-center gap-2 rounded-xl bg-[#160211] px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-transform hover:brightness-110 disabled:opacity-40"
          >
            <CtaIcon className="h-4 w-4" />
            {cta.label}
          </button>
          {status === 'scheduled' && (
            <span className="text-xs text-muted-foreground">Agendada — o disparo segue no horário combinado.</span>
          )}
          {/* UX-DR2: audiência e agenda editáveis a partir da MESMA tela —
              via chat (onde a edição é viva e idempotente). */}
          {(status === 'approved' || status === 'scheduled' || status === 'running' || status === 'paused') && (
            <>
              <button
                type="button"
                onClick={onBackToChat}
                className="rounded-full border border-[#160211]/10 bg-white/60 px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-white"
              >
                Editar audiência no chat
              </button>
              <button
                type="button"
                onClick={onBackToChat}
                className="rounded-full border border-[#160211]/10 bg-white/60 px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-white"
              >
                Editar agenda no chat
              </button>
            </>
          )}
          {onOpenMonitor && status !== 'draft' && status !== 'in_review' && (
            <button
              type="button"
              onClick={onOpenMonitor}
              className="rounded-full border border-[#160211]/10 bg-white/60 px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-white"
            >
              <Send aria-hidden className="mr-1 inline h-3 w-3" />
              Monitor
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
