---
status: blocked
---

# BMad Build Auto Result

Status: blocked
Blocking condition: unclear intent — a invocação continha apenas a referência à skill `/bmad-build-auto`, sem arquivo de spec, sem dispatch folder+id (`spec_folder`/`story_id`) e sem texto de intenção. Não foi possível identificar o que implementar. (Segunda invocação consecutiva sem argumentos — mesmo bloqueio da execução anterior.)

Como desbloquear: reinvocar `/bmad-build-auto` com (a) o caminho de uma spec com `status` reconhecível no frontmatter (`draft`, `ready-for-dev`, `in-progress`, `in-review`, `blocked` ou `done`), (b) uma pasta de spec com `stories.yaml` + id de story (dispatch folder+id), ou (c) uma descrição da intenção a implementar.
