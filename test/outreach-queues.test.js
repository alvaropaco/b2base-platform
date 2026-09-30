'use strict';

/**
 * test/outreach-queues.test.js — Queue de Bull é SINGLETON por nome
 * (incidente 2026-09-30): createQueue/makeQueue chamados por operação
 * (fluxo de envio, dns-verify, reengagement, metrics) instanciavam uma
 * Bull Queue nova a cada chamada — cada uma abre 2+ conexões Redis que
 * nunca fecham — derrubando o Redis no maxclients. Fake Bull conta
 * construções e registra process() para provar: mesma queue, um process.
 */

const test = require('node:test');
const assert = require('node:assert');

let queues;
let FakeBull;

test.beforeEach(() => {
  // Fake Bull injetado ANTES do primeiro require do módulo (padrão _set*ForTests).
  const constructed = [];
  FakeBull = class {
    constructor(name, opts) {
      this.name = name;
      this.opts = opts;
      this.processCalls = 0;
      constructed.push(name);
    }

    process(_concurrency, fn) {
      if (this.processCalls > 0) throw new Error('processor já definido nesta instância');
      this.processCalls += 1;
      this.processor = fn;
    }

    async add() {
      return { id: 'job-1' };
    }

    async close() {}
  };
  FakeBull.constructed = constructed;

  delete require.cache[require.resolve('../outreach-queues')];
  queues = require('../outreach-queues');
  queues._setBullForTests(FakeBull);
});

test('createQueue: mesma queue name → MESMA instância, construída UMA vez', () => {
  const a = queues.createQueue('outreach:message-send');
  const b = queues.createQueue('outreach:message-send');
  assert.equal(a, b, 'singleton por nome — sem conexões novas por chamada');
  assert.equal(FakeBull.constructed.filter((n) => n === 'outreach:message-send').length, 1);
});

test('createQueue: nomes diferentes → instâncias distintas', () => {
  const a = queues.createQueue('outreach:prepare');
  const b = queues.createQueue('outreach:message-send');
  assert.notEqual(a, b);
});

test('o cenário do incidente: makeQueue por MENSAGEM converge para 1 instância', () => {
  // Réplicas dos 3 call sites que vazavam (outreach-workers :378/:459/:604):
  const sites = [1, 2, 3].map(() => queues.createQueue('outreach:message-send'));
  assert.ok(sites.every((q) => q === sites[0]), 'todas as chamadas recebem a mesma queue');
  assert.equal(FakeBull.constructed.length, 1, 'uma única construção — zero conexões órfãs');
});

test('registerProcessor: idempotente por nome (re-registro não duplica process)', () => {
  const q1 = queues.registerProcessor('outreach:message-send', async () => 1, 1);
  const q2 = queues.registerProcessor('outreach:message-send', async () => 2, 1);
  assert.equal(q1, q2, 'mesma instância devolvida');
  assert.equal(q1.processCalls, 1, 'processor registrado UMA vez');
});

test('registerProcessor: nomes distintos registram separadamente', () => {
  const seq = queues.registerProcessor('whatsapp:sequence', async () => 1, 2);
  const send = queues.registerProcessor('whatsapp:send', async () => 1, 1);
  assert.notEqual(seq, send);
  assert.equal(seq.processCalls, 1);
  assert.equal(send.processCalls, 1);
});

test('closeAllQueues limpa o cache — recriar constrói instância nova', async () => {
  const a = queues.createQueue('outreach:prepare');
  await queues.closeAllQueues();
  const b = queues.createQueue('outreach:prepare');
  assert.notEqual(a, b, 'após close, instância nova (a antiga foi fechada)');
  assert.equal(FakeBull.constructed.filter((n) => n === 'outreach:prepare').length, 2);
});
