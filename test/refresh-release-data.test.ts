import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  downloadPlatform,
  githubHeaders,
  platformAssets,
  releaseVersion,
  refresh,
  sha256,
  updatePlatform,
  updateResponse,
  type GitHubAsset,
  type Release,
} from "../scripts/refresh-release-data.ts";

function asset(
  name: string,
  options: { digest?: string; size?: number } = {},
): GitHubAsset {
  return {
    browser_download_url: `https://downloads.example.com/${name}`,
    digest: options.digest,
    name,
    size: options.size ?? 123,
  };
}

describe("release metadata parsing", () => {
  test("extracts product version from stable release tags", () => {
    assert.equal(releaseVersion("v1.2.3"), "1.2.3");
  });

  test("rejects unsupported release tags", () => {
    assert.throws(() => releaseVersion("1.2.3"), /Unsupported release tag/);
    assert.throws(() => releaseVersion("v1.2"), /Unsupported release tag/);
  });

  test("normalizes GitHub sha256 digests", () => {
    const digest =
      "sha256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";

    assert.equal(
      sha256(digest),
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
    assert.equal(sha256(undefined), undefined);
    assert.equal(sha256("sha512:abcdef"), undefined);
  });
});

describe("GitHub API headers", () => {
  test("uses GITHUB_TOKEN as a bearer token when provided", () => {
    const headers = githubHeaders("github-token");

    assert.equal(headers.get("Authorization"), "Bearer github-token");
  });

  test("omits authorization for unauthenticated requests", () => {
    const headers = githubHeaders("");

    assert.equal(headers.get("Authorization"), null);
  });
});

describe("platform asset mapping", () => {
  test("maps ZIP assets to update platforms", () => {
    assert.equal(updatePlatform("hucode-darwin-x64.zip"), "darwin");
    assert.equal(updatePlatform("hucode-darwin-arm64.zip"), "darwin-arm64");
    assert.equal(updatePlatform("hucode-linux-x64.zip"), "linux-x64");
    assert.equal(updatePlatform("hucode-darwin-x64.dmg"), undefined);
    assert.equal(updatePlatform("Hucode-darwin-x64.zip"), undefined);
  });

  test("maps DMG assets only for macOS downloads", () => {
    assert.equal(downloadPlatform("hucode-darwin-x64.dmg"), "darwin");
    assert.equal(downloadPlatform("hucode-darwin-arm64.dmg"), "darwin-arm64");
    assert.equal(downloadPlatform("hucode-linux-x64.dmg"), undefined);
    assert.equal(downloadPlatform("hucode-darwin-x64.zip"), undefined);
  });

  test("merges update and download metadata by platform", () => {
    const digest =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    assert.deepEqual(
      platformAssets([
        asset("hucode-darwin-x64.zip", { digest, size: 10 }),
        asset("hucode-darwin-x64.dmg", { digest, size: 20 }),
        asset("hucode-linux-x64.zip", { size: 30 }),
        asset("hucode-linux-x64.dmg", { size: 40 }),
        asset("checksums.txt", { size: 50 }),
      ]),
      {
        darwin: {
          updateUrl: "https://downloads.example.com/hucode-darwin-x64.zip",
          updateSha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          updateSize: 10,
          downloadUrl: "https://downloads.example.com/hucode-darwin-x64.dmg",
          downloadSha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          downloadSize: 20,
        },
        "linux-x64": {
          updateUrl: "https://downloads.example.com/hucode-linux-x64.zip",
          updateSha256: undefined,
          updateSize: 30,
        },
      },
    );
  });
});

describe("update response", () => {
  const release: Release = {
    assets: {
      darwin: {
        updateUrl: "https://downloads.example.com/hucode-darwin-x64.zip",
        updateSha256:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        updateSize: 123,
      },
    },
    commit: "abc123",
    publishedAt: "2026-05-28T20:47:29Z",
    tag: "v1.2.3",
    version: "1.2.3",
  };

  test("builds VS Code updater payloads", () => {
    assert.deepEqual(updateResponse(release, "darwin"), {
      url: "https://downloads.example.com/hucode-darwin-x64.zip",
      name: "1.2.3",
      notes: "abc123",
      pub_date: "2026-05-28T20:47:29Z",
      version: "abc123",
      productVersion: "1.2.3",
      timestamp: Date.parse("2026-05-28T20:47:29Z"),
      sha256hash:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
  });

  test("rejects platforms missing from the latest release", () => {
    assert.throws(
      () => updateResponse(release, "darwin-arm64"),
      /Latest release is missing darwin-arm64/,
    );
  });
});

describe("refresh pipeline", () => {
  test("writes generated metadata from an injected release provider", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "hucode-updates-"));
    const updateRoot = path.join(root, "update");
    const releasesRoot = path.join(root, "releases");
    const generatedSourcePath = path.join(root, "generated", "releases.ts");

    const latest: Release = {
      assets: {
        darwin: {
          updateUrl: "https://downloads.example.com/latest-darwin.zip",
          updateSha256:
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          updateSize: 100,
        },
      },
      commit: "latest-commit",
      publishedAt: "2026-05-28T20:47:29Z",
      tag: "v1.2.3",
      version: "1.2.3",
    };
    const previous: Release = {
      assets: {},
      commit: "previous-commit",
      publishedAt: "2026-05-27T20:47:29Z",
      tag: "v1.2.2",
      version: "1.2.2",
    };

    await refresh({
      generatedSourcePath,
      releaseProvider: () => Promise.resolve([latest, previous]),
      releasesRoot,
      updateRoot,
    });

    const current = JSON.parse(
      await fs.readFile(path.join(releasesRoot, "current.json"), "utf8"),
    ) as { commit?: string };
    const update = JSON.parse(
      await fs.readFile(
        path.join(updateRoot, "darwin", "stable", previous.commit),
        "utf8",
      ),
    ) as { version?: string };
    const generatedSource = await fs.readFile(generatedSourcePath, "utf8");

    assert.equal(current.commit, latest.commit);
    assert.equal(update.version, latest.commit);
    assert.match(generatedSource, /export const releases = \[/);
    await assert.rejects(
      fs.access(path.join(updateRoot, "darwin", "stable", latest.commit)),
    );
  });
});
