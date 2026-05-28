# Hucode Updates

Update metadata service for Hucode releases.

## Stack

- Node.js 22+
- pnpm 11
- TypeScript
- Cloudflare Workers static assets with Worker fallback

mise reads Node.js from `.node-version` and installs pnpm 11 from
`.mise.toml`.

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
