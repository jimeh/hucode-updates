import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { describe, test } from "node:test";

import {
  latestRelease,
  releases,
  validPlatforms,
} from "../src/generated/releases.ts";
import worker from "../src/index.ts";

function request(pathname: string): Request {
  return new Request(`https://updates.hucode.dev${pathname}`);
}

describe("update fallback", () => {
  test("returns no update for a valid Darwin request", async () => {
    const response = worker.fetch(request("/api/update/darwin/stable/abc123"));

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=300");
    assert.equal(await response.text(), "");
  });

  test("returns no update for a valid Darwin arm64 request", () => {
    const response = worker.fetch(
      request("/api/update/darwin-arm64/stable/abc123"),
    );

    assert.equal(response.status, 204);
  });

  test("rejects unsupported platforms", () => {
    const response = worker.fetch(
      request("/api/update/linux-x64/stable/abc123"),
    );

    assert.equal(response.status, 404);
  });

  test("rejects unsupported qualities", () => {
    const response = worker.fetch(request("/api/update/darwin/insider/abc123"));

    assert.equal(response.status, 404);
  });
});

describe("generated update assets", () => {
  test("derives valid platforms from latest release ZIP assets", () => {
    assert.deepEqual([...validPlatforms].sort(), ["darwin", "darwin-arm64"]);
    assert.equal(latestRelease.tag, "v0.0.20");
    assert.equal(latestRelease.version, "0.0.20");
  });

  test("generates static update responses for older commits", async () => {
    const olderRelease = releases.find((release) => release.tag === "v0.0.19");
    assert.ok(olderRelease);

    const responsePath = `public/api/update/darwin/stable/${olderRelease.commit}`;
    const response = JSON.parse(await fs.readFile(responsePath, "utf8")) as {
      productVersion?: string;
      url?: string;
      version?: string;
    };

    assert.equal(response.productVersion, latestRelease.version);
    assert.equal(response.version, latestRelease.commit);
    assert.equal(response.url, latestRelease.assets.darwin.updateUrl);
  });
});
