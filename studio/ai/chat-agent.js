'use strict';

/**
 * studio/ai/chat-agent.js — orquestrador do assistente de campanha
 * (chat-first, specs/010 iteração UX).
 *
 * O bot conversa com o usuário, pergunta preferências e emite AÇÕES que o
 * servidor executa nos serviços reais (segmento-NL, compose, agenda, materiais).
 * Resposta SEMPRE em JSON: { reply, actions: [...] } — parse tolerante.
 *
 * Ações suportadas:
 *  - set_objective   {objective, offer?}
 *  - set_audience    {description}            → segmento por NL + snapshot
 *  - attach_url      {url}                    → material URL + extração
 *  - confirm_material{materialId}             → confirmação humana da extração
 *  - generate_content{tones?, source?}        → pacote multicanal em revisão
 *  - set_schedule    {mode, windows?, hourlyLimit?, dailyLimit?, timezone?}
 *  - show_balance    {}                       → card do Orçamento de Reputação com passo a passo
 *  - start_whatsapp_pairing {}                → QR do WAHA no próprio chat
 *  - none
 */

const { parseModelJson } = require('./json');
const skills = require('./skills');

const SYSTEM_PROMPT = [
  'Você é o assistente de criação de campanhas do B2Base (prospecção B2B no Brasil).',
  'Você conversa em português, de forma curta e objetiva, UMA pergunta por vez quando faltar informação.',
  'Você monta a campanha inteira: objetivo, audiência (segmento de leads), conteúdo dos canais e agendamento dos disparos.',
  'Se o usuário anexar material (PDF/imagem/URL), use-o como fonte do conteúdo.',
  'ANTES de gerar conteúdo a partir de material anexado, apresente a extração (produto/oferta/público) e peça confirmação.',
  '',
  'LIMITES E BLOQUEIOS DE ENVIO (Orçamento de Reputação): cada canal (e-mail, WhatsApp) tem um saldo de envios',
  'com piso e teto. Abaixo do piso, disparos ficam BLOQUEADOS. E-mail também exige domínio autenticado',
  '(SPF/DKIM/DMARC); WhatsApp exige pareamento por QR. Quando o usuário perguntar sobre limites, saldo,',
  'por que não pode disparar ou como desbloquear/configurar canais:',
  '  - explique em linguagem simples (sem jargão), citando os números do bloco CANAIS do estado;',
  '  - liste um PASSO A PASSO numerado do que falta para liberar;',
  '  - inclua a action "show_balance" para renderizar o card completo com os passos;',
  '  - para parear/conectar o WhatsApp, inclua a action "start_whatsapp_pairing" (o QR aparece no chat);',
  '  - nunca invente números: use apenas o estado fornecido.',
  '',
  'Responda SOMENTE com JSON:',
  '{"reply":"sua mensagem em markdown curto",',
  ' "actions":[{"type":"set_objective","objective":"...","offer":"..."},',
  '            {"type":"set_audience","description":"indústrias de SP com score alto"},',
  '            {"type":"attach_url","url":"https://..."},',
  '            {"type":"confirm_material","materialId":"..."},',
  '            {"type":"generate_content","tones":["formal","comercial"]},',
  '            {"type":"set_schedule","mode":"scheduled","windows":[{"days":[1,2,3,4,5],"startHour":9,"endHour":18}],"hourlyLimit":20,"dailyLimit":100,"timezone":"America/Sao_Paulo"},',
  '            {"type":"show_balance"},',
  '            {"type":"start_whatsapp_pairing"},',
  '            {"type":"none"}]}',
  'Regras: nunca prometa disparo sem aprovação; nada é enviado automaticamente.',
].join('\n');

function buildStateBlock(campaign, extras = {}) {
  return [
    'ESTADO ATUAL DA CAMPANHA:',
    JSON.stringify({
      nome: campaign.name,
      status: campaign.status,
      objetivo: campaign.objective || null,
      oferta: campaign.offer || null,
      canais: campaign.channels,
      audiencia: extras.audienceCount ?? null,
      conteudos: extras.contentSummary || [],
      agenda: campaign.schedule || {},
      materiais: extras.materials || [],
    }),
  ].join('\n');
}

/** Canais/marca/respostas do workspace — o agente explica com dados reais. */
function buildOrgBlock(extras = {}) {
  const parts = [];
  if (extras.canais) {
    parts.push(`CANAIS (Orçamento de Reputação e conexões):\n${JSON.stringify(extras.canais)}`);
  }
  if (extras.respostasQuentes?.length) {
    parts.push(
      'RESPOSTAS QUENTES (leads com interesse nos últimos 7 dias — cite empresa/contato e rascunhe a próxima mensagem quando o usuário pedir):\n' +
        JSON.stringify(extras.respostasQuentes)
    );
  }
  if (extras.marca) {
    const { tomDeVoz, assets, contexto } = extras.marca;
    parts.push(`MARCA DO WORKSPACE:\n${JSON.stringify({ tomDeVoz, assets })}`);
    if (contexto) parts.push(`CONTEXTO DA MARCA (arquivos do cliente):\n${contexto}`);
  }
  return parts.length ? parts.join('\n\n') : null;
}

function buildHistoryBlock(history) {
  const recent = (history || []).slice(-12);
  if (recent.length === 0) return 'HISTÓRICO: (conversa começando)';
  return `HISTÓRICO RECENTE:\n${recent
    .map((m) => `${m.role === 'user' ? 'USUÁRIO' : 'ASSISTENTE'}: ${String(m.text || '').slice(0, 500)}`)
    .join('\n')}`;
}

function createChatAgent({ callLlm } = {}) {
  const llm = callLlm || require('../../llm-client').callLlm;

  async function orchestrate({ campaign, history, userMessage, extras }) {
    const user = [
      buildStateBlock(campaign, extras),
      buildOrgBlock(extras),
      buildHistoryBlock(history),
      skills.selectFor(userMessage),
      `NOVA MENSAGEM DO USUÁRIO: ${userMessage}`,
      'Decida as ações e escreva a resposta para o usuário.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const result = await llm({
      system: SYSTEM_PROMPT,
      user,
      jsonMode: true,
      temperature: 0.4,
      maxTokens: 900,
      tag: 'studio:chat',
    });
    const parsed = parseModelJson(result.content);
    if (!parsed || typeof parsed.reply !== 'string') {
      // Fallback honesto: sem ação, pede para reformular.
      return {
        reply: 'Não entendi completamente — pode reformular? (ex.: "quero vender ERP para indústrias de SP, disparar 20 por hora em horário comercial")',
        actions: [{ type: 'none' }],
      };
    }
    return {
      reply: parsed.reply,
      actions: Array.isArray(parsed.actions) ? parsed.actions.filter((a) => a && a.type) : [],
    };
  }

  return { orchestrate };
}

module.exports = { createChatAgent, SYSTEM_PROMPT };
