import { loadFeed } from "../../lib/feed.js";

export default async (req) => {
  try {
    const url = new URL(req.url);
    const birdeyeKey = Netlify.env.get("BIRDEYE_API_KEY");
    const heliusKey = Netlify.env.get("HELIUS_API_KEY");
    const body = await loadFeed({
      fresh: url.searchParams.has("fresh"),
      birdeyeKey: birdeyeKey || "",
      heliusKey: heliusKey || "",
    });
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      { ok: false, error: error.message || "Feed failed", traders: [], routes: [] },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
};

export const config = { path: "/api/feed" };
