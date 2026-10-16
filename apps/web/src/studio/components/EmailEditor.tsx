/**
 * EmailEditor — editor visual drag-and-drop do Email Studio (US5, T055).
 * Blocos reordenáveis via @dnd-kit, edição inline, preview (mesmo render do
 * envio) e checks. Salva o documento de blocos em `emailDoc`.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  createContent,
  fetchCampaign,
  fetchPreview,
  runChecks,
  suggestFor,
  StudioRequestError,
} from '../api';
import type { EmailBlock, StudioContent } from '../api';
import type { StudioCampaignDetail } from '../types';

export interface EmailEditorProps {
  campaign: StudioCampaignDetail;
}

export function EmailEditor({ campaign }: EmailEditorProps) {
  const [content, setContent] = useState<StudioContent | null>(null);
  const [blocks, setBlocks] = useState<EmailBlock[]>([]);
  const [html, setHtml] = useState<string>('');
  const [view, setView] = useState<'desktop' | 'mobile'>('desktop');
  const [checks, setChecks] = useState<{ spamScore: number; level: string; items: Array<{ detail: string }> } | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const ensureContent = useCallback(async (): Promise<StudioContent> => {
    if (content) return content;
    const created = await createContent(campaign.id, {
      channel: 'email',
      subject: 'Proposta para {{companyName}}',
      emailDoc: {
        blocks: [
          { type: 'text', text: 'Olá {{firstName}}, tudo bem?' },
          { type: 'button', label: 'Agendar conversa', url: 'https://exemplo.com' },
          { type: 'text', text: 'Não quer mais receber? Faça o descadastro.' },
        ],
      },
    });
    setContent(created);
    setBlocks(created.emailDoc?.blocks || []);
    return created;
  }, [campaign.id, content]);

  useEffect(() => {
    // Carrega o conteúdo de e-mail existente da campanha, se houver.
    void (async () => {
      try {
        const detail = await fetchCampaign(campaign.id);
        const emailContent = ((detail.contents || []) as unknown as StudioContent[]).find(
          (c) => c.channel === 'email' && c.kind === 'base' && c.variantLabel === 'A'
        );
        if (emailContent) {
          setContent(emailContent);
          setBlocks(emailContent.emailDoc?.blocks || []);
        }
      } catch {
        // campanha sem conteúdo ainda — o editor cria sob demanda
      }
    })();
  }, [campaign.id]);

  const handleSave = async (nextBlocks: EmailBlock[]) => {
    setBusy(true);
    setError(null);
    try {
      const c = await ensureContent();
      const updatedDoc = { blocks: nextBlocks };
      await fetch(`/api/studio/campaigns/${campaign.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ id: c.id, emailDoc: updatedDoc }] }),
      });
      setBlocks(nextBlocks);
      await refreshPreview(c.id, updatedDoc);
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao salvar');
    } finally {
      setBusy(false);
    }
  };

  const refreshPreview = async (contentId: string, doc: { blocks: EmailBlock[] }) => {
    try {
      const { html: previewHtml } = await fetchPreview(campaign.id, contentId, view);
      setHtml(previewHtml);
    } catch {
      // preview só existe após conteúdo salvo
      void doc;
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = blocks.findIndex((_, i) => `block-${i}` === active.id);
    const newIndex = blocks.findIndex((_, i) => `block-${i}` === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(blocks, oldIndex, newIndex);
    setBlocks(next);
    void handleSave(next);
  };

  const addBlock = (type: EmailBlock['type']) => {
    const block: EmailBlock =
      type === 'button'
        ? { type: 'button', label: 'Agendar conversa', url: 'https://exemplo.com' }
        : type === 'image'
          ? { type: 'image', src: '', alt: '' }
          : { type: 'text', text: 'Novo texto — use {{firstName}} ou {{companyName}}.' };
    const next = [...blocks, block];
    setBlocks(next);
    void handleSave(next);
  };

  const updateBlock = (index: number, patch: Partial<EmailBlock>) => {
    const next = blocks.map((b, i) => (i === index ? { ...b, ...patch } : b));
    setBlocks(next);
  };

  const loadChecks = async () => {
    try {
      setChecks(await runChecks(campaign.id));
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha nos checks');
    }
  };

  const loadSuggestions = async () => {
    if (!content) return;
    try {
      const result = await suggestFor(content.id, 'subject');
      setSuggestions(result.suggestions);
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha nas sugestões');
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3">
        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {(['text', 'button', 'image', 'divider'] as const).map((t) => (
            <button key={t} type="button" onClick={() => addBlock(t)} className="h-8 rounded-md border border-border px-3 text-xs">
              + {t}
            </button>
          ))}
          <button type="button" onClick={() => void handleSave(blocks)} disabled={busy} className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-40">
            {busy ? 'Salvando…' : 'Salvar'}
          </button>
          <button type="button" onClick={loadChecks} className="h-8 rounded-md border border-border px-3 text-xs">
            Rodar checks
          </button>
          <button type="button" onClick={loadSuggestions} className="h-8 rounded-md border border-border px-3 text-xs">
            Sugerir assuntos
          </button>
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={blocks.map((_, i) => `block-${i}`)} strategy={verticalListSortingStrategy}>
            <ul className="space-y-2">
              {blocks.map((block, i) => (
                <SortableBlock
                  key={i}
                  id={`block-${i}`}
                  block={block}
                  onChange={(patch) => updateBlock(i, patch)}
                  onRemove={() => {
                    const next = blocks.filter((_, j) => j !== i);
                    setBlocks(next);
                    void handleSave(next);
                  }}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>

        {checks && (
          <div className="rounded-lg border border-border p-3 text-sm">
            <p>
              Score de spam: <strong>{checks.spamScore}</strong> · nível <strong>{checks.level}</strong>
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {checks.items.map((item, i) => (
                <li key={i}>{item.detail}</li>
              ))}
            </ul>
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="mb-1 text-xs font-semibold">Sugestões de assunto</p>
            <ul className="space-y-1 text-xs">
              {suggestions.map((s, i) => (
                <li key={i} className="rounded bg-muted/40 px-2 py-1">{s}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex gap-1">
          {(['desktop', 'mobile'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`rounded-md px-3 py-1 text-xs ${view === v ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground'}`}
            >
              {v}
            </button>
          ))}
        </div>
        <div
          className="mx-auto overflow-hidden rounded-lg border border-border bg-white text-black"
          style={{ width: view === 'mobile' ? 375 : 600 }}
        >
          {html ? (
            <iframe title="Preview do e-mail" srcDoc={html} className="h-[560px] w-full" />
          ) : (
            <p className="p-6 text-sm text-gray-500">Salve o conteúdo para ver o preview (mesmo render do envio).</p>
          )}
        </div>
      </div>
    </div>
  );
}

function SortableBlock({
  id,
  block,
  onChange,
  onRemove,
}: {
  id: string;
  block: EmailBlock;
  onChange: (patch: Partial<EmailBlock>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <li ref={setNodeRef} style={style} className="rounded-md border border-border p-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="cursor-grab px-1 text-muted-foreground"
          aria-label="Reordenar bloco"
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
        <span className="text-xs font-semibold uppercase text-muted-foreground">{block.type}</span>
        <button type="button" onClick={onRemove} className="ml-auto rounded border border-border px-2 text-xs" aria-label="Remover bloco">
          ×
        </button>
      </div>
      {block.type === 'text' && (
        <textarea
          value={block.text || ''}
          onChange={(e) => onChange({ text: e.target.value })}
          rows={2}
          className="mt-1 w-full rounded border border-input bg-transparent px-2 py-1 text-sm"
        />
      )}
      {block.type === 'button' && (
        <div className="mt-1 flex gap-2">
          <input
            value={block.label || ''}
            onChange={(e) => onChange({ label: e.target.value })}
            placeholder="Rótulo"
            className="h-8 flex-1 rounded border border-input bg-transparent px-2 text-sm"
          />
          <input
            value={block.url || ''}
            onChange={(e) => onChange({ url: e.target.value })}
            placeholder="https://…"
            className="h-8 flex-1 rounded border border-input bg-transparent px-2 text-sm"
          />
        </div>
      )}
      {block.type === 'image' && (
        <div className="mt-1 space-y-1">
          {block.src ? (
            <img src={block.src} alt={block.alt || ''} className="max-h-32 w-full rounded object-cover" />
          ) : (
            <p className="rounded border border-dashed border-border px-2 py-3 text-center text-xs text-muted-foreground">
              Cole o LINK da imagem (banner) abaixo — ela entra no e-mail por URL.
            </p>
          )}
          <input
            value={block.src || ''}
            onChange={(e) => onChange({ src: e.target.value })}
            placeholder="Link da imagem https://…"
            className="h-8 w-full rounded border border-input bg-transparent px-2 text-sm"
          />
          <div className="flex gap-2">
            <input
              value={block.alt || ''}
              onChange={(e) => onChange({ alt: e.target.value })}
              placeholder="Descrição (alt)"
              className="h-8 flex-1 rounded border border-input bg-transparent px-2 text-sm"
            />
            <input
              value={block.href || ''}
              onChange={(e) => onChange({ href: e.target.value })}
              placeholder="Link ao clicar (opcional)"
              className="h-8 flex-1 rounded border border-input bg-transparent px-2 text-sm"
            />
          </div>
        </div>
      )}
    </li>
  );
}
