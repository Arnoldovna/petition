# W3C Nu HTML Checker for `scripts/validate-html.mjs` (F-87, ADR 0015). Never built: the script reads the image
# reference from the FROM line and runs it directly. Dependabot (docker, directory /docker) keeps the digest current.
# `latest` is the only multi-arch tag (linux/amd64 for CI, linux/arm64 for local runs); the newest versioned tag,
# 24.10.17, is amd64-only, so the digest is what pins the version (validator 26.11.14 when this was written).
FROM ghcr.io/validator/validator:latest@sha256:ab58f1a04ce22a393725e3fd6468d2763c08be6a9dc6fcaa0b1d93dd0c5f804e
