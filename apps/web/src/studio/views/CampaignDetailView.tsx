/**
 * CampaignDetailView — detalhe da campanha (T013; tabs ganham vida por story:
 * Conteúdo/revisão na US1, Audiência US2, Agenda US3, Automação US8,
 * Analytics US11).
 */
import { useEffect, useState } from 'react';
import { fetchCampaign, StudioRequestError } from '../api';
import type { StudioCampaignDetail } from '../types';
import { displayStatusLabel } from './CampaignsListView';
import { CampaignReview } from '../components/CampaignReview';
import { AudienceReview } from '../components/AudienceReview';
import { ScheduleView } from './ScheduleView';
import { CampaignMaterialsView } from './CampaignMaterialsView';
import { AiCreateWizard } from '../components/AiCreateWizard';
import { EmailEditor } from '../components/EmailEditor';
import { WhatsAppPreview, RepliesReview } from '../components/WhatsAppPreview';
import { PersonalizationPanel } from '../components/PersonalizationPanel';
import { JourneyCanvas } from '../components/JourneyCanvas';
import { AnalyticsView } from './AnalyticsView';
import { CampaignChat } from '../components/CampaignChat';
import { ExperimentPanel } from '../components/ExperimentPanel';

const TABS = ['Configurar', 'Avançado', 'Audiência', 'Materiais', 'Agenda', 'Automação', 'Analytics'] as const;
type Tab = (typeof TABS)[number];

export function CampaignDetailView({ campaignId }: { campaignId: string }) {
  const [campaign, setCampaign] = useState<StudioCampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('Configurar');

  useEffect(() => {
    let alive = true;
    fetchCampaign(campaignId)
      .then((c) => {
        if (alive) setCampaign(c);
      })
      .catch((err) => {
        if (alive) {
          setError(err instanceof StudioRequestError ? err.message : 'Falha ao carregar campanha');
        }
      });
    return () => {
      alive = false;
    };
  }, [campaignId]);

  if (error) {
    return <p role="alert" className="text-sm text-destructive">{error}</p>;
  }
  if (!campaign) {
    return <p className="text-sm text-muted-foreground">Carregando campanha…</p>;
  }

  return (
    <section aria-label={campaign.name}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{campaign.name}</h2>
          <p className="text-xs text-muted-foreground">
            {displayStatusLabel(campaign)}
            {(campaign.status === 'approved' || campaign.status === 'scheduled') && campaign.statusReason === 'NO_CHANNEL_CONNECTED'
              ? ' · conecte um canal de envio para disparar — a campanha está pronta'
              : campaign.statusReason
                ? ` · ${campaign.statusReason}`
                : ''}
          </p>
        </div>
      </div>

      <div role="tablist" aria-label="Seções da campanha" className="mb-4 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm transition-colors ${
              tab === t
                ? 'border-b-2 border-primary font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Configurar' && campaign && (
        <CampaignChat campaignId={campaign.id} onStateChange={() => void fetchCampaign(campaign.id).then(setCampaign).catch(() => {})} />
      )}
      {tab === 'Avançado' && campaign && (
        <div className="space-y-6">
          <details className="rounded-lg border border-border p-4">
            <summary className="cursor-pointer text-sm font-semibold">
              Criar com IA — material, URL ou prompt (cai em revisão)
            </summary>
            <div className="mt-3">
              <AiCreateWizard campaign={campaign} onCampaignChange={setCampaign} />
            </div>
          </details>
          <CampaignReview campaign={campaign} onCampaignChange={setCampaign} />
          <details className="rounded-lg border border-border p-4">
            <summary className="cursor-pointer text-sm font-semibold">Editor de e-mail (drag-and-drop)</summary>
            <div className="mt-3">
              <EmailEditor campaign={campaign} />
            </div>
          </details>
          <details className="rounded-lg border border-border p-4">
            <summary className="cursor-pointer text-sm font-semibold">
              Personalização com IA por lead (dados do B2Base)
            </summary>
            <div className="mt-3">
              <PersonalizationPanel campaignId={campaign.id} />
            </div>
          </details>
        </div>
      )}
      {tab === 'Audiência' && <AudienceReview campaign={campaign} />}
      {tab === 'Materiais' && <CampaignMaterialsView campaignId={campaign.id} />}
      {tab === 'Agenda' && campaign && (
        <div className="space-y-6">
          <ScheduleView campaign={campaign} onCampaignChange={setCampaign} />
          <ExperimentPanel campaignId={campaign.id} />
        </div>
      )}
      {tab === 'Automação' && campaign && (
        <JourneyCanvas campaignId={campaign.id} campaignStatus={campaign.status} />
      )}
      {tab === 'Analytics' && campaign && <AnalyticsView campaignId={campaign.id} />}
      <RepliesReview />
    </section>
  );
}
