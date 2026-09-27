# agents/skills — guias de marketing e vendas para os agentes de IA

Coleções vendadas (MIT) que o assistente do Cockpit injeta no prompt quando o
pedido do usuário casa com o tema do guia (loader: `studio/ai/skills.js`).

| Coleção | Fonte | Licença | Conteúdo |
|---|---|---|---|
| `marketing/` | [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | MIT © 2025 Corey Haines | 50 guias: cold-email, copywriting, SEO, lançamento, psicologia de marketing… |
| `sales/` | [louisblythe/Sales-Skills](https://github.com/louisblythe/Sales-Skills) | MIT (README §License) | 122 guias: qualificação de leads, rapport, objeções, follow-up… |

## Como funciona

1. Cada `SKILL.md` upstream virou `<coleção>/<nome-da-skill>.md` (frontmatter
   `name`/`description` preservado).
2. `studio/ai/skills.js#selectFor(mensagem)` ranqueia os guias por interseção
   de palavras-chave com a mensagem do usuário e injeta os 2 melhores
   (truncados em 4k chars cada) no turno do chat-agent.
3. Nenhum guia é injetado quando não há casamento — o prompt não incha.

## Atualizar

```sh
git clone --depth 1 https://github.com/coreyhaines31/marketingskills /tmp/ms
git clone --depth 1 https://github.com/louisblythe/Sales-Skills /tmp/ss
for d in /tmp/ms/skills/*/; do cp "$d/SKILL.md" agents/skills/marketing/$(basename "$d").md; done
for d in /tmp/ss/skills/*/; do cp "$d/SKILL.md" agents/skills/sales/$(basename "$d").md; done
```

Conteúdo em inglês — o agente responde em PT-BR usando os guias como base
técnica, não como copy literal.
