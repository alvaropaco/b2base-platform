'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  normalizePhone,
  toChatId,
  phoneFromChatId,
  renderTemplate,
  isOptOutMessage,
  idempotencyKey,
  validateTemplateMessage,
} = require('../whatsapp-utils');

test('normalizePhone: BR number gets 55 prefix', () => {
  assert.strictEqual(normalizePhone('(11) 98765-4321'), '5511987654321');
  assert.strictEqual(normalizePhone('11 98765 4321'), '5511987654321');
  assert.strictEqual(normalizePhone('+55 11 98765-4321'), '5511987654321');
});

test('normalizePhone: already E.164 kept', () => {
  assert.strictEqual(normalizePhone('5511987654321'), '5511987654321');
});

test('normalizePhone: invalid returns null', () => {
  assert.strictEqual(normalizePhone(''), null);
  assert.strictEqual(normalizePhone(null), null);
});

test('toChatId/phoneFromChatId round-trip', () => {
  assert.strictEqual(toChatId('(11) 98765-4321'), '5511987654321@c.us');
  assert.strictEqual(phoneFromChatId('5511987654321@c.us'), '5511987654321');
});

test('renderTemplate: substitutes known vars and sanitizes', () => {
  const lead = { companyName: 'Acme\nIndustria Ltda', tradeName: 'Acme', industry: 'Software', city: 'São Paulo', cnpjPartners: [{ name: 'João Silva', qual: 'CEO' }] };
  const out = renderTemplate('Olá {{firstName}}, da {{companyName}} ({{industry}}) em {{city}}. {{jobTitle}}', lead);
  assert.ok(out.includes('João'), 'firstName derivado do sócio');
  assert.ok(out.includes('Software'));
  assert.ok(out.includes('São Paulo'));
  assert.ok(!out.includes('\n'), 'control chars removidos');
  assert.ok(!/\{\{/.test(out), 'placeholders não resolvidos removidos');
});

test('renderTemplate: unresolved placeholders removed', () => {
  const out = renderTemplate('Olá {{firstName}}, {{unknown}}!', { companyName: 'X' });
  assert.ok(!out.includes('{{unknown}}'));
});

test('isOptOutMessage: keyword variations', () => {
  assert.ok(isOptOutMessage('STOP'));
  assert.ok(isOptOutMessage('sair'));
  assert.ok(isOptOutMessage('NAO QUERO'));
  assert.ok(isOptOutMessage('não quero mais'));
  assert.ok(isOptOutMessage('PARAR'));
  assert.ok(isOptOutMessage('cancelar'));
  assert.ok(isOptOutMessage('Por favor, STOP'));
  assert.ok(!isOptOutMessage('Olá, podemos conversar?'));
  assert.ok(!isOptOutMessage('quero falar sobre a proposta'));
});

test('idempotencyKey: deterministic and stable', () => {
  const a = idempotencyKey('camp1', 'lead1', 2);
  const b = idempotencyKey('camp1', 'lead1', 2);
  const c = idempotencyKey('camp1', 'lead1', 3);
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

// ── Guard de ingestão de template (007 — T003) ──────────────────────────────
test('validateTemplateMessage: template válido passa', () => {
  const out = validateTemplateMessage('Olá {{firstName}}, tudo bem? A {{companyName}} atua em {{industry}}.');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.reason, null);
});

test('validateTemplateMessage: vazio rejeita', () => {
  assert.strictEqual(validateTemplateMessage('').ok, false);
  assert.strictEqual(validateTemplateMessage('   ').reason, 'empty');
  assert.strictEqual(validateTemplateMessage(null).reason, 'empty');
});

test('validateTemplateMessage: BLOCKLIST rejeita (blocked_claim)', () => {
  const out = validateTemplateMessage('Olá {{firstName}}, temos desconto especial para a {{companyName}}!');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'blocked_claim');
});

test('validateTemplateMessage: acima do limite rejeita (too_long)', () => {
  const out = validateTemplateMessage('a'.repeat(601));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'too_long');
});

test('validateTemplateMessage: placeholder desconhecido rejeita (unknown_placeholder)', () => {
  const out = validateTemplateMessage('Olá {{firstName}}, o plano custa {{preco}}.');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'unknown_placeholder');
});

test('validateTemplateMessage: maxLength custom (email aceita texto longo)', () => {
  const body = `Olá {{firstName}},\n\n${'Detalhe do contexto comercial. '.repeat(30)}`;
  assert.ok(body.length > 600);
  assert.strictEqual(validateTemplateMessage(body, { maxLength: 5000 }).ok, true);
});

// ── firstName pela pessoa de contato (007 — T013, US2) ──────────────────────
test('US2 firstName: pessoa de contato tem precedência sobre sócio/empresa', () => {
  const lead = {
    contactName: 'Mariana Souza',
    companyName: 'Acme Ltda', tradeName: 'Acme',
    cnpjPartners: [{ name: 'João Silva', qual: 'Sócio' }],
  };
  const out = renderTemplate('Olá {{firstName}}!', lead);
  assert.ok(out.includes('Mariana'), `esperava "Mariana" em "${out}"`);
  assert.ok(!out.includes('João'), 'sócio só entra se não houver contato');
  assert.ok(!out.includes('Acme'), 'empresa nunca é tratada como pessoa');
});

test('US2 firstName: sem contato, usa o sócio (pessoa real)', () => {
  const lead = {
    companyName: 'Acme Ltda', tradeName: 'Acme',
    cnpjPartners: [{ name: 'João Silva', qual: 'Sócio' }],
  };
  const out = renderTemplate('Olá {{firstName}}!', lead);
  assert.ok(out.includes('João'), `esperava o sócio em "${out}"`);
});

test('US2 firstName: sem contato nem sócio → saudação sem nome, nunca nome de empresa', () => {
  const lead = { companyName: 'NOVAURORA Comércio', tradeName: 'NOVAURORA', cnpjPartners: null };
  const out = renderTemplate('Olá {{firstName}}, tudo bem?', lead);
  assert.strictEqual(out, 'Olá, tudo bem?');
  assert.ok(!out.includes('NOVAURORA'), 'empresa nunca vira "pessoa" na saudação');
  assert.ok(!out.includes('{{'), 'placeholder não vaza');
});

test('US2 firstName: placeholder vazio em outros formatos não quebra a frase', () => {
  const lead = { companyName: 'X', tradeName: null, cnpjPartners: null };
  assert.strictEqual(renderTemplate('Olá {{firstName}}!', lead), 'Olá!');
  assert.strictEqual(renderTemplate('Bom dia {{firstName}}. Tudo bem?', lead), 'Bom dia. Tudo bem?');
  // com nome, o comportamento normal é preservado
  const comNome = renderTemplate('Bom dia {{firstName}}. Tudo bem?', { ...lead, contactName: 'Ana' });
  assert.strictEqual(comNome, 'Bom dia Ana. Tudo bem?');
});

test('QA 2026-10-06: apelido snake_case ({{first_name}}) resolve no render — conteúdo antigo não perde variável', () => {
  const lead = { contactName: 'Ana Souza', companyName: 'Acme', city: 'Joinville', industry: 'Metalurgia' };
  const utils = require('../whatsapp-utils');
  const out = utils.renderTemplate('Oi {{first_name}} da {{company_name}} em {{city}}?', lead);
  assert.strictEqual(out, 'Oi Ana da Acme em Joinville?');
  // Canônico segue intacto.
  assert.strictEqual(utils.renderTemplate('Oi {{firstName}}!', lead), 'Oi Ana!');
});
