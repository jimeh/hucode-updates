import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { format } from "prettier";

const REPO = "jimeh/hucode";
const GENERATED_SOURCE = path.join("src", "generated", "releases.ts");
const RELEASE_NOTES_ROOT = path.join("public", "release-notes");
const UPDATE_ROOT = path.join("public", "api", "update");
const RELEASES_ROOT = path.join("public", "api", "releases");
const LATEST_ROOT = path.join("public", "api", "latest");
const VERSIONS_ROOT = path.join("public", "api", "versions");
const RELEASE_METADATA_ASSET = "hucode-release-metadata.json";

/**
 * Minimal GitHub release asset shape used by the refresh pipeline.
 */
export type GitHubAsset = {
  browser_download_url: string;
  digest?: string;
  name: string;
  size: number;
  url: string;
};

export type GitHubRelease = {
  assets: GitHubAsset[];
  body: string | null;
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
 * Hucode CLI server-web archive metadata for one update platform.
 */
export type ServerWebAsset = {
  sha256?: string;
  size: number;
  url: string;
};

/**
 * Standalone Hucode CLI archive metadata for one update platform.
 */
export type CliAsset = ServerWebAsset;

/**
 * Generated release metadata consumed by static assets and Worker fallback.
 */
export type Release = {
  assets: Record<string, PlatformAsset>;
  cliAssets: Record<string, CliAsset>;
  commit: string;
  publishedAt: string;
  serverWebAssets: Record<string, ServerWebAsset>;
  tag: string;
  version: string;
  vscodeVersion: string;
};

/**
 * Metadata asset optionally published alongside Hucode release binaries.
 */
export type ReleaseMetadata = {
  commit?: string;
  hucodeVersion: string;
  quality?: string;
  schemaVersion: number;
  vscodeVersion: string;
};

type GitHubContent = {
  content: string;
  encoding: string;
};

/**
 * Release metadata plus the GitHub release body used for static Markdown.
 */
export type ReleaseWithNotes = Release & {
  releaseNotes: string;
};

/**
 * Output location overrides for refresh runs.
 */
export type RefreshOptions = {
  generatedSourcePath?: string;
  latestRoot?: string;
  releaseProvider?: () => Promise<ReleaseWithNotes[]>;
  releaseNotesRoot?: string;
  releasesRoot?: string;
  updateRoot?: string;
  versionsRoot?: string;
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

function assertVersion(value: string, label: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`${label} is not a supported version: ${value}`);
  }
}

function validateReleaseMetadata(
  metadata: ReleaseMetadata,
  release: GitHubRelease,
  commit: string,
  hucodeVersion: string,
): ReleaseMetadata {
  if (metadata.schemaVersion !== 1) {
    throw new Error(
      `${release.tag_name} metadata uses unsupported schema version.`,
    );
  }

  if (metadata.hucodeVersion !== hucodeVersion) {
    throw new Error(
      `${release.tag_name} metadata hucodeVersion ` +
        `${metadata.hucodeVersion} does not match tag ${hucodeVersion}.`,
    );
  }

  if (metadata.commit && metadata.commit !== commit) {
    throw new Error(
      `${release.tag_name} metadata commit ${metadata.commit} ` +
        `does not match tag commit ${commit}.`,
    );
  }

  assertVersion(metadata.vscodeVersion, "vscodeVersion");

  return metadata;
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

/**
 * Maps CLI server-web ZIP asset names to update platform identifiers.
 */
export function serverWebPlatform(assetName: string): string | undefined {
  const match =
    /^hucode-server-(?<os>darwin|linux|win32)-(?<arch>x64|arm64)-web\.zip$/.exec(
      assetName,
    );
  const os = match?.groups?.os;
  const arch = match?.groups?.arch;
  if (!os || !arch) {
    return undefined;
  }

  if (os === "darwin" && arch === "x64") {
    return "server-darwin-web";
  }

  return `server-${os}-${arch}-web`;
}

/**
 * Maps standalone CLI archive names to VS Code CLI platform identifiers.
 */
export function cliPlatform(assetName: string): string | undefined {
  const match =
    /^hucode-cli-(?<os>darwin|linux|win32)-(?<arch>x64|arm64)(?<extension>\.zip|\.tar\.gz)$/.exec(
      assetName,
    );
  const os = match?.groups?.os;
  const arch = match?.groups?.arch;
  const extension = match?.groups?.extension;
  if (!os || !arch || !extension) {
    return undefined;
  }

  const expectedExtension = os === "linux" ? ".tar.gz" : ".zip";
  if (extension !== expectedExtension) {
    return undefined;
  }

  return `cli-${os}-${arch}`;
}

/**
 * Builds GitHub API headers, using GITHUB_TOKEN when available.
 */
export function githubHeaders(token = process.env.GITHUB_TOKEN): Headers {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": "hucode-updates",
    "X-GitHub-Api-Version": "2022-11-28",
  });

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return headers;
}

async function fetchJson<T>(url: string): Promise<T> {
  const headers = githubHeaders();
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function fetchAssetJson<T>(asset: GitHubAsset): Promise<T> {
  const headers = githubHeaders();
  headers.set("Accept", "application/octet-stream");

  const response = await fetch(asset.url, { headers });
  if (!response.ok) {
    throw new Error(`${asset.name} returned ${response.status}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Fetches and parses a JSON source file from the Hucode repository.
 */
export async function fetchGitHubSourceJson<T>(
  ref: string,
  filePath: string,
): Promise<T> {
  const file = await fetchJson<GitHubContent>(
    `https://api.github.com/repos/${REPO}/contents/${filePath}?ref=${ref}`,
  );

  if (file.encoding !== "base64") {
    throw new Error(`${filePath} uses unsupported encoding ${file.encoding}`);
  }

  const text = Buffer.from(file.content.replace(/\s/g, ""), "base64").toString(
    "utf8",
  );
  return JSON.parse(text) as T;
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

/**
 * Builds per-platform CLI server-web metadata from release assets.
 */
export function serverWebAssets(
  assets: GitHubAsset[],
): Record<string, ServerWebAsset> {
  const platforms: Record<string, ServerWebAsset> = {};

  for (const asset of assets) {
    const platform = serverWebPlatform(asset.name);
    if (!platform) {
      continue;
    }

    platforms[platform] = {
      url: asset.browser_download_url,
      sha256: sha256(asset.digest),
      size: asset.size,
    };
  }

  return platforms;
}

/**
 * Builds per-platform standalone CLI metadata from release assets.
 */
export function cliAssets(assets: GitHubAsset[]): Record<string, CliAsset> {
  const platforms: Record<string, CliAsset> = {};

  for (const asset of assets) {
    const platform = cliPlatform(asset.name);
    if (!platform) {
      continue;
    }

    platforms[platform] = {
      url: asset.browser_download_url,
      sha256: sha256(asset.digest),
      size: asset.size,
    };
  }

  return platforms;
}

/**
 * Fetches all GitHub releases for the upstream Hucode repository.
 */
export async function fetchGitHubReleases(): Promise<GitHubRelease[]> {
  const githubReleases: GitHubRelease[] = [];

  for (let page = 1; ; page += 1) {
    const releasesPage = await fetchJson<GitHubRelease[]>(
      `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`,
    );

    githubReleases.push(...releasesPage);

    if (releasesPage.length < 100) {
      break;
    }
  }

  return githubReleases;
}

/**
 * Resolves Hucode and VS Code versions for a GitHub release.
 */
export async function releaseVersionInfo(
  release: GitHubRelease,
  commit: string,
): Promise<{ hucodeVersion: string; vscodeVersion: string }> {
  const hucodeVersion = releaseVersion(release.tag_name);
  const metadataAsset = release.assets.find(
    (asset) => asset.name === RELEASE_METADATA_ASSET,
  );

  if (metadataAsset) {
    const metadata = validateReleaseMetadata(
      await fetchAssetJson<ReleaseMetadata>(metadataAsset),
      release,
      commit,
      hucodeVersion,
    );

    return {
      hucodeVersion,
      vscodeVersion: metadata.vscodeVersion,
    };
  }

  const packageJson = await fetchGitHubSourceJson<{ version?: unknown }>(
    commit,
    "package.json",
  );
  if (typeof packageJson.version !== "string") {
    throw new Error(`${release.tag_name} package.json is missing version.`);
  }
  assertVersion(packageJson.version, "package.json version");

  return {
    hucodeVersion,
    vscodeVersion: packageJson.version,
  };
}

async function releases(): Promise<ReleaseWithNotes[]> {
  const githubReleases = await fetchGitHubReleases();

  const stable = githubReleases
    .filter((release) => !release.draft && !release.prerelease)
    .sort((a, b) => b.published_at.localeCompare(a.published_at));

  const resolved: ReleaseWithNotes[] = [];
  for (const release of stable) {
    const commit = await tagCommit(release.tag_name);
    const versionInfo = await releaseVersionInfo(release, commit);

    resolved.push({
      assets: platformAssets(release.assets),
      cliAssets: cliAssets(release.assets),
      commit,
      publishedAt: release.published_at,
      releaseNotes: release.body ?? "",
      serverWebAssets: serverWebAssets(release.assets),
      tag: release.tag_name,
      version: versionInfo.hucodeVersion,
      vscodeVersion: versionInfo.vscodeVersion,
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
    productVersion: latest.vscodeVersion,
    hucodeVersion: latest.version,
    timestamp: Date.parse(latest.publishedAt),
    sha256hash: asset.updateSha256,
  };
}

/**
 * Builds a Hucode CLI-compatible version lookup response.
 */
export function versionResponse(release: Release): unknown {
  return {
    version: release.commit,
    name: release.version,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeMarkdown(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${value.trimEnd()}\n`);
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
      [
        "export const validCliPlatforms = Array.from(",
        "  new Set(releases.flatMap(",
        "    (release) => Object.keys(release.cliAssets),",
        "  )),",
        ").sort();",
      ].join("\n"),
      [
        "export const validServerWebPlatforms = Array.from(",
        "  new Set(releases.flatMap(",
        "    (release) => Object.keys(release.serverWebAssets),",
        "  )),",
        ").sort();",
      ].join("\n"),
      "",
    ].join("\n"),
    { parser: "typescript" },
  );

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, source);
}

function releaseMetadata(release: ReleaseWithNotes): Release {
  return {
    assets: release.assets,
    cliAssets: release.cliAssets,
    commit: release.commit,
    publishedAt: release.publishedAt,
    serverWebAssets: release.serverWebAssets,
    tag: release.tag,
    version: release.version,
    vscodeVersion: release.vscodeVersion,
  };
}

/**
 * Finds the newest release for each CLI or server-web platform.
 *
 * Assumes releases are sorted newest-first; the first platform match wins.
 */
function latestDownloadReleases(releases: Release[]): Record<string, Release> {
  const latestByPlatform: Record<string, Release> = {};

  for (const release of releases) {
    const platforms = [
      ...Object.keys(release.cliAssets),
      ...Object.keys(release.serverWebAssets),
    ];
    for (const platform of platforms) {
      latestByPlatform[platform] ??= release;
    }
  }

  return latestByPlatform;
}

/**
 * Refreshes generated release metadata and static update responses.
 */
export async function refresh(options: RefreshOptions = {}): Promise<void> {
  const generatedSourcePath = options.generatedSourcePath ?? GENERATED_SOURCE;
  const latestRoot = options.latestRoot ?? LATEST_ROOT;
  const releaseProvider = options.releaseProvider ?? releases;
  const releaseNotesRoot = options.releaseNotesRoot ?? RELEASE_NOTES_ROOT;
  const updateRoot = options.updateRoot ?? UPDATE_ROOT;
  const releasesRoot = options.releasesRoot ?? RELEASES_ROOT;
  const versionsRoot = options.versionsRoot ?? VERSIONS_ROOT;
  const knownReleases = await releaseProvider();
  const latest = knownReleases[0];
  if (!latest) {
    throw new Error("No update-capable releases found.");
  }

  const latestPlatforms = Object.keys(latest.assets).sort();
  if (latestPlatforms.length === 0) {
    throw new Error(
      `Latest release (${latest.tag}) has no update-capable assets.`,
    );
  }

  const knownReleaseMetadata = knownReleases.map(releaseMetadata);

  await fs.rm(updateRoot, { recursive: true, force: true });
  await fs.rm(releasesRoot, { recursive: true, force: true });
  await fs.rm(releaseNotesRoot, { recursive: true, force: true });
  await fs.rm(latestRoot, { recursive: true, force: true });
  await fs.rm(versionsRoot, { recursive: true, force: true });

  for (const release of knownReleases.slice(1)) {
    for (const platform of latestPlatforms) {
      await writeJson(
        path.join(updateRoot, platform, "stable", release.commit),
        updateResponse(latest, platform),
      );
    }
  }

  for (const release of knownReleases) {
    await writeMarkdown(
      path.join(releaseNotesRoot, `${release.version}.md`),
      release.releaseNotes,
    );
  }

  const knownDownloadLatest = latestDownloadReleases(knownReleaseMetadata);
  for (const [platform, release] of Object.entries(knownDownloadLatest)) {
    await writeJson(
      path.join(latestRoot, platform, "stable"),
      versionResponse(release),
    );
  }

  for (const release of knownReleaseMetadata) {
    const platforms = [
      ...Object.keys(release.cliAssets),
      ...Object.keys(release.serverWebAssets),
    ];
    for (const platform of platforms) {
      await writeJson(
        path.join(versionsRoot, release.version, platform, "stable"),
        versionResponse(release),
      );
    }
  }

  await writeJson(
    path.join(releasesRoot, "current.json"),
    releaseMetadata(latest),
  );
  await writeJson(
    path.join(releasesRoot, "history.json"),
    knownReleaseMetadata,
  );
  await writeGeneratedSource(knownReleaseMetadata, generatedSourcePath);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await refresh();
}
