/**
 * BrandSettings — Brand Voice + Brand Kit da organização (US12, T120) e
 * painel de parecer de compliance embutido no fluxo de revisão.
 */
import { useCallback, useEffect, useState } from 'react';
import { StudioRequestError } from '../api';

interface BrandProfile {
  voice?: { toneNotes?: string; doExamples?: string[]; dontExamples?: string[] };
  kit?: { logoUrl?: string; colors?: Record<string, string>; fonts?: string };
}

async function brandApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/studio${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json();
  if (!res.ok) throw new StudioRequestError(payload.error || 'ERROR', res.status, payload.message);
  return payload.data as T;
}

export function BrandSettings() {
  const [profile, setProfile] = useState<BrandProfile>({ voice: {}, kit: {} });
  const [toneNotes, setToneNotes] = useState('');
  const [samples, setSamples] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#4f46e5');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await brandApi<BrandProfile>('GET', '/brand');
      setProfile(data);
      setToneNotes(data.voice?.toneNotes || '');
      setLogoUrl(data.kit?.logoUrl || '');
      setPrimaryColor(data.kit?.colors?.primary || '#4f46e5');
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
      await brandApi('PUT', '/brand', {
        voice: { ...(profile.voice || {}), toneNotes },
        kit: { ...(profile.kit || {}), logoUrl, colors: { primary: primaryColor } },
      });
      setNotice('Marca salva.');
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
      await brandApi('POST', '/brand/learn', {
        samples: samples.split('\n').map((s) => s.trim()).filter(Boolean),
      });
      await load();
      setNotice('Brand Voice atualizada a partir dos exemplos.');
    } catch (err) {
      setError(err instanceof StudioRequestError ? err.message : 'Falha ao aprender voz');
    } finally {
      setBusy(null);
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
      <div className="cockpit-glass space-y-2 rounded-2xl p-4">
        <h3 className="text-sm font-semibold">Brand Voice</h3>
        <textarea
          value={toneNotes}
          onChange={(e) => setToneNotes(e.target.value)}
          rows={2}
          placeholder="Como a empresa fala (ex.: direto, técnico, sem girias)"
          className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-violet-400/50 focus-visible:ring-1 focus-visible:ring-violet-400/40"
        />
        <textarea
          value={samples}
          onChange={(e) => setSamples(e.target.value)}
          rows={3}
          placeholder={'Exemplos de textos da marca (um por linha) para a IA aprender o tom…'}
          className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-violet-400/50 focus-visible:ring-1 focus-visible:ring-violet-400/40"
        />
        <button
          type="button"
          onClick={handleLearn}
          disabled={busy !== null}
          className="h-9 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-xs font-medium text-foreground transition-colors hover:bg-white/10 disabled:opacity-40"
        >
          {busy === 'learn' ? 'Aprendendo…' : 'Aprender voz dos exemplos (premium)'}
        </button>
      </div>
      <div className="cockpit-glass space-y-2 rounded-2xl p-4">
        <h3 className="text-sm font-semibold">Brand Kit</h3>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="URL do logo"
            className="h-9 min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-violet-400/50 focus-visible:ring-1 focus-visible:ring-violet-400/40"
          />
          <input
            type="color"
            value={primaryColor}
            onChange={(e) => setPrimaryColor(e.target.value)}
            aria-label="Cor primária"
            className="h-9 w-14 cursor-pointer rounded-xl border border-white/10 bg-transparent"
          />
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={busy !== null}
          className="h-9 rounded-xl bg-gradient-to-r from-violet-500 to-violet-700 px-3 text-xs font-medium text-white shadow-lg shadow-violet-900/40 transition-transform hover:brightness-110 disabled:opacity-40"
        >
          {busy === 'save' ? 'Salvando…' : 'Salvar marca'}
        </button>
      </div>
    </div>
  );
}
