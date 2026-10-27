/**
 * PhotoSendCard — envio de FOTOS como anexos reais pela conta Gmail
 * conectada do usuário (2026-10-27). Integrado ao Settings (onde o Gmail
 * já é conectado/desconectado), mesmo design do painel.
 *
 * Validações de UX aqui são só conveniência — o SERVIDOR revalida tudo
 * (tipo real, tamanho, quantidade, destinatário) antes de enviar.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ImageIcon, Loader2, Send, X } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { sendPhotosByEmail, type SendPhotosResult } from '@/services/api';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ACCEPTED_EXTS = ['jpg', 'jpeg', 'png', 'webp'];
const MAX_FILES = 10;
const MAX_FILE_MB = 10;
const MAX_TOTAL_MB = 18; // margem sob o limite de 25 MB do Gmail (base64 soma ~37%)

interface PhotoItem {
  id: string;
  file: File;
  previewUrl: string;
}

export function PhotoSendCard({
  gmailConnected,
  onConnectGmail,
  connecting,
}: {
  gmailConnected: boolean;
  onConnectGmail: () => void;
  connecting: boolean;
}) {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('Fotos');
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SendPhotosResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Revoga os object URLs ao desmontar (sem vazamento de memória).
  useEffect(() => {
    return () => {
      photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalMb = useMemo(
    () => photos.reduce((sum, p) => sum + p.file.size, 0) / (1024 * 1024),
    [photos]
  );

  const addPhotos = (fileList: FileList | null) => {
    if (!fileList) return;
    setError(null);
    const next: PhotoItem[] = [];
    const problems: string[] = [];
    for (const file of Array.from(fileList)) {
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      if (!ACCEPTED_TYPES.includes(file.type) || !ACCEPTED_EXTS.includes(ext)) {
        problems.push(`"${file.name}" não é JPG, PNG ou WEBP.`);
        continue;
      }
      if (file.size > MAX_FILE_MB * 1024 * 1024) {
        problems.push(`"${file.name}" passa de ${MAX_FILE_MB} MB.`);
        continue;
      }
      if (photos.length + next.length >= MAX_FILES) {
        problems.push(`Máximo de ${MAX_FILES} fotos por envio.`);
        break;
      }
      next.push({ id: `${file.name}-${file.size}-${Date.now()}-${next.length}`, file, previewUrl: URL.createObjectURL(file) });
    }
    if (problems.length) setError(problems.join(' '));
    if (next.length) setPhotos((prev) => [...prev, ...next]);
    if (inputRef.current) inputRef.current.value = '';
  };

  const removePhoto = (id: string) => {
    setPhotos((prev) => {
      const item = prev.find((p) => p.id === id);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  };

  const canSend = gmailConnected && photos.length > 0 && /\S+@\S+\.\S+/.test(to) && progress === null;

  const handleSend = async () => {
    setError(null);
    setResult(null);
    setProgress(0);
    try {
      const res = await sendPhotosByEmail(
        photos.map((p) => p.file),
        to.trim(),
        subject.trim(),
        message.trim(),
        (percent) => setProgress(percent)
      );
      setResult(res);
      photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      setPhotos([]);
      setMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao enviar as fotos');
    } finally {
      setProgress(null);
    }
  };

  return (
    <Card className="border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-slate-950/70">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-emerald-500/10 p-2 text-emerald-500">
            <ImageIcon className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base font-bold">Enviar fotos por Gmail</CardTitle>
            <CardDescription>Fotos anexadas de verdade na mensagem (JPG, PNG, WEBP · até {MAX_FILES} fotos · {MAX_FILE_MB} MB cada)</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!gmailConnected ? (
          <div className="flex flex-col items-start gap-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-600 dark:bg-white/[0.03] dark:text-slate-300 sm:flex-row sm:items-center sm:justify-between">
            <p>Conecte sua conta Google para enviar fotos pelo Gmail.</p>
            <Button variant="gradient" size="sm" onClick={onConnectGmail} disabled={connecting} className="gap-2">
              {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
              Conectar com Google
            </Button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Input
                type="email"
                placeholder="Destinatário (pessoa@empresa.com)"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
              <Input placeholder="Assunto" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <textarea
              placeholder="Mensagem (opcional)"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground"
            />

            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={inputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="hidden"
                onChange={(e) => addPhotos(e.target.files)}
              />
              <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
                Selecionar fotos
              </Button>
              <span className="text-xs text-muted-foreground">
                {photos.length}/{MAX_FILES} fotos · {totalMb.toFixed(1)} MB de {MAX_TOTAL_MB} MB
              </span>
            </div>

            {photos.length > 0 && (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                {photos.map((p) => (
                  <div key={p.id} className="group relative overflow-hidden rounded-lg border border-slate-200 dark:border-white/10">
                    <img src={p.previewUrl} alt={p.file.name} className="h-20 w-full object-cover" />
                    <button
                      type="button"
                      onClick={() => removePhoto(p.id)}
                      className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white transition-colors hover:bg-black/80"
                      aria-label={`Remover ${p.file.name}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                    <p className="truncate px-1 py-0.5 text-[10px] text-muted-foreground">{p.file.name}</p>
                  </div>
                ))}
              </div>
            )}

            {progress !== null && (
              <div className="space-y-1">
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-white/10">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all"
                    style={{ width: `${Math.max(8, progress)}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">Enviando… {progress}%</p>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{error}</p>
              </div>
            )}

            {result && (
              <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Enviado de <strong>{result.from}</strong> para <strong>{result.to}</strong> — {result.count} foto(s) anexada(s).
                  {result.messageId ? ` Confirmação: ${result.messageId}` : ''}
                </p>
              </div>
            )}

            <Button variant="gradient" onClick={() => void handleSend()} disabled={!canSend} className="gap-2">
              {progress !== null ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {progress !== null ? 'Enviando…' : 'Enviar fotos'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
