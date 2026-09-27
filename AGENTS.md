# AGENTS.md — b2base-platform

Instruções para agentes de código (ZCode e afins) neste repositório.

## Spec-Driven Development (BMad)

Este projeto usa o **BMad Method** (estrutura em `_bmad/`) como fluxo canônico
de features de produto:

`$bmad-brainstorming` (opcional) → `$bmad-spec` → `$bmad-prd` →
`$bmad-architecture` / `$bmad-ux` (conforme a feature) →
`$bmad-create-epics-and-stories` → `$bmad-build` → `$bmad-review` /
`$bmad-code-review`

- Spec de cada feature: `_bmad-output/specs/spec-<slug>/` (`SPEC.md` é o
  contrato canônico + companions; derivada do `.memlog.md` da spec).
- Constituição — princípios inegociáveis do projeto:
  `docs/constitution.md`. Toda decisão de spec/plan valida contra ela.
- Artefatos: `_bmad-output/` (specs, `planning-artifacts/`,
  `implementation-artifacts/`). Features 001–010 (era Spec Kit, removido em
  2026-09-26) permanecem em `specs/` apenas como histórico.

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

**Governança**: a constituição (`docs/constitution.md`) continua mandando — o
fluxo BMad da seção acima é o caminho canônico de features; use as skills
conforme a etapa (brainstorming e brief na descoberta, PRD/arquitetura/UX no
plan, epics/stories e build na execução, review/retro no fechamento).

## Design

- Identidade do **Cockpit** (`/studio`): **D1 · tema claro pastel** — linguagem
  **AI Chatbot UI** (pivô aprovado pelo dono em 2026-09-27: fundo branco com
  blobs rosa/azul borrados, Manrope, sparkles, cards brancos translúcidos,
  botão primário `#160211`). Spine canônica
  em
  `_bmad-output/planning-artifacts/ux-designs/ux-b2base-platform-2026-09-26/DESIGN.md`
  (tokens, glass, glow semântico) + `EXPERIENCE.md` (comportamento). Os painéis
  "Avançado" são navegação da sidebar — não reverta para gaveta de rodapé.
- Referências de padrões — **NÃO são a paleta do produto**: `DESIGN.md` (raiz,
  análise Mobbin: hierarquia, contenção, pills) e `framer/DESIGN.md`
  (motion/vidro/glow).
