/**
 * Bull v4 queue factory for outreach jobs.
 *
 * QUEUES:
 *   outreach:prepare    — creates outreach_contact, generates AI message
 *   outreach:message-send — sends one email via Gmail API
 *   outreach:gmail-sync — syncs mailbox via Gmail History API
 *
 * Uses bull v4. The default export is the Queue constructor.
 */
const Bull = require('bull');

// Incidente 2026-09-30: createQueue era chamado POR OPERAÇÃO (fluxo de envio
// em outreach-workers:378/459/604, dns-verify, reengagement, metrics) e cada
// chamada instanciava uma Bull Queue nova — cada uma abre 2+ conexões Redis
// que nunca fecham — derrubando o Redis no maxclients (~10k conexões órfãs
// em 32h). Queue é SINGLETON por nome: instâncias Bull da mesma queue são
// seguras para add/process compartilhados no mesmo processo.
let BullImpl = Bull;
const _queueByName = new Map();
const _registeredNames = new Set();

/** Injeta o construtor de Bull em testes (padrão _set*ForTests da casa). */
function _setBullForTests(impl) {
  BullImpl = impl;
  _resetQueuesForTests();
}

function _resetQueuesForTests() {
  _queueByName.clear();
  _registeredNames.clear();
  _queues = null;
}

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || null;

function redisConfig() {
  const cfg = { host: REDIS_HOST, port: REDIS_PORT };
  if (REDIS_PASSWORD) cfg.password = REDIS_PASSWORD;
  return cfg;
}

const QUEUES = Object.freeze({
  OUTREACH_PREPARE: 'outreach:prepare',
  OUTREACH_SEND: 'outreach:message-send',
  OUTREACH_GMAIL_SYNC: 'outreach:gmail-sync',
});

function createQueue(name) {
  // Singleton por nome (incidente 2026-09-30): chamadas repetidas de
  // createQueue/getQueues/makeQueue convergem para a MESMA instância Bull —
  // sem novas conexões Redis por chamada.
  if (_queueByName.has(name)) return _queueByName.get(name);
  const queue = new BullImpl(name, { redis: redisConfig() });
  _queueByName.set(name, queue);
  return queue;
}

let _queues = null;

function getQueues() {
  if (!_queues) {
    _queues = {
      prepare: createQueue(QUEUES.OUTREACH_PREPARE),
      send: createQueue(QUEUES.OUTREACH_SEND),
      gmailSync: createQueue(QUEUES.OUTREACH_GMAIL_SYNC),
    };
  }
  return _queues;
}

const _workers = [];

/**
 * Register a processor on a queue name and return the queue.
 * @param {string} name     - Bull queue name
 * @param {Function} processor - async(job) => result
 * @param {number} concurrency - how many jobs to process in parallel
 * @returns {import('bull').Queue}
 */
function registerProcessor(name, processor, concurrency = 1) {
  // Idempotente por nome (incidente 2026-09-30): re-registrar no MESMO
  // processo trocaria o processador da queue singleton e duplicaria consumo
  // em reimports/loops. Segundo registro é ignorado com aviso.
  if (_registeredNames.has(name)) {
    console.warn(`[queues] processador "${name}" já registrado neste processo — re-registro ignorado`);
    return _queueByName.get(name);
  }
  const queue = createQueue(name);
  queue.process(concurrency, async (job) => {
    try {
      return await processor(job);
    } catch (err) {
      console.error(`[worker:${name}] job ${job.id} failed:`, err.message);
      throw err;
    }
  });
  _registeredNames.add(name);
  _workers.push(queue);
  return queue;
}

async function closeAllQueues() {
  const q = getQueues();
  await Promise.all([q.prepare, q.send, q.gmailSync].map((q) => q.close()));
  _queues = null;
  _queueByName.delete(QUEUES.OUTREACH_PREPARE);
  _queueByName.delete(QUEUES.OUTREACH_SEND);
  _queueByName.delete(QUEUES.OUTREACH_GMAIL_SYNC);
}

async function closeAllWorkers() {
  await Promise.all(_workers.map((w) => w.close()));
  _workers.length = 0;
}

module.exports = {
  QUEUES,
  getQueues,
  createQueue,
  registerProcessor,
  closeAllQueues,
  closeAllWorkers,
  redisConfig,
  _setBullForTests,
  _resetQueuesForTests,
};
