'use strict';

/**
 * studio/enrich-base-service.js — motor do enriquecimento de base pelo chat
 * (multi-fonte: site, catálogo digital da loja, agregadores de link, snippets
 * — o MESMO executor company.digital_presence do motor distribuído).
 *
 * Extraído do handler síncrono do chat (2026-10-13): enriquecer a BASE
 * INTEIRA dentro da requisição HTTP estourava o timeout do ingress (~60s) e
 * o usuário via "Falha ao enviar mensagem" com o motor ainda trabalhando.
 * O chat agora enfileira (`studio:enrich`, ver enrich-worker.js) e ESTE
 * serviço roda no processo do app, escrevendo o resultado como mensagem da
 * conversa quando termina.
 */

const CHUNK_SIZE = 5; // buscas em paralelo — lote de 40 roda em ~1-2 min

/**
 * Roda o multi-fonte para uma lista de leads (em memória), em chunks
 * paralelos. NUNCA lança: falha por lead vira notFound/semNovo.
 */
async function enrichLeads(prisma, { leads, chunkSize = CHUNK_SIZE, perLeadTimeoutMs = 30000, logger } = {}) {
  const digitalPresence = require('../workers/digital-presence');
  const { isCompanyDomain } = digitalPresence;
  const { usablePhone } = require('../whatsapp-utils');
  const quiet = { info() {}, warn() {}, error() {}, child() { return this; } };
  const log = logger || quiet;

  // Mesma regra do disparo: 10-13 dígitos com DDI 55 quando presente — o
  // lixo estrangeiro (+91… do crawler antigo) conta como "sem telefone" e é
  // substituído pelo que a busca encontrar.
  const semTelefone = (p) => !usablePhone(p.cnpjPhones);
  const semNumero = leads.filter(semTelefone);
  const comNumero = leads.filter((p) => !semTelefone(p));

  const found = [];
  const promoted = [];
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
          { signal: AbortSignal.timeout(perLeadTimeoutMs + 2000), logger: log }
        );
        return { lead, nome, outcome };
      } catch (err) {
        return { lead, nome, outcome: null };
      }
    }));
    for (const { lead, nome, outcome } of outcomes) {
      const dpInfo = (outcome && outcome.data && outcome.data.digital_presence) || {};
      const wa = dpInfo.whatsapp || null; // SÓ existe quando status = 'confirmado'
      const domain = (outcome && outcome.data && outcome.data.domain) || null;
      const status = dpInfo.status || 'nao_encontrado';
      const score = typeof dpInfo.score === 'number' ? dpInfo.score : null;
      const fonteUrl = Array.isArray(dpInfo.fontes) && dpInfo.fontes[0] ? dpInfo.fontes[0].url : null;

      // NÃO CONFIRMADO (score 40-69): NÃO entra no cadastro — fila de revisão
      // manual (a IA mostra na conversa; o painel de enriquecimento detalha).
      if (status === 'nao_confirmado' || (dpInfo.nao_confirmado && !wa)) {
        naoConfirmado.push({
          companyName: nome,
          whatsapp: (dpInfo.nao_confirmado && dpInfo.nao_confirmado.whatsapp) || null,
          score: (dpInfo.nao_confirmado && dpInfo.nao_confirmado.score) || score,
          motivo: (dpInfo.nao_confirmado && dpInfo.nao_confirmado.motivo) || null,
        });
        continue;
      }
      if (!wa) {
        (semTelefone(lead) ? notFound : semNovo).push(nome);
        if (dpInfo.search_unavailable) buscaMorta += 1;
        continue;
      }
      const digits = String(wa).replace(/\D/g, '');
      const current = Array.isArray(lead.cnpjPhones) ? lead.cnpjPhones.filter(Boolean) : [];
      const frontDigits = current.length ? String(current[0]).replace(/\D/g, '') : null;
      if (frontDigits === digits) {
        found.push({ prospectId: lead.id, companyName: nome, whatsapp: wa });
        continue;
      }
      const updates = { cnpjPhones: [wa, ...current.filter((p) => String(p).replace(/\D/g, '') !== digits)] };
      // E-mail corporativo achado na MESMA fonte (literal no HTML): preenche
      // quando o lead não tem — destrava também o disparo por e-mail.
      const email = dpInfo.corporate_email || null;
      if (email && !lead.cnpjEmail) updates.cnpjEmail = email;
      // Domínio só vira lead.domain quando é site DA EMPRESA — catálogo
      // digital (diggy.menu) e agregador (taplink/linktr) não são o site.
      if (domain && !lead.domain && isCompanyDomain(domain)) updates.domain = domain;
      await prisma.prospect.update({ where: { id: lead.id }, data: updates });
      (current.length ? promoted : found).push({
        prospectId: lead.id, companyName: nome, whatsapp: wa, anterior: current[0] || null,
        status, score, fonteUrl,
      });
    }
  }

  return { found, promoted, notFound, semNovo, naoConfirmado, buscaMorta, semNumero, comNumero };
}

/**
 * Monta o card `enrichment_done` (mesma copy do modo síncrono do chat).
 * `escopoTotal` = leads no raio da campanha/org; `loteSize` = processados.
 */
function buildEnrichmentCard({ found, promoted, notFound, semNovo, naoConfirmado = [], buscaMorta, escopoTotal, semNumeroCount, comNumeroCount, loteSize, restantes }) {
  const cadastrados = [...found, ...promoted];
  const lines = [];
  // Escopo EXPLÍCITO no card: a busca foi SÓ sobre a base do usuário —
  // nenhum lead de outra organização entra aqui (isolamento por orgId).
  lines.unshift(`🔎 Escopo: procurei na SUA base — ${escopoTotal} lead(s) no raio desta campanha/org (${semNumeroCount || 0} sem telefone, ${comNumeroCount || 0} para atualizar), lote de ${loteSize}.`);
  if (cadastrados.length) {
    lines.push(cadastrados.map((f) => {
      const trocou = f.anterior ? ` (substituiu ${f.anterior} na frente)` : '';
      const fonte = f.fonteUrl ? ` — fonte: ${f.fonteUrl}` : '';
      const score = typeof f.score === 'number' ? ` (score ${f.score})` : '';
      return `• **${f.companyName}** — ${f.whatsapp} ✓ WhatsApp CONFIRMADO${score}${trocou}${fonte}`;
    }).join('\n'));
  }
  if (naoConfirmado.length) {
    lines.push(`⚠️ ${naoConfirmado.length} lead(s) com número NÃO CONFIRMADO (score 40-69) — NÃO entraram no cadastro, precisam de revisão manual:`);
    lines.push(naoConfirmado.map((f) => `• **${f.companyName}** — ${f.whatsapp || '?'} (score ${f.score})${f.motivo ? ` — ${f.motivo}` : ''}`).join('\n'));
  }
  if (notFound.length && buscaMorta >= notFound.length) {
    lines.push(`⚠️ A BUSCA NA INTERNET respondeu vazia para todos os ${notFound.length} lead(s) nesta rodada (${notFound.slice(0, 5).join(', ')}${notFound.length > 5 ? '…' : ''}). Isso é instabilidade dos motores de busca, não prova de que não existe número — me peça para enriquecer de novo em alguns minutos.`);
  } else if (notFound.length) {
    lines.push(`⚠️ ${notFound.length} lead(s) SEM WhatsApp público encontrado na internet (site, catálogo, redes): ${notFound.slice(0, 5).join(', ')}${notFound.length > 5 ? '…' : ''}`);
  }
  if (semNovo.length) {
    lines.push(`ℹ️ ${semNovo.length} lead(s) já tinham telefone e não achei WhatsApp novo na internet — cadastro mantido: ${semNovo.slice(0, 5).join(', ')}${semNovo.length > 5 ? '…' : ''}`);
  }
  if (restantes > 0) {
    lines.push(`Ainda há ${restantes} lead(s) fora deste lote — me peça "continua o enriquecimento" para o próximo lote.`);
  }
  if (cadastrados.length) {
    lines.push('Pode disparar por WhatsApp: quem tem número no cadastro entra na fila na matrícula — e contato cancelado por no_phone volta sozinho no reforço de fila (o disparo re-lê o cadastro no envio). Lembrando: lead SEM consentimento WhatsApp registrado continua fora até você autorizar ("<nome> autorizou WhatsApp").');
  } else if (buscaMorta === 0) {
    lines.push('Nada novo encontrado nesta rodada: sem número público na internet, o WhatsApp continua impossível para quem está sem telefone — me peça para atualizar os telefones manualmente ou capture leads novos.');
  }
  return {
    type: 'enrichment_done',
    label: cadastrados.length
      ? `Enriquecimento concluído — ${cadastrados.length} WhatsApp(s) CONFIRMADO(S) e cadastrado(s)`
      : 'Enriquecimento concluído — nenhum WhatsApp confirmado',
    detail: lines.join('\n'),
    found: cadastrados.map((f) => f.companyName),
    promoted: promoted.map((f) => f.companyName),
    notFound,
    semNovo,
    restantes: restantes || 0,
  };
}

module.exports = { enrichLeads, buildEnrichmentCard, CHUNK_SIZE };
