/**
 * AttachmentChip — chip do anexo que sai JUNTO na mensagem (Story 2.1,
 * UX-DR3 da onda "criação sem bloqueios"): pill com ícone do tipo
 * (imagem/documento), nome truncado em UMA linha, "×" de remoção e badge
 * discreto do canal destino (e-mail/WhatsApp). Gramática do Chip existente:
 * borda `accent/25`, fundo `accent/10`, dentro de `.cockpit-scope`.
 */
import { FileText, Image as ImageIcon, X } from 'lucide-react';
import type { StudioAttachment } from '../types';

const CHANNEL_BADGE: Record<StudioAttachment['channels'], { label: string; cls: string }> = {
  email: { label: 'E-mail', cls: 'bg-[#160211]/10 text-foreground/80' },
  whatsapp: { label: 'WhatsApp', cls: 'bg-emerald-100 text-emerald-800' },
  both: { label: 'Ambos', cls: 'bg-[#160211]/10 text-foreground/80' },
};

export function isImageAttachment(a: Pick<StudioAttachment, 'mimeType' | 'originalName'>): boolean {
  if (a.mimeType && a.mimeType.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif)$/i.test(a.originalName || '');
}

export interface AttachmentChipProps {
  attachment: StudioAttachment;
  onRemove?: (attachment: StudioAttachment) => void;
  /** Remoção em curso (desabilita o × sem sumir com o chip). */
  removing?: boolean;
}

export function AttachmentChip({ attachment, onRemove, removing }: AttachmentChipProps) {
  const Icon = isImageAttachment(attachment) ? ImageIcon : FileText;
  const badge = CHANNEL_BADGE[attachment.channels] || CHANNEL_BADGE.both;
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[#160211]/25 bg-[#160211]/10 px-3 py-1.5 text-xs text-foreground"
      title={`${attachment.originalName} · ${badge.label}`}
    >
      <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-foreground/70" />
      <span className="min-w-0 truncate">{attachment.originalName}</span>
      <span aria-hidden className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>
        {badge.label}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(attachment)}
          disabled={removing}
          aria-label={`Remover anexo ${attachment.originalName}`}
          className="ml-0.5 shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-white/70 hover:text-foreground disabled:opacity-40"
        >
          <X aria-hidden className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
