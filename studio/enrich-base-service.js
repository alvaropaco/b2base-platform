'use strict';

/**
 * studio/enrich-base-service.js — motor do enriquecimento de base pelo chat.
 * Canais: WhatsApp (cnpjPhones) e E-MAIL corporativo (cnpjEmail) — o MESMO
 * executor company.digital_presence do motor distribuído (fonte + score;
 * número só entra quando 'confirmado'; e-mail precisa estar LITERAL na fonte).
 *
 * Base INTEIRA roda no processo do app via fila `studio:enrich`
 * (enrich-worker.js) — dentro da requisição HTTP o ingress corta (~60s).
 */

const CHUNK_SIZE = 5; // buscas em paralelo — lote de 40 roda em ~1-2 min

/**
 * Roda o pipeline para uma lista de leads (em memória), em chunks paralelos.
 * `channel`: 'whatsapp' | 'email' | 'both'. NUNCA lança: falha por lead vira
 * notFound/semNovo.
 */
async function enrichLeads(prisma, { channel = 'whatsapp', leads, chunkSize = CHUNK_SIZE, perLeadTimeoutMs = 30000, logger } = {}) {
  const digitalPresence = require('../workers/digital-presence');
  const { isCompanyDomain } = digitalPresence;
  const { usablePhone } = require('../whatsapp-utils');
  const quiet = { info() {}, warn() {}, error() {}, child() { return this; } };
  const log = logger || quiet;

  const querWhats = channel !== 'email';
  const querEmail = channel !== 'whatsapp';

  // Alvos por canal: WhatsApp = sem telefone utilizável (mesma regra do
  // disparo); e-mail = sem cnpjEmail.
  const semTelefone = (p) => !usablePhone(p.cnpjPhones);
  const semEmail = (p) => !p.cnpjEmail;
  const ehAlvo = (p) => (querWhats && semTelefone(p)) || (querEmail && semEmail(p));
  const semNumero = leads.filter(ehAlvo);
  const comNumero = leads.filter((p) => !ehAlvo(p));

  const found = [];
  const promoted = [];
  const emailsFound = [];
  const notFound = [];
  const semNovo = [];
  const naoConfirmado = [];
  let buscaMorta = 0;

  for (let i = 0; i < leads.length; i += chunkSize) {
    const chunk = leads.slice(i, i + chunkSize);
    const outcomes = await Promise.all(chunk.map(async (lead) => {
      const nome = String(lead.companyName || lead.tradeName || lead.id);
      try {
        const outcome = await digitalPresence.executors['company.digital_presence'](
          {
            input: {
              companyName: String(lead.companyName || lead.tradeName || ''),
              cnpj: lead.cnpj || undefined,
              tradeName: lead.tradeName || undefined,
              city: lead.city || undefined,
              state: lead.state || undefined,
              domain: lead.domain || null,
            },
            capability: 'company.digital_presence', timeoutMs: perLeadTimeoutMs,
          },
          {
            signal: AbortSignal.timeout(perLeadTimeoutMs + 2000),
            logger: log,
            // Gate Twilio no caminho do CHAT também (o worker company-deep já
            // injeta): wa.me fixo/voicemail/inválido não é promovido. Sem
            // Redis/credenciais o gate fail-open — nunca bloqueia a busca.
            deps: {
              twilioLookup: require('../twilio-lookup'),
              registry: (() => { try { return require('../enrichment-provider-registry').getWorkerRegistry(); } catch (_e) { return null; } })(),
            },
          }
        );
        return { lead, nome, outcome };
      } catch (err) {
        return { lead, nome, outcome: null };
      }
    }));
    for (const { lead, nome, outcome } of outcomes) {
      const dpInfo = (outcome && outcome.data && outcome.data.digital_presence) || {};
      const wa = querWhats ? (dpInfo.whatsapp || null) : null; // só status 'confirmado'
      const em = querEmail ? (dpInfo.corporate_email || null) : null; // literal na fonte
      const domain = (outcome && outcome.data && outcome.data.domain) || null;
      const status = dpInfo.status || 'nao_encontrado';
      const fonteUrl = Array.isArray(dpInfo.fontes) && dpInfo.fontes[0] ? dpInfo.fontes[0].url : null;

      // NÃO CONFIRMADO (score 40-69, WhatsApp): NÃO entra no cadastro — fila
      // de revisão manual (a IA mostra na conversa; o painel detalha).
      if (querWhats && (status === 'nao_confirmado' || (dpInfo.nao_confirmado && !wa))) {
        naoConfirmado.push({
          companyName: nome,
          whatsapp: (dpInfo.nao_confirmado && dpInfo.nao_confirmado.whatsapp) || null,
          score: (dpInfo.nao_confirmado && dpInfo.nao_confirmado.score) || null,
          motivo: (dpInfo.nao_confirmado && dpInfo.nao_confirmado.motivo) || null,
        });
        continue;
      }
      if (!wa && !em) {
        (ehAlvo(lead) ? notFound : semNovo).push(nome);
        if (dpInfo.search_unavailable) buscaMorta += 1;
        continue;
      }

      const updates = {};
      let salvouWhats = false;
      let anterior = null;
      if (wa) {
        const digits = String(wa).replace(/\D/g, '');
        const current = Array.isArray(lead.cnpjPhones) ? lead.cnpjPhones.filter(Boolean) : [];
        const frontDigits = current.length ? String(current[0]).replace(/\D/g, '') : null;
        if (frontDigits !== digits) {
          updates.cnpjPhones = [wa, ...current.filter((p) => String(p).replace(/\D/g, '') !== digits)];
          anterior = current[0] || null;
          salvouWhats = true;
        }
      }
      const emailEraVazio = !lead.cnpjEmail;
      if (em && emailEraVazio) {
        updates.cnpjEmail = em;
      }
      // Domínio só vira lead.domain quando é site DA EMPRESA — catálogo
      // digital (diggy.menu) e agregador (taplink/linktr) não são o site.
      if (domain && !lead.domain && isCompanyDomain(domain)) updates.domain = domain;

      if (Object.keys(updates).length > 0) {
        await prisma.prospect.update({ where: { id: lead.id }, data: updates });
      }
      if (wa && salvouWhats) {
        (anterior ? promoted : found).push({
          prospectId: lead.id, companyName: nome, whatsapp: wa, anterior,
          status, score: typeof dpInfo.score === 'number' ? dpInfo.score : null,
          fonteUrl: Array.isArray(dpInfo.fontes) && dpInfo.fontes[0] ? dpInfo.fontes[0].url : null,
        });
      } else if (wa) {
        found.push({ prospectId: lead.id, companyName: nome, whatsapp: wa });
      }
      if (em && updates.cnpjEmail) {
        emailsFound.push({
          prospectId: lead.id, companyName: nome, email: em,
          fonteUrl: dpInfo.corporate_email_fonte || fonteUrl || null,
        });
      }
    }
  }

  return { found, promoted, emailsFound, notFound, semNovo, naoConfirmado, buscaMorta, semNumero, comNumero };
}

/**
 * Monta o card `enrichment_done` por canal. `escopoTotal` = leads no raio da
 * campanha/org; `loteSize` = processados. `audienceRecovery` = quando a
 * varredura rodou na base PORQUE a audiência da campanha está vazia, o card
 * carrega o caminho de 1 clique para colocar a base na audiência (chip).
 */
function buildEnrichmentCard({ channel = 'whatsapp', found = [], promoted = [], emailsFound = [], notFound = [], semNovo = [], naoConfirmado = [], buscaMorta = 0, escopoTotal, semNumeroCount, comNumeroCount, loteSize, restantes, audienceRecovery = null }) {
  const querEmail = channel !== 'whatsapp';
  const querWhats = channel !== 'email';
  const cadastrados = [...found, ...promoted];
  const lines = [];
  // Escopo EXPLÍCITO no card: a busca foi SÓ sobre a base do usuário —
  // nenhum lead de outra organização entra aqui (isolamento por orgId).
  const alvoLabel = querWhats && querEmail ? 'sem telefone/e-mail' : (querEmail ? 'sem e-mail' : 'sem telefone');
  lines.unshift(`🔎 Escopo: procurei na SUA base — ${escopoTotal} lead(s) no raio desta campanha/org (${semNumeroCount || 0} ${alvoLabel}, ${comNumeroCount || 0} para atualizar), lote de ${loteSize}.`);

  if (querWhats && cadastrados.length) {
    lines.push(cadastrados.map((f) => {
      const trocou = f.anterior ? ` (substituiu ${f.anterior} na frente)` : '';
      const fonte = f.fonteUrl ? ` — fonte: ${f.fonteUrl}` : '';
      const score = typeof f.score === 'number' ? ` (score ${f.score})` : '';
      return `• **${f.companyName}** — ${f.whatsapp} ✓ WhatsApp CONFIRMADO${score}${trocou}${fonte}`;
    }).join('\n'));
  }
  if (querEmail && emailsFound.length) {
    lines.push(emailsFound.map((f) => {
      const fonte = f.fonteUrl ? ` — fonte: ${f.fonteUrl}` : '';
      return `• **${f.companyName}** — ${f.email} ✓ e-mail corporativo cadastrado${fonte}`;
    }).join('\n'));
  }
  if (naoConfirmado.length) {
    lines.push(`⚠️ ${naoConfirmado.length} lead(s) com número NÃO CONFIRMADO (score 40-69) — NÃO entraram no cadastro, precisam de revisão manual:`);
    lines.push(naoConfirmado.map((f) => `• **${f.companyName}** — ${f.whatsapp || '?'} (score ${f.score})${f.motivo ? ` — ${f.motivo}` : ''}`).join('\n'));
  }
  const alvoNome = querWhats && querEmail ? 'WhatsApp/e-mail' : (querEmail ? 'e-mail público' : 'WhatsApp público');
  if (notFound.length && buscaMorta >= notFound.length) {
    lines.push(`⚠️ A BUSCA NA INTERNET respondeu vazia para todos os ${notFound.length} lead(s) nesta rodada (${notFound.slice(0, 5).join(', ')}${notFound.length > 5 ? '…' : ''}). Isso é instabilidade dos motores de busca, não prova de que não existe contato — me peça para enriquecer de novo em alguns minutos.`);
  } else if (notFound.length) {
    lines.push(`⚠️ ${notFound.length} lead(s) SEM ${alvoNome} encontrado na internet (site, catálogo, redes): ${notFound.slice(0, 5).join(', ')}${notFound.length > 5 ? '…' : ''}`);
  }
  if (semNovo.length) {
    lines.push(`ℹ️ ${semNovo.length} lead(s) já tinham o dado no cadastro e não achei nada novo na internet — cadastro mantido: ${semNovo.slice(0, 5).join(', ')}${semNovo.length > 5 ? '…' : ''}`);
  }
  if (restantes > 0) {
    lines.push(`Ainda há ${restantes} lead(s) fora deste lote — me peça "continua o enriquecimento" para o próximo lote.`);
  }
  if (querEmail && emailsFound.length) {
    lines.push('Pode disparar por e-mail: quem tem e-mail no cadastro entra na fila na matrícula (canal e-mail).');
  } else if (querWhats && cadastrados.length) {
    lines.push('Pode disparar por WhatsApp: quem tem número no cadastro entra na fila na matrícula — e contato cancelado por no_phone volta sozinho no reforço de fila (o disparo re-lê o cadastro no envio). Lembrando: lead SEM consentimento WhatsApp registrado continua fora até você autorizar ("<nome> autorizou WhatsApp").');
  } else if (buscaMorta === 0) {
    const dado = querEmail ? 'e-mail' : 'número';
    lines.push(`Nada novo encontrado nesta rodada: sem ${dado} público na internet, o ${querEmail ? 'disparo por e-mail' : 'WhatsApp'} continua impossível para quem está sem — me peça para atualizar o cadastro manualmente ou capture leads novos.`);
  }
  const label = querWhats && !querEmail
    ? (cadastrados.length
      ? `Enriquecimento concluído — ${cadastrados.length} WhatsApp(s) CONFIRMADO(S) e cadastrado(s)`
      : 'Enriquecimento concluído — nenhum WhatsApp confirmado')
    : (querEmail && !querWhats
      ? (emailsFound.length
        ? `Enriquecimento concluído — ${emailsFound.length} e-mail(s) cadastrado(s)`
        : 'Enriquecimento concluído — nenhum e-mail novo encontrado')
      : (cadastrados.length || emailsFound.length
        ? `Enriquecimento concluído — ${cadastrados.length} WhatsApp(s) e ${emailsFound.length} e-mail(s) cadastrado(s)`
        : 'Enriquecimento concluído — nada novo encontrado'));
  const card = {
    type: 'enrichment_done',
    label,
    detail: lines.join('\n'),
    found: querWhats ? cadastrados.map((f) => f.companyName) : emailsFound.map((f) => f.companyName),
    promoted: promoted.map((f) => f.companyName),
    emails: emailsFound.map((f) => f.email),
    notFound,
    semNovo,
    restantes: restantes || 0,
  };
  // Chip de recuperação (audiência 0 → base na audiência com 1 clique):
  // mesma forma do card de captura — o frontend deriva o select_leads.
  if (audienceRecovery && Array.isArray(audienceRecovery.prospectIds) && audienceRecovery.prospectIds.length > 0) {
    card.suggestedFilter = {
      description: audienceRecovery.description || 'base da organização',
      prospectIds: audienceRecovery.prospectIds,
      matchedCount: audienceRecovery.matchedCount != null ? audienceRecovery.matchedCount : audienceRecovery.prospectIds.length,
    };
  }
  return card;
}

module.exports = { enrichLeads, buildEnrichmentCard, CHUNK_SIZE };
