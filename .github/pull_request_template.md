## What and why

<!-- One or two sentences. Link the FEATURES.md / BUGS.md item this closes. -->

## How

<!-- Notable decisions, trade-offs, anything a reviewer should look at first. -->

## Checklist

- [ ] `pnpm verify` is green locally
- [ ] Tests cover the change (unit, integration or e2e where it belongs); no test was weakened or skipped
- [ ] No utility classes in markup; only maw tokens in CSS
- [ ] No secrets, `.env` files or credentials in the diff (gitleaks clean)
- [ ] Screenshots attached for visible UI changes (desktop 1440 and mobile 390, light and dark)
- [ ] Docs updated (README, ADR, `.env.example`) if behaviour or configuration changed
