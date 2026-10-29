'use strict';

/**
 * test/studio-image-chat.test.js — IMAGEM GERADA NO CHAT (2026-10-26):
 * a imagem gerada tem que APARECER na conversa, não só virar link em texto.
 *   1. a rota REAL /media/:name (a mesma montada no server-prod) serve o
 *      arquivo com 200/Content-Type/bytes corretos e recusa o resto;
 *   2. o card do chat carrega o caminho estruturado (imagePath relativo +
 *      imageUrl absoluto) — sem link cru no detail;
 *   3. falha do motor → card HONESTO (retryable) e nenhuma URL inventada;
 *   4. turno completo: o card persiste na mensagem (GET /chat) e a imagem
 *      volta pelo /media — sobrevive a recarregar a página/histórico.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.STUDIO_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-image-chat-'));
process.env.LITELLM_URL = 'http://litellm.test';
process.env.LITELLM_MODEL = 'test-model';
process.env.STUDIO_IMAGE_MODEL = 'test-image-model';
process.env.APP_URL = 'https://www.b2base.net';

const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const storage = require('../studio/storage');
const mediaRoute = require('../studio/media-route');

// PNG 1x1 válido (mesmo fixture de studio-image-vision).
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d8b300000000049454e44ae426082', 'hex');

async function startServer({ fetchImpl, llmImpl } = {}) {
  const orig = global.fetch;
  // Gateway LiteLLM é externo (litellm.test) → interceptado; o que aponta
  // para o próprio servidor de teste (127.0.0.1) vai ao fetch REAL.
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('127.0.0.1')) return orig(url, opts);
    if (fetchImpl) return fetchImpl(u, opts);
    throw new Error('fetch inesperado: ' + u);
  };
  const app = express();
  app.use(express.json());
  // A MESMA rota pública do server-prod (mesmo handler de produção).
  app.get('/media/:name', mediaRoute);
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium' });
  prisma.commercialSettings.rows.push({ orgId: 'org-1', productDescription: 'software B2B' });
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    next();
  });
  let llmCalls = 0;
  app.use('/api/studio', createStudioRouter(prisma, {
    overrides: {
      aiDeps: {
        callLlm:
          llmImpl ||
          (async () => ({ content: JSON.stringify({ reply: 'ok', actions: [{ type: 'none' }] }) })),
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html></html>' }),
      },
    },
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, body) => {
    const res = await fetch(`${base}${p.startsWith('/media') ? '' : '/api/studio'}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    let parsed = null;
    try { parsed = JSON.parse(buffer.toString('utf8')); } catch (_e) { /* binário (/media) */ }
    return { res, body: parsed, buffer };
  };
  return {
    prisma,
    api,
    base,
    llmCalls: () => llmCalls,
    restore: () => { global.fetch = orig; },
    close: () => server.close(),
  };
}

// ── 1. rota /media REAL: 200 + Content-Type + bytes; 404 no resto ───────────

test('rota /media (a mesma do server-prod): serve o PNG com status/Content-Type/Cache-Control corretos', async () => {
  const world = await startServer();
  try {
    const name = storage.saveGenerated(PNG, 'png');
    const { res, buffer } = await world.api('GET', `/media/${name}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /image\/png/, 'Content-Type de imagem');
    assert.match(res.headers.get('cache-control') || '', /immutable/, 'cache imutável (nome é hash do conteúdo)');
    assert.deepEqual([...buffer], [...PNG], 'bytes servidos = bytes gerados');
    // Nome inexistente e traversal → 404 seco (nada de HTML/SPA).
    const missing = await world.api('GET', '/media/ffffffffffffffffffffffffffffffff.png');
    assert.equal(missing.res.status, 404);
    const traversal = await world.api('GET', '/media/..%2F..%2Fsecret.png');
    assert.equal(traversal.res.status, 404);
  } finally {
    world.restore();
    world.close();
  }
});

// ── 2. card estruturado: imagePath relativo + imageUrl absoluto ─────────────

test('generate_image: card traz imagePath RELATIVO (chat) + imageUrl ABSOLUTO (e-mail), sem link cru no detail', async () => {
  const world = await startServer({
    fetchImpl: async (u) => {
      if (u.includes('/v1/images/generations')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG.toString('base64') }] }) };
      }
      throw new Error('fetch inesperado: ' + u);
    },
  });
  const { api } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Banner no chat', channels: ['email'] });
    const out = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'generate_image',
      params: { prompt: 'banner de dobradeira industrial azul' },
    });
    assert.equal(out.res.status, 200);
    const card = out.body.data.card;
    assert.equal(card.type, 'image_generated');
    assert.match(card.imagePath, /^\/media\/[a-f0-9]{32}\.png$/, 'caminho relativo canônico para o chat');
    assert.match(card.imageUrl, /^https:\/\/www\.b2base\.net\/media\/[a-f0-9]{32}\.png$/, 'URL absoluta preservada para o e-mail');
    assert.ok(!/Link público da imagem/i.test(card.detail), 'detail não carrega mais link cru — a prévia é o deliverable');
    // O caminho relativo do card SERVE a imagem na origem do app.
    const served = await world.api('GET', card.imagePath);
    assert.equal(served.res.status, 200);
    assert.match(served.res.headers.get('content-type') || '', /image\/png/);
    assert.deepEqual([...served.buffer], [...PNG]);
  } finally {
    world.restore();
    world.close();
  }
});

// ── 3. falha do motor: card honesto com retry — NENHUMA URL inventada ───────

test('generate_image com motor FORA: card retryable sem imageUrl/imagePath (nada de falso sucesso)', async () => {
  const world = await startServer({
    fetchImpl: async (u) => {
      if (u.includes('/v1/images/generations')) {
        return { ok: false, status: 503, json: async () => ({ error: { message: 'motor fora' } }) };
      }
      throw new Error('fetch inesperado: ' + u);
    },
  });
  const { api } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Banner falho', channels: ['email'] });
    const out = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'generate_image',
      params: { prompt: 'banner de pizza artesanal' },
    });
    assert.equal(out.res.status, 200);
    const card = out.body.data.card;
    assert.equal(card.type, 'image_generated');
    assert.match(card.label, /Não consegui gerar/i);
    assert.equal(card.imageUrl, undefined, 'falha NUNCA devolve URL');
    assert.equal(card.imagePath, undefined, 'falha NUNCA devolve caminho');
    assert.equal(card.retryable, true, 'card marca retry explícito');
    assert.match(card.prompt, /pizza/, 'prompt resumido para o chip "tentar de novo"');
  } finally {
    world.restore();
    world.close();
  }
});

// ── 4. histórico: o card persiste na mensagem e a imagem volta pelo /media ──

test('turno completo: card da imagem persiste no histórico (GET /chat) e o arquivo continua servido', async () => {
  const world = await startServer({
    fetchImpl: async (u) => {
      if (u.includes('/v1/images/generations')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG.toString('base64') }] }) };
      }
      throw new Error('fetch inesperado: ' + u);
    },
    llmImpl: async ({ user }) => {
      // 1ª chamada é o roteador de intenção; o turno REAL traz o marcador
      // "NOVA MENSAGEM DO USUÁRIO" (mesmo padrão de studio-agent-platform).
      if (String(user || '').includes('NOVA MENSAGEM DO USUÁRIO')) {
        return {
          content: JSON.stringify({
            reply: 'Gerando seu banner…',
            actions: [{ type: 'generate_image', prompt: 'banner de consultancy industrial' }],
          }),
        };
      }
      return { content: JSON.stringify({ reply: 'Pronto — a imagem está acima.', actions: [{ type: 'none' }] }) };
    },
  });
  const { api } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Banner histórico', channels: ['email'] });
    const turn = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'gere uma imagem de banner industrial' });
    assert.equal(turn.res.status, 200);
    const card = (turn.body.data.cards || []).find((k) => k && k.type === 'image_generated');
    assert.ok(card, 'card da imagem no turno');
    assert.ok(card.imagePath, 'card persistido com imagePath');
    // Histórico (o que o frontend busca ao recarregar a página):
    const history = await api('GET', `/campaigns/${c.data.id}/chat`);
    assert.equal(history.res.status, 200);
    const assistant = (history.body.data || []).filter((m) => m.role === 'assistant');
    const persisted = assistant.flatMap((m) => m.cards || []).find((k) => k && k.type === 'image_generated');
    assert.ok(persisted, 'card da imagem está NO HISTÓRICO');
    assert.match(persisted.imagePath, /^\/media\/[a-f0-9]{32}\.png$/);
    // E o arquivo continua sendo servido depois do turno:
    const served = await world.api('GET', persisted.imagePath);
    assert.equal(served.res.status, 200);
    assert.deepEqual([...served.buffer], [...PNG], 'imagem do histórico abre de verdade');
  } finally {
    world.restore();
    world.close();
  }
});

// ── 5. banner CLICÁVEL (2026-10-27): o botão desenhado na arte é só pixel —
// o bloco image nasce com href = link do botão do próprio e-mail (wa.me).

test('generate_image com attachToEmail: banner herda o href do botão (clique cai no WhatsApp)', async () => {
  const imageBodies = [];
  const world = await startServer({
    fetchImpl: async (u, opts = {}) => {
      if (u.includes('/v1/images/generations')) {
        imageBodies.push(JSON.parse(String(opts.body || '{}')));
        return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG.toString('base64') }] }) };
      }
      throw new Error('fetch inesperado: ' + u);
    },
  });
  const { api, prisma } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Banner clicável', channels: ['email'] });
    prisma.studioContent.rows.push({
      id: 'ce-cta', orgId: 'org-1', campaignId: c.data.id, channel: 'email',
      kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
      subject: 'Máquinas industriais', whatsappText: null,
      emailDoc: {
        blocks: [
          { type: 'text', text: 'Olá {{firstName}}, tudo bem?' },
          { type: 'button', label: 'Falar com a Arthur Company', url: 'https://wa.me/5512996399943' },
        ],
      },
    });

    const out = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'generate_image',
      params: { prompt: 'banner de máquinas industriais com botão verde', attachToEmail: true },
    });
    assert.equal(out.res.status, 200);
    const card = out.body.data.card;
    assert.equal(card.type, 'image_generated');
    assert.equal(card.insertedIntoEmail, true, 'banner inserido no e-mail');

    const row = prisma.studioContent.rows.find((r) => r.id === 'ce-cta');
    const [imageBlock] = row.emailDoc.blocks;
    assert.equal(imageBlock.type, 'image');
    assert.match(imageBlock.src, /^https:\/\/www\.b2base\.net\/media\//, 'src absoluto para o cliente de e-mail');
    assert.equal(imageBlock.href, 'https://wa.me/5512996399943', 'banner nasce CLICÁVEL apontando para a conversa');
    assert.ok(
      row.emailDoc.blocks.some((b) => b.type === 'button' && b.url === 'https://wa.me/5512996399943'),
      'bloco button original permanece (mesmo destino do clique)'
    );
    // ARTE LIMPA (2026-10-27): a imagem para e-mail NÃO desenha o botão — o
    // CTA de verdade é HTML. A diretriz vai no prompt do motor de imagem.
    assert.equal(imageBodies.length, 1, 'uma geração de imagem');
    const sentPrompt = String(imageBodies[0].prompt || '');
    assert.match(sentPrompt, /NÃO desenhe botões/i, 'diretriz de arte limpa no prompt do gateway');
    assert.match(sentPrompt, /máquinas industriais/, 'descrição do usuário preservada');
    // CTA REAL no card: o chat mostra o botão de verdade separado do zoom.
    assert.equal(card.ctaUrl, 'https://wa.me/5512996399943', 'card traz o link do CTA');
    assert.match(card.ctaLabel, /Falar com a Arthur Company/, 'card traz o rótulo do botão');
  } finally {
    world.restore();
    world.close();
  }
});

// ── 6. LINK DE PÁGINA (álbum externo) → imagem direta resolvida + BYTES ─────
// O dono cola o link de uma PÁGINA (ex.: álbum de imagens em qualquer host) e
// o sistema resolve o link direto (og:image), BAIXA os bytes para o NOSSO
// storage (banner não depende do host de origem) e insere o banner com o CTA
// herdado. Agnóstico de host — nenhum caso especial de site no código.

test('imageUrl de PÁGINA (álbum externo): resolve link direto, baixa os bytes e insere o banner com CTA', async () => {
  const IMG_BYTES = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d8b300000000049454e44ae426082',
    'hex'
  );
  const seen = [];
  const world = await startServer({
    fetchImpl: async (u, opts = {}) => {
      const url = String(u);
      seen.push(url);
      if (url === 'https://galeria.exemplo.com/a/bbhIHpt') {
        return {
          ok: true, status: 200,
          text: async () => '<html><head><meta property="og:image" content="https://cdn.exemplo.com/machines123.jpg" /></head><body>album</body></html>',
          json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      if (url === 'https://cdn.exemplo.com/machines123.jpg') {
        return {
          ok: true, status: 200,
          text: async () => '', json: async () => ({}),
          arrayBuffer: async () => IMG_BYTES.buffer.slice(IMG_BYTES.byteOffset, IMG_BYTES.byteOffset + IMG_BYTES.byteLength),
        };
      }
      throw new Error('fetch inesperado: ' + url);
    },
  });
  const { api, prisma } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Banner do álbum', channels: ['email'] });
    prisma.studioContent.rows.push({
      id: 'ce-album', orgId: 'org-1', campaignId: c.data.id, channel: 'email',
      kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
      subject: 'Máquinas', whatsappText: null,
      emailDoc: {
        blocks: [
          { type: 'text', text: 'Olá {{firstName}}, tudo bem?' },
          { type: 'button', label: 'Falar com a Arthur Company', url: 'https://wa.me/5512996399943', color: '#25D366' },
        ],
      },
    });

    // 1ª chamada: gate de confirmação; 2ª: com o selo → executa.
    const gated = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'edit_content',
      params: { channel: 'email', imageUrl: 'https://galeria.exemplo.com/a/bbhIHpt' },
    });
    assert.ok(gated.body.data.card.type === 'confirm_change', 'gate pede confirmação');
    const out = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'edit_content',
      params: { channel: 'email', imageUrl: 'https://galeria.exemplo.com/a/bbhIHpt', confirmed: true },
    });
    assert.equal(out.res.status, 200);

    const row = prisma.studioContent.rows.find((r) => r.id === 'ce-album');
    const [imageBlock] = row.emailDoc.blocks;
    assert.equal(imageBlock.type, 'image', 'banner no topo');
    // Os BYTES ficam NO NOSSO storage (banner não depende do host de origem).
    assert.match(imageBlock.src, /^https?:\/\/[^/]+\/media\/[a-f0-9]{32}\.(png|jpe?g)$/, 'src do NOSSO storage (servível e embutível por CID)');
    const promoted = imageBlock.src.split('/media/')[1];
    assert.deepEqual(require('../studio/storage').readGenerated(promoted), IMG_BYTES, 'bytes reais preservados');
    assert.equal(imageBlock.href, 'https://wa.me/5512996399943', 'CTA herdado');
    // A resolução passou pela página do álbum E pelo download da imagem direta.
    assert.ok(seen.some((u) => u.includes('galeria.exemplo.com/a/bbhIHpt')), 'página foi aberta para resolver o direto');
    assert.ok(seen.some((u) => u.includes('cdn.exemplo.com/machines123.jpg')), 'imagem direta baixada');
  } finally {
    world.restore();
    world.close();
  }
});

test('imageUrl de página BLOQUEADA (429) → card honesto com os caminhos, sem inserir nada', async () => {
  const world = await startServer({
    fetchImpl: async (u) => {
      if (String(u).includes('galeria.exemplo.com')) {
        return { ok: false, status: 429, text: async () => '', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
      }
      throw new Error('fetch inesperado: ' + u);
    },
  });
  const { api, prisma } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Álbum bloqueado', channels: ['email'] });
    prisma.studioContent.rows.push({
      id: 'ce-429', orgId: 'org-1', campaignId: c.data.id, channel: 'email',
      kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
      subject: 'S', whatsappText: null,
      emailDoc: { blocks: [{ type: 'text', text: 'Olá' }, { type: 'button', label: 'B', url: 'https://wa.me/5512996399943' }] },
    });

    // 1ª volta: gate. 2ª volta (selo): 429 do host vira ERRO 400 com os
    // caminhos reais (a rota /actions propaga erros exposable direto).
    await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'edit_content',
      params: { channel: 'email', imageUrl: 'https://galeria.exemplo.com/a/bbhIHpt' },
    });
    const res = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'edit_content',
      params: { channel: 'email', imageUrl: 'https://galeria.exemplo.com/a/bbhIHpt', confirmed: true },
    });
    assert.equal(res.res.status, 400);
    assert.match(res.body.message, /429/, 'diz que o site bloqueou (429)');
    assert.match(res.body.message, /link DIRETO|anexa o arquivo/i, 'aponta os caminhos reais');
    const row = prisma.studioContent.rows.find((r) => r.id === 'ce-429');
    assert.ok(!row.emailDoc.blocks.some((b) => b.type === 'image'), 'nada inserido com a fonte bloqueada');
  } finally {
    world.restore();
    world.close();
  }
});

// ── 7. BANNER ÚNICO (2026-10-29): aplicar outra imagem TROCA, nunca empilha ──
// Caso real: e-mail saiu com 10+ imagens porque cada edit_content prependava
// um bloco image novo. Agora a inserção remove as imagens anteriores.

test('edit_content com imageUrl TROCA o banner anterior — o e-mail fica com UMA imagem só', async () => {
  const world = await startServer({});
  const { api, prisma } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Banner único', channels: ['email'] });
    prisma.studioContent.rows.push({
      id: 'ce-uma', orgId: 'org-1', campaignId: c.data.id, channel: 'email',
      kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
      subject: 'S', whatsappText: null,
      emailDoc: {
        blocks: [
          { type: 'image', src: 'https://cdn.velha.com/banner-antigo.jpg' },
          { type: 'image', src: 'https://cdn.velha.com/banner-antigo-2.png' },
          { type: 'text', text: 'Olá' },
          { type: 'button', label: 'B', url: 'https://wa.me/5512996399943' },
        ],
      },
    });

    // Direta (termina em .jpg) nem passa por resolução — vai verbatim.
    const gated = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'edit_content',
      params: { channel: 'email', imageUrl: 'https://cdn.exemplo.com/banner-novo.jpg' },
    });
    assert.ok(gated.body.data.card.type === 'confirm_change', 'gate pede confirmação');
    const out = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'edit_content',
      params: { channel: 'email', imageUrl: 'https://cdn.exemplo.com/banner-novo.jpg', confirmed: true },
    });
    assert.equal(out.res.status, 200);

    const row = prisma.studioContent.rows.find((r) => r.id === 'ce-uma');
    const images = row.emailDoc.blocks.filter((b) => b.type === 'image');
    assert.equal(images.length, 1, 'UMA imagem só no e-mail');
    assert.equal(images[0].src, 'https://cdn.exemplo.com/banner-novo.jpg', 'a NOVA (a antiga saiu)');
    assert.ok(row.emailDoc.blocks.some((b) => b.type === 'text'), 'texto intacto');
    assert.ok(row.emailDoc.blocks.some((b) => b.type === 'button'), 'botão intacto');
  } finally {
    world.restore();
    world.close();
  }
});

test('edit_content removeImage:true TIRA a imagem do e-mail e mantém o resto', async () => {
  const world = await startServer({});
  const { api, prisma } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Sem imagem', channels: ['email'] });
    prisma.studioContent.rows.push({
      id: 'ce-remove', orgId: 'org-1', campaignId: c.data.id, channel: 'email',
      kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
      subject: 'S', whatsappText: null,
      emailDoc: {
        blocks: [
          { type: 'image', src: 'https://cdn.exemplo.com/banner.jpg' },
          { type: 'text', text: 'Olá' },
          { type: 'button', label: 'B', url: 'https://wa.me/5512996399943' },
        ],
      },
    });

    const gated = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'edit_content',
      params: { channel: 'email', removeImage: true },
    });
    assert.ok(gated.body.data.card.type === 'confirm_change', 'gate pede confirmação');
    const out = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'edit_content',
      params: { channel: 'email', removeImage: true, confirmed: true },
    });
    assert.equal(out.res.status, 200);

    const row = prisma.studioContent.rows.find((r) => r.id === 'ce-remove');
    assert.ok(!row.emailDoc.blocks.some((b) => b.type === 'image'), 'nenhuma imagem sobra');
    assert.ok(row.emailDoc.blocks.some((b) => b.type === 'text'), 'texto intacto');
    assert.ok(row.emailDoc.blocks.some((b) => b.type === 'button'), 'botão intacto');
  } finally {
    world.restore();
    world.close();
  }
});

// ── 8. CTA com PLACEHOLDER (2026-10-29): domínio de exemplo nunca vira link ──
// Caso real: o modelo gerou o botão apontando para www.exemplo.com.br e o
// clique levava o lead a um site fictício em vez do WhatsApp.

test('edit_content com ctaUrl PLACEHOLDER (domínio de exemplo) → 400 honesto pedindo o link real', async () => {
  const world = await startServer({});
  const { api, prisma } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'CTA real', channels: ['email'] });
    prisma.studioContent.rows.push({
      id: 'ce-cta', orgId: 'org-1', campaignId: c.data.id, channel: 'email',
      kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
      subject: 'S', whatsappText: null,
      emailDoc: { blocks: [{ type: 'text', text: 'Olá' }] },
    });

    // Falha ANTES do gate de confirmação — o dono não confirma uma troca
    // que falharia (o modelo inventou o domínio, o servidor recusa na hora).
    const res = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'edit_content',
      params: { channel: 'email', ctaUrl: 'https://www.exemplo.com.br', confirmed: true },
    });
    assert.equal(res.res.status, 400);
    assert.match(res.body.message, /EXEMPLO|placeholder/i, 'explica que é placeholder');
    assert.match(res.body.message, /wa\.me|REAL/i, 'aponta o formato do link real');
    const row = prisma.studioContent.rows.find((r) => r.id === 'ce-cta');
    assert.ok(!row.emailDoc.blocks.some((b) => b.type === 'button'), 'nada inserido com link fictício');
  } finally {
    world.restore();
    world.close();
  }
});

test('edit_content com ctaUrl REAL (wa.me) troca o botão normalmente', async () => {
  const world = await startServer({});
  const { api, prisma } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'CTA wa.me', channels: ['email'] });
    prisma.studioContent.rows.push({
      id: 'ce-cta-real', orgId: 'org-1', campaignId: c.data.id, channel: 'email',
      kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
      subject: 'S', whatsappText: null,
      emailDoc: { blocks: [{ type: 'text', text: 'Olá' }] },
    });

    const gated = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'edit_content',
      params: { channel: 'email', ctaUrl: 'https://wa.me/5512996399943' },
    });
    assert.ok(gated.body.data.card.type === 'confirm_change', 'gate pede confirmação');
    const out = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'edit_content',
      params: { channel: 'email', ctaUrl: 'https://wa.me/5512996399943', confirmed: true },
    });
    assert.equal(out.res.status, 200);
    const row = prisma.studioContent.rows.find((r) => r.id === 'ce-cta-real');
    const btn = row.emailDoc.blocks.find((b) => b.type === 'button');
    assert.ok(btn, 'botão criado');
    assert.equal(btn.url, 'https://wa.me/5512996399943', 'link do WhatsApp real');
  } finally {
    world.restore();
    world.close();
  }
});
