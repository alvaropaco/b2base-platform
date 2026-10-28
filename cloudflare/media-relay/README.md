# b2base-media-relay — relay de fetch no Cloudflare

Alguns hosts de imagem (caso real: imgur) bloqueiam o IP de origem do
servidor b2base com 429/403. Este Worker faz o fetch pela edge do Cloudflare
(IP diferente) e repassa a resposta — o resolvedor do Studio
(`studio/resolve-image-link.js`) tenta o fetch direto e, só quando é
bloqueado, tenta UMA vez por aqui.

Contrato:

- `GET /?url=<url codificada>` com `Authorization: Bearer <RELAY_AUTH>`.
- Sem autenticação → 401. Só http/https. Resposta `image/*`/`text/html`
  repassada com o content-type do upstream; teto de 30 MB.
- O segredo nunca vai na URL — só no header.

## Deploy (uma vez)

Com o `wrangler` logado na conta Cloudflare (o mesmo account id do R2):

```sh
cd cloudflare/media-relay
wrangler secret put RELAY_AUTH   # cole um segredo forte (ex.: openssl rand -hex 24)
wrangler deploy
```

Anote o endpoint final (`https://b2base-media-relay.<subdomínio>.workers.dev`)
e configure na app:

```
MEDIA_FETCH_RELAY_URL="https://b2base-media-relay.<subdomínio>.workers.dev"
MEDIA_FETCH_RELAY_AUTH="Bearer <o mesmo segredo>"
```

Sem essas duas vars o sistema continua funcionando — bloqueio vira erro
honesto no card (comportamento de sempre).
