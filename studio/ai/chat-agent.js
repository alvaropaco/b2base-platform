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
 *  - capture_leads   {query, state?, city?, cnae?, limit?} → captura híbrida de leads (Epic 2)
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
  'Sobre leads, descreva APENAS o que está no estado (empresa, contato, localidade, porte). NUNCA afirme',
  'engajamento, intenção ou chance ("resposta quente", "interessado", "92% de chance") — o estado não traz',
  'esses dados e inventá-los é alucinação; o usuário decide pelo critério dele, não por palpite seu.',
  'Se mensagens ANTERIORES da conversa (suas ou do usuário) mencionarem interesse, engajamento ou percentuais',
  'de leads, trate como inválido: não repita nem confirme esses números — o estado atual é a única fonte.',
  '',
  'CAPTURA DE LEADS (Epic 2): quando o usuário pedir MAIS leads ("capture mais leads", "capture leads da base",',
  '"encontre empresas novas de X"), inclua a action capture_leads: {"type":"capture_leads","query":"<termo curto do setor>"}',
  '  - query é OBRIGATÓRIA e é um TERMO DE SETOR curto (ex.: "equipamentos agrícolas"), não a frase do usuário inteira;',
  '  - filtros opcionais: "state" (UF), "city", "cnae" (termo do ramo), "limit" (quantidade, default 25);',
  '  - a captura busca PRIMEIRO na base do próprio usuário e, se não bastar, no CNPJ público — nunca prometa',
  '    leads que não vieram no card; apresente contagem e proveniência (da base dele / via CNPJ).',
  '',
  'DECISÃO FECHADA (Epic 1, FR2): o bloco audienciaDecidida do estado é UM FATO decidido pelo usuário —',
  'critérios de audiência já fechados, com contagem do snapshot ativo. NUNCA re-pergunte o que já está',
  'decidido ali; referencie os critérios quando for relevante e só proponha mudança se o usuário pedir.',
  'Pergunte uma vez, nunca mais.',
  '',
  'MENSAGEM RICA (regra de ouro): se a mensagem do usuário já trouxer várias informações de uma vez',
  '(o que vende, para quem, tom, anexo), processe TUDO de uma vez — emita as actions correspondentes',
  'na MESMA resposta e NUNCA re-pergunte o que já está na mensagem ou no ESTADO ATUAL (objetivo, oferta,',
  'audiência decidida). Só pergunte o que de fato FALTA para a campanha avançar — conferindo sempre o',
  'estado antes de formular qualquer pergunta.',
  '',
  'REVISÃO DE CONTEÚDO: quando o usuário pedir para VER, LER ou revisar o e-mail/mensagem gerados',
  '("me manda o e-mail", "mostra como ficou", "quero ler"), inclua a action "show_content" — o texto',
  'completo aparece no chat. Nunca apenas aponte para o painel e troque de assunto.',
  '',
  'JORNADA (Epic 3): a campanha avança em ordem — objetivo → audiência → conteúdo → agenda → certificado.',
  'O bloco jornada do estado mostra a FASE CORRENTE e o que já foi concluído: avance a próxima fase pendente.',
  'Nunca emita ação de uma fase À FRENTE do que já existe (ex.: agendar sem conteúdo) — o servidor recusa',
  'com explicação e o usuário fica sem o que pediu. Conteúdo/materiais podem ser ajustados a qualquer momento.',
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
  '            {"type":"show_content"},',
  '            {"type":"capture_leads","query":"equipamentos agrícolas","limit":25},',
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
      // FATO decidido pelo usuário (FR2) — nunca re-perguntar (ver SYSTEM_PROMPT).
      // Só entra quando materializou >0 com snapshot ativo (chat-routes);
      // decisões sem contagem válida vão como HISTÓRICO, sem a regra.
      audienciaDecidida: extras.audienceCriteria || null,
      audienciaHistorico: extras.audienceHistory || null,
      audienciaLeads: extras.audienceLeadSample || [],
      audienciaDisponiveis: extras.audienceAvailableSample || [],
      conteudos: extras.contentSummary || [],
      agenda: campaign.schedule || {},
      materiais: extras.materials || [],
      // Jornada explícita (Epic 3): fase corrente + fases concluídas — o
      // modelo avança a próxima fase pendente; atalho é recusado server-side.
      jornada: extras.journey || null,
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

/**
 * Degradação honesta (Epic 1, FR1/UX-DR4): a resposta explica o que NÃO foi
 * alterado (chips leigos, zero jargão) e dá o próximo passo — nunca o
 * "problema técnico" seco que virava beco sem saída. Stack fica só no
 * servidor/trace, nunca ao usuário.
 */
function buildDegradedReply(unchanged) {
  const chips = {
    leads: 'seus leads não foram tocados ✓',
    conteudos: 'seus conteúdos continuam do mesmo jeito ✓',
    materiais: 'seus materiais continuam guardados ✓',
    agenda: 'o agendamento não foi alterado ✓',
  };
  const parts = unchanged.map((phase) => chips[phase]).filter(Boolean);
  return [
    'Não consegui concluir o processamento da sua última mensagem agora — tive um problema técnico do meu lado.',
    ...(parts.length ? parts : ['a campanha segue exatamente como estava ✓']),
    'Tenta de novo em 1 minuto — se persistir, me diga com outras palavras.',
  ].join(' ');
}

/** Fases que existem na campanha e que o turno NÃO conseguiu concluir. */
function unchangedPhases(campaign, extras = {}) {
  const unchanged = ['leads'];
  if (Array.isArray(extras.contentSummary) && extras.contentSummary.length > 0) unchanged.push('conteudos');
  if (Array.isArray(extras.materials) && extras.materials.some((m) => m.confirmed)) unchanged.push('materiais');
  const schedule = campaign.schedule || {};
  if (schedule.mode || (Array.isArray(schedule.windows) && schedule.windows.length > 0)) unchanged.push('agenda');
  return unchanged;
}

function createChatAgent({ callLlm } = {}) {
  const llm = callLlm || require('../../llm-client').callLlm;

  /**
   * Extração PEQUENA e dedicada de intenção (QA 2026-10-02, bugs 1/2 do dono):
   * mensagem rica de abertura re-perguntava o que já fora dito porque o
   * orchestrate (uma chamada só: decidir + escrever) deixava de emitir as
   * actions. Aqui UMA chamada minúscula (300 tokens, temp 0) extrai
   * objetivo/oferta/audiência EXPLICITAMENTE presentes na mensagem — o
   * caller materializa pelos handlers reais e o orchestrate escreve a
   * resposta com o estado já atualizado. Falhar aqui NUNCA derruba o turno:
   * o caller segue para o orchestrate normal.
   */
  async function extractIntent({ userMessage, onLlmCall = () => {} } = {}) {
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
        system:
          'Você extrai intenção comercial de mensagens para uma campanha B2B. Responda apenas com JSON válido.',
        buildUser: (previousRaw) => {
          const base = [
            'PRIMEIRA EXTRAÇÃO DE INTENÇÃO — leia a mensagem do usuário e extraia o que estiver EXPLICITAMENTE nela.',
            'Responda SOMENTE com JSON: {"objective":"...","offer":"...","audience":"..."}',
            'Regras:',
            '- objective: o que a pessoa quer alcançar com a campanha (ex.: "agendar demos de ERP").',
            '- offer: o produto/serviço oferecido (ex.: "software de gestão fiscal").',
            '- audience: PARA QUEM ela vende — segmento de empresas em poucas palavras (ex.: "indústrias de médio porte em SP").',
            '- Campo ausente na mensagem = null. NUNCA invente ou complete por conta própria.',
            '',
            `MENSAGEM DO USUÁRIO: ${String(userMessage || '').slice(0, 2000)}`,
          ].join('\n');
          if (!previousRaw) return base;
          return [
            `Sua resposta anterior NÃO foi JSON utilizável: ${String(previousRaw).slice(0, 300)}`,
            'Responda de novo SOMENTE com JSON no formato {"objective":"...","offer":"...","audience":"..."} sobre a mensagem abaixo.',
            '',
            base,
          ].join('\n');
        },
        validate: () => null, // parse apenas — normalização fica no caller
        maxTokens: 300,
        temperature: 0,
        parseAttempts: 2,
        tag: 'studio:intent',
      });
      const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null);
      return {
        objective: clean(parsed.objective),
        offer: clean(parsed.offer),
        audience: clean(parsed.audience),
      };
    } catch (err) {
      console.error('[studio/chat] extractIntent falhou (turno segue sem extração):', err.stack || String(err));
      return { objective: null, offer: null, audience: null };
    }
  }

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
    // JSON POR ESTÁGIO (3 tentativas de parse + 2 de validação, com deadline
    // suave — json.js): truncado → pedido de concisão; inválido → a resposta
    // anterior volta no prompt. Falhar aqui é falha do MODELO, não do
    // usuário — o fallback final diz isso honestamente.
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
        degraded: false,
      };
    } catch (err) {
      // Erro visível (NFR4/FR3): a causa NUNCA é descartada — log com stack
      // no servidor e errorCode+errorStack no retorno (viram trace
      // persistido pelo chat-routes). A resposta é degradação explicável,
      // não beco sem saída.
      console.error('[studio/chat] orchestrator failed:', err.stack || String(err));
      const unchanged = unchangedPhases(campaign, extras);
      return {
        reply: buildDegradedReply(unchanged),
        actions: [{ type: 'none' }],
        degraded: true,
        errorCode: err.code || 'LLM_TURN_FAILED',
        errorStack: String(err.stack || err),
        unchanged,
        nextStep: 'tente de novo em 1 minuto',
      };
    }
  }

  return { orchestrate, extractIntent };
}

module.exports = { createChatAgent, SYSTEM_PROMPT };
