// =============================================================================
// twilio-lookup.js — cliente Twilio Lookup v2 (pacote Line Type Intelligence).
//
// Papel no produto: GATE do WhatsApp extraído do site
// (workers/digital-presence.js). Número que o Twilio classifica como fixo,
// toll-free, voicemail etc. (ou inválido) NÃO vira telefone prioritário do
// lead — o motor de disparo usa cnpjPhones[0] e número ruim é bounce +
// queima de sessão. mobile/fixedVoip/nonFixedVoip passam.
//
// Auth: HTTP Basic — aceita API Key (TWILIO_API_KEY_SID/TWILIO_API_KEY_SECRET,
// recomendado pela Twilio) ou Account SID + Auth Token. Sem credenciais,
// isConfigured() = false e o chamador segue FAIL-OPEN (comportamento anterior
// à integração — o gate nunca derruba a feature por indisponência do Twilio).
//
// Custo: line_type_intelligence é pacote COBRADO por lookup. O rate limit fica
// por conta do enrichment-provider-registry (provider 'twilio.lookup', defaults
// 120 rpm / 20 concorrentes). Sem SDK da Twilio — REST puro via fetch.
// =============================================================================

const LOOKUP_BASE = 'https://lookups.twilio.com/v2/PhoneNumbers';

// Linhas que no contexto BR não carregam WhatsApp do negócio: fixo, 0800,
// caixa postal (voicemail), premium/compartilhado. Qualquer outro valor
// (mobile, fixedVoip, nonFixedVoip, unknown, vazio) passa — bloquear por
// classificação incerta regrediria a feature do WhatsApp do site.
const BLOCKED_LINE_TYPES = new Set([
  'landline',
  'landline_premium',
  'landline_toll_free',
  'tollFree',
  'voicemail',
  'premium',
  'sharedCost',
]);

function credentials() {
  if (process.env.TWILIO_API_KEY_SID && process.env.TWILIO_API_KEY_SECRET) {
    return { user: process.env.TWILIO_API_KEY_SID, pass: process.env.TWILIO_API_KEY_SECRET };
  }
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    return { user: process.env.TWILIO_ACCOUNT_SID, pass: process.env.TWILIO_AUTH_TOKEN };
  }
  return null;
}

function isConfigured() {
  return credentials() !== null;
}

/**
 * Consulta o Lookup v2. NUNCA lança: retorna { ok:false, reason } em falha
 * (o worker registra o outcome no circuit breaker e segue fail-open).
 * phoneE164 aceita '+5511...' — o '+' é URI-encodeado no path.
 */
async function lookupPhoneNumber(phoneE164, { fetchImpl = fetch, signal = null, timeoutMs = 5000 } = {}) {
  const creds = credentials();
  if (!creds) return { ok: false, reason: 'NOT_CONFIGURED', latencyMs: 0 };

  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('twilio lookup timeout')), timeoutMs);
  const onOuterAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    const url = `${LOOKUP_BASE}/${encodeURIComponent(phoneE164)}?Fields=line_type_intelligence`;
    const auth = Buffer.from(`${creds.user}:${creds.pass}`).toString('base64');
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, reason: `HTTP_${res.status}`, detail: (body && body.message) || null, latencyMs: Date.now() - started };
    }
    const lti = body.line_type_intelligence || null;
    return {
      ok: true,
      latencyMs: Date.now() - started,
      valid: body.valid !== false,
      validationErrors: body.validation_errors || [],
      lineType: lti ? lti.type : null,
      carrierName: lti ? lti.carrier_name : null,
      e164: body.phone_number || null,
    };
  } catch (err) {
    return {
      ok: false,
      reason: (signal && signal.aborted) ? 'ABORTED' : 'NETWORK_ERROR',
      detail: err.message,
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Política de promoção do WhatsApp do site. Respostas de lookup indisponíveis
 * (Twilio fora, sem credenciais, circuito aberto) são FAIL-OPEN: promove como
 * hoje — o gate protege contra dado ruim CONFIRMADO, não contra falta de dado.
 */
function evaluateWhatsAppNumber(res) {
  if (!res || !res.ok) {
    return { decision: 'ALLOW', reason: `LOOKUP_UNAVAILABLE:${(res && res.reason) || 'NULL'}` };
  }
  if (res.valid === false) {
    const errs = (res.validationErrors || []).join('+') || 'INVALID';
    return { decision: 'BLOCK', reason: `INVALID_NUMBER:${errs}` };
  }
  if (res.lineType && BLOCKED_LINE_TYPES.has(res.lineType)) {
    return { decision: 'BLOCK', reason: `LINE_TYPE:${res.lineType}` };
  }
  return { decision: 'ALLOW', reason: `LINE_TYPE:${res.lineType || 'unknown'}` };
}

module.exports = { isConfigured, lookupPhoneNumber, evaluateWhatsAppNumber, BLOCKED_LINE_TYPES };
