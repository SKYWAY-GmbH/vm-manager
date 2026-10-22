export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json(
    {
      version: process.env.APP_VERSION?.trim() || null,
      commit: process.env.APP_COMMIT?.trim() || null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
