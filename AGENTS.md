# Agent Guide

## Project Shape

This repo hosts `updates.hucode.dev`, a minimal Cloudflare Worker plus static
asset service for Hucode releases. Keep it framework-free TypeScript unless the
existing shape stops fitting.

- `src/index.ts` is the Worker fallback for update paths that are not served as
  static files. Valid updater misses return `204`; malformed or unsupported
  paths return `404`.
- `scripts/refresh-release-data.ts` fetches release data from
  `jimeh/hucode` and regenerates checked-in static assets.
- `src/generated/releases.ts` is generated metadata used by the Worker.
- `public/api/releases/*`, `public/api/update/*`, and
  `public/release-notes/*` are generated static assets.
- `test/refresh-release-data.test.ts` covers the refresh pipeline.
- `test/update-contract.test.ts` covers generated assets and Worker updater
  behavior.

## Commands

Use the repo scripts instead of ad hoc equivalents:

```sh
mise install
pnpm install
pnpm check
pnpm dev
pnpm deploy
```

`pnpm check` is the main validation gate. It runs linting, formatting checks,
type checks, and tests. The pre-commit hook only runs format, lint, and
typecheck for staged files, so run `pnpm check` before handing off behavior
changes.

## Release Refresh

Use the refresh script for generated release data:

```sh
GITHUB_TOKEN="$(gh auth token)" pnpm refresh
pnpm check
```

Authenticated GitHub API requests avoid local `403` failures from unauthenticated
rate limits. The refresh workflow uses a GitHub App token from
`RELEASE_BOT_CLIENT_ID` and `RELEASE_BOT_PRIVATE_KEY`; keep that app-token
pattern for workflow auth.

`pnpm refresh` should be the only normal way to update these generated paths:

- `public/api/releases/*`
- `public/api/update/*`
- `public/release-notes/*`
- `src/generated/releases.ts`

If the refresh output changes, include all regenerated files in the same change
and verify with `pnpm check`. The workflow allowlist in
`.github/workflows/refresh-release-data.yml` should match the generated paths.

## Release Notes

Per-version release notes are static Markdown files generated from stable GitHub
release bodies:

```text
/release-notes/{version}.md
```

Use version-only names like `0.0.24.md`, not tag names like `v0.0.24.md`.
Release note bodies should stay in `public/release-notes/*`; do not embed them
in `src/generated/releases.ts` or the public release JSON metadata.

## Constraints

- Keep static assets asset-first. The Worker exists only for the update fallback
  contract that static headers cannot express.
- Preserve `public/_headers` content types when adding static asset families.
- Do not pin tests to a specific live latest release version. Assert shape and
  consistency instead.
- Keep Worker code free of Node ambient assumptions. Node scripts and tests are
  typechecked through `tsconfig.node.json`.
- `pnpm-workspace.yaml` enforces `minimumReleaseAge: 10080`; keep the seven-day
  dependency maturity gate unless explicitly changing dependency policy.
- Avoid new dependencies when the implementation is small.
