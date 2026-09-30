/**
 * WhatsAppProvider — abstração isolada da comunicação com o WhatsApp.
 *
 * Toda chamada HTTP ao WAHA passa por aqui. Nenhum outro módulo do backend
 * deve chamar o WAHA diretamente: use as funções exportadas (a implementação
 * concreta é `WAHAWhatsAppProvider`).
 *
 * Configuração via environment variables (nunca hardcoded):
 *   WAHA_BASE_URL     — base URL do WAHA (ex.: http://localhost:3000)
 *   WAHA_API_KEY      — API key para autenticar as chamadas (X-Api-Key)
 *   WAHA_WEBHOOK_URL  — URL para onde o WAHA envia os eventos (informacional)
 *
 * Nota sobre durabilidade: a sessão é persistente porque o WAHA mantém o estado
 * do WhatsApp no disco (volume persistente) e o nome da sessão é determinístico.
 * Nosso `WhatsAppAccount` guarda apenas o `sessionName` e o `status`, permitindo
 * re-conectar/re-assumir a sessão após reinício do servidor sem re-parear o QR.
 */
const crypto = require('crypto');

const BASE_URL = String(process.env.WAHA_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const API_KEY = process.env.WAHA_API_KEY || null;

function isConfigured() {
  return Boolean(process.env.WAHA_BASE_URL);
}

function _headers(extra = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (API_KEY) h['X-Api-Key'] = API_KEY;
  return { ...h, ...extra };
}

/**
 * Realiza uma chamada HTTP ao WAHA e normaliza o erro.
 * @returns {Promise<any>} corpo JSON (ou null se vazio).
 */
async function _request(method, path, body, extraHeaders) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: _headers(extraHeaders),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch (_e) { json = null; }
  }

  if (!res.ok) {
    const detail = (json && (json.error || json.message)) || text || '';
    const message = `WAHA HTTP ${res.status} ${detail}`.trim();
    const err = new Error(message);
    err.status = res.status;
    err.details = json;
    if (res.status === 401 || res.status === 403) {
      console.error(
        `[waha] AUTH_FAILURE em ${method} ${path}: ${message} — confira se WAHA_API_KEY bate entre o B2Base (Infisical /b2base) e o WAHA (Infisical /b2base-waha).`
      );
    }
    throw err;
  }

  return json;
}

/**
 * Extrai o id da mensagem a partir das várias formas de resposta do WAHA.
 */
function _extractMessageId(response) {
  if (!response) return null;
  if (typeof response === 'string') return response;
  if (response.id) return response.id;
  if (response.key && response.key.id) return response.key.id;
  if (response.message) return _extractMessageId(response.message);
  if (response.result) return _extractMessageId(response.result);
  return null;
}

/**
 * WAHAWhatsAppProvider — implementação concreta do WhatsAppProvider.
 */
const WAHAWhatsAppProvider = {
  isConfigured,

  // ── Session management ────────────────────────────────────────────
  async createSession(sessionName) {
    return _request('POST', '/api/sessions', { name: sessionName });
  },

  async startSession(sessionName) {
    return _request('POST', `/api/sessions/${encodeURIComponent(sessionName)}/start`);
  },

  async stopSession(sessionName) {
    return _request('POST', `/api/sessions/${encodeURIComponent(sessionName)}/stop`);
  },

  async restartSession(sessionName) {
    return _request('POST', `/api/sessions/${encodeURIComponent(sessionName)}/restart`);
  },

  async getSessionStatus(sessionName) {
    return _request('GET', `/api/sessions/${encodeURIComponent(sessionName)}`);
  },

  async logout(sessionName) {
    return _request('POST', `/api/sessions/${encodeURIComponent(sessionName)}/logout`);
  },

  async deleteSession(sessionName) {
    return _request('DELETE', `/api/sessions/${encodeURIComponent(sessionName)}`);
  },

  /**
   * Obtém o QR Code da sessão.
   * @returns {Promise<{ qrCode: string|null, raw: string|null, error?: string }>}
   *   `qrCode` é um data-url PNG (pronto para <img>); `raw` é o valor bruto.
   *
   * Nota: o WAHA só devolve QR quando a sessão está em SCAN_QR_CODE — antes
   * disso responde 422 depois de ~10s esperando internamente. Quem chama deve
   * aguardar o status (ver `waitForWhatsAppQr` em server-prod.js).
   */
  async getQRCode(sessionName) {
    // Tenta primeiro o formato binário PNG (mais simples de exibir).
    try {
      const res = await fetch(
        `${BASE_URL}/api/${encodeURIComponent(sessionName)}/auth/qr?format=image`,
        { headers: _headers({ Accept: 'image/png' }) },
      );
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('image')) {
        const buf = Buffer.from(await res.arrayBuffer());
        return { qrCode: `data:image/png;base64,${buf.toString('base64')}`, raw: null };
      }
      // Fallback: JSON com data-url/URL ou valor bruto do QR.
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_e) { /* ignora */ }
      if (json && typeof json.qrCode === 'string') {
        if (json.qrCode.startsWith('data:') || json.qrCode.startsWith('http')) {
          return { qrCode: json.qrCode, raw: json.raw || null };
        }
        // Valor bruto ("2@..."): devolver em `raw` — embrulhar como base64 PNG
        // produziria uma imagem quebrada.
        return { qrCode: null, raw: json.qrCode };
      }
      const message = (json && (json.message || json.error)) || `WAHA HTTP ${res.status}`;
      return { qrCode: null, raw: null, error: message };
    } catch (err) {
      return { qrCode: null, raw: null, error: String((err && err.message) || err) };
    }
  },

  // ── Messaging ─────────────────────────────────────────────────────
  async sendText(sessionName, chatId, text, replyTo) {
    const response = await _request('POST', '/api/sendText', {
      session: sessionName,
      chatId,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    });
    return { providerMessageId: _extractMessageId(response) };
  },

  /**
   * Mídia pela interface de provider (AD-11; Story 2.3, FR6 da onda
   * "criação sem bloqueios"): imagem → sendImage, documento → sendFile,
   * `caption` recebe o texto da peça (sem duplicar mensagem de texto).
   *
   * @param {string} sessionName
   * @param {string} chatId
   * @param {object} media - { kind: 'image'|'document', data(base64)?, url?,
   *                          mimetype?, fileName?, caption? }
   *   bytes em `data` (lidos do storage no send — D8) ou referência em `url`.
   */
  async sendMedia(sessionName, chatId, media) {
    const kind = media && media.kind === 'image' ? 'image' : 'document';
    const endpoint = kind === 'image' ? '/api/sendImage' : '/api/sendFile';
    const file = media.url
      ? media.url
      : {
          data: String(media.data || ''),
          mimetype: media.mimetype || 'application/octet-stream',
          filename: media.fileName || (kind === 'image' ? 'imagem' : 'arquivo'),
        };
    const response = await _request('POST', endpoint, {
      session: sessionName,
      chatId,
      file,
      ...(media.caption ? { caption: media.caption } : {}),
    });
    return { providerMessageId: _extractMessageId(response) };
  },

  async getChat(sessionName, chatId) {
    return _request('GET', `/api/${encodeURIComponent(sessionName)}/chats/${encodeURIComponent(chatId)}`);
  },
};

/**
 * Nome de sessão determinístico e seguro por workspace.
 * Deriva um hash estável do orgId para que a mesma organização sempre reutilize
 * a mesma sessão WAHA (durabilidade) sem expor ids internos nem credenciais.
 */
function deterministicSessionName(orgId) {
  const hash = crypto.createHash('sha256').update(String(orgId || '')).digest('hex').slice(0, 16);
  return `b2base_${hash}`;
}

/**
 * Validação de webhook: compara a chave enviada com a configurada em tempo
 * constante (evita timing attack). Aceita WAHA_WEBHOOK_TOKEN (dedicado) ou,
 * como fallback, WAHA_API_KEY. Se nenhuma estiver configurada, retorna false
 * (o webhook é rejeitado — fail closed).
 */
function verifyWebhookApiKey(receivedKey) {
  const expected = process.env.WAHA_WEBHOOK_TOKEN || API_KEY;
  if (!expected) return false;
  if (!receivedKey || typeof receivedKey !== 'string') return false;
  const a = Buffer.from(receivedKey);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  WAHAWhatsAppProvider,
  WhatsAppProvider: WAHAWhatsAppProvider,
  deterministicSessionName,
  verifyWebhookApiKey,
  isConfigured,
};
