import { RunDetailView } from "@/components/runs/RunDetailView";

/** Next.js 16: route `params` are async. */
export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <RunDetailView runId={id} />;
}
