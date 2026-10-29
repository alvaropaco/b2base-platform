'use strict';

/**
 * studio/ai/compose.js — pacote de campanha multicanal por tom (specs/010,
 * T047; FR-025/FR-026). Um chamado por tom/variante: e-mail (assunto,
 * pré-header, blocos), WhatsApp (curto, com CTA) e texto para LinkedIn —
 * cada canal adaptado, nunca cópia do mesmo texto. DI: callLlm injetável
 * (pesquisa D9); Brand Voice entra como diretriz quando configurada (US12).
 *
 * Confiabilidade (fix issue chat; QA 2026-10-02, bug 3/6): UM JSON com os 3
 * canais era a tarefa de "pensar" que o modelo mais falhava (truncava ou
 * estourava o timeout com gateway carregado). Hoje são DUAS chamadas:
 *   1. e-mail — o JSON pesado, com orçamento próprio de retry e timeout
 *      maior (45s cobre o p99 do gateway; a 2ª tentativa ainda cabe no
 *      deadline de 75s do callLlmJson);
 *   2. canais curtos (WhatsApp/LinkedIn/timing) — JSON pequeno, BEST-EFFORT:
 *      falhar aqui nunca derruba o pacote (e-mail sozinho já é revisável).
 */

const { callLlmJson } = require('./json');

function createComposer({ callLlm } = {}) {
  const llm = callLlm || require('../../llm-client').callLlm;

  /** Contexto comum aos dois prompts (fonte + marca + objetivo/oferta). */
  function contextLines({ sourceText, orgContext, objective, offer }) {
    return [
      orgContext ? `Contexto da empresa vendedora: ${orgContext}` : '',
      objective ? `Objetivo da campanha: ${objective}` : '',
      offer ? `Oferta: ${offer}` : '',
      'Base do conteúdo (material/fonte confirmada):',
      String(sourceText || '').slice(0, 12_000),
    ].filter(Boolean);
  }

  const SYSTEM = 'Você é redator de campanhas B2B em português, respondendo apenas com JSON válido e completo.';

  /**
   * Compõe o pacote de UM tom. Retorna:
   * { title, email: {subject, preheader, blocks}, whatsapp: {text}|null,
   *   linkedinText|null, timing|null }
   */
  async function composeForTone({ tone, sourceText, orgContext, objective, offer }) {
    const buildEmailUser = (previousRaw) => {
      const prompt = [
        `Gere o pacote de campanha de prospecção no tom "${tone}" — somente o CANAL E-MAIL.`,
        ...contextLines({ sourceText, orgContext, objective, offer }),
        '',
        'Responda SOMENTE com JSON no formato:',
        '{"title":"...",',
        ' "email":{"subject":"... usa {{companyName}}","preheader":"...","blocks":[{"type":"text","text":"... usa {{firstName}}"},{"type":"button","label":"...","url":"https://...","color":"#25D366"}]}}',
        'Regras: e-mail estruturado e completo; Use apenas variáveis do catálogo: {{firstName}}, {{companyName}}, {{city}}, {{industry}}, {{state}}.',
        'O CTA vai SEMPRE num bloco button (rótulo + url + color), NUNCA como link no meio do texto;',
        'quando o botão abrir conversa no WhatsApp, use color "#25D366" (verde WhatsApp);',
        'URL só http/https e vinda da BASE — NUNCA invente link, número ou endereço.',
        'NUNCA use domínio de exemplo/fictício (exemplo.com.br, example.com, seudominio.com…): se a base',
        'não traz o link real do CTA, o botão sai SEM o campo url — o servidor pede o endereço ao usuário.',
        'Nunca invente números ou benefícios que não estejam na base.',
      ]
        .filter(Boolean)
        .join('\n');
      if (!previousRaw) return prompt;
      return [
        'Sua resposta anterior NÃO foi JSON utilizável (provavelmente truncada).',
        'Responda novamente com o JSON COMPLETO, sem texto fora do JSON, mantendo o mesmo tom.',
        '--- RESPOSTA ANTERIOR (inválida) ---',
        String(previousRaw).slice(0, 1200),
        '',
        prompt,
      ].join('\n');
    };

    const emailPack = await callLlmJson(llm, {
      system: SYSTEM,
      buildUser: buildEmailUser,
      validate: (p) => (p.email && typeof p.email === 'object' ? null : 'pacote sem o e-mail preenchido'),
      maxTokens: 2500,
      temperature: 0.7,
      timeoutMs: 45_000,
      tag: 'studio:compose',
    });

    // Canais curtos: JSON pequeno e best-effort — WhatsApp/LinkedIn são um
    // bônus do pacote; falhar aqui não repete o trabalho que já deu certo.
    try {
      const buildShortUser = (previousRaw) => {
        const prompt = [
          `Gere o pacote de campanha de prospecção no tom "${tone}" — somente os CANAIS CURTOS (WhatsApp, LinkedIn e timing).`,
          ...contextLines({ sourceText, orgContext, objective, offer }),
          emailPack.title ? `Título do pacote já gerado: ${emailPack.title}` : '',
          '',
          'Responda SOMENTE com JSON no formato:',
          '{"whatsapp":{"text":"mensagem curta com {{firstName}} e CTA"},"linkedinText":"texto para contato manual","timing":"sugestão de dia/horário"}',
          'Regras: WhatsApp é curto e direto; adapte REALMENTE o texto por canal.',
          'Use apenas variáveis do catálogo: {{firstName}}, {{companyName}}, {{city}}, {{industry}}, {{state}}.',
          'Nunca invente números ou benefícios que não estejam na base.',
        ]
          .filter(Boolean)
          .join('\n');
        if (!previousRaw) return prompt;
        return [
          'Sua resposta anterior NÃO foi JSON utilizável.',
          'Responda novamente com o JSON COMPLETO, sem texto fora do JSON, mantendo o mesmo tom.',
          '--- RESPOSTA ANTERIOR (inválida) ---',
          String(previousRaw).slice(0, 800),
          '',
          prompt,
        ].join('\n');
      };
      const short = await callLlmJson(llm, {
        system: SYSTEM,
        buildUser: buildShortUser,
        validate: (p) => (p.whatsapp?.text || p.linkedinText ? null : 'canais curtos ausentes'),
        // 700 truncava no deepseek (finish_reason=length — QA 2026-10-06).
        maxTokens: 1200,
        temperature: 0.7,
        timeoutMs: 45_000,
        parseAttempts: 2,
        tag: 'studio:compose',
      });
      return {
        title: emailPack.title || null,
        email: emailPack.email,
        whatsapp: short.whatsapp || null,
        linkedinText: short.linkedinText || null,
        timing: short.timing || null,
      };
    } catch (_err) {
      // Best-effort: o e-mail (o canal primário) já está pronto e persiste.
      return {
        title: emailPack.title || null,
        email: emailPack.email,
        whatsapp: null,
        linkedinText: null,
        timing: null,
      };
    }
  }

  /**
   * Composer DEDICADO de WhatsApp (QA 2026-10-06, 2º round: o caminho
   * multicanal truncava — deepseek cortava o JSON curto em 700 tokens e o
   * "bônus best-effort" nunca saía; o usuário pedia WhatsApp e a IA falhava
   * "não deu para concluir"). UMA chamada pequena, orçamento de tokens
   * próprio, sem depender do e-mail.
   */
  async function composeWhatsApp({ tone, sourceText, orgContext, objective, offer }) {
    const buildUser = (previousRaw, lastProblem) => {
      const prompt = [
        `Gere a MENSAGEM DE WHATSAPP de prospecção no tom "${tone}" — somente o canal WhatsApp.`,
        ...contextLines({ sourceText, orgContext, objective, offer }),
        '',
        'Responda SOMENTE com JSON no formato:',
        '{"whatsapp":{"text":"mensagem curta (4-8 linhas) com {{firstName}} e um CTA claro"}}',
        'Regras: mensagem CURTA e direta (WhatsApp), com {{firstName}} e um chamado para ação;',
        'SAUDAÇÃO: o nome do DESTINATÁRIO é SEMPRE a variável {{firstName}} — NUNCA escreva um nome',
        'próprio literal na saudação (a MESMA mensagem vai para TODOS os leads; nome fixo = todo',
        'mundo recebe o nome errado). Nome do VENDEDOR/assinatura pode ser literal.',
        'Use apenas variáveis do catálogo: {{firstName}}, {{companyName}}, {{city}}, {{industry}}, {{state}}.',
        'Nunca invente números ou benefícios que não estejam na base.',
      ]
        .filter(Boolean)
        .join('\n');
      if (!previousRaw) return prompt;
      return [
        lastProblem ? `Problema na sua resposta anterior: ${lastProblem}.` : 'Sua resposta anterior NÃO foi JSON utilizável.',
        'Responda novamente com o JSON COMPLETO, sem texto fora do JSON, mantendo o mesmo tom.',
        '--- RESPOSTA ANTERIOR (inválida) ---',
        String(previousRaw).slice(0, 800),
        '',
        prompt,
      ].join('\n');
    };
    const out = await callLlmJson(llm, {
      system: SYSTEM,
      buildUser,
      validate: (p) => {
        const text = p.whatsapp?.text || p.text;
        if (typeof text !== 'string' || !text.trim()) return 'mensagem de WhatsApp ausente';
        // Caso real (2026-10-13): a IA assou o nome do USUÁRIO na saudação
        // ("Olá, Jefferson, sou Jefferson Torres") e TODO lead recebeu o nome
        // errado. A variável {{firstName}} é OBRIGATÓRIA — sem ela, refaz.
        if (!text.includes('{{firstName}}')) {
          return 'a mensagem precisa usar a variável {{firstName}} para o nome do destinatário — nome próprio literal na saudação vai igual para todos os leads';
        }
        return null;
      },
      maxTokens: 1024,
      temperature: 0.7,
      timeoutMs: 30_000,
      parseAttempts: 3,
      tag: 'studio:compose',
    });
    const text = out.whatsapp?.text || out.text;
    return { text: String(text).trim() };
  }

  return { composeForTone, composeWhatsApp };
}

module.exports = { createComposer };
