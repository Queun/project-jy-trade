# Project Agent Instructions

## Working Context

- Read `docs/development.md`, `docs/project-plan.md`, and the relevant contract or architecture document before changing a business workflow.
- Preserve `.env`, `data/`, `outputs/`, private Excel files, and other local runtime artifacts. Do not commit them.
- Keep changes scoped to the requested workflow and avoid unrelated refactors.

## Verification And Commits

- Treat a completed, verified logical change as commit-ready by default. Create a Git commit unless the user explicitly asks not to commit yet.
- Prefer small, reviewable commits with one coherent purpose. Do not mix unrelated work into the same commit.
- Before committing, run focused tests for the changed behavior, then `npm run deploy:check` for main-path changes and `git diff --check`.
- Report the commit hash and subject after a successful commit. Never discard or overwrite unrelated user changes to make a commit clean.
