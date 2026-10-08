import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

/**
 * LowBalancePopup — aviso "saldo acabando" (2026-10-08, pedido do dono).
 *
 * Aparece sobre o Cockpit quando a carteira única marca `lowBalance`
 * (saldo ≤ 25% do teto, calculado no servidor). Dentro: a mensagem do
 * estado + os packs Stripe para COMPRAR DIRETO daqui (credita o pool único
 * e-mail + WhatsApp). "Depois" dispensa por hoje (sessionStorage) — volta
 * na próxima visita enquanto continuar baixo.
 */
export interface LowBalancePopupProps {
  balance: number;
  available: number;
  threshold: number;
  packs: { units: number; totalCents: number }[] | null;
  busyUnits: string | null;
  onBuy: (units: number) => void;
  onClose: () => void;
}

export function LowBalancePopup({ balance, available, threshold, packs, busyUnits, onBuy, onClose }: LowBalancePopupProps) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Saldo acabando">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="cockpit-glass-strong relative w-full max-w-md rounded-2xl border border-[#160211]/15 p-5 shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar aviso"
          className="absolute right-3 top-3 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-white/60 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-sm font-black text-foreground">Seu saldo está acabando</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Restam <strong className="text-foreground">{balance}</strong> envio(s) no pool único (limite do aviso:{' '}
              {threshold}). Comprar mais agora evita que suas campanhas de e-mail e WhatsApp parem no meio — os dois
              canais consomem o MESMO saldo.
            </p>
          </div>
        </div>

        <div className="mt-4">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Comprar envios agora (Stripe — credita o pool único)
          </p>
          {packs && packs.length > 0 ? (
            <div className="flex gap-2">
              {packs.map((pack) => {
                const preco = (pack.totalCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
                const busy = busyUnits === String(pack.units);
                return (
                  <button
                    key={pack.units}
                    type="button"
                    disabled={busy}
                    onClick={() => onBuy(pack.units)}
                    className="flex-1 rounded-xl bg-[#160211] px-3 py-2.5 text-center text-xs font-bold text-white shadow-lg transition-transform hover:scale-[1.02] disabled:opacity-60"
                  >
                    +{pack.units} envios
                    <span className="block text-[10px] font-medium opacity-80">{busy ? 'abrindo…' : preco}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              A compra por aqui está indisponível nesta instalação (Stripe não configurado) — fale com o suporte.
            </p>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            Disponível agora no pool: {available} envio(s). A reposição diária também complementa o saldo.
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-xl border border-[#160211]/15 bg-white/70 px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-white"
        >
          Depois
        </button>
      </div>
    </div>
  );
}
