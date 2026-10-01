'use strict';

/**
 * studio/journey.js — estado explícito da jornada de criação de campanha
 * (Epic 3, Story 3.1 da spec-studio-campaign-reliability).
 *
 * A jornada canônica é objetivo → audiência → conteúdo → agenda → certificado.
 * Duas responsabilidades:
 *
 *  1. PERSISTIR a fase corrente + fases concluídas (`StudioCampaign.journey`)
 *     como explicitação da derivação que já existia no cliente
 *     (`currentRailStep` no StudioApp) — o Json nunca é fonte única de
 *     verdade: a derivação usa sempre o estado materializado (objetivo,
 *     audiência decidida, conteúdos, schedule).
 *  2. GUARDAR atalho: ação de uma fase À FRENTE com pré-requisito ausente é
 *     recusada com explicação do que falta (card `journey_block`) — o caso
 *     canônico é agendar sem conteúdo. Ações da fase corrente/anteriores
 *     NUNCA bloqueiam (revisão livre — onda "criação sem bloqueios").
 */

const PHASES = ['objetivo', 'audiencia', 'conteudo', 'agenda', 'certificado'];

const PHASE_LABELS = {
  objetivo: 'objetivo',
  audiencia: 'audiência',
  conteudo: 'conteúdo',
  agenda: 'agenda',
  certificado: 'certificado',
};

function phaseIndex(phase) {
  const i = PHASES.indexOf(phase);
  return i === -1 ? 0 : i;
}

/** Schedule configurado de verdade (hourlyLimit/startAt), não `{}` default. */
function hasScheduleSet(schedule) {
  return Boolean(schedule && typeof schedule === 'object' && (schedule.hourlyLimit || schedule.startAt));
}

/**
 * Fase corrente a partir do estado materializado — espelho server-side da
 * derivação do cliente. Audiência conta como decidida pela DECISÃO FECHADA
 * (FR2: materialização com contagem > 0) — audiência>0 é a jornada canônica
 * da spec (Story 3.4).
 */
function derivePhase({ objective, audienceDecided, hasContent, hasSchedule }) {
  if (!objective) return 'objetivo';
  if (!audienceDecided) return 'audiencia';
  if (!hasContent) return 'conteudo';
  if (!hasSchedule) return 'agenda';
  return 'certificado';
}

function normalizeMarks(mark) {
  return (Array.isArray(mark) ? mark : [mark]).filter(Boolean).filter((m) => PHASES.includes(m));
}

/**
 * Persiste a jornada: fase derivada do estado + conclusões explícitas
 * (`completed[fase] = ISO`). `mark` conclui fase(s) no ato (ex.: decisão
 * fechada FR2 → 'audiencia'; status scheduled → 'certificado'). Conteúdo
 * existente fora do chat também vira conclusão (a derivação consulta a base).
 */
async function syncJourney(prisma, campaign, { mark, audienceDecided } = {}) {
  const prev = campaign.journey && typeof campaign.journey === 'object' ? campaign.journey : {};
  const completed = { ...(prev.completed || {}) };
  for (const m of normalizeMarks(mark)) {
    if (!completed[m]) completed[m] = new Date().toISOString();
  }
  try {
    let decided = audienceDecided;
    if (decided === undefined) decided = Boolean(completed.audiencia);
    let hasContent = Boolean(completed.conteudo);
    if (!hasContent) {
      hasContent = (await prisma.studioContent.count({ where: { campaignId: campaign.id } })) > 0;
    }
    if (hasContent && !completed.conteudo) completed.conteudo = new Date().toISOString();
    const phase = derivePhase({
      objective: campaign.objective,
      audienceDecided: decided,
      hasContent,
      hasSchedule: hasScheduleSet(campaign.schedule),
    });
    const journey = { phase, completed, updatedAt: new Date().toISOString() };
    if (JSON.stringify(journey) !== JSON.stringify(prev)) {
      await prisma.studioCampaign.update({ where: { id: campaign.id }, data: { journey } });
      campaign.journey = journey;
    }
    return journey;
  } catch (err) {
    // Review E3-M3: o efeito da action JÁ aconteceu quando a jornada roda —
    // falha de persistência aqui não pode reclassificar a run como failed
    // (retry duplicaria conteúdo/audiência). O Json nunca é fonte única de
    // verdade: loga com stack e segue.
    console.error('[studio:journey] persistência da jornada falhou (efeito preservado):', err.stack || String(err));
    return { ...(prev || {}), completed, stale: true };
  }
}

/**
 * Estado que o guard precisa — consulta REAL (não o Json): conteúdo existe?
 * Uma query, chamada só quando há action candidata a atalho.
 */
async function guardState(prisma, campaign) {
  const contentCount = await prisma.studioContent.count({ where: { campaignId: campaign.id } });
  return { hasContent: contentCount > 0 };
}

/**
 * Guard de atalho (Story 3.1): só salto À FRENTE com pré-requisito ausente
 * bloqueia. Recusa é card mordomo (o que falta + próximo passo), sem jargão
 * e sem nome de action exposto ao usuário.
 */
function guardAction(type, state = {}) {
  if (type === 'set_schedule' && !state.hasContent) {
    return {
      ok: false,
      card: {
        type: 'journey_block',
        label: 'Ainda não dá para agendar',
        detail:
          'A campanha precisa de uma mensagem antes do agendamento. Posso gerar agora a partir do seu objetivo' +
          ' — ou cole o material (URL/PDF) que eu uso como base. Depois agendamos.',
        missing: ['conteudo'],
        nextAction: 'generate_content',
      },
    };
  }
  return { ok: true };
}

/**
 * Bloco jornada para o prompt do orchestrate (pureza: usa o que o turno já
 * carrega em extras, sem query extra). O modelo avança a fase pendente e
 * evita emitir atalho; o guard é a rede server-side.
 */
function previewFromExtras(campaign, extras = {}) {
  const completed = (campaign.journey && campaign.journey.completed) || {};
  const hasContent =
    Boolean(completed.conteudo) || (Array.isArray(extras.contentSummary) && extras.contentSummary.length > 0);
  // Mesma regra do syncJourney (review E3-L7): audiência decidida = DECISÃO
  // FECHADA (FR2, materialização com contagem > 0) — nunca duas regras.
  const decided = Boolean(completed.audiencia);
  const phase = derivePhase({
    objective: campaign.objective,
    audienceDecided: decided,
    hasContent,
    hasSchedule: hasScheduleSet(campaign.schedule),
  });
  return { fase: phase, faseLabel: PHASE_LABELS[phase], concluidas: Object.keys(completed) };
}

module.exports = {
  PHASES,
  PHASE_LABELS,
  phaseIndex,
  derivePhase,
  hasScheduleSet,
  syncJourney,
  guardState,
  guardAction,
  previewFromExtras,
};
