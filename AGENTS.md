# AGENTS.md — b2base-platform

Instruções para agentes de código (ZCode e afins) neste repositório.

## Spec-Driven Development (Spec Kit)

Este projeto usa o GitHub Spec Kit (estrutura em `.specify/`). Features de
produto seguem o fluxo, nesta ordem:

`$speckit-specify` → `$speckit-clarify` → `$speckit-plan` → `$speckit-tasks` →
`$speckit-analyze` → `$speckit-implement` → `$speckit-converge`

(`clarify`, `analyze` e `checklist` são opcionais, mas recomendados em features
com ambiguidade; o restante é obrigatório.)

- Spec de cada feature: `specs/<NNN>-<nome>/` (branch `NNN-<nome>` criado pelo
  script de spec-kit).
- Constituição — princípios inegociáveis do projeto:
  `.specify/memory/constitution.md`. Toda decisão de spec/plan valida contra ela.
- Templates de artefatos: `.specify/templates/`.

## Regras rápidas

- Nunca commitar segredos: `.env`, `.env.local`, tokens ou credenciais.
- Stack: Node.js/Express + Prisma/Postgres (raiz, `apps/web/`), Python 3.12
  (`services/`). Não introduzir framework/dependência nova sem justificativa na
  spec ou no plan.
- Migrações de schema apenas via Prisma (`pnpm run db:migrate` / `db:deploy`);
  nunca `db push` em produção.
- Testes são porta de entrada: `pnpm test` (node --test) na plataforma,
  `pytest` nos serviços Python. Alteração de comportamento sem teste não sai.
- Comunicação entre serviços via NATS JetStream; consumidores idempotentes;
  eventos versionados (`*.v1`), evolução via `.v2`.
- Respeitar gating por plano (trial/premium) e isolamento por organização em
  qualquer endpoint novo.
- Commits no padrão conventional, em PT-BR (ex.: `feat(score): ...`).

## BMad Method (v6)

Camada opcional de agentes/workflows de planejamento e desenvolvimento
(BMAD-METHOD, módulo `bmm`), instalada em `_bmad/` com skills em
`.agents/skills/bmad-*` (descobertas nativamente pelo ZCode e por outras
ferramentas — `/bmad-help`, `/bmad-prd`, `/bmad-architecture`,
`/bmad-create-epics-and-stories`, `/bmad-build`, `/bmad-code-review`,
`/bmad-agent-pm`, entre outras; catálogo completo em
`_bmad/_config/bmad-help.csv`, e `/bmad-help` recomenda o próximo passo).

- Artefatos gerados (PRD, arquitetura, epics/stories, reviews) vão para
  `_bmad-output/` e podem ser versionados como insumo das specs.
- `_bmad/config.toml` é gerenciado pelo instalador (`npx bmad-method install`
  ou o CLI global `bmad`); overrides de time em `_bmad/custom/config.toml`
  (versionado) e pessoais em `config.user.toml` (gitignored — cada dev
  regenera rodando o instalador).
- Skills do BMad executam scripts Python via `uv` (`_bmad/scripts/`); exigem
  `uv` no PATH.

**Governança**: a constituição continua mandando — features de produto que
viram código seguem o fluxo Spec Kit (`specs/<NNN>-<nome>/`, seção acima).
Use o BMad para descoberta/exploração (brainstorming, PRD, arquitetura,
refino de ideias) e transporte as decisões para a spec Spec Kit
correspondente.
