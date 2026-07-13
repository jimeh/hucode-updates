import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { describe, test } from "node:test";

import {
  latestRelease,
  releases,
  validCliPlatforms,
  validServerWebPlatforms,
  validPlatforms,
} from "../src/generated/releases.ts";
import worker, { commitDownloadResponse } from "../src/index.ts";

const updateAssets = latestRelease.assets as Record<
  string,
  {
    updateSha256?: string;
    updateUrl: string;
  }
>;

function request(pathname: string): Request {
  return new Request(`https://updates.hucode.dev${pathname}`);
}

describe("update fallback", () => {
  test("returns no update for valid platform requests", async () => {
    for (const platform of validPlatforms) {
      const response = worker.fetch(
        request(`/api/update/${platform}/stable/abc123`),
      );

      assert.equal(response.status, 204);
      assert.equal(
        response.headers.get("Cache-Control"),
        "public, max-age=300",
      );
      assert.equal(await response.text(), "");
    }
  });

  test("rejects invalid update paths", () => {
    const invalidPaths = [
      "/api/update/linux-x64/stable/abc123",
      "/api/update/darwin/insider/abc123",
      "/api/update/darwin/stable",
      "/api/update/darwin/stable/abc123/extra",
      "/api/releases/current.json",
    ];

    for (const pathname of invalidPaths) {
      const response = worker.fetch(request(pathname));

      assert.equal(response.status, 404);
    }
  });
});

describe("server-web download fallback", () => {
  test("redirects commit downloads to generated server-web archives", () => {
    const response = commitDownloadResponse(
      "/commit:server-web-commit/server-darwin-web/stable",
      [
        {
          cliAssets: {},
          commit: "server-web-commit",
          serverWebAssets: {
            "server-darwin-web": {
              url: "https://downloads.example.com/server-web.zip",
            },
          },
        },
      ],
    );

    assert.ok(response);
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("Location"),
      "https://downloads.example.com/server-web.zip",
    );
  });

  test("redirects cross-platform server-web commit downloads", () => {
    const platforms = [
      "server-linux-x64-web",
      "server-linux-arm64-web",
      "server-win32-x64-web",
      "server-win32-arm64-web",
    ];

    for (const platform of platforms) {
      const url = `https://downloads.example.com/${platform}.zip`;
      const response = commitDownloadResponse(
        `/commit:server-web-commit/${platform}/stable`,
        [
          {
            cliAssets: {},
            commit: "server-web-commit",
            serverWebAssets: { [platform]: { url } },
          },
        ],
      );

      assert.ok(response);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("Location"), url);
    }
  });

  test("redirects commit downloads to generated CLI archives", () => {
    const response = commitDownloadResponse(
      "/commit:cli-commit/cli-linux-arm64/stable",
      [
        {
          cliAssets: {
            "cli-linux-arm64": {
              url: "https://downloads.example.com/cli-linux-arm64.tar.gz",
            },
          },
          commit: "cli-commit",
          serverWebAssets: {},
        },
      ],
    );

    assert.ok(response);
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("Location"),
      "https://downloads.example.com/cli-linux-arm64.tar.gz",
    );
  });

  test("rejects malformed or unavailable commit downloads", () => {
    const invalidPaths = [
      "/commit:server-web-commit/server-darwin-web/insider",
      "/commit:server-web-commit/server-darwin-arm64-web/stable",
      "/commit:server-web-commit/server-darwin-web/stable/extra",
      "/commit:/server-darwin-web/stable",
    ];
    const knownReleases = [
      {
        cliAssets: {},
        commit: "server-web-commit",
        serverWebAssets: {
          "server-darwin-web": {
            url: "https://downloads.example.com/server-web.zip",
          },
        },
      },
    ];

    for (const pathname of invalidPaths) {
      assert.equal(commitDownloadResponse(pathname, knownReleases), undefined);
      assert.equal(worker.fetch(request(pathname)).status, 404);
    }
  });
});

describe("generated update assets", () => {
  test("derives valid platforms from latest release ZIP assets", () => {
    assert.deepEqual([...validPlatforms].sort(), ["darwin", "darwin-arm64"]);
    assert.match(latestRelease.version, /^\d+\.\d+\.\d+$/);
    assert.equal(latestRelease.tag, `v${latestRelease.version}`);
  });

  test("generates release notes for each known release", async () => {
    for (const release of releases) {
      const responsePath = `public/release-notes/${release.version}.md`;

      await fs.access(responsePath);
    }
  });

  test("keeps server-web platforms separate from desktop update platforms", () => {
    for (const platform of validServerWebPlatforms) {
      assert.equal(validPlatforms.includes(platform), false);
    }
  });

  test("keeps CLI platforms separate from desktop update platforms", () => {
    for (const platform of validCliPlatforms) {
      assert.equal(validPlatforms.includes(platform), false);
    }
  });

  test("generates optional server-web release metadata", async () => {
    for (const release of releases) {
      assert.ok("cliAssets" in release);
      assert.ok("serverWebAssets" in release);

      for (const platform of Object.keys(release.cliAssets)) {
        const responsePath = `public/api/versions/${release.version}/${platform}/stable`;
        const response = JSON.parse(
          await fs.readFile(responsePath, "utf8"),
        ) as {
          name?: string;
          version?: string;
        };

        assert.equal(response.name, release.version);
        assert.equal(response.version, release.commit);
      }

      for (const platform of Object.keys(release.serverWebAssets)) {
        const responsePath = `public/api/versions/${release.version}/${platform}/stable`;
        const response = JSON.parse(
          await fs.readFile(responsePath, "utf8"),
        ) as {
          name?: string;
          version?: string;
        };

        assert.equal(response.name, release.version);
        assert.equal(response.version, release.commit);
      }
    }
  });

  test("generates static update responses for older commits", async () => {
    for (const release of releases.slice(1)) {
      for (const platform of validPlatforms) {
        const responsePath = `public/api/update/${platform}/stable/${release.commit}`;
        const response = JSON.parse(
          await fs.readFile(responsePath, "utf8"),
        ) as {
          hucodeVersion?: string;
          productVersion?: string;
          sha256hash?: string;
          timestamp?: number;
          url?: string;
          version?: string;
        };
        const updateAsset = updateAssets[platform];
        assert.ok(updateAsset);

        assert.equal(response.productVersion, latestRelease.vscodeVersion);
        assert.equal(response.hucodeVersion, latestRelease.version);
        assert.equal(response.version, latestRelease.commit);
        assert.equal(response.url, updateAsset.updateUrl);
        assert.equal(response.sha256hash, updateAsset.updateSha256);
        assert.equal(response.timestamp, Date.parse(latestRelease.publishedAt));
      }
    }
  });

  test("does not generate static update responses for the latest commit", async () => {
    for (const platform of validPlatforms) {
      await assert.rejects(
        fs.access(
          `public/api/update/${platform}/stable/${latestRelease.commit}`,
        ),
      );
    }
  });
});
