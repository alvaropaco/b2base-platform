/**
 * CampaignMaterialsView — aba Materiais do detalhe da campanha (Story 2.4,
 * FR7/PS1/D7 da onda "criação sem bloqueios"): lista materiais POR campanha
 * (via `StudioMaterial.campaignId`) e anexos prontos; materiais da org
 * (sem campanha) aparecem rotulados à parte. Falha de extração NUNCA some:
 * motivo + caminho (trocar arquivo ou confirmar mesmo assim). Escopo de org
 * resolvido no endpoint (`GET /campaigns/:id/materials`).
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, FileText, Image as ImageIcon } from 'lucide-react';
import { fetchCampaignMaterials, StudioRequestError, type CampaignMaterials } from '../api';
import { AttachmentChip, isImageAttachment } from '../components/AttachmentChip';

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Extração pendente', cls: 'bg-amber-100 text-amber-800' },
  extracted: { label: 'Extraído', cls: 'bg-emerald-100 text-emerald-800' },
  failed: { label: 'Falha na extração', cls: 'bg-rose-100 text-rose-800' },
  needs_manual: { label: 'Precisa de descrição manual', cls: 'bg-amber-100 text-amber-800' },
};

function MaterialRow({
  material,
  scopeLabel,
}: {
  material: CampaignMaterials['campaignMaterials'][number];
  scopeLabel?: string;
}) {
  const status = STATUS_LABEL[material.extractionStatus] || { label: material.extractionStatus, cls: 'bg-[#160211]/5 text-muted-foreground' };
  const failed = material.extractionStatus === 'failed' || material.extractionStatus === 'needs_manual';
  return (
    <li className="rounded-xl border border-[#160211]/10 bg-white/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <FileText aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {material.sourceRef || material.kind}
        </span>
        {scopeLabel && (
          <span className="rounded-full bg-[#160211]/5 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {scopeLabel}
          </span>
        )}
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${status.cls}`}>{status.label}</span>
        {material.confirmedAt && (
          <span className="text-[10px] text-muted-foreground">
            entrou em {new Date(material.createdAt).toLocaleDateString('pt-BR')}
          </span>
        )}
      </div>
      {failed && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-rose-800">
          <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {material.extractionError || 'Extração não concluída.'} — troque o arquivo ou me peça para confirmar mesmo
            assim; o material nunca some da campanha.
          </span>
        </p>
      )}
    </li>
  );
}

export function CampaignMaterialsView({ campaignId }: { campaignId: string }) {
  const [data, setData] = useState<CampaignMaterials | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchCampaignMaterials(campaignId)
      .then(setData)
      .catch((err) => setError(err instanceof StudioRequestError ? err.message : 'Falha ao carregar materiais'));
  }, [campaignId]);

  useEffect(load, [load]);

  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Carregando materiais…</p>;

  const empty =
    data.campaignMaterials.length === 0 && data.attachments.length === 0 && data.orgMaterials.length === 0;

  return (
    <div className="space-y-4">
      {empty && (
        <p className="text-sm text-muted-foreground">
          Nada anexado ainda — materiais e anexos criados na campanha aparecem aqui.
        </p>
      )}

      {data.attachments.length > 0 && (
        <section aria-label="Anexos que saem na mensagem">
          <h3 className="mb-2 text-sm font-semibold">Anexos que saem na mensagem</h3>
          <ul className="flex flex-wrap gap-2">
            {data.attachments.map((a) => (
              <li key={a.id}>
                <span className="inline-flex items-center gap-1.5">
                  {isImageAttachment(a) ? (
                    <ImageIcon aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <FileText aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <AttachmentChip attachment={a} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Materiais da campanha">
        <h3 className="mb-2 text-sm font-semibold">Materiais desta campanha</h3>
        {data.campaignMaterials.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum material criado nesta campanha ainda.</p>
        ) : (
          <ul className="space-y-2">
            {data.campaignMaterials.map((m) => (
              <MaterialRow key={m.id} material={m} />
            ))}
          </ul>
        )}
      </section>

      {data.orgMaterials.length > 0 && (
        <section aria-label="Materiais da organização (sem campanha)">
          <h3 className="mb-2 text-sm font-semibold">Da organização (fora desta campanha)</h3>
          <ul className="space-y-2">
            {data.orgMaterials.map((m) => (
              <MaterialRow key={m.id} material={m} scopeLabel="org" />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
