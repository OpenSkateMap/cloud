import { describe, expect, test } from "bun:test";
import { parseVideoLink, type VideoLink, youtubeAvailability } from "../src/lib/video-links.ts";

const youtube = (id: string, startSeconds: number | null = null): VideoLink => ({
  provider: "youtube",
  externalId: id,
  url: `https://www.youtube.com/watch?v=${id}${startSeconds === null ? "" : `&t=${startSeconds}s`}`,
  startSeconds,
  thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
});

describe("parseVideoLink", () => {
  test("every YouTube form of one clip gives the same link", () => {
    for (const link of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ&si=tracking&feature=share",
      "http://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?si=abc",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ",
    ]) {
      expect(parseVideoLink(link)).toEqual(youtube("dQw4w9WgXcQ"));
    }
  });

  test("a YouTube start time survives in seconds", () => {
    expect(parseVideoLink("https://youtu.be/dQw4w9WgXcQ?t=95")).toEqual(youtube("dQw4w9WgXcQ", 95));
    expect(parseVideoLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m35s")).toEqual(youtube("dQw4w9WgXcQ", 95));
    expect(parseVideoLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=3600")).toEqual(youtube("dQw4w9WgXcQ", 3600));
    expect(parseVideoLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0")).toEqual(youtube("dQw4w9WgXcQ"));
    expect(parseVideoLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=soon")).toEqual(youtube("dQw4w9WgXcQ"));
  });

  test("Instagram posts, reels and IGTV become one canonical link without the account", () => {
    const reel: VideoLink = { provider: "instagram", externalId: "C1aB2cD3eF4", url: "https://www.instagram.com/reel/C1aB2cD3eF4/", startSeconds: null, thumbnailUrl: null };
    expect(parseVideoLink("https://www.instagram.com/reel/C1aB2cD3eF4/?igsh=xyz")).toEqual(reel);
    expect(parseVideoLink("https://instagram.com/reels/C1aB2cD3eF4")).toEqual(reel);
    expect(parseVideoLink("https://www.instagram.com/tv/C1aB2cD3eF4/")).toEqual(reel);
    expect(parseVideoLink("https://www.instagram.com/someskater/reel/C1aB2cD3eF4/")).toEqual(reel);
    expect(parseVideoLink("https://www.instagram.com/p/C1aB2cD3eF4/")).toEqual({ ...reel, url: "https://www.instagram.com/p/C1aB2cD3eF4/" });
  });

  test("anything else is refused", () => {
    for (const link of [
      "",
      "not a link",
      "ftp://youtu.be/dQw4w9WgXcQ",
      "https://vimeo.com/123456",
      "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/@channel",
      "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/playlist?list=PL123",
      "https://youtu.be/",
      "https://www.instagram.com/someskater/",
      "https://www.instagram.com/a/b/reel/C1aB2cD3eF4/",
      "https://www.instagram.com/reel/",
      "javascript:alert(1)",
    ]) {
      expect(parseVideoLink(link)).toBeNull();
    }
  });
});

describe("youtubeAvailability", () => {
  const answering = (status: number) => {
    const asked: string[] = [];
    const fetcher = async (url: string) => {
      asked.push(url);
      return new Response(status === 200 ? JSON.stringify({ title: "Kickflip" }) : "", { status });
    };
    return { asked, fetcher };
  };

  test("asks YouTube's oEmbed about the canonical watch link", async () => {
    const youtube = answering(200);
    expect(await youtubeAvailability("dQw4w9WgXcQ", youtube.fetcher)).toBe("available");
    expect(youtube.asked).toEqual([
      "https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ",
    ]);
  });

  test("a private or missing video is unavailable", async () => {
    for (const status of [400, 401, 403, 404]) {
      expect(await youtubeAvailability("aaaaaaaaaaa", answering(status).fetcher)).toBe("unavailable");
    }
  });

  test("an error or no answer lets the video through", async () => {
    expect(await youtubeAvailability("dQw4w9WgXcQ", answering(503).fetcher)).toBe("unknown");
    expect(await youtubeAvailability("dQw4w9WgXcQ", async () => Promise.reject(new Error("offline")))).toBe("unknown");
  });
});
