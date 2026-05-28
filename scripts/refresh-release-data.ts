import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { format } from "prettier";

const REPO = "jimeh/hucode";
const GENERATED_SOURCE = path.join("src", "generated", "releases.ts");
const UPDATE_ROOT = path.join("public", "api", "update");
const RELEASES_ROOT = path.join("public", "api", "releases");

/**
 * Minimal GitHub release asset shape used by the refresh pipeline.
 */
export type GitHubAsset = {
  browser_download_url: string;
  digest?: string;
  name: string;
  size: number;
};

type GitHubRelease = {
  assets: GitHubAsset[];
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  tag_name: string;
};

type GitHubRef = {
  object: {
    sha: string;
    type: string;
    url: string;
  };
};

type GitHubTag = {
  object: {
    sha: string;
    type: string;
  };
};

/**
 * Hucode update and installer metadata for one update platform.
 */
export type PlatformAsset = {
  downloadUrl?: string;
  downloadSha256?: string;
  downloadSize?: number;
  updateUrl: string;
  updateSha256?: string;
  updateSize: number;
};

/**
 * Generated release metadata consumed by static assets and Worker fallback.
 */
export type Release = {
  assets: Record<string, PlatformAsset>;
  commit: string;
  publishedAt: string;
  tag: string;
  version: string;
};

/**
 * Output location overrides for refresh runs.
 */
export type RefreshOptions = {
  generatedSourcePath?: string;
  releaseProvider?: () => Promise<Release[]>;
  releasesRoot?: string;
  updateRoot?: string;
};

/**
 * Extracts a semver product version from a Hucode release tag.
 */
export function releaseVersion(tag: string): string {
  const match = /^v(?<version>\d+\.\d+\.\d+)$/.exec(tag);
  const version = match?.groups?.version;
  if (!version) {
    throw new Error(`Unsupported release tag: ${tag}`);
  }

  return version;
}

/**
 * Normalizes a GitHub asset digest into the update service hash format.
 */
export function sha256(digest: string | undefined): string | undefined {
  const match = /^sha256:(?<hash>[a-f0-9]{64})$/i.exec(digest ?? "");
  return match?.groups?.hash?.toLowerCase();
}

/**
 * Maps update ZIP asset names to VS Code update platform identifiers.
 */
export function updatePlatform(assetName: string): string | undefined {
  const match = /^hucode-(?<os>[a-z0-9]+)-(?<arch>[a-z0-9]+)\.zip$/.exec(
    assetName,
  );
  const groups = match?.groups;
  const os = groups?.os;
  const arch = groups?.arch;
  if (!os || !arch) {
    return undefined;
  }

  if (os === "darwin" && arch === "x64") {
    return "darwin";
  }

  if (os === "darwin" && arch === "arm64") {
    return "darwin-arm64";
  }

  return `${os}-${arch}`;
}

/**
 * Maps downloadable installer asset names to update platform identifiers.
 */
export function downloadPlatform(assetName: string): string | undefined {
  const match = /^hucode-(?<os>[a-z0-9]+)-(?<arch>[a-z0-9]+)\.dmg$/.exec(
    assetName,
  );
  const groups = match?.groups;
  const os = groups?.os;
  const arch = groups?.arch;
  if (!os || !arch) {
    return undefined;
  }

  if (os === "darwin" && arch === "x64") {
    return "darwin";
  }

  if (os === "darwin" && arch === "arm64") {
    return "darwin-arm64";
  }

  return undefined;
}

async function fetchJson<T>(url: string): Promise<T> {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": "hucode-updates",
    "X-GitHub-Api-Version": "2022-11-28",
  });

  if (process.env.GITHUB_TOKEN) {
    headers.set("Authorization", `Bearer ${process.env.GITHUB_TOKEN}`);
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function tagCommit(tag: string): Promise<string> {
  const ref = await fetchJson<GitHubRef>(
    `https://api.github.com/repos/${REPO}/git/ref/tags/${tag}`,
  );

  if (ref.object.type === "commit") {
    return ref.object.sha;
  }

  if (ref.object.type !== "tag") {
    throw new Error(`${tag} points to unsupported ${ref.object.type} object`);
  }

  const tagObject = await fetchJson<GitHubTag>(ref.object.url);
  if (tagObject.object.type !== "commit") {
    throw new Error(`${tag} tag points to unsupported object`);
  }

  return tagObject.object.sha;
}

/**
 * Builds per-platform update and download metadata from release assets.
 */
export function platformAssets(
  assets: GitHubAsset[],
): Record<string, PlatformAsset> {
  const platforms: Record<string, PlatformAsset> = {};

  for (const asset of assets) {
    const platform = updatePlatform(asset.name);
    if (!platform) {
      continue;
    }

    platforms[platform] = {
      updateUrl: asset.browser_download_url,
      updateSha256: sha256(asset.digest),
      updateSize: asset.size,
    };
  }

  for (const asset of assets) {
    const platform = downloadPlatform(asset.name);
    if (!platform || !platforms[platform]) {
      continue;
    }

    platforms[platform].downloadUrl = asset.browser_download_url;
    platforms[platform].downloadSha256 = sha256(asset.digest);
    platforms[platform].downloadSize = asset.size;
  }

  return platforms;
}

async function releases(): Promise<Release[]> {
  const githubReleases = await fetchJson<GitHubRelease[]>(
    `https://api.github.com/repos/${REPO}/releases?per_page=100`,
  );

  const stable = githubReleases
    .filter((release) => !release.draft && !release.prerelease)
    .sort((a, b) => b.published_at.localeCompare(a.published_at));

  const resolved: Release[] = [];
  for (const release of stable) {
    resolved.push({
      assets: platformAssets(release.assets),
      commit: await tagCommit(release.tag_name),
      publishedAt: release.published_at,
      tag: release.tag_name,
      version: releaseVersion(release.tag_name),
    });
  }

  return resolved;
}

/**
 * Builds a VS Code-compatible update response for a platform.
 */
export function updateResponse(latest: Release, platform: string): unknown {
  const asset = latest.assets[platform];
  if (!asset) {
    throw new Error(`Latest release is missing ${platform}`);
  }

  return {
    url: asset.updateUrl,
    name: latest.version,
    notes: latest.commit,
    pub_date: latest.publishedAt,
    version: latest.commit,
    productVersion: latest.version,
    timestamp: Date.parse(latest.publishedAt),
    sha256hash: asset.updateSha256,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeGeneratedSource(
  releases: Release[],
  filePath = GENERATED_SOURCE,
): Promise<void> {
  const source = await format(
    [
      "/* Generated by scripts/refresh-release-data.ts. */",
      "",
      `export const releases = ${JSON.stringify(releases, null, 2)} as const;`,
      "",
      "export const latestRelease = releases[0];",
      "export const validPlatforms = Object.keys(latestRelease.assets);",
      "",
    ].join("\n"),
    { parser: "typescript" },
  );

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, source);
}

/**
 * Refreshes generated release metadata and static update responses.
 */
export async function refresh(options: RefreshOptions = {}): Promise<void> {
  const generatedSourcePath = options.generatedSourcePath ?? GENERATED_SOURCE;
  const releaseProvider = options.releaseProvider ?? releases;
  const updateRoot = options.updateRoot ?? UPDATE_ROOT;
  const releasesRoot = options.releasesRoot ?? RELEASES_ROOT;
  const knownReleases = await releaseProvider();
  const latest = knownReleases[0];
  if (!latest) {
    throw new Error("No update-capable releases found.");
  }

  const latestPlatforms = Object.keys(latest.assets).sort();

  await fs.rm(updateRoot, { recursive: true, force: true });
  await fs.rm(releasesRoot, { recursive: true, force: true });

  for (const release of knownReleases.slice(1)) {
    for (const platform of latestPlatforms) {
      await writeJson(
        path.join(updateRoot, platform, "stable", release.commit),
        updateResponse(latest, platform),
      );
    }
  }

  await writeJson(path.join(releasesRoot, "current.json"), latest);
  await writeJson(path.join(releasesRoot, "history.json"), knownReleases);
  await writeGeneratedSource(knownReleases, generatedSourcePath);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await refresh();
}
