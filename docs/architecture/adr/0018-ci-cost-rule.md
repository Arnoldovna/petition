# ADR 0018: CI cost rule: e2e on pull requests only, images only for a public repository

- Status: Accepted (cross-project rule, applied to petition on 2026-11-16; not yet in
  `project-scaffold/references/conventions.md` §9, see Consequences)
- Date: 2026-11-16
- Covers: PLAN.md "CI" and "CD" rows; amends ADR 0015 (CI and CD) and conventions §9 for this repository

## Context

The repository stays private until Marina makes it public herself. Private repositories pay for GitHub Actions
minutes and GHCR storage.

- The most expensive CI job is `e2e`: it builds the production image, starts the isolated compose project
  `petition-e2e`, runs the canvas smoke check, Playwright on four projects (`seed-readonly`, `desktop`, `mobile`,
  `webkit-iphone`) and the Nu validator. After a squash-merge, the push to `main` would run it again on a tree the PR
  run already tested: one PR per phase, phases run one after another, so `main` does not move between the PR run and
  the merge (ADR 0017).
- `release.yml` (conventions §9) builds and pushes `ghcr.io/arnoldovna/petition` with provenance and SBOM after every
  green CI run on `main`. Nobody pulls the image while the repository is private, and there is no deploy target.
- The template `release.yml` tags with `type=sha` and passes `IMAGE_TAG: sha-${{ github.sha }}` to the deploy job.
  Under `workflow_run`, `github.sha` is the head of `main` when the release workflow starts, which can be newer than
  the commit CI tested.

## Decision

1. **`ci.yml` job `e2e` runs on pull requests only**: `if: github.event_name == 'pull_request'`. On `push` to `main`
   and on `workflow_dispatch` it is skipped. All other jobs (`lint` with the schema drift check, `typecheck`, `unit`,
   `integration`, `build`, `dev-setup-smoke`, `gitleaks`) keep the template triggers (`pull_request`, `push` to `main`,
   `workflow_dispatch`). A run with skipped jobs still concludes `success`, so `release.yml` is still triggered.
2. **`release.yml` job `images` runs only when the repository is public**:

   ```yaml
   env:
     RELEASE_SHA: ${{ github.event.workflow_run.head_sha || github.sha }}
   jobs:
     images:
       if: >-
         github.event.repository.private == false &&
         ((github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') ||
          (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push'))
   ```

   `repository` is part of both the `workflow_run` and the `workflow_dispatch` event payloads, so the expression never
   reads a missing object. Manual runs are accepted on `main` only, because `latest` must never point at a branch build.

3. **`deploy`** keeps `needs: images`, the `production` environment and the PLAN.md switch, plus the visibility rule:
   `if: github.event.repository.private == false && vars.DEPLOY_ENABLED == 'true'`.
4. **The released commit is the tested commit.** `RELEASE_SHA` (item 2) is used for `actions/checkout` `ref`, for the
   tags (`type=raw,value=sha-${{ env.RELEASE_SHA }}` and `type=raw,value=latest`), for the OCI label
   `org.opencontainers.image.revision` (metadata-action `labels:` override) and for the deploy job's `IMAGE_TAG`. The
   template's `type=sha,format=long` and `IMAGE_TAG: sha-${{ github.sha }}` lines are not used.
5. **Static validation instead of a live run.** Because `images` and `deploy` are skipped while the repository is
   private, Gate 1a checks every workflow with actionlint
   (`docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:<tag>`, a one-off check, nothing committed) and checks
   that the `release.yml` run on `main` shows `images` and `deploy` as skipped.

## Alternatives considered

- **e2e on every event (template).** Roughly doubles the e2e minutes for no new information while `main` cannot move
  between the PR run and the merge. Rejected.
- **Nightly e2e on `main` instead of per PR.** The quality gate needs the e2e result on the PR
  (`gh pr checks --watch`). Rejected.
- **Build the image on `main` but do not push it.** The PR's e2e job already builds the same Dockerfile from the same
  tree. Rejected.
- **Delete `release.yml` until the repository is public.** PLAN.md requires the CD workflow to exist (prepared,
  deploy disabled). The visibility condition makes it a no-op without deleting it. Rejected.

## Consequences

- While the repository is private, every `release.yml` run shows `images` and `deploy` as skipped. Gate 1a and every
  later gate check this instead of "image pushed". The PR's `e2e` job is the proof that the production image builds
  and that `@napi-rs/canvas` works in it on linux/amd64 (canvas smoke check, ADR 0005); local `pnpm verify` proves
  linux/arm64.
- After Marina makes the repository public, the next green CI run on `main` publishes the image. To publish at once:
  `gh workflow run release.yml --ref main` (hand-over note in the presentation phase, not an autonomous step).
- Deploying from the private repository is impossible by design; it needs a new ADR that supersedes item 3.
- Dependabot PRs also run e2e. That is intended: dependency updates are what e2e must catch.
- `project-scaffold/references/conventions.md` §9 does not contain this rule yet. It is the same rule as imageboard's
  ADR 0020; the shared file should be updated so social-network does not re-decide it (flagged for Marina).
