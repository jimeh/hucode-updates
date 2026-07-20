import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  cliAssets,
  cliPlatform,
  downloadPlatform,
  fetchGitHubReleases,
  githubHeaders,
  platformAssets,
  releaseVersion,
  releaseVersionInfo,
  refresh,
  serverWebAssets,
  serverWebPlatform,
  sha256,
  stableReleases,
  updatePlatform,
  updateResponse,
  versionResponse,
  type GitHubAsset,
  type GitHubRelease,
  type Release,
  type ReleaseWithNotes,
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
    url: `https://api.github.com/assets/${name}`,
  };
}

function githubRelease(
  tag: string,
  options: Partial<GitHubRelease> = {},
): GitHubRelease {
  return {
    assets: [],
    body: null,
    draft: false,
    html_url: `https://github.com/jimeh/hucode/releases/tag/${tag}`,
    prerelease: false,
    published_at: "2026-05-28T20:47:29Z",
    tag_name: tag,
    ...options,
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

describe("release version info", () => {
  test("prefers release metadata asset for VS Code version", async () => {
    const originalFetch = globalThis.fetch;
    const release = githubRelease("v0.0.32", {
      assets: [asset("hucode-release-metadata.json")],
    });

    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            hucodeVersion: "0.0.32",
            vscodeVersion: "1.125.0",
            commit: "release-commit",
            quality: "stable",
          }),
        ),
      );

    try {
      assert.deepEqual(await releaseVersionInfo(release, "release-commit"), {
        hucodeVersion: "0.0.32",
        vscodeVersion: "1.125.0",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("falls back to package.json at the release commit", async () => {
    const originalFetch = globalThis.fetch;
    const release = githubRelease("v0.0.32");
    const content = Buffer.from(
      JSON.stringify({ version: "1.125.0" }),
      "utf8",
    ).toString("base64");
    const requestedUrls: string[] = [];

    const mockFetch: typeof fetch = (input) => {
      if (typeof input !== "string") {
        throw new TypeError("Expected fetch URL string.");
      }

      requestedUrls.push(input);

      return Promise.resolve(
        new Response(JSON.stringify({ content, encoding: "base64" })),
      );
    };

    globalThis.fetch = mockFetch;

    try {
      assert.deepEqual(await releaseVersionInfo(release, "release-commit"), {
        hucodeVersion: "0.0.32",
        vscodeVersion: "1.125.0",
      });
      assert.deepEqual(requestedUrls, [
        "https://api.github.com/repos/jimeh/hucode/contents/package.json?ref=release-commit",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects metadata that does not match the release tag", async () => {
    const originalFetch = globalThis.fetch;
    const release = githubRelease("v0.0.32", {
      assets: [asset("hucode-release-metadata.json")],
    });

    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            hucodeVersion: "0.0.31",
            vscodeVersion: "1.125.0",
          }),
        ),
      );

    try {
      await assert.rejects(
        releaseVersionInfo(release, "release-commit"),
        /does not match tag/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
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

describe("GitHub release fetching", () => {
  test("fetches all release pages", async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      githubRelease(`v1.0.${index}`),
    );
    const secondPage = [githubRelease("v0.9.0")];

    const mockFetch: typeof fetch = (input) => {
      if (typeof input !== "string") {
        throw new TypeError("Expected fetch URL string.");
      }

      requestedUrls.push(input);

      const url = new URL(input);
      const page = url.searchParams.get("page");
      const body = page === "1" ? firstPage : secondPage;

      return Promise.resolve(new Response(JSON.stringify(body)));
    };

    globalThis.fetch = mockFetch;

    try {
      const releases = await fetchGitHubReleases();

      assert.equal(releases.length, 101);
      assert.deepEqual(requestedUrls, [
        "https://api.github.com/repos/jimeh/hucode/releases?per_page=100&page=1",
        "https://api.github.com/repos/jimeh/hucode/releases?per_page=100&page=2",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("GitHub release ordering", () => {
  test("uses GitHub's latest release then descending semver", () => {
    const latest = githubRelease("v0.0.51", {
      published_at: "2026-07-20T02:59:14Z",
    });
    const laterPublished = githubRelease("v0.0.9", {
      published_at: "2026-07-20T08:11:23Z",
    });
    const higherVersion = githubRelease("v0.0.10", {
      published_at: "2026-07-19T20:48:19Z",
    });

    assert.deepEqual(
      stableReleases([latest, laterPublished, higherVersion], latest).map(
        (release) => release.tag_name,
      ),
      ["v0.0.51", "v0.0.10", "v0.0.9"],
    );
  });
});

describe("platform asset mapping", () => {
  test("maps ZIP assets to update platforms", () => {
    assert.equal(updatePlatform("hucode-darwin-x64.zip"), "darwin");
    assert.equal(updatePlatform("hucode-darwin-arm64.zip"), "darwin-arm64");
    assert.equal(updatePlatform("hucode-linux-x64.zip"), "linux-x64");
    assert.equal(updatePlatform("hucode-linux-arm64.zip"), "linux-arm64");
    assert.equal(updatePlatform("hucode-linux-armhf.zip"), undefined);
    assert.equal(updatePlatform("hucode-win32-x64.zip"), undefined);
    assert.equal(
      updatePlatform("hucode-server-darwin-arm64-web.zip"),
      undefined,
    );
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
      platformAssets(
        [
          asset("hucode-darwin-x64.zip", { digest, size: 10 }),
          asset("hucode-darwin-x64.dmg", { digest, size: 20 }),
          asset("hucode-linux-x64.zip", { size: 30 }),
          asset("hucode-linux-arm64.zip", { digest, size: 40 }),
          asset("hucode-linux-armhf.zip", { size: 50 }),
          asset("checksums.txt", { size: 60 }),
        ],
        "https://github.com/jimeh/hucode/releases/tag/v1.2.3",
      ),
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
          updateUrl: "https://github.com/jimeh/hucode/releases/tag/v1.2.3",
          updateSha256: undefined,
          updateSize: 30,
        },
        "linux-arm64": {
          updateUrl: "https://github.com/jimeh/hucode/releases/tag/v1.2.3",
          updateSha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          updateSize: 40,
        },
      },
    );
  });

  test("maps server-web ZIP assets to CLI update platforms", () => {
    const digest =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    assert.equal(
      serverWebPlatform("hucode-server-darwin-arm64-web.zip"),
      "server-darwin-arm64-web",
    );
    assert.equal(
      serverWebPlatform("hucode-server-darwin-x64-web.zip"),
      "server-darwin-web",
    );
    assert.equal(
      serverWebPlatform("hucode-server-linux-x64-web.zip"),
      "server-linux-x64-web",
    );
    assert.equal(
      serverWebPlatform("hucode-server-linux-arm64-web.zip"),
      "server-linux-arm64-web",
    );
    assert.equal(
      serverWebPlatform("hucode-server-win32-x64-web.zip"),
      "server-win32-x64-web",
    );
    assert.equal(
      serverWebPlatform("hucode-server-win32-arm64-web.zip"),
      "server-win32-arm64-web",
    );
    assert.equal(
      serverWebPlatform("hucode-server-linux-armhf-web.zip"),
      undefined,
    );
    assert.equal(
      serverWebPlatform("hucode-server-alpine-x64-web.zip"),
      undefined,
    );
    assert.equal(
      serverWebPlatform("hucode-server-win32-x86-web.zip"),
      undefined,
    );
    assert.equal(serverWebPlatform("hucode-darwin-arm64.zip"), undefined);
    assert.deepEqual(
      serverWebAssets([
        asset("hucode-server-darwin-arm64-web.zip", { digest, size: 10 }),
        asset("hucode-server-darwin-x64-web.zip", { size: 20 }),
        asset("hucode-darwin-x64.zip", { size: 30 }),
      ]),
      {
        "server-darwin-arm64-web": {
          url: "https://downloads.example.com/hucode-server-darwin-arm64-web.zip",
          sha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          size: 10,
        },
        "server-darwin-web": {
          url: "https://downloads.example.com/hucode-server-darwin-x64-web.zip",
          sha256: undefined,
          size: 20,
        },
      },
    );
  });

  test("maps standalone CLI archives to CLI update platforms", () => {
    const digest =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    assert.equal(cliPlatform("hucode-cli-darwin-x64.zip"), "cli-darwin-x64");
    assert.equal(
      cliPlatform("hucode-cli-darwin-arm64.zip"),
      "cli-darwin-arm64",
    );
    assert.equal(cliPlatform("hucode-cli-linux-x64.tar.gz"), "cli-linux-x64");
    assert.equal(
      cliPlatform("hucode-cli-linux-arm64.tar.gz"),
      "cli-linux-arm64",
    );
    assert.equal(cliPlatform("hucode-cli-win32-x64.zip"), "cli-win32-x64");
    assert.equal(cliPlatform("hucode-cli-win32-arm64.zip"), "cli-win32-arm64");
    assert.equal(cliPlatform("hucode-cli-linux-armhf.tar.gz"), undefined);
    assert.equal(cliPlatform("hucode-cli-alpine-x64.tar.gz"), undefined);
    assert.equal(cliPlatform("hucode-cli-win32-x86.zip"), undefined);
    assert.equal(cliPlatform("hucode-cli-linux-x64.zip"), undefined);
    assert.equal(cliPlatform("hucode-cli-darwin-x64.tar.gz"), undefined);

    assert.deepEqual(
      cliAssets([
        asset("hucode-cli-linux-arm64.tar.gz", { digest, size: 10 }),
        asset("hucode-cli-win32-x64.zip", { size: 20 }),
        asset("hucode-server-linux-arm64-web.zip", { size: 30 }),
      ]),
      {
        "cli-linux-arm64": {
          url: "https://downloads.example.com/hucode-cli-linux-arm64.tar.gz",
          sha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          size: 10,
        },
        "cli-win32-x64": {
          url: "https://downloads.example.com/hucode-cli-win32-x64.zip",
          sha256: undefined,
          size: 20,
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
    cliAssets: {},
    commit: "abc123",
    publishedAt: "2026-05-28T20:47:29Z",
    serverWebAssets: {},
    tag: "v1.2.3",
    version: "1.2.3",
    vscodeVersion: "1.125.0",
  };

  test("builds VS Code updater payloads", () => {
    assert.deepEqual(updateResponse(release, "darwin"), {
      url: "https://downloads.example.com/hucode-darwin-x64.zip",
      name: "1.2.3",
      notes: "abc123",
      pub_date: "2026-05-28T20:47:29Z",
      version: "abc123",
      productVersion: "1.125.0",
      hucodeVersion: "1.2.3",
      timestamp: Date.parse("2026-05-28T20:47:29Z"),
      sha256hash:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
  });

  test("uses the release page for manual Linux updates", () => {
    const linuxRelease: Release = {
      ...release,
      assets: {
        "linux-arm64": {
          updateUrl: "https://github.com/jimeh/hucode/releases/tag/v1.2.3",
          updateSha256:
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          updateSize: 456,
        },
      },
    };

    const response = updateResponse(linuxRelease, "linux-arm64") as {
      url?: string;
    };

    assert.equal(
      response.url,
      "https://github.com/jimeh/hucode/releases/tag/v1.2.3",
    );
  });

  test("rejects platforms missing from the latest release", () => {
    assert.throws(
      () => updateResponse(release, "darwin-arm64"),
      /Latest release is missing darwin-arm64/,
    );
  });
});

describe("download version responses", () => {
  const release: Release = {
    assets: {},
    cliAssets: {},
    commit: "abc123",
    publishedAt: "2026-05-28T20:47:29Z",
    serverWebAssets: {},
    tag: "v1.2.3",
    version: "1.2.3",
    vscodeVersion: "1.125.0",
  };

  test("builds Hucode CLI version lookup payloads", () => {
    assert.deepEqual(versionResponse(release), {
      version: "abc123",
      name: "1.2.3",
    });
  });
});

describe("refresh pipeline", () => {
  test("rejects a latest release with no update-capable assets", async () => {
    const latest: ReleaseWithNotes = {
      assets: {},
      cliAssets: {},
      commit: "latest-commit",
      publishedAt: "2026-05-28T20:47:29Z",
      releaseNotes: "",
      serverWebAssets: {},
      tag: "v1.2.3",
      version: "1.2.3",
      vscodeVersion: "1.125.0",
    };

    await assert.rejects(
      refresh({
        releaseProvider: () => Promise.resolve([latest]),
      }),
      /Latest release \(v1\.2\.3\) has no update-capable assets\./,
    );
  });

  test("writes generated metadata from an injected release provider", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "hucode-updates-"));
    const latestRoot = path.join(root, "latest");
    const updateRoot = path.join(root, "update");
    const releasesRoot = path.join(root, "releases");
    const releaseNotesRoot = path.join(root, "release-notes");
    const versionsRoot = path.join(root, "versions");
    const generatedSourcePath = path.join(root, "generated", "releases.ts");

    const latest: ReleaseWithNotes = {
      assets: {
        darwin: {
          updateUrl: "https://downloads.example.com/latest-darwin.zip",
          updateSha256:
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          updateSize: 100,
        },
      },
      cliAssets: {},
      commit: "latest-commit",
      publishedAt: "2026-05-28T20:47:29Z",
      releaseNotes: "## Latest\r\n\r\nLatest release notes.\r\n\r\n",
      serverWebAssets: {},
      tag: "v1.2.3",
      version: "1.2.3",
      vscodeVersion: "1.125.0",
    };
    const previous: ReleaseWithNotes = {
      assets: {},
      cliAssets: {},
      commit: "previous-commit",
      publishedAt: "2026-05-27T20:47:29Z",
      releaseNotes: "## Previous\n\nPrevious release notes.",
      serverWebAssets: {},
      tag: "v1.2.2",
      version: "1.2.2",
      vscodeVersion: "1.124.0",
    };

    await refresh({
      generatedSourcePath,
      latestRoot,
      releaseProvider: () => Promise.resolve([latest, previous]),
      releaseNotesRoot,
      releasesRoot,
      updateRoot,
      versionsRoot,
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
    const latestNotes = await fs.readFile(
      path.join(releaseNotesRoot, "1.2.3.md"),
      "utf8",
    );
    const previousNotes = await fs.readFile(
      path.join(releaseNotesRoot, "1.2.2.md"),
      "utf8",
    );

    assert.equal(current.commit, latest.commit);
    assert.equal(update.version, latest.commit);
    assert.equal(latestNotes, "## Latest\n\nLatest release notes.\n");
    assert.equal(previousNotes, "## Previous\n\nPrevious release notes.\n");
    assert.match(generatedSource, /export const releases = \[/);
    await assert.rejects(
      fs.access(path.join(updateRoot, "darwin", "stable", latest.commit)),
    );
    await assert.rejects(fs.access(latestRoot));
    await assert.rejects(fs.access(versionsRoot));
  });

  test("advertises Linux updates only to older builds", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "hucode-updates-"));
    const updateRoot = path.join(root, "update");
    const generatedSourcePath = path.join(root, "generated", "releases.ts");
    const releasePageUrl =
      "https://github.com/jimeh/hucode/releases/tag/v1.2.3";
    const latest: ReleaseWithNotes = {
      assets: {
        "linux-arm64": {
          updateUrl: releasePageUrl,
          updateSize: 200,
        },
        "linux-x64": {
          updateUrl: releasePageUrl,
          updateSize: 100,
        },
      },
      cliAssets: {},
      commit: "latest-commit",
      publishedAt: "2026-05-28T20:47:29Z",
      releaseNotes: "",
      serverWebAssets: {},
      tag: "v1.2.3",
      version: "1.2.3",
      vscodeVersion: "1.125.0",
    };
    const previous: ReleaseWithNotes = {
      assets: {},
      cliAssets: {},
      commit: "previous-commit",
      publishedAt: "2026-05-27T20:47:29Z",
      releaseNotes: "",
      serverWebAssets: {},
      tag: "v1.2.2",
      version: "1.2.2",
      vscodeVersion: "1.124.0",
    };

    await refresh({
      generatedSourcePath,
      latestRoot: path.join(root, "latest"),
      releaseProvider: () => Promise.resolve([latest, previous]),
      releaseNotesRoot: path.join(root, "release-notes"),
      releasesRoot: path.join(root, "releases"),
      updateRoot,
      versionsRoot: path.join(root, "versions"),
    });

    for (const platform of ["linux-x64", "linux-arm64"]) {
      const response = JSON.parse(
        await fs.readFile(
          path.join(updateRoot, platform, "stable", previous.commit),
          "utf8",
        ),
      ) as { hucodeVersion?: string; url?: string; version?: string };

      assert.equal(response.hucodeVersion, latest.version);
      assert.equal(response.version, latest.commit);
      assert.equal(response.url, releasePageUrl);
      await assert.rejects(
        fs.access(path.join(updateRoot, platform, "stable", latest.commit)),
      );
    }

    const generatedSource = await fs.readFile(generatedSourcePath, "utf8");
    assert.match(generatedSource, /"linux-x64"/);
    assert.match(generatedSource, /"linux-arm64"/);
  });

  test("writes CLI and server-web metadata for archive releases", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "hucode-updates-"));
    const latestRoot = path.join(root, "latest");
    const updateRoot = path.join(root, "update");
    const releasesRoot = path.join(root, "releases");
    const releaseNotesRoot = path.join(root, "release-notes");
    const versionsRoot = path.join(root, "versions");
    const generatedSourcePath = path.join(root, "generated", "releases.ts");

    const latest: ReleaseWithNotes = {
      assets: {
        darwin: {
          updateUrl: "https://downloads.example.com/latest-darwin.zip",
          updateSize: 100,
        },
      },
      cliAssets: {
        "cli-linux-x64": {
          url: "https://downloads.example.com/latest-cli.tar.gz",
          sha256:
            "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          size: 150,
        },
      },
      commit: "latest-commit",
      publishedAt: "2026-05-28T20:47:29Z",
      releaseNotes: "",
      serverWebAssets: {
        "server-darwin-web": {
          url: "https://downloads.example.com/latest-server-web.zip",
          size: 200,
        },
      },
      tag: "v1.2.3",
      version: "1.2.3",
      vscodeVersion: "1.125.0",
    };
    const previous: ReleaseWithNotes = {
      assets: {},
      cliAssets: {
        "cli-win32-arm64": {
          url: "https://downloads.example.com/previous-cli.zip",
          sha256:
            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          size: 250,
        },
      },
      commit: "previous-commit",
      publishedAt: "2026-05-27T20:47:29Z",
      releaseNotes: "",
      serverWebAssets: {
        "server-darwin-arm64-web": {
          url: "https://downloads.example.com/previous-server-web.zip",
          size: 300,
        },
      },
      tag: "v1.2.2",
      version: "1.2.2",
      vscodeVersion: "1.124.0",
    };

    await refresh({
      generatedSourcePath,
      latestRoot,
      releaseProvider: () => Promise.resolve([latest, previous]),
      releaseNotesRoot,
      releasesRoot,
      updateRoot,
      versionsRoot,
    });

    const latestX64 = JSON.parse(
      await fs.readFile(
        path.join(latestRoot, "server-darwin-web", "stable"),
        "utf8",
      ),
    ) as { name?: string; version?: string };
    const latestArm64 = JSON.parse(
      await fs.readFile(
        path.join(latestRoot, "server-darwin-arm64-web", "stable"),
        "utf8",
      ),
    ) as { name?: string; version?: string };
    const latestCliLinux = JSON.parse(
      await fs.readFile(
        path.join(latestRoot, "cli-linux-x64", "stable"),
        "utf8",
      ),
    ) as { name?: string; version?: string };
    const latestCliWin32 = JSON.parse(
      await fs.readFile(
        path.join(latestRoot, "cli-win32-arm64", "stable"),
        "utf8",
      ),
    ) as { name?: string; version?: string };
    const versionX64 = JSON.parse(
      await fs.readFile(
        path.join(versionsRoot, "1.2.3", "server-darwin-web", "stable"),
        "utf8",
      ),
    ) as { name?: string; version?: string };
    const versionCliLinux = JSON.parse(
      await fs.readFile(
        path.join(versionsRoot, "1.2.3", "cli-linux-x64", "stable"),
        "utf8",
      ),
    ) as { name?: string; version?: string };
    const versionCliWin32 = JSON.parse(
      await fs.readFile(
        path.join(versionsRoot, "1.2.2", "cli-win32-arm64", "stable"),
        "utf8",
      ),
    ) as { name?: string; version?: string };
    const current = JSON.parse(
      await fs.readFile(path.join(releasesRoot, "current.json"), "utf8"),
    ) as {
      cliAssets?: Record<string, unknown>;
      serverWebAssets?: Record<string, unknown>;
    };
    const generatedSource = await fs.readFile(generatedSourcePath, "utf8");

    assert.deepEqual(latestX64, {
      version: latest.commit,
      name: latest.version,
    });
    assert.deepEqual(latestArm64, {
      version: previous.commit,
      name: previous.version,
    });
    assert.deepEqual(latestCliLinux, {
      version: latest.commit,
      name: latest.version,
    });
    assert.deepEqual(latestCliWin32, {
      version: previous.commit,
      name: previous.version,
    });
    assert.deepEqual(versionX64, {
      version: latest.commit,
      name: latest.version,
    });
    assert.deepEqual(versionCliLinux, {
      version: latest.commit,
      name: latest.version,
    });
    assert.deepEqual(versionCliWin32, {
      version: previous.commit,
      name: previous.version,
    });
    assert.deepEqual(current.cliAssets?.["cli-linux-x64"], {
      url: "https://downloads.example.com/latest-cli.tar.gz",
      sha256:
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      size: 150,
    });
    assert.ok(current.serverWebAssets?.["server-darwin-web"]);
    assert.match(generatedSource, /validCliPlatforms/);
    assert.match(generatedSource, /validServerWebPlatforms/);
    await assert.rejects(
      fs.access(
        path.join(versionsRoot, "1.2.2", "server-darwin-web", "stable"),
      ),
    );
  });
});
