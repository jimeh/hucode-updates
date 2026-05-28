import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { describe, test } from "node:test";

import {
  latestRelease,
  releases,
  validPlatforms,
} from "../src/generated/releases.ts";
import worker from "../src/index.ts";

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

describe("generated update assets", () => {
  test("derives valid platforms from latest release ZIP assets", () => {
    assert.deepEqual([...validPlatforms].sort(), ["darwin", "darwin-arm64"]);
    assert.equal(latestRelease.tag, "v0.0.20");
    assert.equal(latestRelease.version, "0.0.20");
  });

  test("generates static update responses for older commits", async () => {
    for (const release of releases.slice(1)) {
      for (const platform of validPlatforms) {
        const responsePath = `public/api/update/${platform}/stable/${release.commit}`;
        const response = JSON.parse(
          await fs.readFile(responsePath, "utf8"),
        ) as {
          productVersion?: string;
          sha256hash?: string;
          timestamp?: number;
          url?: string;
          version?: string;
        };
        const updateAsset = updateAssets[platform];
        assert.ok(updateAsset);

        assert.equal(response.productVersion, latestRelease.version);
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
