import { VIDEO_PROVIDERS } from "@openskatemap/db/schema";
import type { Fetch } from "../auth/apple-tokens.ts";

export type VideoProvider = (typeof VIDEO_PROVIDERS)[number];

export type VideoLink = {
  provider: VideoProvider;
  externalId: string;
  url: string;
  startSeconds: number | null;
  thumbnailUrl: string | null;
};

const youtubeId = /^[\w-]{11}$/;
const instagramCode = /^[\w-]{5,40}$/;
const youtubeHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const instagramHosts = new Set(["instagram.com", "www.instagram.com"]);

function parseStart(value: string | null): number | null {
  if (value === null) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match || match[0] === "") return null;
  const [, hours = "0", minutes = "0", seconds = "0"] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export const thumbnailUrl = (provider: VideoProvider, externalId: string) =>
  provider === "youtube" ? `https://i.ytimg.com/vi/${externalId}/hqdefault.jpg` : null;

function youtube(id: string, start: number | null): VideoLink {
  const seconds = start !== null && start > 0 && start < 24 * 3600 ? start : null;
  return {
    provider: "youtube",
    externalId: id,
    url: `https://www.youtube.com/watch?v=${id}${seconds === null ? "" : `&t=${seconds}s`}`,
    startSeconds: seconds,
    thumbnailUrl: thumbnailUrl("youtube", id),
  };
}

export function parseVideoLink(input: string): VideoLink | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.split("/").filter((part) => part !== "");
  const start = parseStart(url.searchParams.get("t") ?? url.searchParams.get("start"));

  if (host === "youtu.be") {
    const id = path[0];
    return id !== undefined && youtubeId.test(id) ? youtube(id, start) : null;
  }
  if (youtubeHosts.has(host)) {
    const id = path[0] === "watch" ? url.searchParams.get("v") : ["shorts", "live", "embed"].includes(path[0] ?? "") ? path[1] : undefined;
    return id != null && youtubeId.test(id) ? youtube(id, start) : null;
  }
  if (instagramHosts.has(host)) {
    const at = path.findIndex((part) => ["reel", "reels", "p", "tv"].includes(part));
    const kind = path[at];
    const code = path[at + 1];
    if (at < 0 || at > 1 || kind === undefined || code === undefined || !instagramCode.test(code)) return null;
    const segment = kind === "p" ? "p" : "reel";
    return { provider: "instagram", externalId: code, url: `https://www.instagram.com/${segment}/${code}/`, startSeconds: null, thumbnailUrl: null };
  }
  return null;
}

export type VideoAvailability = "available" | "unavailable" | "unknown";

export async function youtubeAvailability(id: string, fetcher: Fetch = fetch): Promise<VideoAvailability> {
  const watch = `https://www.youtube.com/watch?v=${id}`;
  try {
    const response = await fetcher(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, {
      signal: AbortSignal.timeout(3000),
    });
    await response.body?.cancel();
    if (response.ok) return "available";
    return [400, 401, 403, 404].includes(response.status) ? "unavailable" : "unknown";
  } catch {
    return "unknown";
  }
}
