# b2base-platform (monorepo)

Monorepo da plataforma B2B de inteligência de CNPJs e prospecção. Absorveu os
antigos repos standalone `alvaropaco/cnpj-data-publisher` e
`alvaropaco/service-cnpj-enrichment` (sem histórico — cópia limpa de código).

## Serviços

| Diretório | Linguagem | Papel |
| --- | --- | --- |
| raiz (`server-prod.js` + módulos) | Node.js | Plataforma: API Express, SPA em `apps/web/`, outreach (e-mail/WhatsApp), campanhas, billing (Prisma/Postgres, NATS, Stripe, Firebase) |
| `services/cnpj-data-publisher/` | Python 3.12 | Ingestão mensal dos Dados Abertos do CNPJ (Receita Federal): download → Parquet (DuckDB) → diff → eventos no NATS JetStream |
| `services/company-enrichment-worker/` | Python 3.12 | Worker de enriquecimento event-driven: descoberta de domínio, OSINT (BBOT/SpiderFoot), análise IA, graph |

## Fluxo de dados

```
Receita Federal ──> cnpj-data-publisher ──> NATS (BRAZIL_COMPANY_EVENTS,
                                            company.br.cnpj.{discovered,updated,...}.v1)
                        │
                        └── Postgres analítico (pgvector) ──> embedder (TEI)

b2base-platform ──> NATS (enrichment.company.requested.v1)
                        │
                        ▼
              company-enrichment-worker ──> enrichment.company.completed.v1
                        │
                        ▼
              b2base-platform (persistência idempotente — nats-enrichment.js)
```

## Desenvolvimento

```bash
# Plataforma (Node)
pnpm install
pnpm run dev            # web (Vite) + server (node --watch)
pnpm test               # node --test test/*.test.js
docker compose up -d    # Postgres local

# cnpj-data-publisher
cd services/cnpj-data-publisher
make setup              # venv + deps
make lint typecheck test
docker compose up -d    # postgres + nats (+ minio)

# company-enrichment-worker
cd services/company-enrichment-worker
python -m venv .venv && pip install -e ".[dev]"
pytest tests/unit -q
docker compose up -d    # pgvector + nats + worker em mock mode
```

## Spec-Driven Development (BMad)

Features de produto seguem o [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD)
(v6, instalado em `_bmad/`), com a constituição do projeto
(`docs/constitution.md`) como conjunto de princípios.

Fluxo por feature (skills no ZCode): `$bmad-brainstorming` (opcional) →
`$bmad-spec` → `$bmad-prd` → `$bmad-architecture` / `$bmad-ux` →
`$bmad-create-epics-and-stories` → `$bmad-build` → `$bmad-review`.

- Spec por feature: `_bmad-output/specs/spec-<slug>/` (`SPEC.md` = contrato canônico)
- Skills do fluxo: `.agents/skills/bmad-*/` (descobertas pelo ZCode e outras ferramentas)
- Artefatos: `_bmad-output/` · Features 001–010 (era Spec Kit): `specs/` (histórico)
- Instruções para agentes: `AGENTS.md`

## Build & deploy (GitOps)

Imagens publicadas por CI no GHCR; ArgoCD sincroniza a partir de
`alvaropaco/k8s-infra`:

| Serviço | Workflow | Imagem | Gatilho de publicação |
| --- | --- | --- | --- |
| plataforma | `build.yml` | `ghcr.io/alvaropaco/b2base-platform` | push em `main` (paths da plataforma) → tag `sha-<sha>` + bump automático do `k8s-infra/apps/b2base/values.yaml` |
| cnpj-data-publisher | `cnpj-data-publisher.yml` | `ghcr.io/alvaropaco/cnpj-data-publisher` | tags `v*` (consumido por `k8s-infra/argocd/apps/cnpj-data-publisher.yaml`, hoje `v0.1.5`) |
| company-enrichment-worker | `company-enrichment-worker.yml` | `ghcr.io/alvaropaco/company-enrichment-worker` | tags `enrichment-v*` ou `workflow_dispatch` (variantes `default` e `-osint`) |

Cada workflow tem filtro de `paths`/`paths-ignore`: mudanças em um serviço não
rebuildam os outros.

Deploy do enrichment worker usa o chart que vive em
`services/company-enrichment-worker/helm/company-enrichment-worker` (fonte da
verdade; a antiga cópia em `k8s-infra/apps/` é removida após o primeiro sync).

## Histórico da migração

- `alvaropaco/cnpj-data-publisher` → `services/cnpj-data-publisher/`
  (camada SaaS TypeScript embutida — NestJS/Next.js — foi descartada; docs de
  sessão arquivados em `services/cnpj-data-publisher/docs/history/`)
- `alvaropaco/service-cnpj-enrichment` → `services/company-enrichment-worker/`
  (chart de produção migrou de `k8s-infra/apps/`; imagem migrou do registry
  local `172.17.0.1:5000` para o GHCR)

Os dois repos antigos devem ser arquivados no GitHub após o cutover.

## Motor de Enriquecimento Distribuído (v2)

Motor orientado a eventos onde um lead gera um **job** expandido em **tasks**
independentes (entidade × capability), executadas em paralelo por **workers**
especializados via NATS JetStream. Spec completa em
`specs/001-distributed-enrichment/` (spec, plan, contratos v1, quickstart).

### Componentes

| Módulo | Papel |
|---|---|
| `enrichment-manager.js` | ciclo de vida do job: planeja, publica, consome resultados, DAG, expansão, conclusão |
| `enrichment-capabilities.js` | catálogo declarativo (tiers trial/premium, limites, regras de expansão) |
| `enrichment-provider-registry.js` | rate limit, concorrência e circuit breaker por provider (Redis) |
| `workers/sdk/` | runtime compartilhado dos workers (validate → execute → persist → publish → ack) |
| `workers/identity.js` | `identity.cnpj.resolve`, `identity.cnpj.basic`, `identity.domain.verify` |
| `workers/search.js` | `search.news`, `search.legal` |
| `workers/company-deep.js` | `company.profile.deep` (PDL), `company.logo`, `company.deepgraph` (ponte worker Python) |
| `qualification.js` | consumidor separado de resultados → `recalcLeadScore` (debounce por lead) |
| `raw-store.js` | retenção do dado bruto + reprocessamento sem recaptura |

### Rodando em dev

```bash
docker compose up -d              # postgres + nats (JetStream) + redis
pnpm run db:migrate               # migration do motor (tabelas enrichment_*)
pnpm run dev                      # API + manager + qualificação
pnpm run worker:identity          # terminal 2
pnpm run worker:search            # terminal 3
pnpm run worker:company-deep      # terminal 4 (capabilities premium)
```

### Rollout (sem big-bang)

1. `ENRICHMENT_ENGINE_V2=true` + `ENRICHMENT_ENGINE_V2_ORGS=<orgIds>` — motor v2
   apenas para as orgs allowlistadas; demais seguem no fluxo legado intacto.
2. `ENRICHMENT_CATALOG_FULL=true` — habilita as capabilities portadas
   (PDL, jurídico, logo, deepgraph) depois da paridade validada em staging
   (quickstart C1–C8).
3. Rollback = remover a org da allowlist ou desligar a flag. Sem migration.

### Deploy

Mesma imagem da plataforma (`ghcr.io/alvaropaco/b2base-platform`); workers são
processos separados por **entrypoint** — no `k8s-infra`, um Deployment por
família de worker apontando para `node workers/<família>.js` (padrão do
`workertype-deployment.yaml` do enrichment-worker Python). Métricas em
`:9090/metrics` (`b2base_enrichment_*`); pendência por capability serve de base
para autoscaling futuro (KEDA/HPA — fora do escopo v1).

### Limitação conhecida (prioridade)

A prioridade da task (0–3) é respeitada na **ordem de planejamento e de
publicação em lote** pelo manager. O JetStream não tem fila prioritária nativa,
então não há preempção entre tasks já publicadas — decisão registrada no plan
(research R7); faixas por subject (ex.: `enrichment.task.p0.>`) é a evolução
natural caso a operação exija preempção real.
