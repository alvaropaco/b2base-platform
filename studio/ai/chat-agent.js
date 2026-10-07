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
const { parseModelJson } = require('./json');
const skills = require('./skills');

/**
 * Decodifica o campo "reply" de um JSON PARCIAL (streaming): extrai o valor
 * da string até onde ela já foi transmitida, decodificando escapes (\n,
 * \", \\, \uXXXX — \u incompleto no fim aguarda mais bytes). Chave ausente →
 * '' (o modelo pode emitir actions antes do reply; os deltas começam quando
 * "reply" aparecer).
 */
function extractReplySoFar(raw) {
  const s = String(raw || '');
  const key = s.match(/"reply"\s*:\s*"/);
  if (!key) return '';
  const start = key.index + key[0].length;
  let out = '';
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') return out; // fecha a string — valor completo
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = s[i + 1];
    if (next === undefined) return out;
    if (next === 'u') {
      const hex = s.slice(i + 2, i + 6);
      if (hex.length < 4) return out; // escape \u incompleto — espera o resto
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
    out += map[next] !== undefined ? map[next] : next;
    i += 1;
  }
  return out;
}

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
  'CAPTURA DE LEADS (Epic 2): quando o usuário pedir MAIS leads — "capture mais leads", "procura leads",',
  '"procura potenciais leads", "adiciona leads à minha campanha/base", "preciso de mais leads",',
  '"encontre empresas novas de X" — inclua a action capture_leads: {"type":"capture_leads","query":"<termo curto do setor>"}',
  '  - query é OBRIGATÓRIA e é um TERMO DE SETOR curto (ex.: "equipamentos agrícolas"), não a frase do usuário inteira;',
  '  - filtros opcionais: "state" (UF), "city", "cnae" (termo do ramo), "limit" (quantidade, default 25);',
  '  - a captura busca PRIMEIRO na base do próprio usuário e, se não bastar, no CNPJ público — nunca prometa',
  '    leads que não vieram no card; apresente contagem e proveniência (da base dele / via CNPJ).',
  '  - REGRA CRÍTICA: pedido de ADICIONAR/PROCURAR leads é CAPTURA — trazer leads que NÃO estavam na base.',
  '    NUNCA responda esse pedido apenas materializando um filtro da base atual: se o filtro casa 0 e o',
  '    usuário quer leads, a resposta é capture_leads, não "importar/enriquecer a base antes".',
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
  'CAPACIDADES (o que você FAZ de verdade — ao perguntarem "o que você consegue fazer", liste isto e',
  'NADA além; nunca diga que não consegue algo desta lista, e nunca prometa o que não está nela):',
  '  1. Campanhas: criar (create_campaign), listar todas da sua organização (list_campaigns), renomear',
  '     (rename_campaign), duplicar (duplicate_campaign) e apagar (delete_campaign — sempre pede confirmação);',
  '     a conversa opera na campanha aberta, mas você vê e cria as outras.',
  '  2. Objetivo e oferta da campanha (set_objective); audiência por linguagem natural (set_audience),',
  '     ajuste fino de leads (select_leads) e captura de leads novos (capture_leads).',
  '  3. Conteúdo: anexar material por URL (attach_url) ou arquivo, gerar e-mail/WhatsApp/LinkedIn',
  '     (generate_content — quando o usuário pedir WhatsApp use channel:"whatsapp"; o servidor também',
  '     deduz o canal da frase), editar o que já existe (edit_content) e MOSTRAR o texto completo no chat',
  '     (show_content — channel:"whatsapp" mostra SÓ a mensagem de WhatsApp). NUNCA diga que gerou',
  '     WhatsApp se o card não confirmar — o card diz o que de fato foi criado.',
  '  4. Disparo: aprovar (approve_campaign) e COLOCAR EM VOO (launch_campaign — disparo único imediato,',
  '     e-mail e WhatsApp, SEM perguntar nada de agenda). TESTE ANTES DO DISPARO: QUALQUER pedido de',
  '     "manda/envia para o número X" ou "me manda um teste no e-mail Y" é TESTE — EMITA send_test_message',
  '     (nada vai para os leads nem gasta saldo). TESTE EM LEADS REAIS: "manda a mensagem para a',
  '     <Empresa>" → send_test_message {leads:["<Empresa>"]} — sai com os DADOS REAIS do lead (fora da',
  '     fila, sem saldo), para 1 ou vários leads, quantas vezes quiser. CONSENTIMENTO: o card do disparo diz quando leads',
  '     ficaram fora do WhatsApp por falta de consentimento (LGPD) — registre em LOTE com',
  '     grant_whatsapp_consent_batch {all:true} (toda a audiência de UMA vez) ou {names:[...]} — NUNCA 1 action',
  '     por lead, NUNCA divida em lotes de 3 e NUNCA peça "continua": o lote registra todos de uma vez',
  '     "<lead> autorizou WhatsApp" e EMITA grant_whatsapp_consent {name} (atesto dele, registro auditável).',
  '     Regra do disparo: quando o usuário pedirem para',
  '     disparar/enviar/colocar no ar uma campanha, EMITA launch_campaign na hora. Agenda (set_schedule)',
  '     SÓ quando o usuário PEDIR explicitamente para programar (dias/horários). Aprovar e disparar na',
  '     mesma mensagem? Emita as duas actions, approve primeiro.',
  '  5. Domínio e canais: CONECTAR a conta de e-mail de disparo pelo chat',
  '     (connect_email — SMTP com App Password ou Resend; no Resend, a API key é do USUÁRIO a menos que',
  '     o servidor diga que a plataforma tem a própria), mostrar os registros DNS',
  '     (SPF/DKIM/DMARC) a publicar (show_dns_records) e parear o WhatsApp por QR',
  '     (start_whatsapp_pairing).',
  '  6. Leads: consultar dados do lead pelo estado, editar empresa/contato/TELEFONE (update_lead — telefone',
  '     com DDD destrava leads cancelados por no_phone no WhatsApp) e',
  '     consentimento WhatsApp; e Ler respostas: mostrar quem respondeu (show_replies — interessados,',
  '     reuniões e pedidos de opt-out dos últimos dias, com empresa e canal).',
  '  Fora do seu alcance hoje (seja honesto): publicar os registros DNS no provedor do domínio (publicar',
  '  é com o usuário — você ORIENTA e REVERIFICA com show_dns_records), ler a caixa de entrada inteira',
  '  fora das respostas classificadas e alterar o plano da organização.',
  '',
  'REGRA ABSOLUTA CONTRA NEGAÇÃO FALSA: as actions do catálogo EXISTEM e executam pelo chat. NUNCA diga',
  'que algo da lista "só pode ser feito no painel", que "não há action para isso", que "não tem acesso"',
  'ou peça para o usuário sair do chat para usar outra tela. Pedido de gerenciar campanhas',
  '(criar/renomear — inclusive "muda o nome da campanha para X" —/duplicar/apagar/listar) → EMITA a',
  'action correspondente na MESMA resposta (ex.: {"type":"create_campaign","name":"X"}), sem perguntar',
  'de volta se pode.',
  '',
  'CONFIRMAÇÃO DE ALTERAÇÕES (regra do dono): quando você for alterar algo que JÁ EXISTE (editar ou',
  'refazer conteúdo, mudar audiência decidida, reconfigurar agenda, apagar campanha), o servidor devolve',
  'um card "confirm_change" em vez de executar. Nesse caso: diga no reply EXATAMENTE o que a alteração',
  'faria e diga que o botão de confirmar está no card — NUNCA repita a action no mesmo turno e NUNCA',
  'diga que já fez. Criar algo que ainda NÃO existe continua direto (sem confirmação).',
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
  '            {"type":"list_campaigns"},',
  '            {"type":"create_campaign","name":"Outbound indústrias"},',
  '            {"type":"rename_campaign","name":"Outbound indústrias 2026"},',
  '            {"type":"approve_campaign"},',
  '            {"type":"launch_campaign"},',
  '            {"type":"send_test_message","phone":"12 99965-7200"},',
  '            {"type":"connect_email","email":"vendas@empresa.com","provider":"resend","apiKey":"re_..."},',
  '            {"type":"set_schedule","mode":"scheduled","windows":[{"days":[1,2,3,4,5],"startHour":9,"endHour":18}],"hourlyLimit":20,"dailyLimit":100,"timezone":"America/Sao_Paulo"},',
  '            {"type":"show_balance"},',
  '            {"type":"start_whatsapp_pairing"},',
  '            {"type":"none"}]}',
  'Catálogo completo de actions (além das acima, todas com {type} e os campos citados):',
  'list_campaigns {}; create_campaign {name, channels?}; rename_campaign {name};',
  'duplicate_campaign {campaignId?, name?}; delete_campaign {campaignId?}; approve_campaign {campaignId?};',
  'launch_campaign {campaignId?};',
  'attach_files {attachmentIds:[id]}; update_lead {prospectId, fields:{companyName?, tradeName?, contactName?, city?, state?, industry?, employees?, cnpjPhones?}} — cnpjPhones destrava lead no_phone;',
  'grant_whatsapp_consent_batch {all:true} ou {names:["Empresa A","Empresa B"]} — registra consentimento em LOTE (NUNCA emita 1 action por lead; leads capturados JÁ nascem com consentimento);',
  'select_content_variant {channel, tone} — o usuário ESCOLHEU qual variante segue no disparo (as outras são arquivadas);',
  'show_replies {}; show_dns_records {}; show_capabilities {}; connect_email {email, provider:"smtp"|"resend", password?|apiKey?, smtpHost?, smtpPort?, fromName?};',
  'send_test_message {phone?|email?} — mensagem de TESTE da campanha para um destino, com dados de exemplo;',
  'edit_content {channel, whatsappText?|text?|subject?} — TROCA o texto do canal pelo texto EXATO que o usuário pediu (sem ids);',
  'grant_whatsapp_consent {name} — registra o consentimento WhatsApp de um lead (atesto do dono);',
  'select_leads {add:[id], remove:[id]} ou {set:[id]}.',
  'Regras: nunca prometa disparo sem aprovação; nada é enviado automaticamente.',
  'Responda com NO MÁXIMO 2-3 actions por turno — prefira concluir uma etapa e confirmar.',
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

/**
 * Roteador determinístico de GERENCIAMENTO DE CAMPANHAS (QA 2026-10-02:
 * o modelo negava que dava para criar/renomear pelo chat e mandava para o
 * painel). Pedido de criar/renomear/duplicar/apagar/listar campanha injeta
 * um bloco curto no prompt do turno com a action exata — a negação fica
 * impossível no momento que importa, sem custo de chamada extra.
 * Retorna o bloco de instrução ou null (pedido comum).
 */
const CAMPAIGN_MGMT_RE = new RegExp(
  [
    '\\b(criar?|crie|cria|nova|novo|montar?|monte)\\b[^.?!]{0,48}\\bcampanhas?\\b',
    '\\bcampanhas?\\b[^.?!]{0,48}\\b(criar|crie|cria|nova)\\b',
    '\\b(renomear?|renomeia|duplicar?|duplica|clonar?|clona|apagar?|apague|apaga|excluir|exclui|remover?)\\b[^.?!]{0,32}\\bcampanhas?\\b',
    '\\bcampanhas?\\b[^.?!]{0,32}\\b(renomear|renomeia|duplicar|duplica|apagar|apaga|excluir)\\b',
    '\\b(mudar?|mude|muda|trocar?|troque|troca|alterar?|altere|altera)\\b[^.?!]{0,32}\\b(o\\s+)?nome\\b[^.?!]{0,32}\\bcampanhas?\\b',
    '\\b(o\\s+)?nome\\b[^.?!]{0,16}(da|dessa|desta|minha)\\s+campanha\\b',
    '\\b(minhas|suas|as|minha)\\s+campanhas?\\b',
    '\\b(listar?|liste|quais)\\s+(as\\s+)?campanhas?\\b',
  ].join('|'),
  'i'
);
/** Trabalho de CONTEÚDO ("criar conteúdo/mensagem da campanha") não é gerência. */
const CONTENT_WORK_RE = /\b(conte[úu]do|mensagem|e-?mail|whatsapp|audi[êe]ncia|material|copy)\b/i;

function campaignManagementHint(userMessage) {
  const msg = String(userMessage || '');
  if (!CAMPAIGN_MGMT_RE.test(msg)) return null;
  // "criar conteúdo da campanha" gera conteúdo — não é gerência de campanhas.
  const mgmtMatch = msg.match(CAMPAIGN_MGMT_RE);
  if (CONTENT_WORK_RE.test(mgmtMatch[0])) return null;
  return [
    'GERENCIAMENTO DE CAMPANHAS DETECTADO — as actions EXISTEM e executam pelo chat:',
    '{"type":"create_campaign","name":"<nome>"} · {"type":"rename_campaign","name":"<novo nome>"} ·',
    '{"type":"duplicate_campaign","campaignId":"..."} · {"type":"delete_campaign"} (o servidor pede',
    'confirmação) · {"type":"list_campaigns"} · {"type":"approve_campaign"}.',
    'USE a action correspondente NESTA resposta com os dados que o usuário já deu (ex.: renomear usa o',
    'nome NOVO que ele indicou). Só pergunte o que de fato falta (ex.: o nome novo). NUNCA diga que',
    'precisa ser no painel, que não há action, ou pergunte se pode.',
  ].join('\n');
}

/**
 * Extrai determinísticamente o NOVO NOME de um pedido de renomeação da
 * campanha aberta (QA 2026-10-02: o modelo negava a renomeação mesmo com o
 * hint — agora o servidor executa sozinho e o modelo só confirma). Retorna
 * o nome limpo ou null (pedido sem alvo claro → cai para o modelo perguntar
 * o nome novo).
 */
function extractRenameTarget(userMessage) {
  const msg = String(userMessage || '').trim();
  if (!msg) return null;
  // GAP: o usuário costuma citar o NOME ATUAL no meio do pedido ("renomeia a
  // campanha TESTE para B2BASE") — até 4 palavras entre "campanha" e a
  // preposição do nome novo são toleradas.
  const GAP = '(?:[\\wÀ-ÿ-]+\\s+){0,4}';
  // ANCORADAS: citam a palavra "campanha" explicitamente.
  const patterns = [
    new RegExp(
      '(?:renomei[ao]|renomear)\\s+(?:a\\s+)?campanha\\s+' + GAP + '(?:para|pra|como|para ser|para ficar como)\\s+(.+)',
      'i'
    ),
    new RegExp(
      '(?:mud[aeo]|mudar|troc[aeo]|trocar|alter[aeo]|alterar)\\s+(?:o\\s+)?nome\\s+(?:d[ao]s?\\s+)?(?:dessa|desta|minha|da)?\\s*(?:[\\wÀ-ÿ-]+\\s+){0,3}campanha\\s+' +
        GAP +
        '(?:para|pra|como|para ser)\\s+(.+)',
      'i'
    ),
    new RegExp(
      '(?:o\\s+)?nome\\s+(?:d[ao]s?\\s+)?(?:dessa|desta|minha|da)\\s+campanha\\s+' +
        GAP +
        '(?:agora\\s+)?(?:[ée]|ser[áa]|vai\\s+ser|fica|vira|passa\\sa\\sser)\\s+(.+)',
      'i'
    ),
  ];
  // BARE (QA 2026-10-05): dentro do Cockpit a conversa JÁ É a campanha —
  // "muda o nome para X" / "renomeia para X" sem citar a palavra. Só valem
  // quando a frase NÃO fala de lead/contato (esses não são rename de
  // campanha).
  const bare = [
    /(?:renomei[ao]|renomear)\s+(?:o\s+nome\s+)?(?:para|pra|como)\s+(.+)/i,
    /(?:mud[aeo]|mudar|troc[aeo]|trocar|alter[aeo]|alterar)\s+(?:o\s+)?nome\s+(?:para|pra|como|para ser)\s+(.+)/i,
  ];
  const aboutLeads = /\b(leads?|contatos?)\b/i.test(msg);
  for (const re of aboutLeads ? patterns : [...patterns, ...bare]) {
    const m = msg.match(re);
    if (m && m[1]) {
      let name = m[1].trim()
        .replace(/^["'“”«»]+|["'“”«»]+$/g, '') // aspas em volta
        .replace(/\s*(por favor|pfv|pf)\s*$/i, '')
        .replace(/[.,;!?…]+\s*$/, '')
        .trim();
      if (!name) continue;
      return name.slice(0, 200);
    }
  }
  return null;
}

/**
 * Criação DETERMINÍSTICA de campanha (QA 2026-10-05): "cria uma campanha
 * chamada X" executa server-side — o modelo só confirma. Exige marcador
 * EXPLÍCITO de nome (chamada/com o nome/nome/":") — "cria uma campanha para
 * indústrias" NÃO tem nome (o "para" traz o público) e segue pelo modelo.
 */
function extractCreateTarget(userMessage) {
  const msg = String(userMessage || '').trim();
  if (!msg) return null;
  const patterns = [
    /(?:cri[ae]r?|monte|montar|abr[aeo]r?)\s+(?:uma\s+|um\s+|mais\s+uma\s+)?campanha\s+(?:chamad[ao]|com\s+o\s+nome|com\s+nome|nome)\s+(.+)/i,
    /(?:nova|novo)\s+campanha\s*:\s*(.+)/i,
    /(?:cri[ae]r?|monte|montar)\s+(?:uma\s+)?campanha\s+(?:chamad[ao]|com\s+o\s+nome|com\s+nome)\s+(.+)/i,
  ];
  for (const re of patterns) {
    const m = msg.match(re);
    if (m && m[1]) {
      let name = m[1].trim()
        .replace(/^["'“”«»]+|["'“”«»]+$/g, '')
        .replace(/\s*(por favor|pfv|pf)\s*$/i, '')
        .replace(/[.,;!?…]+\s*$/, '')
        .trim();
      if (!name) continue;
      return name.slice(0, 200);
    }
  }
  return null;
}

/**
 * Intenção de CAPTURA de leads (QA 2026-10-02, 5ª bateria: 'procura
 * potenciais leads' virava filtro de base 0-match — o modelo não emitia
 * capture_leads). Detecta pedidos de ADICIONAR/PROCURAR/TRAZER leads novos
 * (para a campanha ou para a base). Retorna true/false.
 */
const LEAD_CAPTURE_RE = new RegExp(
  [
    '\\b(procura|procurar|procure|busca|buscar|busque|acha|achar|ache|encontra|encontrar|encontre|captur(?:a|ar|e)|adicion(?:a|ar|e)|acrescent(?:a|ar|e)|traz|trazer|trag[aeo]|gera|gerar|gere|puxa|puxar)\\b[^.?!]{0,48}\\b(leads?|empresas?|contatos?|prospects?|potenciais)\\b',
    '\\b(leads?|empresas?|contatos?|prospects?)\\b[^.?!]{0,40}\\b(para|pra|na|no|d[aeo])\\s+(minha\\s+|nossa\\s+|essa\\s+|esta\\s+)?(campanha|base)\\b',
    '\\b(mais|novos|novas|potenciais|qualificados?|novatos?)\\s+(leads?|empresas?|contatos?|prospects?)\\b',
    '\\b(leads?)\\s+(novos|novas|potenciais|qualificados?)\\b',
  ].join('|'),
  'i'
);

function leadCaptureIntent(userMessage) {
  return LEAD_CAPTURE_RE.test(String(userMessage || ''));
}

/**
 * Termo de setor para a captura, extraído da frase ('leads de construção
 * civil' → 'construção civil'). Null quando a frase não traz setor — o
 * caller usa o segmento vigente da campanha como fallback.
 */
function extractCaptureQuery(userMessage) {
  const msg = String(userMessage || '');
  const patterns = [
    /\b(?:leads?|empresas?|contatos?|prospects?)(?:\s+(?:novos?|novas?|potenciais|qualificados?|b2b))?\s+(?:d[oe]|de|sobre)\s+([^.?!]{2,80}?)(?=\s+(?:para|pra|que|com|no|na|em|d[aeo])\s|[,.?!]|$)/i,
    /\b(?:empresas?|leads?)\s+(?:do\s+)?(?:setor|ramo|segmento)\s+(?:d[eo]\s+)?([^.?!]{2,80}?)(?=\s+(?:para|pra|que|com)\s|[,.?!]|$)/i,
  ];
  for (const re of patterns) {
    const m = msg.match(re);
    if (m && m[1]) {
      const term = m[1].trim().replace(/\s+/g, ' ');
      if (term.length >= 2) return term.slice(0, 80);
    }
  }
  return null;
}

/**
 * Roteador de CONEXÃO DE E-MAIL DE DISPARO (QA 2026-10-05: o modelo negava
 * "cadastrar e-mail pelo chat" — a capacidade existe desde a onda da
 * plataforma inteira). Injeta a action exata e o fluxo de coleta.
 */
const EMAIL_CONNECT_RE = /\b(cadastr(?:a|ar|e)|conectar?|conecte|configur(?:a|ar|e)|registrar?|registre|adicion(?:a|ar|e)|definir?|defin[ae]|trocar?|troc[ae]|mudar?|mud[ae])\b[^.?!]{0,64}\b(e-?mail|remetente|disparo)s?\b|\b(e-?mail|remetente)\s+(de\s+)?disparos?\b/i;

/**
 * Intenção de CANAL na frase (QA 2026-10-06: "faz uma mensagem para enviar
 * por whatsapp" gerava só E-MAIL e a revisão só mostrava e-mails). Fato
 * determinístico do servidor: whatsapp > linkedin > e-mail. Retorna
 * 'whatsapp' | 'linkedin_text' | 'email' | null.
 */
const CHANNEL_INTENT_RULES = [
  ['whatsapp', /\b(whatsa?p?p?|wpp|zap\s*zap)\b/i],
  ['linkedin_text', /\blinked?in\b/i],
  ['email', /\be-?\s?mails?\b/i],
];

function extractChannelIntent(userMessage) {
  const msg = String(userMessage || '');
  for (const [channel, re] of CHANNEL_INTENT_RULES) {
    if (re.test(msg)) return channel;
  }
  return null;
}

/**
 * TESTE DE MENSAGEM antes do disparo (QA 2026-10-06, pedido do dono: novos
 * usuários precisam testar a mensagem antes de ir para todos os leads).
 * Determinístico: extrai o destino (telefone/e-mail) da própria frase.
 * Retorna { phone, email } ou null.
 */
const TEST_MESSAGE_RE = /\b(teste|testar|testa|testando)\b[^.?!]{0,64}\b(mensagem|whatsapp|e-?\s?mail|disparo)\b|\bmensagem\s+padr(ã|a)o\b[^.?!]{0,64}\b(envi\w*|mand\w*|n(ú|u)mero)\b/i;
const SEND_RE = /\b(envi\w*|mand\w*|dispar\w*)\b/i;
const PHONE_RE = /\(?\s*\d{2}\s*\)?\s?-?\s?9?\d{4}\s?-?\s?\d{4}/;

function testMessageIntent(userMessage) {
  const msg = String(userMessage || '');
  const emailMatch = msg.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  const phoneMatch = msg.match(PHONE_RE);
  const phone = phoneMatch ? phoneMatch[0].replace(/\s+/g, ' ').trim() : null;
  const email = emailMatch ? emailMatch[0] : null;
  if (!phone && !email) return null;
  // Frase explícita de teste OU qualquer "manda/envia para <número|e-mail>":
  // no contexto do studio, envio para UM destino digitado só pode ser teste
  // (o disparo real vai para a AUDIÊNCIA, nunca para um número solto).
  const explicit = TEST_MESSAGE_RE.test(msg);
  const sendsToDestination = SEND_RE.test(msg);
  if (!explicit && !sendsToDestination) return null;
  return { phone, email };
}

function testMessageHint(userMessage) {
  const t = testMessageIntent(userMessage);
  const msg = String(userMessage || '');
  // Sem destino digitado, mas citando lead/empresa com verbo de envio → teste
  // em LEADS REAIS (sai com os dados reais do cadastro).
  const leadsContext = !t && SEND_RE.test(msg) && /\b(leads?|empresas?)\b/i.test(msg);
  if (!t && !leadsContext) return null;
  return [
    'TESTE DE MENSAGEM ANTES DO DISPARO — a action send_test_message EXISTE e executa pelo chat:',
    t
      ? `{"type":"send_test_message"${t.phone ? `,"phone":"${t.phone}"` : ''}${t.email ? `,"email":"${t.email}"` : ''}}`
      : '{"type":"send_test_message","leads":["<nome da empresa/lead como está na lista>"]}',
    t
      ? 'Envia a mensagem JÁ GERADA da campanha para o destino informado, com dados de exemplo — NADA vai para os leads, não gasta saldo nem toca a fila.'
      : 'Envia a mensagem JÁ GERADA para os leads citados com os DADOS REAIS deles — fora da fila, sem saldo, 1 ou vários, quantas vezes quiser.',
    'NUNCA diga que não dá para testar; NUNCA ofereça disparar a campanha inteira para "testar".',
  ].join('\n');
}

/**
 * TROCA DE MENSAGEM/CONTEÚDO pelo chat (QA 2026-10-06: o modelo emitia
 * edit_content sem o contrato `contents` e a action falhava — "falou que
 * trocou mas não trocou"). O modelo NÃO tem ids no estado: canal + texto
 * basta (o servidor resolve o conteúdo base).
 */
/**
 * ESCOLHA DE VARIANTE (QA 2026-10-07: o dono escolhia 'comercial' e as DUAS
 * variantes seguiam — o disparo saía em dobro). UMA action arquiva as outras.
 */
const SELECT_VARIANT_RE = /\b(usar|escolh\w+|selecion\w+|prefir\w+|fica\w*|manter|validar?|vale)\b[^.?!]{0,64}\b(a\s+)?(comercial|diret[ao]|formal|urgente|tecnic[ao]|vers(ã|a)o)\b/i;

function selectVariantHint(userMessage) {
  const msg = String(userMessage || '');
  if (!SELECT_VARIANT_RE.test(msg)) return null;
  return [
    'ESCOLHA DE VARIANTE — o usuário escolheu qual TOM/versão segue no disparo. UMA action:',
    '{"type":"select_content_variant","channel":"whatsapp"|"email","tone":"<tom escolhido, ex.: comercial>"}',
    'As outras variações são ARQUIVADAS (o disparo segue só com a escolhida). NUNCA diga que',
    'as duas vão; NUNCA use edit_content para isso.',
  ].join('\n');
}

const EDIT_CONTENT_RE = /\b(troc\w+|substitu\w+|alter\w+|edit\w+|mud\w+)\b[^.?!]{0,64}\b(mensagem|conte(ú|u)do|texto)\b/i;

function editContentHint(userMessage) {
  const msg = String(userMessage || '');
  if (!EDIT_CONTENT_RE.test(msg)) return null;
  return [
    'TROCA DE CONTEÚDO — a action edit_content EXISTE e aceita canal + texto SEM ids:',
    '{"type":"edit_content","channel":"whatsapp"|"email"|"linkedin_text","whatsappText":"<texto EXATO que o usuário pediu>"}',
    '(para e-mail use "text" para o corpo e "subject" para o assunto). Copie o texto do usuário',
    'ITERALMENTE — nunca resuma nem reescreva. O servidor resolve o conteúdo e pede confirmação.',
  ].join('\n');
}

/**
 * CONSENTIMENTO WhatsApp em LOTE (QA 2026-10-07: o modelo dividia em lotes
 * de 3 pedindo 'continua' — inaceitável). Qualquer pedido de registrar
 * consentimento → UMA action grant_whatsapp_consent_batch {all:true}.
 */
const CONSENT_BATCH_RE = /\b(registr\w+|consenti\w+|autoriz\w+|liber\w+|habilit\w+)\b[^.?!]{0,64}\b(consentimento|whatsapp|todos|todas)\b/i;

function consentBatchHint(userMessage) {
  const msg = String(userMessage || '');
  if (!CONSENT_BATCH_RE.test(msg)) return null;
  return [
    'CONSENTIMENTO WHATSAPP EM LOTE — UMA ÚNICA action registra TODOS de uma vez:',
    '{"type":"grant_whatsapp_consent_batch","all":true}',
    'Registra TODOS os leads da audiência que ainda não têm consentimento. NUNCA divida em',
    'lotes de 3, NUNCA peça "continua", NUNCA emita 1 action por lead. Leads capturados/cadastrados',
    'JÁ nascem com consentimento — só os antigos precisam disto.',
  ].join('\n');
}

/**
 * DISPARO PARCIAL (QA 2026-10-07: 'dispara para os primeiros 15 leads' — o
 * modelo tentou listar 15 leads na saída e truncou o turno inteiro). Extrai
 * o N da frase: UMA action curta launch_campaign {limit:N}.
 */
const LAUNCH_LIMIT_RE = /\b(dispar\w*|envi\w*|mand\w*|coloc\w*.*voo)\b[^.?!]{0,80}?(primeiros?|s\u00f3|apenas|maximo|m\u00e1ximo|limite)\b[^.?!]{0,24}?\b(\d{1,3})\s*(leads?|empresas?|contatos?)\b/i;

function launchLimitHint(userMessage) {
  const msg = String(userMessage || '');
  const m = msg.match(LAUNCH_LIMIT_RE);
  if (!m) return null;
  const limit = Math.min(200, Math.max(1, parseInt(m[3], 10)));
  return [
    'DISPARO PARCIAL — o usuário quer disparar para os PRIMEIROS ' + limit + ' leads. UMA action:',
    `{"type":"launch_campaign","limit":${limit}}`,
    'O servidor envia só os primeiros ' + limit + ' da fila; o resto fica para o próximo disparo.',
    'NUNCA liste os leads na saída; NUNCA use select_leads/capture para isso.',
  ].join('\n');
}

function emailConnectHint(userMessage) {
  const msg = String(userMessage || '');
  if (!EMAIL_CONNECT_RE.test(msg)) return null;
  // "email de X" em contexto de LEAD/audiência não é conexão de canal.
  if (/\b(leads?|contatos?|prospec\w*)\b/i.test(msg) && !/disparo|remetente|conectar|cadastr/i.test(msg)) return null;
  // Estado REAL da chave Resend da plataforma (QA 2026-10-06: o modelo
  // prometeu "a chave da própria plataforma" que não existia no ambiente e a
  // action falhou com "API key obrigatória."). O fato é determinístico aqui —
  // o modelo nunca deve supor o que o ambiente tem.
  const plataformaTemKey = Boolean(process.env.RESEND_API_KEY);
  return [
    'CONEXÃO DE E-MAIL DE DISPARO DETECTADO — a action connect_email EXISTE e executa pelo chat:',
    '{"type":"connect_email","email":"<endereço>","provider":"resend"|"smtp","password":"<app password smtp>","apiKey":"<key resend>","fromName":"<nome opcional>"}',
    'Fluxo: se faltar informação, pergunte UMA coisa por vez — (1) o endereço de e-mail, (2) o provedor',
    '(Resend ou SMTP — SMTP pede senha de app e, opcionalmente, host/porta), (3) a senha/key. Depois EMITA',
    'a action. NUNCA diga que não dá pelo chat; NUNCA repita a action com a mesma actionId.',
    plataformaTemKey
      ? 'A plataforma TEM key Resend própria (fato do servidor): se o usuário não tiver a dele, emita provider "resend" SEM apiKey e diga que vai usar a chave da plataforma.'
      : 'A plataforma NÃO TEM key Resend própria neste ambiente (fato do servidor): NUNCA mencione "chave da plataforma" — peça a API key do Resend do PRÓPRIO USUÁRIO (apiKey, começa com "re_") ou SMTP com senha de app (password).',
    'RESEND + DOMÍNIO (QA 2026-10-06): o domínio do ENDEREÇO precisa constar como "Verified" na conta da API key —',
    'subdomínio verificado (ex.: resend.dominio.com) NÃO libera endereços no domínio raiz (@dominio.com). Se o',
    'usuário pedir um remetente no domínio raiz e só houver subdomínio verificado, ofereça os dois caminhos:',
    '(a) conectar um endereço no subdomínio já verificado, ou (b) verificar o domínio raiz no painel do Resend',
    '(adicionar o domínio e publicar os registros DKIM/SPF) antes de conectar.',
  ].join('\n');
}

function createChatAgent({ callLlm, callLlmStream } = {}) {
  const llm = callLlm || require('../../llm-client').callLlm;
  // Streaming real quando disponível (prod); nos testes (só callLlm injetado)
  // sintetiza a partir da chamada simples — um delta único, hermético.
  const streamFn =
    callLlmStream ||
    (async (opts) => {
      const r = await llm(opts);
      if (opts.onDelta) opts.onDelta(r.content);
      return r;
    });

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
        maxTokens: 800, // deepseek-v4-flash truncava 300 (QA 2026-10-05)
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

  async function orchestrate({ campaign, history, userMessage, extras, onLlmCall = () => {}, onReplyDelta = null, hintOverride = null }) {
    const user = [
      buildStateBlock(campaign, extras),
      buildOrgBlock(extras),
      buildHistoryBlock(history),
      skills.selectFor(userMessage),
      hintOverride || campaignManagementHint(userMessage) || emailConnectHint(userMessage) || testMessageHint(userMessage) || editContentHint(userMessage) || consentBatchHint(userMessage) || selectVariantHint(userMessage) || launchLimitHint(userMessage),
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

    // 1ª tentativa EM STREAMING (QA 2026-10-02, bug 4 do dono — "impressionar"):
    // o reply começa a aparecer no chat no primeiro token, não no fim da
    // geração. Os deltas são o campo "reply" decodificado incrementalmente
    // (extractReplySoFar). Se o JSON final não parsear/validar, o fluxo cai
    // para o loop de reparo não-streaming de baixo — nada se perde.
    let streamedRaw = null;
    if (onReplyDelta) {
      const streamStartedAt = Date.now();
      try {
        const result = await streamFn({
          system: SYSTEM_PROMPT,
          user,
          jsonMode: true,
          temperature: 0.4,
          maxTokens: 1200,
          tag: 'studio:chat',
          onDelta: (fullSoFar) => onReplyDelta(extractReplySoFar(fullSoFar)),
        });
        onLlmCall({
          durationMs: Date.now() - streamStartedAt,
          model: result.model || null,
          usage: result.usage || null,
          truncated: Boolean(result.truncated),
          fallbackUsed: Boolean(result.fallbackUsed),
          status: 'succeeded',
        });
        streamedRaw = result.content;
        const parsed = parseModelJson(streamedRaw);
        if (parsed && typeof parsed === 'object' && typeof parsed.reply === 'string' && parsed.reply.trim()) {
          return {
            reply: parsed.reply,
            actions: Array.isArray(parsed.actions) ? parsed.actions.filter((a) => a && a.type) : [],
            degraded: false,
          };
        }
      } catch (err) {
        onLlmCall({
          durationMs: Date.now() - streamStartedAt,
          model: null,
          usage: null,
          truncated: false,
          fallbackUsed: false,
          status: 'failed',
          errorCode: err.code || null,
        });
        console.warn(`[studio/chat] streaming indisponível (${err.code || err.message}) — cai para chamada simples`);
      }
    }

    try {
      const parsed = await callLlmJson(instrumented, {
        system: SYSTEM_PROMPT,
        buildUser: (previousRaw) => {
          const raw = previousRaw || streamedRaw;
          return raw
            ? `${user}\n\nSUA RESPOSTA ANTERIOR NÃO VEIO COMO JSON VÁLIDO PARA O USUÁRIO. Refaça a MESMA decisão em JSON válido, sem texto fora do JSON. Sua resposta anterior foi:\n${String(raw).slice(0, 800)}`
            : user;
        },
        validate: (parsed) =>
          typeof parsed.reply === 'string' && parsed.reply.trim() ? null : 'reply ausente ou vazio',
        // 1200 truncava turnos com lista de leads/limit (QA 2026-10-07:
        // 'dispara para os primeiros 15' — 4 tentativas, todas cortadas).
        maxTokens: 2000,
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

/** UF citada na frase ('em SP', 'no RJ') — case-sensitive para não casar
 *  artigos/preposições minúsculos ('da', 'em baixo'). Null quando ausente. */
function extractCaptureState(userMessage) {
  const m = String(userMessage || '').match(
    /\b(?:em|no|na|da)\s+(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\b/
  );
  return m ? m[1] : null;
}

module.exports = {
  createChatAgent,
  SYSTEM_PROMPT,
  extractReplySoFar,
  campaignManagementHint,
  emailConnectHint,
  extractChannelIntent,
  testMessageIntent,
  testMessageHint,
  editContentHint,
  consentBatchHint,
  selectVariantHint,
  launchLimitHint,
  extractRenameTarget,
  extractCreateTarget,
  leadCaptureIntent,
  extractCaptureQuery,
  extractCaptureState,
};
