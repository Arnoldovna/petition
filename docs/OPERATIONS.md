# Operations

How petition is run and maintained outside of development: what CI and CD do while the repository is private
(ADR 0018), how to erase an account on request (F-91), how to publish the first container image once the repository
is public, and what a deployment has to satisfy. Development setup lives in the [README](../README.md) and in
[OVERVIEW.md section 19](architecture/OVERVIEW.md#19-docker-and-local-development).

Current state: the repository is private, no image has been published and nothing is deployed. Every command below
runs from the repository root, `~/petition`. On Marina's machine every shell starts with
`source ~/.devenv.sh` (Node 26, pnpm 10.34.9, git 2.50).

Steps marked **(Marina)** change repository settings, visibility or published packages. They are never run by an
agent or a script.

## 1. CI cost rule (ADR 0018)

Private repositories pay for Actions minutes and package storage, so the two expensive parts of the pipeline only run
where they add information. Full reasoning: [ADR 0018](architecture/adr/0018-ci-cost-rule.md).

| Workflow / job                                 | Pull request | Push to `main`           | Manual (`workflow_dispatch`) | Condition                                                 |
| ---------------------------------------------- | ------------ | ------------------------ | ---------------------------- | --------------------------------------------------------- |
| `ci.yml` lint, typecheck, unit, integration    | runs         | runs                     | runs                         | none                                                      |
| `ci.yml` build, `dev-setup-smoke`, gitleaks    | runs         | runs                     | runs                         | none                                                      |
| `ci.yml` e2e                                   | runs         | skipped                  | skipped                      | `github.event_name == 'pull_request'`                     |
| `release.yml` `build + push image` (`images`)  | never        | after green CI on `main` | `main` only                  | `github.event.repository.private == false`                |
| `release.yml` `deploy`                         | never        | after `images`           | after `images`               | repository public **and** `vars.DEPLOY_ENABLED == 'true'` |
| `audit.yml` (`pnpm audit --prod`, high and up) | never        | when the lockfile moves  | runs                         | also weekly, Monday 03:00 UTC; never a pull request check |

Why e2e is enough on the pull request: phases are merged one at a time with a squash merge, so `main` does not move
between the PR's e2e run and the merge (ADR 0017). The PR's e2e job is also the only proof that the production image
builds and that `@napi-rs/canvas` works in it on linux/amd64 (canvas smoke check, ADR 0005).

### What to check after every merge while the repository is private

The release workflow must finish with both jobs skipped. Anything else means the visibility condition is broken.

```bash
run_id=$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$run_id" --json conclusion,headSha,jobs --jq '{conclusion, headSha, jobs: [.jobs[] | {name, conclusion}]}'
```

Expected: run `conclusion` is `skipped`, `headSha` is the merge commit, and both `build + push image` and `deploy` are
`skipped`.

Running the audit by hand (presentation phase, and whenever a security advisory is announced):

```bash
gh workflow run audit.yml --ref main
# The new run appears after a few seconds: take the id of the workflow_dispatch run.
gh run list --workflow audit.yml --limit 1 --json databaseId,event,createdAt
gh run watch <databaseId>
```

### Changing the rule

- Making the repository public is the only switch for `images`. No variable or secret turns it on in a private
  repository.
- Deploying from the private repository is impossible by design. It needs a new ADR that supersedes ADR 0018 item 3.
- Workflow edits are checked statically with actionlint, because `images` and `deploy` cannot run before the
  repository is public: `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:<tag>` (a one-off check, nothing is
  committed).

## 2. Erasure on request (F-91, ADR 0013, ADR 0016)

There is no password reset, because the app sends no email (OVERVIEW.md section 3). A user who can still sign in
deletes their signature or account themselves (`/signature/delete`, `/account/delete`). A user who lost their password
asks through the contact channel named on the privacy page (`CONTACT_URL`), and the operator erases the account with
`src/tools/erase-user.ts`.

The tool deletes the user row in one transaction. The foreign keys cascade to `profiles` and `signatures`, exactly like
`POST /account/delete`. It never prints or logs the email address, only the numeric user id. Its behaviour is covered
by `src/tools/__tests__/erase-user.int.test.ts` (refuses without `--confirm`, matches case-insensitively, cascades).

### Procedure

The commands take the address from the shell variable `ERASE_EMAIL`, which keeps it out of every command line you
might paste elsewhere. In zsh, `read -r ERASE_EMAIL` sets it without writing it to the shell history; run
`unset ERASE_EMAIL` when you are done. The address is still visible in the local process list while the tool runs, so
run it on a machine you control.

1. **Record the request** with the date it arrived. GDPR Art. 12(3) gives one month to answer.
2. **Verify ownership of the address.** Write to the address named in the request and ask its owner to confirm the
   erasure by replying from it. Only a reply from that mailbox counts: a request that merely names an address, or a
   sender header, proves nothing. Until verification, do not tell the requester whether an account with that address
   exists.
3. **Preview** (deletes nothing, exits 1 on purpose):

   ```bash
   pnpm admin:erase -- --email "$ERASE_EMAIL"
   ```

   Output: `erase-user: user 42 would be erased: account, profile, signature`, followed by
   `erase-user: refusing to delete without --confirm. Nothing was deleted.` Write down the user id.

4. **Erase:**

   ```bash
   pnpm admin:erase -- --email "$ERASE_EMAIL" --confirm
   ```

   Output: a JSON log line with `"msg":"account.erased"` and the `userId`, then
   `erase-user: user 42 erased: account, profile, signature`. Exit code 0. The confirmed run looks the account up again
   inside the transaction and locks the row, so the line it prints describes exactly what was deleted. If the user id
   differs from the preview, the account was deleted and re-registered in between; stop and check before answering.

5. **Check:** run the preview again. It must answer `no account has this email address. Nothing was deleted.`
6. **Answer** the requester from the same mailbox that verified the address. Keep only the date, the user id and the
   `account.erased` log line as the record of the erasure, not the address.

### Where to run it

The commands in the procedure use `pnpm admin:erase`, which works wherever the repository is checked out. Add
`--confirm` for step 4 in every variant.

- **Local database** (`pnpm dev` and `pnpm demo` share the same Postgres container and volume): `pnpm admin:erase`
  reads `DATABASE_URL` from `.env`.
- **Inside the locally built image:** the `migrate` service is used on purpose, because it receives only
  `DATABASE_URL` and no session or CSRF secret. Postgres must already be running.

  ```bash
  docker compose run --rm --no-deps migrate dist/tools/erase-user.js --email "$ERASE_EMAIL"
  ```

- **Production:** run the tag that is deployed, so the tool matches the schema. `-e DATABASE_URL` without a value
  passes the variable from your shell, so the credentials never appear on the command line.

  ```bash
  docker run --rm --network <database network> -e DATABASE_URL \
    ghcr.io/arnoldovna/petition:sha-<deployed commit> dist/tools/erase-user.js --email "$ERASE_EMAIL"
  ```

The runtime image is distroless and has no pnpm and no shell. Its entrypoint is `node`, so the command after the image
name is the script path and its arguments.

### Exit codes and messages

Every message starts with `erase-user: `. Argument errors add a usage line.

| Exit | Message on stderr                                            | Meaning and next step                                                                                |
| ---- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 0    | none (stdout: `user <id> erased: ...`)                       | Erased. Continue with step 5.                                                                        |
| 1    | `refusing to delete without --confirm. Nothing was deleted.` | Preview only, as intended in step 3.                                                                 |
| 1    | `no account has this email address. Nothing was deleted.`    | Nothing to erase: the address was never registered, or it was changed. Ask for the address in use.   |
| 1    | `--email ...`, `unknown option ...`, `unexpected argument`   | Typo in the arguments. The message names the rule, never the value.                                  |
| 1    | `DATABASE_URL is required`                                   | No database configured in this shell or container.                                                   |
| 1    | `the database query failed; nothing was deleted.`            | Connection or permission problem. The transaction was rolled back; fix the connection and run again. |

### What the erasure does and does not cover

- **Sessions:** the user's open sessions stay in Redis until they expire, but they belong to nobody. The next request
  from such a browser finds no user row and is treated as a guest (ADR 0002).
- **Rate-limit counters** hold only an HMAC of the email and expire after at most one hour (ADR 0012).
- **Logs** contain user ids only, never names or addresses (ADR 0011). Nothing to delete there.
- **Re-registration:** the same address can register again afterwards and gets a new user id (F-69).
- **Backups:** an erased account stays in every database backup taken before the erasure until that backup expires.
  If a deployment keeps backups, state their retention on the privacy page and, after restoring a backup, delete the
  recorded user ids again before the app goes back online. `\bind` (psql 16 or later) sends the id as a query
  parameter, so it never becomes part of the SQL text, and anything that is not an integer fails with an error instead
  of changing the statement; the cascade removes profile and signature:

  ```bash
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v id=42 <<'SQL'
  DELETE FROM users WHERE id = $1 \bind :id \g
  SQL
  ```

## 3. Publishing the first image after the repository is public

While the repository is private the `images` job is skipped (section 1). Nobody pulls the image and there is no deploy
target, so nothing is lost.

### Before switching to public (Marina)

- [ ] The presentation phase is merged and CI on `main` is green.
- [ ] `pnpm secrets:scan` is clean over the full history (gitleaks `git` and `dir`), and `git ls-files .env` prints
      nothing.
- [ ] The audit run by hand is green (section 1).
- [ ] No commercial typeface is referenced anywhere in the repository (conventions §10).
- [ ] The social preview is uploaded in Settings → General → Social preview: `docs/media/social-preview.png`
      (1280 × 640). GitHub has no API for it, so it is a manual step. How the image is built and regenerated is in
      [docs/media/social-preview.md](media/social-preview.md).
- [ ] The email addresses in the commit metadata are acceptable in public. gitleaks does not look at them, and they
      become public with the code: author and committer of every commit, the tagger of every annotated tag, every
      `Co-authored-by` trailer, and the commits of merged pull requests, which GitHub keeps under
      `refs/pull/<n>/head` after their branch is deleted.

      Settle the address for new commits first, because every commit made with another address adds to what has to
      be checked or rewritten: `git config user.email 42670470+Arnoldovna@users.noreply.github.com` in the
      repository, and in GitHub Settings → Emails "Keep my email addresses private" (merges made on GitHub then use
      the noreply address) and "Block command line pushes that expose my email". Once the branch commits and the
      squash merge have the same author, GitHub also stops adding a `Co-authored-by` line to the merge.

      Then list the addresses (the fetch adds the pull-request commits as local refs):

      ```bash
      git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'
      git log --all --format='%ae%n%ce' | sort -u
      git log --all --format='%(trailers:key=Co-authored-by,valueonly)' | sed '/^$/d' | sort -u
      git for-each-ref refs/tags --format='%(taggeremail)' | sed '/^$/d' | sort -u
      ```

      Only the GitHub noreply address (`42670470+Arnoldovna@users.noreply.github.com`), `noreply@github.com` (the
      committer of every merge made on GitHub), bots and `noreply@anthropic.com` belong there. Any other address is
      decided before the switch: keep it, or publish a new repository with a rewritten history instead. In that
      rewrite, `git filter-repo --mailmap <file>` changes authors, committers and taggers, but a `Co-authored-by`
      trailer is part of the commit message: the same run needs `--replace-message <file>` with one line
      `<old address>==>42670470+Arnoldovna@users.noreply.github.com` per address. Run the listing again on the
      rewritten clone before pushing it. Rewriting `main` here is not enough, because a push cannot rewrite or delete
      the pull-request refs (only GitHub Support can).

- [ ] The repository is switched to public in Settings → General → Danger Zone.
- [ ] Right after: a branch ruleset for `main` (pull request required, required status checks from `ci.yml`, no force
      push), CodeQL default setup and secret scanning with push protection in Settings → Code security (PLAN.md
      "Wartung": rulesets and CodeQL become available on the free plan once the repository is public).

### Publish (Marina)

Either wait for the next green CI run on `main` (any merge), or publish at once:

```bash
gh workflow run release.yml --ref main
# The new run appears in the list after a few seconds; check its createdAt before watching it.
gh run list --workflow release.yml --limit 1 --json databaseId,event,createdAt
gh run watch <databaseId>
```

Manual runs are accepted on `main` only, because `latest` must never point at a branch build. Expected result:
`build + push image` succeeds, `deploy` is skipped (`DEPLOY_ENABLED` is not set).

The image is `ghcr.io/arnoldovna/petition` with two tags, `sha-<commit>` and `latest`. The commit is the one CI tested
(`RELEASE_SHA` = the CI run's `head_sha`), also for manual runs on `main`. The build carries provenance (`mode=max`),
an SBOM and the label `org.opencontainers.image.revision` with the same commit. It is built for linux/amd64 only.

### Verify

```bash
gh auth refresh --scopes read:packages   # once, if the next call answers 403
gh api users/Arnoldovna/packages/container/petition --jq '{visibility, html_url}'
docker buildx imagetools inspect ghcr.io/arnoldovna/petition:latest
docker pull --platform linux/amd64 ghcr.io/arnoldovna/petition:latest
docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  ghcr.io/arnoldovna/petition:latest
```

- `imagetools inspect` lists the linux/amd64 image and an attestation manifest (provenance and SBOM).
- The revision label equals `git rev-parse origin/main` at the time of the run.
- Optional, on Apple Silicon under emulation: the canvas smoke check in the published image,
  `docker run --rm --platform linux/amd64 --network none ghcr.io/arnoldovna/petition:latest dist/tools/smoke-canvas.js`.

### Package visibility (Marina)

If the `gh api` call above reports `"visibility": "private"`, anonymous pulls fail. Make the package public in the
package's settings (Package settings → Danger Zone → Change visibility). GitHub does not allow a public package to be
made private again, so this is a deliberate, one-way step. The package is linked to the repository through the
`org.opencontainers.image.source` label that `docker/metadata-action` sets, so it appears on the repository page.

From then on every green CI run on `main` pushes a new `sha-<commit>` tag and moves `latest`.

## 4. Deploy checklist

The `deploy` job in `release.yml` is a placeholder that fails on purpose (`No deploy target configured yet`). PLAN.md
postpones deployment until a hosting account exists. Everything below must hold before `DEPLOY_ENABLED` is set.

### Enabling the job (Marina)

- [ ] The repository is public and section 3 is done.
- [ ] A hosting target exists and the placeholder step in `release.yml` is replaced by a real deploy step (in a pull
      request, through the quality gate). Setting the variable first would turn every release run red.
- [ ] Environment `production` exists (Settings → Environments) with required reviewers and a deployment branch rule
      for `main` only. Its secrets hold the deploy credentials and the app secrets below, never repository secrets.
- [ ] `gh variable set DEPLOY_ENABLED --body true` last.

The job deploys `IMAGE_TAG=sha-<RELEASE_SHA>`, never `latest`, so a deployment always names the tested commit.

### Configuration

Validated at startup by `src/config/env.ts`; a missing or invalid key stops the process and the error lists key names
only. Never copy the local `.env` to a server: it contains `POSTGRES_PASSWORD=local-only` and the demo password.

| Key                                              | Production value                                                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                       | `production` (already set in the image)                                                                                                                                                                                                    |
| `PORT`                                           | `3000` (default); the container exposes 3000                                                                                                                                                                                               |
| `LOG_LEVEL`                                      | `info`                                                                                                                                                                                                                                     |
| `TRUST_PROXY`                                    | the number of reverse-proxy hops in front of the app, usually `1`. With `0` behind a TLS proxy the secure session cookie is never set, so every form POST fails, and all clients share the proxy's rate-limit budget (ADR 0011, ADR 0012). |
| `COOKIE_SECURE`                                  | unset or `true` (the site must be served over https: `__Host-` cookies, HSTS, `upgrade-insecure-requests`)                                                                                                                                 |
| `DATABASE_URL`                                   | `postgres://` URL of a production database with its own credentials; TLS when the database is reached over a network you do not control                                                                                                    |
| `REDIS_URL`                                      | `redis://` on a private network, `rediss://` otherwise                                                                                                                                                                                     |
| `SESSION_SECRET`                                 | freshly generated, at least 32 characters, e.g. `openssl rand -base64 32`                                                                                                                                                                  |
| `CSRF_SECRET`                                    | freshly generated, at least 32 characters, different from every `SESSION_SECRET` entry (the app refuses to start otherwise)                                                                                                                |
| `IMPRINT_URL`                                    | **required** for a public site: `https://` link to the operator's imprint (ADR 0016, section 5 DDG)                                                                                                                                        |
| `CONTACT_URL`                                    | `https://` link to a channel that can receive erasure and access requests (section 2); the default GitHub profile is not one                                                                                                               |
| `APP_TIME_ZONE`                                  | `Europe/Berlin` (default)                                                                                                                                                                                                                  |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS` | defaults (120 minutes, 168 hours)                                                                                                                                                                                                          |
| `RATE_LIMIT_GLOBAL_MAX`, `RATE_LIMIT_AUTH_MAX`   | defaults (300, 10). A higher value logs `rate_limit.relaxed` at startup; that warning must not appear in production.                                                                                                                       |

Never set in production: `SEED_ALLOW`, `SEED_DEMO_PASSWORD` (the seed must never run against real users, ADR 0016),
`POSTGRES_*`, `APP_PORT` and `E2E_*` (local compose only).

Rotating secrets:

- `SESSION_SECRET` is a comma-separated list; the first entry signs, all entries verify (ADR 0002). Put the new secret
  first, keep the old one for `SESSION_ABSOLUTE_HOURS` (168 hours), then remove it. The keyed email hash for rate
  limits is derived from the first entry, so its counters reset on rotation, which is harmless (ADR 0012).
- `CSRF_SECRET` is a single key. Rotating it invalidates forms that are open at that moment ("This form has expired",
  one retry for the user).

### Reverse proxy and container

- [ ] TLS terminates at the proxy, plain http only on the private hop to the container. The proxy sets
      `X-Forwarded-For` and `X-Forwarded-Proto`, and `TRUST_PROXY` matches the number of proxies.
- [ ] The proxy does **not** compress `text/html`. Pages carry the CSRF token next to reflected input, which is the
      BREACH precondition; the app itself compresses only `/assets` and `/fonts` (ADR 0010).
- [ ] At least **384 MiB** memory for the app container: argon2id uses 64 MiB per hash and up to two hashes run at
      once (ADR 0009).
- [ ] The container keeps the compose hardening: runs as the image's non-root user 65532, all capabilities dropped,
      `no-new-privileges`, a read-only root filesystem with a tmpfs on `/tmp`, no port published except through the
      proxy.
- [ ] Liveness probe `GET /health/live`, readiness probe `GET /health/ready` (database and Redis; 503 while shutting
      down). Health checks are not logged.
- [ ] Stop grace period of at least 15 seconds. On `SIGTERM` the app fails readiness, finishes in-flight requests and
      exits; a hard timeout forces the exit after 10 seconds.
- [ ] Logs are JSON lines on stdout (pino) with a request id; collect them with a retention period that the privacy
      page can state.

### Data stores

- [ ] PostgreSQL 17 or later (tested on 18): the schema uses the built-in `pg_c_utf8` collation (ADR 0007).
- [ ] Redis 8 (tested). It holds sessions and rate-limit counters only. The local compose Redis runs without
      persistence; in production that means a Redis restart signs everyone out, which is acceptable for this app.
- [ ] Database backups, if any, have a stated retention, and the erasure procedure's backup note applies (section 2).

### Release order and rollback

1. Run the migrations with the new image before the new app starts: `node dist/db/migrate.js` with only
   `DATABASE_URL` (the compose `migrate` service is the model). Migrations never run from the web process.
2. Start the new app container and wait for `/health/ready` to answer 200.
3. Smoke test: the home page loads over https with HSTS and `__Host-` cookies; registering, signing and deleting a test
   account work end to end; the startup log shows no `rate_limit.relaxed` warning.

Rollback: deploy the previous `sha-<commit>` tag. Migrations are forward-only (drizzle-kit SQL in `drizzle/`), so a
release that changes the schema must stay compatible with the previous image, or rollback means a forward fix.

## Related documents

- [ADR 0013](architecture/adr/0013-deletion-flows.md): deletion flows and the cascade
- [ADR 0015](architecture/adr/0015-test-and-delivery-pipeline.md): test layers, CI and CD
- [ADR 0016](architecture/adr/0016-privacy-notice-imprint-and-erasure.md): privacy notice, imprint, seed guard, erasure
- [ADR 0018](architecture/adr/0018-ci-cost-rule.md): CI cost rule
- [OVERVIEW.md section 16](architecture/OVERVIEW.md#16-configuration): every configuration key
