import { loadFeed } from "../../lib/feed.js";

export default async (req) => {
  try {
    const url = new URL(req.url);
    const body = await loadFeed({
      fresh: url.searchParams.has("fresh"),
      fomoKey: Netlify.env.get("FOMO_API_KEY") || "",
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
