# petition

"Nonsense Petition", a tongue-in-cheek petition for absolutely nothing: register, sign with a hand-drawn or typed
signature and browse everyone who signed. I am rebuilding it from scratch from my 2018 bootcamp project as a
server-rendered Express 5 app.

This README is a stub. Screenshots, the architecture diagram and the full story follow when the app is finished. Until
then, the plan lives in [docs/architecture/OVERVIEW.md](docs/architecture/OVERVIEW.md).

## Getting started

Prerequisites: Node 26 (`.nvmrc`), pnpm 10.34.9 (`packageManager`) and Docker.

Reviewers:

```bash
pnpm install
pnpm demo
```

Developers:

```bash
pnpm install
pnpm dev:setup
pnpm dev
```

`pnpm verify` runs the full quality gate (format, lint, types, unit, integration, build, e2e, secret scan).

## Credits

Schibsted Grotesk and Noto Sans are licensed under the SIL Open Font License 1.1 and self-hosted via @fontsource; the
licence texts are in [LICENSES/](LICENSES/).

## Licence

MIT, see [LICENSE](LICENSE).
