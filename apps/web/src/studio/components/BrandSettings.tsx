/**
 * BrandSettings — Brand Voice + Brand Kit da organização (US12, T120) e
 * painel de parecer de compliance embutido no fluxo de revisão.
 *
 * Assets da marca (2026-09-27): upload de logo, materiais de marketing
 * (imagem/PDF) e arquivos de contexto (.txt/.md) que alimentam os agentes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Loader2, Trash2, Upload } from 'lucide-react';
import {
  deleteBrandAsset,
  fetchBrand,
  saveBrand,
  StudioRequestError,
  uploadBrandAsset,
  type BrandAsset,
} from '../api';

const CONTEXT_ACCEPT = '.txt,.md,.pdf';

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function BrandSettings() {
  const [profile, setProfile] = useState<{ voice?: { toneNotes?: string }; kit?: { logoUrl?: string; colors?: Record<string, string>; assets?: BrandAsset[] } }>({});
  const [toneNotes, setToneNotes] = useState('');
  const [samples, setSamples] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#8B5CF6');
  const [assets, setAssets] = useState<BrandAsset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const materialInputRef = useRef<HTMLInputElement>(null);
  const contextInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchBrand();
      setProfile(data);
      setToneNotes(data.voice?.toneNotes || '');
      setPrimaryColor(data.kit?.colors?.primary || '#8B5CF6');
      setAssets(data.kit?.assets || []);
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao carregar marca');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      await saveBrand({
        voice: { ...(profile.voice || {}), toneNotes },
        kit: {
          ...(profile.kit || {}),
          colors: { ...(profile.kit?.colors || {}), primary: primaryColor },
        },
      });
      await load(); // relê do servidor: persistência visível na hora
      setNotice('Marca salva — os agentes já usam este tom de voz.');
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao salvar');
    } finally {
      setBusy(null);
    }
  };

  const handleLearn = async () => {
    setBusy('learn');
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/studio/brand/learn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ samples: samples.split('\n').map((s) => s.trim()).filter(Boolean) }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new StudioRequestError(body.error || 'LEARN_FAILED', res.status, body.message);
      await load();
      setNotice('Brand Voice atualizada a partir dos exemplos.');
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao aprender voz');
    } finally {
      setBusy(null);
    }
  };

  const handleUpload = async (file: File, kind: BrandAsset['kind']) => {
    setBusy(`upload-${kind}`);
    setError(null);
    setNotice(null);
    try {
      const asset = await uploadBrandAsset(file, kind);
      await load();
      setNotice(
        kind === 'logo'
          ? 'Logo atualizado.'
          : kind === 'material'
            ? `Material “${asset.originalName}” anexado à marca.`
            : `Contexto “${asset.originalName}” adicionado — os agentes leem este arquivo.`
      );
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha no upload');
    } finally {
      setBusy(null);
      if (logoInputRef.current) logoInputRef.current.value = '';
      if (materialInputRef.current) materialInputRef.current.value = '';
      if (contextInputRef.current) contextInputRef.current.value = '';
    }
  };

  const handleDeleteAsset = async (asset: BrandAsset) => {
    if (!window.confirm(`Remover “${asset.originalName}”?`)) return;
    try {
      await deleteBrandAsset(asset.id);
      await load();
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao remover arquivo');
    }
  };

  const logo = assets.find((a) => a.kind === 'logo');
  const materials = assets.filter((a) => a.kind === 'material');
  const contexts = assets.filter((a) => a.kind === 'context');

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {notice}
        </p>
      )}

      <div className="cockpit-glass space-y-2 rounded-2xl p-4">
        <h3 className="text-sm font-semibold">Brand Voice</h3>
        <textarea
          value={toneNotes}
          onChange={(e) => setToneNotes(e.target.value)}
          rows={2}
          placeholder="Como a empresa fala (ex.: direto, técnico, sem girias)"
          className="w-full rounded-xl border border-[#160211]/10 bg-white/70 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-[#160211]/40 focus-visible:ring-1 focus-visible:ring-[#160211]/30"
        />
        <textarea
          value={samples}
          onChange={(e) => setSamples(e.target.value)}
          rows={3}
          placeholder={'Exemplos de textos da marca (um por linha) para a IA aprender o tom…'}
          className="w-full rounded-xl border border-[#160211]/10 bg-white/70 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-[#160211]/40 focus-visible:ring-1 focus-visible:ring-[#160211]/30"
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleLearn}
            disabled={busy !== null}
            className="h-9 rounded-xl border border-[#160211]/10 bg-white/70 px-3 text-xs font-medium text-foreground transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            {busy === 'learn' ? 'Aprendendo…' : 'Aprender voz dos exemplos (premium)'}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy !== null}
            className="h-9 rounded-xl bg-[#160211] px-4 text-xs font-medium text-white shadow-md transition-transform hover:brightness-110 disabled:opacity-40"
          >
            {busy === 'save' ? 'Salvando…' : 'Salvar marca'}
          </button>
        </div>
      </div>

      <div className="cockpit-glass space-y-3 rounded-2xl p-4">
        <h3 className="text-sm font-semibold">Logo e identidade</h3>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl border border-[#160211]/10 bg-white/70">
            {logo ? (
              <img src={logo.url} alt="Logo da marca" className="max-h-full max-w-full object-contain" />
            ) : (
              <ImageIcon className="h-6 w-6 text-muted-foreground/60" />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={logoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleUpload(file, 'logo');
              }}
            />
            <button
              type="button"
              onClick={() => logoInputRef.current?.click()}
              disabled={busy !== null}
              className="flex h-9 items-center gap-1.5 rounded-xl border border-[#160211]/10 bg-white/70 px-3 text-xs font-medium text-foreground transition-colors hover:bg-white/10 disabled:opacity-40"
            >
              {busy === 'upload-logo' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {logo ? 'Trocar logo' : 'Subir logo'}
            </button>
            <input
              type="color"
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              aria-label="Cor primária"
              className="h-9 w-14 cursor-pointer rounded-xl border border-[#160211]/10 bg-transparent"
              title="Cor primária da marca"
            />
          </div>
        </div>
      </div>

      <div className="cockpit-glass space-y-3 rounded-2xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Materiais de marketing</h3>
          <input
            ref={materialInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,application/pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file, 'material');
            }}
          />
          <button
            type="button"
            onClick={() => materialInputRef.current?.click()}
            disabled={busy !== null}
            className="flex h-9 items-center gap-1.5 rounded-xl border border-[#160211]/10 bg-white/70 px-3 text-xs font-medium text-foreground transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            {busy === 'upload-material' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Anexar material
          </button>
        </div>
        {materials.length === 0 ? (
          <p className="text-xs text-muted-foreground">Imagens e PDFs (folders, pitch, arte) que a IA usa como fonte ao criar campanhas.</p>
        ) : (
          <ul className="space-y-1.5">
            {materials.map((a) => (
              <AssetRow key={a.id} asset={a} onDelete={() => void handleDeleteAsset(a)} />
            ))}
          </ul>
        )}
      </div>

      <div className="cockpit-glass space-y-3 rounded-2xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Contexto para os agentes</h3>
          <input
            ref={contextInputRef}
            type="file"
            accept={CONTEXT_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file, 'context');
            }}
          />
          <button
            type="button"
            onClick={() => contextInputRef.current?.click()}
            disabled={busy !== null}
            className="flex h-9 items-center gap-1.5 rounded-xl border border-[#160211]/10 bg-white/70 px-3 text-xs font-medium text-foreground transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            {busy === 'upload-context' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Subir contexto
          </button>
        </div>
        {contexts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Arquivos .txt/.md/.pdf com contexto do negócio (proposta, objeções comuns, diferenciais) — o assistente lê junto ao montar campanhas.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {contexts.map((a) => (
              <AssetRow key={a.id} asset={a} onDelete={() => void handleDeleteAsset(a)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function AssetRow({ asset, onDelete }: { asset: BrandAsset; onDelete: () => void }) {
  return (
    <li className="flex items-center gap-2.5 rounded-xl border border-[#160211]/10 bg-white/50 px-3 py-2">
      <FileText className="h-4 w-4 shrink-0 text-foreground" />
      <a
        href={asset.url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1 truncate text-xs font-medium text-foreground hover:underline"
        title={asset.originalName}
      >
        {asset.originalName}
      </a>
      <span className="shrink-0 text-[10px] text-muted-foreground">{formatSize(asset.size)}</span>
      <button
        type="button"
        onClick={onDelete}
        className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-rose-50 hover:text-rose-700"
        aria-label={`Remover ${asset.originalName}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
