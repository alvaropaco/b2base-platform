# b2base-platform Constitution

Princípios que governam especificações, planos e implementações deste monorepo.
Features guiadas pelo BMad Method (`$bmad-*`) validam as decisões contra este
documento; violações precisam de justificativa explícita na spec/plan.

> **Histórico de emendas:** 1.0.0 (2026-09-16, ratificação; fluxo Spec Kit) →
> **2.0.0 (2026-09-26): fluxo Spec Kit substituído pelo BMad Method —
> princípio I reescrito e Fluxo de Desenvolvimento atualizado; demais
> princípios intactos.** Migrado de `.specify/memory/constitution.md`.

## Princípios Fundamentais

### I. Especificação antes de código
Toda feature de produto nasce como spec BMad em
`_bmad-output/specs/spec-<slug>/` (via `$bmad-spec`, a partir de
`$bmad-brainstorming` / `$bmad-product-brief` quando aplicável).
Implementação sem spec/plan correspondente só é aceitável para fixes triviais,
chores e ajustes de infraestrutura documentados. A spec define o "quê" e os
critérios de aceite; o plan (PRD, arquitetura, epics/stories) define o "como".

### II. Persistência idempotente orientada a eventos
Os serviços conversam por NATS JetStream com contratos de evento versionados
(`company.br.cnpj.*.v1`, `enrichment.company.*.v1`). Consumidores devem ser
idempotentes (reprocessar o mesmo evento não pode duplicar estado — padrão de
referência: `nats-enrichment.js`). Contratos existentes nunca mudam de forma
quebrada: evolução ganha sufixo `.v2` e período de convivência.

### III. Testes como porta de entrada (NÃO-NEGOCIÁVEL)
Feature nova ou comportamento alterado exige teste antes do merge:
`pnpm test` (`node --test test/*.test.js`) na plataforma, `pytest` +
`make lint typecheck test` nos serviços Python.

### IV. Multi-tenancy e gating por plano
Dados e ações são isolados por organização (contexto via `org-context.js`).
Recursos respeitam o plano do cliente (trial = enriquecimento básico,
premium = profundo) através de `plan.js` / `plan-masking.js` — nenhuma resposta
de API pode vazar capacidade além do plano contratado. Regras de cobrança
(Stripe) mudam sempre com as skills Stripe como referência.

### V. Segredos fora do repositório
`.env` / `.env.local` nunca são commitados; credenciais chegam por variáveis de
ambiente. Scopes OAuth são os mínimos necessários (Gmail, Firebase, WhatsApp).
Materiais sensíveis de teste usam fixtures, nunca contas reais de produção.

### VI. Simplicidade incremental (YAGNI)
Plataforma em Node.js com módulos planos na raiz; serviços extraídos para
Python apenas quando a carga justificar (padrão: `cnpj-data-publisher` e
`company-enrichment-worker`). Novas dependências e frameworks exigem
justificativa na spec/plan. Preferir evoluir módulo existente a criar camada nova.

### VII. Deploy GitOps observável
CI publica imagens por commit no GHCR (`sha-<sha>`) e o ArgoCD sincroniza a
partir de `alvaropaco/k8s-infra` — infraestrutura não é alterada por mão na
produção. Fluxos críticos novos expõem métricas (prom-client) e logs
estruturados suficientes para diagnóstico sem acesso a dados de cliente.

## Restrições de Stack

- Plataforma: Node.js (Express 5, Prisma 5/Postgres, ioredis, NATS, Stripe,
  Firebase Admin); SPA em `apps/web/` (Vite).
- Serviços: Python 3.12 (publisher: DuckDB/Parquet; enrichment worker: OSINT/IA).
- Migrações de schema exclusivamente via Prisma
  (`pnpm run db:migrate` / `db:deploy`) — nunca `db push` direto em produção.
- Integrações externas de billing/pagamento seguem as skills Stripe do repo.

## Fluxo de Desenvolvimento

1. Feature: `$bmad-brainstorming` (opcional) → `$bmad-spec` → `$bmad-prd` →
   `$bmad-architecture` / `$bmad-ux` (conforme a feature) →
   `$bmad-create-epics-and-stories` → `$bmad-build` → `$bmad-review` /
   `$bmad-code-review`. Catálogo e orientação: `$bmad-help`.
2. Artefatos vivem em `_bmad-output/`: specs (`specs/spec-<slug>/`),
   planejamento (`planning-artifacts/`), implementação
   (`implementation-artifacts/`). Features 001–010 (era Spec Kit) permanecem
   em `specs/` como histórico.
3. Branch por feature; commits no padrão conventional (PT-BR),
   ex.: `feat(score): ...`, `fix(enrichment): ...`.
4. Quality gates antes do merge: `pnpm test`, build do web, lint/typecheck/test
   dos serviços afetados.
5. Merge em `main` dispara CI por paths e deploy automático da plataforma;
   serviços Python publicam por tags (`v*`, `enrichment-v*`).

## Governança

- Esta constituição se sobrepõe a práticas ad-hoc: em conflito, ela vence.
- Specs/planos que precisam violar um princípio registram a exceção e a
  justificativa na própria spec; complexidade sem justificativa é recusada em review.
- Emendas seguem versionamento MAJOR.MINOR.PATCH: MAJOR remove ou reescreve um
  princípio, MINOR adiciona princípio/seção, PATCH esclarece redação. A emenda
  é documentada no commit correspondente com plano de migração do que já existe.
- Orientação de runtime para agentes: `AGENTS.md` na raiz.

**Version**: 2.0.0 | **Ratified**: 2026-09-16 | **Last Amended**: 2026-09-26
