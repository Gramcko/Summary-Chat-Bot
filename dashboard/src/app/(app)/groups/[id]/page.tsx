import { GroupDetailView } from "@/components/groups/GroupDetailView";

/** Next.js 16: route `params` are async. */
export default async function GroupDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <GroupDetailView groupId={id} />;
}
