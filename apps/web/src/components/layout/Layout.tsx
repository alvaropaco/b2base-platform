import React from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { ActiveTab } from '@/types';
import { cn } from '@/lib/utils';
import type { CrmBadgeState } from '@/lib/crmBadge';

interface LayoutProps {
  children: React.ReactNode;
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  isDark: boolean;
  setIsDark: (dark: boolean) => void;
  totalProspectsCount: number;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  onOpenCreateModal: () => void;
  onOpenQualifyModal: () => void;
  userName: string;
  userEmail: string;
  onLogout: () => void;
  /** Workspace configurado no onboarding conversacional (FR-016). */
  companyName?: string;
  /** E-mail do workspace (FR-016) — cai no userEmail quando ausente. */
  workspaceEmail?: string;
  /** CRM declarado na conversa — badge verde no rodapé da sidebar (FR-017). */
  crmBadge?: CrmBadgeState;
}

export const Layout: React.FC<LayoutProps> = ({
  children,
  activeTab,
  setActiveTab,
  isDark,
  setIsDark,
  totalProspectsCount,
  searchQuery,
  setSearchQuery,
  onOpenCreateModal,
  onOpenQualifyModal,
  userName,
  userEmail,
  onLogout,
  companyName,
  workspaceEmail,
  crmBadge,
}) => {
  const mobileNavItems: Array<{ id: ActiveTab; label: string; badge?: string | null }> = [
    { id: 'dashboard', label: 'Visão comercial' },
    { id: 'prospects', label: 'Descobrir leads', badge: totalProspectsCount > 0 ? `${totalProspectsCount}` : null },
    { id: 'pipeline', label: 'Pipeline de vendas', badge: 'Ao vivo' },
    { id: 'risk', label: 'Risco e potencial' },
    { id: 'enrichment', label: 'Inteligência comercial' },
    // Studio (Cockpit): página própria — o clique redireciona para /studio.
    { id: 'studio' as ActiveTab, label: 'Studio' },
    { id: 'whatsapp', label: 'WhatsApp' },
    { id: 'history', label: 'Histórico' },
  ];

  return (
    <div className={`min-h-screen flex bg-slate-50 text-slate-900 ${isDark ? 'dark bg-slate-950 text-foreground' : ''}`}>
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        isDark={isDark}
        setIsDark={setIsDark}
        totalProspectsCount={totalProspectsCount}
        companyName={companyName}
        userEmail={workspaceEmail || userEmail}
        crmBadge={crmBadge}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <Header
          activeTab={activeTab}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          onOpenCreateModal={onOpenCreateModal}
          onOpenQualifyModal={onOpenQualifyModal}
          userName={userName}
          userEmail={userEmail}
          onLogout={onLogout}
        />
        <nav id="mobile-dashboard-navigation" aria-label="Navegação principal mobile" className="border-b border-slate-200 bg-white/95 px-3 py-2 dark:border-white/10 dark:bg-slate-950/95 lg:hidden">
          <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {mobileNavItems.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => {
                    // Studio = página própria (mesma regra do Sidebar).
                    if (item.id === 'studio') {
                      window.location.assign('/studio');
                      return;
                    }
                    setActiveTab(item.id);
                  }}
                  className={cn(
                    'flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-xs font-black transition',
                    isActive
                      ? 'border-slate-950 bg-slate-950 text-white shadow-sm dark:border-white dark:bg-white dark:text-slate-950'
                      : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-indigo-200 hover:bg-indigo-50 hover:text-slate-950 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-300 dark:hover:bg-white/[0.06] dark:hover:text-white'
                  )}
                >
                  <span>{item.label}</span>
                  {item.badge && (
                    <span className={cn(
                      'rounded-full px-1.5 py-0.5 text-[10px]',
                      isActive ? 'bg-white/15 text-current dark:bg-slate-950/10' : 'bg-white text-slate-500 dark:bg-white/10 dark:text-slate-300'
                    )}>
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </nav>
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 xl:p-8">
          {children}
        </main>
      </div>
    </div>
  );
};
