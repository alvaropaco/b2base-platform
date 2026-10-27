'use strict';

/**
 * test/studio-email-renderer.test.js — US5 do Campaign Studio (T052).
 *
 * Documento de blocos → MJML → HTML responsivo (T053): preview usa a MESMA
 * função do envio (SC-006), variável sem dado vira fallback — nunca literal
 * (FR-033/SC-011), blocos condicionais resolvidos POR LEAD no render
 * (FR-034) e UTM anexada aos links (FR-037).
 */

const test = require('node:test');
const assert = require('node:assert');
const { renderEmail, resolveConditions } = require('../studio/email-renderer');

const LEAD = {
  id: 'lead-1',
  companyName: 'MB Máquinas',
  contactName: 'Ana Silva',
  city: 'São Paulo',
  state: 'SP',
  industry: 'indústria metalúrgica',
  employees: 120,
};

const DOC = {
  blocks: [
    { type: 'text', text: 'Olá {{firstName}}, tudo bem? Sobre a {{companyName}}:' },
    {
      type: 'text',
      text: 'Vimos que a {{companyName}} é do setor de tecnologia.',
      condition: { field: 'industry', op: 'contains', value: 'tecnologia' },
    },
    {
      type: 'text',
      text: 'Para indústrias como a sua, temos algo especial.',
      condition: { field: 'industry', op: 'contains', value: 'indústria' },
    },
    { type: 'button', label: 'Agendar conversa', url: 'https://exemplo.com/cta?foo=1' },
    { type: 'text', text: 'Não quer mais receber? Faça o descadastro.' },
  ],
};

test('renderEmail: blocos → HTML responsivo com texto interpolado', () => {
  const result = renderEmail(DOC, LEAD);
  assert.ok(result.html.includes('<html'), 'HTML completo (MJML compilado)');
  assert.ok(result.html.includes('Olá Ana'), 'variável firstName resolvida');
  assert.ok(result.html.toUpperCase().includes('MB MÁQUINAS'.toUpperCase()) || result.html.includes('MB Máquinas'));
  assert.ok(result.text.includes('descadastro'), 'texto plano acompanha o render');
});

test('blocos condicionais resolvidos POR LEAD no render (FR-034)', () => {
  // LEAD é metalúrgica: bloco "tecnologia" some, bloco "indústrias" fica.
  const result = renderEmail(DOC, LEAD);
  assert.ok(!result.html.includes('setor de tecnologia'), 'condição falsa é removida');
  assert.ok(result.html.includes('indústrias como a sua'), 'condição verdadeira permanece');
  // Lead de tecnologia: o inverso.
  const techLead = { ...LEAD, industry: 'tecnologia' };
  const techResult = renderEmail(DOC, techLead);
  assert.ok(techResult.html.includes('setor de tecnologia'));
  assert.ok(!techResult.html.includes('indústrias como a sua'));
});

test('preview === envio: mesma função, mesmo resultado (SC-006)', () => {
  const a = renderEmail(DOC, LEAD);
  const b = renderEmail(DOC, LEAD);
  assert.equal(a.html, b.html);
  assert.deepEqual(resolveConditions(DOC.blocks, LEAD).map((b) => b.type), resolveConditions(DOC.blocks, LEAD).map((b) => b.type));
});

test('variável sem dado → fallback configurável, nunca literal (FR-033/SC-011)', () => {
  const doc = { blocks: [{ type: 'text', text: 'Bem-vindo, {{firstName}} da {{city}}!' }] };
  const noName = renderEmail(doc, { ...LEAD, contactName: null }, { fallbacks: { firstName: 'pessoal' } });
  assert.ok(noName.text.includes('Bem-vindo, pessoal'), 'fallback aplicado');
  assert.ok(!noName.text.includes('{{'), 'nenhuma variável literal vai ao lead');
  // Sem fallback configurado → string vazia no lugar.
  const silent = renderEmail(doc, { ...LEAD, contactName: null });
  assert.ok(silent.text.includes('Bem-vindo,  da'), 'fallback default = vazio');
});

test('UTM automática anexada aos links da campanha (FR-037)', () => {
  const result = renderEmail(DOC, LEAD, {
    utmTemplate: { utmSource: 'studio', utmMedium: 'email', utmCampaign: 'lancamento-erp' },
  });
  assert.ok(
    result.html.includes('utm_source=studio') &&
      result.html.includes('utm_medium=email') &&
      result.html.includes('utm_campaign=lancamento-erp'),
    'UTM aplicada ao CTA'
  );
  // Sem UTM configurada → link intacto.
  const plain = renderEmail(DOC, LEAD);
  assert.ok(plain.html.includes('https://exemplo.com/cta?foo=1'), 'URL original preservada sem UTM');
});

// ── Checks de qualidade (T058: spam, links, a11y — FR-036) ─────────────────

const { createFakePrisma } = require('./helpers/fake-prisma');
const compliance = require('../studio/compliance-service');

test('checks: spam heurístico, link quebrado (block) e imagem sem alt', async () => {
  const prisma = createFakePrisma();
  prisma.studioCampaign.rows.push({ id: 'camp-q', orgId: 'org-1', channels: ['email'], status: 'in_review' });
  prisma.studioContent.rows.push({
    id: 'content-q', orgId: 'org-1', campaignId: 'camp-q', channel: 'email',
    subject: 'GRÁTIS GRÁTIS GRÁTIS!!!', preheader: null,
    whatsappText: null, linkedinText: null,
    emailDoc: { blocks: [
      { type: 'text', text: 'Oferta imperdível, oferta garantida!!! Clique aqui!!!' },
      { type: 'image', src: 'https://img/exemplo.png' },
      { type: 'button', label: 'Ver', url: 'https://quebrado.exemplo.com' },
      { type: 'text', text: 'descadastro disponível' },
    ] },
    origin: 'manual', variantLabel: 'A', kind: 'base', stepIndex: 1,
    editHistory: [], ctaUrl: null, tone: null,
  });
  const campaign = prisma.studioCampaign.rows[0];
  const result = await compliance.runQualityChecks(prisma, campaign, {
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
  });
  assert.ok(result.spamScore > 0, 'score de spam > 0');
  assert.ok(result.items.some((i) => i.detail.includes('Link inacessível')), 'link quebrado → block');
  assert.ok(result.items.some((i) => i.detail.includes('alt')), 'imagem sem alt apontada');
  assert.equal(result.level, 'block', 'link quebrado bloqueia');
});

test('checks: conteúdo limpo → ok, sem itens', async () => {
  const prisma = createFakePrisma();
  prisma.studioCampaign.rows.push({ id: 'camp-clean', orgId: 'org-1', channels: ['email'], status: 'in_review' });
  prisma.studioContent.rows.push({
    id: 'content-clean', orgId: 'org-1', campaignId: 'camp-clean', channel: 'email',
    subject: 'Proposta de parceria', preheader: null, whatsappText: null, linkedinText: null,
    emailDoc: { blocks: [
      { type: 'text', text: 'Olá! Gostaria de apresentar nossa solução.' },
      { type: 'image', src: 'https://img/exemplo.png', alt: 'Diagrama da solução' },
      { type: 'button', label: 'Agendar', url: 'https://ok.exemplo.com' },
    ] },
    origin: 'manual', variantLabel: 'A', kind: 'base', stepIndex: 1,
    editHistory: [], ctaUrl: null, tone: null,
  });
  const result = await compliance.runQualityChecks(prisma, prisma.studioCampaign.rows[0], {
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(result.spamScore, 0);
  assert.equal(result.level, 'ok');
});

// ── Imagem por LINK no e-mail (2026-10-16): banner com src/alt e href
// opcional (banner clicável, UTM aplicada ao clique — FR-037).

test('renderEmail: bloco image por link → <img> com src/alt (banner full-width)', () => {
  const { html } = renderEmail({
    blocks: [{ type: 'image', src: 'https://cdn.exemplo.com/banner-dobradeira.jpg', alt: 'Dobradeira industrial' }],
  }, LEAD);
  assert.ok(html.includes('src="https://cdn.exemplo.com/banner-dobradeira.jpg"'), 'src do link no HTML');
  assert.ok(html.includes('alt="Dobradeira industrial"'), 'alt presente');
  assert.ok(!html.includes('<a href'), 'sem href não vira link');
});

test('renderEmail: image com href → banner CLICÁVEL com UTM da campanha', () => {
  const { html } = renderEmail({
    blocks: [{ type: 'image', src: 'https://cdn.exemplo.com/banner.jpg', alt: 'Banner', href: 'https://exemplo.com/cta' }],
  }, LEAD, { utmTemplate: { utmSource: 'email', utmCampaign: 'dobradeiras' } });
  const anchor = html.match(/<a href="([^"]+)"[^>]*><img/);
  assert.ok(anchor, 'img embrulhada em <a>');
  assert.ok(anchor[1].startsWith('https://exemplo.com/cta?'), 'href do clique');
  assert.ok(anchor[1].includes('utm_campaign=dobradeiras'), 'UTM aplicada ao clique (FR-037)');
});

// ── 2026-10-27: banner SEM href herda o link do BOTÃO do próprio e-mail ─────
// O botão desenhado dentro do banner gerado é só pixel — o clique no banner
// tem que cair na MESMA conversa do WhatsApp (pedido do dono). A regra vale
// para blocos salvos ANTES da correção: o default é no RENDER (envio/teste/
// prévia), não só na inserção.

const { linkBannerToCta, emailDocToHtml } = require('../studio/channel-bridge');

test('linkBannerToCta: imagem sem href herda a url do bloco button', () => {
  const doc = linkBannerToCta({
    blocks: [
      { type: 'image', src: 'https://cdn.exemplo.com/banner.png', alt: 'Banner' },
      { type: 'text', text: 'Olá!' },
      { type: 'button', label: 'Falar com a Arthur Company', url: 'https://wa.me/5512996399943' },
    ],
  });
  assert.equal(doc.blocks[0].href, 'https://wa.me/5512996399943', 'banner clicável para o wa.me');
  // O bloco button original permanece intacto.
  assert.equal(doc.blocks[2].type, 'button');
});

test('linkBannerToCta: imagem COM href próprio não é sobrescrita; sem button nada muda', () => {
  const comHref = linkBannerToCta({
    blocks: [
      { type: 'image', src: 'https://cdn.exemplo.com/a.png', href: 'https://exemplo.com/proprio' },
      { type: 'button', label: 'B', url: 'https://wa.me/1' },
    ],
  });
  assert.equal(comHref.blocks[0].href, 'https://exemplo.com/proprio', 'href explícito vence');
  const semBotao = linkBannerToCta({ blocks: [{ type: 'image', src: 'https://cdn.exemplo.com/b.png' }] });
  assert.equal(semBotao.blocks[0].href, undefined, 'sem button, sem href inventado');
  assert.equal(linkBannerToCta(null), null, 'emailDoc ausente não quebra');
});

test('emailDocToHtml: banner salvo SEM href (campanha antiga) sai CLICÁVEL no HTML do envio', () => {
  const html = emailDocToHtml({
    blocks: [
      { type: 'image', src: 'https://cdn.exemplo.com/banner-maquinas.png', alt: 'Banner' },
      { type: 'text', text: 'Olá {{firstName}}, tudo bem?' },
      { type: 'button', label: 'Falar com a Arthur Company', url: 'https://wa.me/5512996399943' },
    ],
  }, LEAD);
  assert.ok(html, 'HTML gerado');
  const anchor = html.match(/<a href="([^"]+)"[^>]*><img/);
  assert.ok(anchor, 'banner embrulhado em <a>');
  assert.ok(anchor[1].includes('wa.me/5512996399943'), 'clique do banner cai na conversa do WhatsApp');
  assert.ok(html.includes('href="https://wa.me/5512996399943"'), 'botão de texto também linkado');
});

test('emailDocToHtml: sem blocos → null (chamador cai no texto plano)', () => {
  assert.equal(emailDocToHtml(null, LEAD), null);
  assert.equal(emailDocToHtml({ blocks: [] }, LEAD), null);
});

// ── 2026-10-27: CTA REAL — URL sanitizada + botão com cor editável ──────────
// O botão verde "Fale com a gente no WhatsApp" é HTML estilizado (texto/cor/
// URL editáveis), NUNCA desenho dentro da imagem. Links: só http/https
// absoluto (wa.me incluído, parâmetros preservados); protocolo perigoso é
// bloqueado e credenciais na URL nunca saem no HTML.

const { sanitizeLink, normalizeHexColor } = require('../studio/email-renderer');

test('sanitizeLink: http/https passa (wa.me com path e query preservados)', () => {
  assert.equal(sanitizeLink('https://wa.me/5512996399943'), 'https://wa.me/5512996399943');
  assert.equal(
    sanitizeLink('https://wa.me/5512996399943?text=Ol%C3%A1%20Arthur'),
    'https://wa.me/5512996399943?text=Ol%C3%A1%20Arthur',
    'query preservada'
  );
  assert.equal(sanitizeLink(' http://exemplo.com/promo?a=1&b=2 '), 'http://exemplo.com/promo?a=1&b=2');
});

test('sanitizeLink: javascript:, data:, relativa e vazia → BLOQUEADAS', () => {
  assert.equal(sanitizeLink('javascript:alert(1)'), '');
  assert.equal(sanitizeLink('data:text/html;base64,PHNjcmlwdD4='), '');
  assert.equal(sanitizeLink('JAVASCRIPT:void(0)'), '', 'protocolo case-insensitive também bloqueia');
  assert.equal(sanitizeLink('/pagina-relativa'), '');
  assert.equal(sanitizeLink('não é url'), '');
  assert.equal(sanitizeLink(''), '');
  assert.equal(sanitizeLink(null), '');
});

test('sanitizeLink: credenciais na URL (user:pass@host) NUNCA saem no link', () => {
  const clean = sanitizeLink('https://user:secreta@exemplo.com/oferta?a=1');
  assert.ok(clean.startsWith('https://exemplo.com/oferta'), 'userinfo removido: ' + clean);
  assert.ok(!clean.includes('secreta'));
  assert.ok(clean.includes('a=1'), 'query preservada');
});

test('normalizeHexColor: só #rgb/#rrggbb; resto → null', () => {
  assert.equal(normalizeHexColor('#25D366'), '#25d366');
  assert.equal(normalizeHexColor('#F60'), '#f60');
  assert.equal(normalizeHexColor('green'), null);
  assert.equal(normalizeHexColor('#25D366; background:url(x)'), null, 'injeção via style bloqueada');
  assert.equal(normalizeHexColor(''), null);
});

test('renderEmail: button com color green → estilo inline usa a COR do bloco', () => {
  const { html } = renderEmail({
    blocks: [{ type: 'button', label: 'Falar com a gente no WhatsApp', url: 'https://wa.me/5512996399943', color: '#25D366' }],
  }, LEAD);
  assert.ok(html.includes('background:#25d366'), 'cor verde do CTA');
  assert.ok(html.includes('<a href="https://wa.me/5512996399943"'), 'link real no CTA');
  assert.ok(html.includes('Falar com a gente no WhatsApp'), 'texto do CTA');
});

test('renderEmail: button SEM color mantém o padrão atual (indigo)', () => {
  const { html } = renderEmail({
    blocks: [{ type: 'button', label: 'Agendar', url: 'https://exemplo.com' }],
  }, LEAD);
  assert.ok(html.includes('background:#4f46e5'), 'default inalterado');
});

test('renderEmail: button com URL PERIGOSA → styled span SEM link (nada de href)', () => {
  const { html } = renderEmail({
    blocks: [{ type: 'button', label: 'Clique', url: 'javascript:alert(1)' }],
  }, LEAD);
  assert.ok(!html.includes('<a href'), 'nenhum link perigoso no HTML');
  assert.ok(html.includes('Clique'), 'texto permanece (honesto, sem link)');
});
