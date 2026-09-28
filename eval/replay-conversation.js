'use strict';

/**
 * eval/replay-conversation.js — replay SEGURO de uma conversa real.
 *
 * Regra de ouro: a campanha de ORIGEM é apenas lida (histórico + estado);
 * os turnos do usuário são replicados numa campanha NOVA `[AI-REPLAY]`,
 * nunca na origem. Autenticação idêntica ao evaluator (Firebase → sessão),
 * então funciona contra a produção sem headers de teste.
 *
 * Uso:
 *   B2BASE_REPLAY_CAMPAIGN_ID=<id da origem> \
 *   [B2BASE_REPLAY_URL|B2BASE_EVAL_URL=https://www.b2base.net] \
 *   B2BASE_EVAL_EMAIL=... B2BASE_EVAL_PASSWORD=... \
 *   pnpm run eval:replay
 */

const { createAuthenticatedEvalClient } = require('./auth');

async function main() {
  const campaignId = process.env.B2BASE_REPLAY_CAMPAIGN_ID;
  if (!campaignId) throw new Error('Defina B2BASE_REPLAY_CAMPAIGN_ID (campanha de origem, somente leitura).');
  const baseUrl = process.env.B2BASE_REPLAY_URL || process.env.B2BASE_EVAL_URL || 'https://www.b2base.net';

  const client = await createAuthenticatedEvalClient({ baseUrl });

  // 1) Origem: somente leitura.
  const history = await client.getHistory(campaignId);
  const userTurns = [...history]
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .filter((m) => m.role === 'user')
    .map((m) => String(m.text || '').trim())
    .filter(Boolean);
  if (userTurns.length === 0) throw new Error('A conversa de origem não tem turnos de usuário.');

  const state = await client.getState(campaignId).catch(() => null);
  const source = state?.campaign || {};

  // 2) Destino: campanha NOVA dedicada (nunca a origem).
  const stamp = new Date().toISOString().slice(0, 10);
  const replay = await client.createCampaign({
    name: `[AI-REPLAY] ${stamp} ${(source.name || campaignId).slice(0, 90)}`,
    channels: Array.isArray(source.channels) && source.channels.length ? source.channels : ['email'],
  });

  // 3) Replica os turnos do usuário, na ordem.
  const turns = [];
  for (const message of userTurns) {
    const t0 = Date.now();
    const result = await client.chat(replay.id, message).catch((err) => ({ error: String(err.message) }));
    turns.push({
      user: message,
      reply: result?.reply || '',
      cards: (result?.cards || []).map((c) => c.type),
      latencyMs: Date.now() - t0,
      error: result?.error || null,
    });
    process.stdout.write('.');
  }
  console.log('');

  const latencies = turns.map((t) => t.latencyMs);
  const p = (arr, q) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.ceil((q / 100) * arr.length) - 1)] : null);

  console.log(`origem (somente leitura): ${campaignId}${source.name ? ` — "${source.name}"` : ''}`);
  console.log(`replay: ${replay.id} · ${turns.length} turno(s) · latência p50 ${p(latencies, 50)}ms · p95 ${p(latencies, 95)}ms`);
  for (const t of turns) {
    console.log(
      `\nUSUÁRIO: ${t.user}\nASSISTENTE (${t.latencyMs}ms${t.error ? ` · ERRO: ${t.error}` : ''}): ${t.reply || '(vazio)'}\n[cards: ${t.cards.join(', ') || '—'}]`
    );
  }
}

main().catch((err) => {
  console.error(`replay falhou: ${err.message}`);
  process.exitCode = 1;
});
