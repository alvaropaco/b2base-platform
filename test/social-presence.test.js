'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── company.social_presence (maigret) — caso MB: perfis sociais da empresa ──
// Sem rede: o driver é um FAKE (SOCIAL_PRESENCE_PYTHON=node) e as páginas de
// perfil rodam num servidor HTTP local na porta efêmera.

process.env.SOCIAL_PRESENCE_PYTHON = process.argv[0]; // node
const workers = require('../workers/social-presence');
const capabilities = require('../enrichment-capabilities');
const logger = { info() {}, warn() {}, error() {}, child() { return this; } };

function writeFakeDriver(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maigret-fake-'));
  const file = path.join(dir, 'fake-driver.js');
  const body = `${lines.map((l) => `console.log(${JSON.stringify(l)});`).join('\n')}\n`;
  fs.writeFileSync(file, body);
  return file;
}

function withDriverEnv(file, fn) {
  const prev = process.env.SOCIAL_PRESENCE_DRIVER;
  process.env.SOCIAL_PRESENCE_DRIVER = file;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.SOCIAL_PRESENCE_DRIVER;
    else process.env.SOCIAL_PRESENCE_DRIVER = prev;
  });
}

const TASK = (input) => ({ input, capability: 'company.social_presence', timeoutMs: 180000 });

test('capability company.social_presence: básica, habilitada e com input válido', () => {
  const def = capabilities.getCapability('company.social_presence');
  assert.equal(def.enabled, true);
  assert.equal(def.tier, 'basic', 'todos os planos');
  assert.ok(capabilities.eligibleCapabilities({ plan: 'trial' }).includes('company.social_presence'), 'todos os planos');
  assert.equal(def.validateInput({ companyName: 'XPTO' }).ok, true);
  // O schema deixa campos opcionais (companyName OU tradeName); quem exige ao
  // menos um é o executor (INVALID_INPUT — testado abaixo).
  assert.equal(def.validateInput({}).ok, true);
});

test('buildHandleCandidates: fantasia vence, slug limpo; contato SÓ em modo pessoa', () => {
  const out = workers.buildHandleCandidates({
    companyName: 'PURPLE ICE ACAI COMERCIO DE ALIMENTOS LTDA',
    tradeName: 'Purple Ice Açaí',
    contactName: 'Rafael Shinji',
  });
  assert.deepEqual(out, ['purpleiceacai'], 'fantasia vence e sufixos societários somem do slug');
  const semFantasia = workers.buildHandleCandidates({ companyName: 'HUMAITA DELIVERY LTDA' });
  assert.deepEqual(semFantasia, ['humaitadelivery'], 'razão social limpa vira o candidato');
  assert.ok(!out.includes('rafaelshinji'), 'LGPD: pessoa de contato fora por padrão');
});

test('executor: perfis do driver viram social_presence no result (sem rede)', async () => {
  const file = writeFakeDriver([
    JSON.stringify({ kind: 'found', username: 'purpleice', site: 'Instagram', url: 'instagram:purpleice' }),
    JSON.stringify({ kind: 'found', username: 'purpleice', site: 'TikTok', url: 'tiktok:purpleice' }),
    JSON.stringify({ kind: 'done' }),
  ]);
  await withDriverEnv(file, async () => {
    const result = await workers.executors['company.social_presence'](TASK({ companyName: 'Purple Ice', tradeName: 'Purple Ice' }), { logger });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.data.social_presence.count, 2);
    assert.equal(result.data.social_presence.profiles[0].site, 'Instagram');
    assert.deepEqual(result.data.contacts, []);
  });
});

test('executor: wa.me na página de perfil (fora da home da plataforma) vira contact whatsapp', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/wa') {
      res.setHeader('content-type', 'text/html');
      res.end('<html><a href="https://wa.me/5527999240650">Fale no WhatsApp</a></html>');
    } else {
      res.setHeader('content-type', 'text/html');
      res.end('<html>home da rede sem numero</html>');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const file = writeFakeDriver([
    JSON.stringify({ kind: 'found', username: 'lojax', site: 'RedeMenu', url: `http://127.0.0.1:${port}/wa` }),
    JSON.stringify({ kind: 'done' }),
  ]);
  try {
    await withDriverEnv(file, async () => {
      const result = await workers.executors['company.social_presence'](TASK({ companyName: 'Loja X LTDA', tradeName: 'Loja X' }), { logger });
      assert.equal(result.status, 'COMPLETED');
      assert.equal(result.data.contacts[0] && result.data.contacts[0].value, '+5527999240650');
      assert.ok(result.facts.some((f) => f.attribute === 'contact.whatsapp'));
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('executor: driver sem maigret → FAILED MAIGRET_UNAVAILABLE não-retentável', async () => {
  const file = writeFakeDriver([
    JSON.stringify({ kind: 'error', code: 'MAIGRET_UNAVAILABLE', message: 'No module named maigret' }),
  ]);
  await withDriverEnv(file, async () => {
    const result = await workers.executors['company.social_presence'](TASK({ companyName: 'XPTO LTDA' }), { logger });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.error.type, 'MAIGRET_UNAVAILABLE');
    assert.equal(result.error.retryable, false);
  });
});

test('runDriverScan: deadline mata o processo e devolve o parcial parseado', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maigret-slow-'));
  const file = path.join(dir, 'slow-driver.js');
  fs.writeFileSync(file, [
    `console.log(${JSON.stringify(JSON.stringify({ kind: 'found', username: 'abc', site: 'S', url: 'u' }))});`,
    'setTimeout(() => {}, 30000);',
  ].join('\n'));
  const prevDriver = process.env.SOCIAL_PRESENCE_DRIVER;
  process.env.SOCIAL_PRESENCE_DRIVER = file;
  try {
    const t0 = Date.now();
    const scan = await workers.runDriverScan(['abc'], { deadlineMs: 2000 }); // folga p/ spawn sob carga da suíte paralela
    assert.equal(scan.kind, 'timeout');
    assert.equal(scan.rows.length, 1, 'perfil achado antes do corte é preservado');
    assert.ok(Date.now() - t0 < 10000, 'deadline curto, não os 30s do driver');
  } finally {
    if (prevDriver === undefined) delete process.env.SOCIAL_PRESENCE_DRIVER;
    else process.env.SOCIAL_PRESENCE_DRIVER = prevDriver;
  }
});

test('executor: sem companyName/tradeName → INVALID_INPUT', async () => {
  const result = await workers.executors['company.social_presence'](TASK({ city: 'X' }), { logger });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error.type, 'INVALID_INPUT');
});
