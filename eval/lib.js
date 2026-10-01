'use strict';

/**
 * eval/lib.js — núcleo puro do evaluator (sem rede): asserções
 * determinísticas, percentis e carregamento de suítes. Testável com
 * `node --test` sem tocar na aplicação.
 *
 * Princípio (Conversational Quality Stack): assertamos COMPORTAMENTO
 * (cards, estado, invariantes), nunca texto exato do modelo.
 */

/** Frase proibida em QUALQUER resposta — o fallback antigo culpava o
 * usuário por falha de parse do modelo (QA 2026-09-28, F1). */
const FORBIDDEN_PHRASES = ['Não entendi completamente'];

const WEIGHTED_METRICS = {
  correctness: 0.25,
  relevance: 0.15,
  contextRetention: 0.15,
  conversationFlow: 0.15,
  clarification: 0.1,
  toolUse: 0.1,
  concision: 0.1,
};

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function loadSuite(raw) {
  const suite = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    throw new Error('Suíte inválida: esperado { version, cases: [...] }.');
  }
  for (const c of suite.cases) {
    if (!c.id || !Array.isArray(c.turns) || c.turns.length === 0) {
      throw new Error(`Caso inválido na suíte: ${c.id || '(sem id)'} — precisa de id e turns[].`);
    }
  }
  return suite;
}

/** Cada asserção devolve { id, pass, detail }. */
function evaluateAssertion(exp, ctx) {
  const replies = ctx.turns.map((t) => String(t.reply || ''));
  const allCards = ctx.turns.flatMap((t) => t.cards || []);
  const lastReply = replies[replies.length - 1] || '';
  const pass = (ok, detail) => ({ id: exp.type + (exp.card ? `:${exp.card}` : ''), pass: !!ok, detail: detail || '' });

  switch (exp.type) {
    case 'replyNonEmpty':
      return pass(
        replies.every((r) => r.trim().length > 0),
        'toda resposta deve ser não vazia'
      );
    case 'cardPresent':
      return pass(allCards.some((c) => c && c.type === exp.card), `esperado card "${exp.card}"`);
    case 'cardAbsent':
      return pass(!allCards.some((c) => c && c.type === exp.card), `card "${exp.card}" não deveria existir`);
    case 'replyContains':
      return pass(replies.some((r) => r.toLowerCase().includes(String(exp.text).toLowerCase())), `resposta deveria conter "${exp.text}"`);
    case 'replyNotContains':
      return pass(!replies.some((r) => r.toLowerCase().includes(String(exp.text).toLowerCase())), `nenhuma resposta deveria conter "${exp.text}"`);
    case 'replyMatches':
      return pass(replies.some((r) => new RegExp(exp.pattern, 'i').test(r)), `resposta deveria casar /${exp.pattern}/i`);
    case 'replyNotMatches':
      return pass(!replies.some((r) => new RegExp(exp.pattern, 'i').test(r)), `nenhuma resposta deveria casar /${exp.pattern}/i`);
    case 'lastReplyContains':
      return pass(lastReply.toLowerCase().includes(String(exp.text).toLowerCase()), `última resposta deveria conter "${exp.text}"`);
    case 'stateObjectiveMatches':
      return pass(new RegExp(exp.pattern, 'i').test(String(ctx.state?.campaign?.objective || '')), `objetivo deveria casar /${exp.pattern}/i`);
    case 'scheduleHourlyLimit':
      return pass(Number(ctx.state?.campaign?.schedule?.hourlyLimit) === Number(exp.value), `hourlyLimit deveria ser ${exp.value}`);
    /**
     * F3: audiência 0 leads com base populada DEVE ser comunicada com o
     * contraste "0 × total da base" (card novo ou aviso no reply). Mencionar
     * apenas "0 leads incluídos" (card antigo, silencioso) NÃO conta.
     */
    case 'audienceConsistent': {
      const count = Number(ctx.state?.extras?.audienceCount);
      if (!Number.isFinite(count) || count > 0) return pass(true, `audiência com ${count} leads`);
      const warningRe = /nenhum lead|nenhum casou|sua base tem|ajustar o segmento/i;
      const warned =
        allCards.some((c) => c && c.type === 'audience' && (c.emptyMatch || warningRe.test(String((c.label || '') + ' ' + (c.detail || ''))))) ||
        replies.some((r) => warningRe.test(r));
      return pass(warned, 'audiência 0 leads precisa de aviso explícito (card ou reply)');
    }
    /**
     * Epic 3 (Story 3.4): ordem canônica dos cards da jornada — a lista
     * `cards` deve aparecer COMO SUBSEQUÊNCIA na sequência de cards emitidos
     * (turnos extras/intermediários não quebram; ausência ou inversão quebra).
     */
    case 'cardOrder': {
      const expected = (exp.cards || []).map(String);
      const actual = allCards.map((c) => c && c.type).filter(Boolean);
      let i = 0;
      for (const type of actual) {
        if (type === expected[i]) i += 1;
        if (i >= expected.length) break;
      }
      return pass(
        i >= expected.length,
        `cards deveriam aparecer na ordem ${expected.join(' → ')} (vista: ${actual.join(', ') || 'nenhum'})`
      );
    }
    /** F5 (Epic 4): card presente SEM duplicidade — exatamente 1 ocorrência. */
    case 'cardPresentUnique': {
      const expected = String(exp.card);
      const count = allCards.filter((c) => c && c.type === expected).length;
      return pass(count === 1, `card "${expected}" deveria aparecer exatamente 1× (viu ${count})`);
    }
    /** Epic 3 (D5): a audiência materializada casa o mínimo da base fixada. */
    case 'audienceCountAtLeast':
      return pass(
        Number(ctx.state?.extras?.audienceCount) >= Number(exp.value),
        `audiência deveria ter ≥ ${exp.value} lead(s) (viu ${ctx.state?.extras?.audienceCount ?? '—'})`
      );
    /**
     * Epic 3 (Story 3.4): certificado avaliado e pronto para voo. Default
     * (`strict:false`): nível green|amber SEM item de bloqueio — pendência
     * informativa não reprova (conta QA tem envios pausados/consents
     * parciais por design). `strict:true` exige nível 'green'.
     */
    case 'certificateGreen': {
      const cert = ctx.certificate;
      if (!cert || !cert.level) return pass(false, 'certificado indisponível (GET /certificate falhou)');
      if (exp.strict) return pass(cert.level === 'green', `certificado deveria estar green (veio ${cert.level})`);
      const blocked = (cert.items || []).some((i) => i.level === 'block');
      return pass(
        !blocked && cert.level !== 'blocked',
        `certificado não deveria ter bloqueio (nível ${cert.level}${blocked ? ' + item block' : ''})`
      );
    }
    /**
     * Epic 3/4 (nao-re-pergunta, CAP-1): decisão tomada NÃO vira nova ação —
     * via traces (actionTypes por turno), a action deveria ocorrer no máximo
     * 1× em toda a conversa.
     */
    case 'actionNotRepeated': {
      const action = String(exp.action || '');
      const traces = Array.isArray(ctx.traces) ? ctx.traces : null;
      if (!traces) return pass(false, 'traces indisponíveis para validar repetição de ação');
      const turnsWith = traces.filter((t) => Array.isArray(t.actionTypes) && t.actionTypes.includes(action)).length;
      return pass(turnsWith <= 1, `action "${action}" deveria ocorrer no máximo 1× (ocorreu ${turnsWith}×)`);
    }
    default:
      return pass(false, `asserção desconhecida: ${exp.type}`);
  }
}

/**
 * Avalia um caso: invariantes globais (frases proibidas) + asserções do caso.
 * Score do caso = proporcion de asserções+invariantes passando.
 */
function evaluateCase(caseDef, ctx) {
  const assertions = [
    ...FORBIDDEN_PHRASES.map((phrase) => ({ type: 'replyNotContains', text: phrase, invariant: true })),
    ...(caseDef.expect || []),
  ];
  const results = assertions.map((exp) => {
    const r = evaluateAssertion(exp, ctx);
    return { ...r, invariant: Boolean(exp.invariant) };
  });
  const passed = results.filter((r) => r.pass).length;
  return {
    id: caseDef.id,
    title: caseDef.title || caseDef.id,
    pass: results.every((r) => r.pass),
    score: assertions.length ? (passed / assertions.length) * 100 : 0,
    assertions: results,
    turns: ctx.turns.map((t) => ({ latencyMs: t.latencyMs, replyPreview: String(t.reply || '').slice(0, 240), cards: (t.cards || []).map((c) => c.type) })),
    failures: results.filter((r) => !r.pass).map((r) => ({ id: r.id, detail: r.detail })),
  };
}

module.exports = { FORBIDDEN_PHRASES, WEIGHTED_METRICS, percentile, loadSuite, evaluateAssertion, evaluateCase };
