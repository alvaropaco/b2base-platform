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

const { callLlmJson } = require('./json');
const skills = require('./skills');

const SYSTEM_PROMPT = [
  'Você é o assistente de criação de campanhas do B2Base (prospecção B2B no Brasil).',
  'Você conversa em português, de forma curta e objetiva, UMA pergunta por vez quando faltar informação.',
  'Se o usuário responder algo curto ("sim", "pode", "demonstração") ou escolher uma opção que VOCÊ ofereceu,',
  'interprete a resposta à luz da sua pergunta anterior no HISTÓRICO — nunca peça para reformular sem antes',
  'tentar responder ao que foi perguntado.',
  'Você monta a campanha inteira: objetivo, audiência (segmento de leads), conteúdo dos canais e agendamento dos disparos.',
  'Quando o usuário descrever PARA QUEM quer vender, inclua SEMPRE a action "set_audience" com esse público —',
  'mesmo que depois peça mais detalhes; o painel de audiência precisa do segmento materializado.',
  'Se o usuário anexar material (PDF/imagem/URL), use-o como fonte do conteúdo.',
  'ANTES de gerar conteúdo a partir de material anexado, apresente a extração (produto/oferta/público) e peça confirmação.',
  'Quando o usuário pedir para incluir, remover ou trocar leads ESPECÍFICOS da audiência (ex.: "tira a Repro",',
  '"adiciona a Acme", "traz a Repro de volta"), use a action select_leads com os prospectId reais do estado:',
  '  - bloco audienciaLeads = leads JÁ INCLUÍDOS na seleção;',
  '  - bloco audienciaDisponiveis = leads na base FORA da seleção (use-os para ADICIONAR);',
  '  {"type":"select_leads","add":["id"],"remove":["id"]} — ou {"type":"select_leads","set":["id",...]} para substituir.',
  'Nunca invente id: se o lead não está em nenhuma das duas amostras, peça para ele selecionar no painel de leads.',
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
      audienciaLeads: extras.audienceLeadSample || [],
      audienciaDisponiveis: extras.audienceAvailableSample || [],
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

  async function orchestrate({ campaign, history, userMessage, extras, onLlmCall = () => {} }) {
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

    // Telemetria por tentativa (StudioChatTrace via onLlmCall) + reparo de
    // JSON em 2 tentativas (truncado → pedido de concisão; inválido → a
    // resposta anterior volta no prompt). Falhar aqui é falha do MODELO, não
    // do usuário — o fallback final diz isso honestamente.
    const instrumented = async (opts) => {
      const startedAt = Date.now();
      try {
        const result = await llm(opts);
        onLlmCall({
          durationMs: Date.now() - startedAt,
          model: result.model || null,
          usage: result.usage || null,
          truncated: Boolean(result.truncated),
          fallbackUsed: Boolean(result.fallbackUsed),
          status: 'succeeded',
        });
        return result;
      } catch (error) {
        onLlmCall({
          durationMs: Date.now() - startedAt,
          model: null,
          usage: null,
          truncated: false,
          fallbackUsed: false,
          status: 'failed',
          errorCode: error.code || null,
        });
        throw error;
      }
    };

    try {
      const parsed = await callLlmJson(instrumented, {
        system: SYSTEM_PROMPT,
        buildUser: (previousRaw) =>
          previousRaw
            ? `${user}\n\nSUA RESPOSTA ANTERIOR NÃO VEIO COMO JSON VÁLIDO PARA O USUÁRIO. Refaça a MESMA decisão em JSON válido, sem texto fora do JSON. Sua resposta anterior foi:\n${String(previousRaw).slice(0, 800)}`
            : user,
        validate: (parsed) =>
          typeof parsed.reply === 'string' && parsed.reply.trim() ? null : 'reply ausente ou vazio',
        maxTokens: 1200,
        temperature: 0.4,
        tag: 'studio:chat',
      });
      return {
        reply: parsed.reply,
        actions: Array.isArray(parsed.actions) ? parsed.actions.filter((a) => a && a.type) : [],
      };
    } catch (_err) {
      return {
        reply:
          'Tive um problema técnico para processar sua mensagem agora — nada foi alterado na campanha. Pode enviar de novo? Se persistir, me diga com outras palavras.',
        actions: [{ type: 'none' }],
      };
    }
  }

  return { orchestrate };
}

module.exports = { createChatAgent, SYSTEM_PROMPT };
