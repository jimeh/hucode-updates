import { releases, validPlatforms } from "./generated/releases.ts";

const UPDATE_PATH =
  /^\/api\/update\/(?<platform>[^/]+)\/(?<quality>[^/]+)\/(?<commit>[^/]+)$/;
const COMMIT_DOWNLOAD_PATH =
  /^\/commit:(?<commit>[^/]+)\/(?<platform>[^/]+)\/(?<quality>[^/]+)$/;

const VALID_PLATFORMS = new Set<string>(validPlatforms);
const VALID_QUALITY = "stable";
const NO_UPDATE_HEADERS = {
  "Cache-Control": "public, max-age=300",
};

type ServerWebRelease = {
  commit: string;
  serverWebAssets: Record<string, { url: string }>;
};

function updateNoResponse(pathname: string): Response | undefined {
  const match = UPDATE_PATH.exec(pathname);
  const groups = match?.groups;
  if (!groups) {
    return undefined;
  }

  const { commit, platform, quality } = groups;
  const isValid = Boolean(
    platform &&
    VALID_PLATFORMS.has(platform) &&
    quality === VALID_QUALITY &&
    commit,
  );

  if (!isValid) {
    return undefined;
  }

  return new Response(null, {
    status: 204,
    headers: NO_UPDATE_HEADERS,
  });
}

function serverWebAssetUrl(
  commit: string,
  platform: string,
  knownReleases: readonly ServerWebRelease[] = releases,
): string | undefined {
  const release = knownReleases.find((release) => release.commit === commit);

  return release?.serverWebAssets[platform]?.url;
}

export function commitDownloadResponse(
  pathname: string,
  knownReleases: readonly ServerWebRelease[] = releases,
): Response | undefined {
  const match = COMMIT_DOWNLOAD_PATH.exec(pathname);
  const groups = match?.groups;
  if (!groups) {
    return undefined;
  }

  const { commit, platform, quality } = groups;
  if (!commit || !platform || quality !== VALID_QUALITY) {
    return undefined;
  }

  const url = serverWebAssetUrl(commit, platform, knownReleases);
  if (!url) {
    return undefined;
  }

  return Response.redirect(url, 302);
}

/**
 * Cloudflare Worker fallback for update paths not served as static assets.
 */
export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);

    const response =
      updateNoResponse(url.pathname) ?? commitDownloadResponse(url.pathname);
    if (response) {
      return response;
    }

    return new Response("Not found", { status: 404 });
  },
};
