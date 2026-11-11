import { NextResponse } from "next/server";
import { prewarmDatasetVersion } from "@/lib/server/dataset-query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ versionId: string }> },
) {
  const startedAt = Date.now();

  try {
    const { versionId } = await params;
    const url = new URL(request.url);
    const includeShards = url.searchParams.get("includeShards") === "1";

    await prewarmDatasetVersion(versionId, { includeShards });

    return NextResponse.json(
      {
        ok: true,
        datasetVersionId: versionId,
        includeShards,
        durationMs: Date.now() - startedAt,
      },
      { headers: datasetCacheHeaders() },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Dataset prewarm failed." },
      { status: 500, headers: datasetCacheHeaders() },
    );
  }
}

function datasetCacheHeaders() {
  return {
    "Cache-Control": "no-store",
  };
}
