import { validPlatforms } from "./generated/releases.ts";

const UPDATE_PATH =
  /^\/api\/update\/(?<platform>[^/]+)\/(?<quality>[^/]+)\/(?<commit>[^/]+)$/;

const VALID_PLATFORMS = new Set<string>(validPlatforms);
const VALID_QUALITY = "stable";
const NO_UPDATE_HEADERS = {
  "Cache-Control": "public, max-age=300",
};

function isValidUpdateRequest(pathname: string): boolean {
  const match = UPDATE_PATH.exec(pathname);
  const groups = match?.groups;
  const platform = groups?.platform;

  return Boolean(
    platform &&
      groups &&
      VALID_PLATFORMS.has(platform) &&
      groups.quality === VALID_QUALITY &&
      groups.commit,
  );
}

/**
 * Cloudflare Worker fallback for update paths not served as static assets.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (!isValidUpdateRequest(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(null, {
      status: 204,
      headers: NO_UPDATE_HEADERS,
    });
  },
};
