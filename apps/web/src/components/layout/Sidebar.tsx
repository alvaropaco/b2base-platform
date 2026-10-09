import React from 'react';
import {
  Building2,
  ChevronDown,
  CreditCard,
  History,
  Kanban,
  LayoutDashboard,
  Link2,
  MessageCircle,
  Moon,
  Network,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
} from 'lucide-react';
import { ActiveTab } from '@/types';
import { cn } from '@/lib/utils';
import type { CrmBadgeState } from '@/lib/crmBadge';

interface SidebarProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  isDark: boolean;
  setIsDark: (dark: boolean) => void;
  totalProspectsCount: number;
  /** Workspace configurado no onboarding conversacional (FR-016). */
  companyName?: string;
  userEmail?: string;
  /** CRM declarado na conversa — badge verde quando conectado (FR-017). */
  crmBadge?: CrmBadgeState;
}

/** Iniciais do workspace (até 2 letras) para o avatar da organização. */
function orgInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'B2';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  isDark,
  setIsDark,
  totalProspectsCount,
  companyName,
  userEmail,
  crmBadge,
}) => {
  const navItems = [
    { id: 'dashboard' as ActiveTab, label: 'Visão comercial', icon: LayoutDashboard, badge: null },
    { id: 'prospects' as ActiveTab, label: 'Descobrir leads', icon: Building2, badge: totalProspectsCount > 0 ? `${totalProspectsCount}` : null },
    { id: 'pipeline' as ActiveTab, label: 'Pipeline de vendas', icon: Kanban, badge: 'Ao vivo' },
    { id: 'risk' as ActiveTab, label: 'Risco e potencial', icon: ShieldCheck, badge: null },
    { id: 'enrichment' as ActiveTab, label: 'Inteligência comercial', icon: Network, badge: null },
    // Studio (Cockpit): NÃO é tab — é página própria em /studio. O clique
    // redireciona (ver onClick no map); id fora do union de ActiveTab de
    // propósito, então o item nunca fica "ativo" no shell de tabs.
    { id: 'studio' as ActiveTab, label: 'Studio', icon: Sparkles, badge: null },
    { id: 'whatsapp' as ActiveTab, label: 'WhatsApp', icon: MessageCircle, badge: null },
    { id: 'history' as ActiveTab, label: 'Histórico de disparos', icon: History, badge: null },
  ];

  const appItems = [
    { label: 'Potencial de compra', icon: CreditCard },
  ];

  return (
    <aside className="sticky top-0 z-40 hidden h-screen w-72 shrink-0 border-r border-slate-200 bg-white/95 backdrop-blur-xl dark:border-white/10 dark:bg-slate-950/95 lg:flex lg:flex-col">
      <div className="flex h-16 items-center justify-between border-b border-slate-200 px-5 dark:border-white/10">
        <div className="flex items-center gap-3">
          <img
            src="/logo-symbol.png"
            alt="B2Base"
            className="h-10 w-10 object-contain"
          />
          <div>
            <h1 className="text-base font-black tracking-tight text-slate-950 dark:text-white">B2Base</h1>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">Inteligência comercial</p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* Workspace: nome da empresa + e-mail configurados no onboarding (FR-016) */}
        <button className="mb-5 flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 p-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50/50 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-indigo-500/10">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-sky-500 text-xs font-black text-white">
              {orgInitials(companyName || '')}
            </div>
            <div className="min-w-0">
              <p className="truncate text-xs font-black text-slate-950 dark:text-white">
                {companyName || 'Organização'}
              </p>
              <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                {userEmail || 'Organização'}
              </p>
            </div>
          </div>
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
        </button>

        <div className="space-y-6">
          <div>
            <p className="mb-2 px-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">Vendas</p>
            <nav className="space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      // Studio = página própria: redireciona de verdade para
                      // /studio (App.tsx renderiza o Cockpit fora do shell).
                      if (item.id === 'studio') {
                        window.location.assign('/studio');
                        return;
                      }
                      setActiveTab(item.id);
                    }}
                    className={cn(
                      'group flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-sm font-bold transition-all',
                      isActive
                        ? 'bg-slate-950 text-white shadow-lg shadow-slate-900/15 dark:bg-white dark:text-slate-950'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-300 dark:hover:bg-white/5 dark:hover:text-white'
                    )}
                  >
                    <span className="flex items-center gap-3">
                      <Icon className={cn('h-4 w-4', isActive ? 'text-current' : 'text-slate-400 group-hover:text-indigo-500')} />
                      {item.label}
                    </span>
                    {item.badge && (
                      <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-black', isActive ? 'bg-white/15 text-current dark:bg-slate-950/10' : 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-300')}>
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          <div>
            <p className="mb-2 px-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">Apoio comercial</p>
            <div className="space-y-1">
              {appItems.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => {
                    // "Potencial de compra" abre a análise de risco (era botão morto).
                    if (item.label === 'Potencial de compra') {
                      setActiveTab('risk');
                    }
                  }}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-950 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-white"
                >
                  <item.icon className="h-4 w-4 text-slate-400" />
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3 border-t border-slate-200 p-4 dark:border-white/10">
        {/* CRM declarado na conversa com a Ava — badge verde quando conectado (FR-017) */}
        {crmBadge?.connected ? (
          <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-500/20 dark:bg-emerald-500/10">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <span className="truncate text-xs font-bold text-emerald-700 dark:text-emerald-300">
              {crmBadge.label} conectado
            </span>
            <Link2 className="ml-auto h-3.5 w-3.5 shrink-0 text-emerald-500" />
          </div>
        ) : (
          <button
            onClick={() => setActiveTab('settings')}
            className="flex w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-indigo-200 hover:bg-indigo-50/50 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-indigo-500/10"
          >
            <Link2 className="h-3.5 w-3.5 text-slate-400" />
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
              Configurar CRM depois
            </span>
          </button>
        )}

        <div className="rounded-2xl border border-indigo-100 bg-indigo-50 p-4 dark:border-indigo-500/20 dark:bg-indigo-500/10">
          <div className="flex items-center gap-2 text-indigo-700 dark:text-indigo-300">
            <Sparkles className="h-4 w-4" />
            <span className="text-xs font-black uppercase tracking-[0.14em]">Recomendação de oportunidades</span>
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-600 dark:text-slate-300">Leads sugeridos, sinais de compra e próximos passos para o time comercial.</p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsDark(!isDark)}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-200 dark:hover:bg-white/[0.06]"
          >
            {isDark ? <Moon className="h-4 w-4 text-indigo-300" /> : <Sun className="h-4 w-4 text-amber-500" />}
            {isDark ? 'Escuro' : 'Claro'}
          </button>
          <button onClick={() => setActiveTab('settings')} className="rounded-xl border border-slate-200 bg-white p-2 text-slate-500 transition hover:bg-slate-50 hover:text-slate-950 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-300 dark:hover:bg-white/[0.06] dark:hover:text-white">
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
};
