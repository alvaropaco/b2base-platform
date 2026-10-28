/**
 * b2base-media-relay — fetch em nome do servidor b2base quando o host de
 * origem bloqueia o IP dele (caso real: imgur devolve 429/403 para IP de
 * datacenter). O Cloudflare busca na edge (IP diferente) e repassa a resposta.
 *
 * Fechado por segredo: só atende com `Authorization: Bearer <RELAY_AUTH>` —
 * o MESMO segredo configurado na app (MEDIA_FETCH_RELAY_AUTH, com o prefixo
 * "Bearer "). Uso: GET https://<worker>/?url=<url codificada>
 *
 * Deploy: ver cloudflare/media-relay/README.md
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_BYTES = 30 * 1024 * 1024; // teto generoso: página HTML ou imagem

export default {
  async fetch(request, env) {
    const auth = request.headers.get('authorization') || '';
    if (!env.RELAY_AUTH || auth !== `Bearer ${env.RELAY_AUTH}`) {
      return new Response('unauthorized\n', { status: 401 });
    }
    const target = new URL(request.url).searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) {
      return new Response('query "url" http/https obrigatória\n', { status: 400 });
    }
    let upstream;
    try {
      upstream = await fetch(target, {
        headers: { 'User-Agent': UA, Accept: 'text/html,image/*,*/*;q=0.8' },
        redirect: 'follow',
      });
    } catch (err) {
      return new Response(`upstream: ${err.message}\n`, { status: 502 });
    }
    if (!upstream.ok) {
      return new Response(`upstream ${upstream.status}\n`, { status: 502 });
    }
    const body = await upstream.arrayBuffer();
    if (body.byteLength > MAX_BYTES) {
      return new Response('acima do teto\n', { status: 413 });
    }
    const headers = new Headers({ 'cache-control': 'no-store' });
    const ctype = upstream.headers.get('content-type');
    if (ctype) headers.set('content-type', ctype);
    return new Response(body, { status: 200, headers });
  },
};
