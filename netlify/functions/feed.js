import { loadFeed } from "../../lib/feed.js";
import { settleFeed } from "../../lib/settle.js";

export default async (req) => {
  try {
    const url = new URL(req.url);
    const feed = await loadFeed({
      fresh: url.searchParams.has("fresh"),
      fomoKey: Netlify.env.get("FOMO_API_KEY") || "",
    });
    const body = await settleFeed(feed);
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      { ok: false, error: error.message || "Feed failed", traders: [], routes: [] },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
};

export const config = { path: "/api/feed" };
