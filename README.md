# Hucode Updates

Update metadata service for Hucode releases.

## Stack

- Node.js 22+
- pnpm 11
- pinact
- TypeScript
- Cloudflare Workers static assets with Worker fallback

mise reads Node.js from `.node-version` and installs pnpm 11 and pinact from
`mise.toml`.

pnpm is configured in `pnpm-workspace.yaml` with `minimumReleaseAge: 10080`,
which only allows dependency versions that have been published for at least
seven days.

## Commands

```sh
mise install
pnpm install
pnpm refresh
pnpm check
pnpm dev
pnpm deploy
```

`pnpm refresh` fetches GitHub release metadata, updates the generated release
manifest, and writes static update responses for older known release commits.

## Release Refresh

The `Refresh release data` GitHub Actions workflow can be run manually or
triggered from `jimeh/hucode` after release assets are uploaded:

```sh
gh api \
  --method POST \
  /repos/jimeh/hucode-updates/dispatches \
  -f event_type=hucode-release-published
```

The caller needs a token with write access to `jimeh/hucode-updates`.

The workflow commits refreshed metadata with
`grafana/github-api-commit-action`, so commits are created through GitHub's
API and signed by GitHub when `GITHUB_TOKEN` is used.
