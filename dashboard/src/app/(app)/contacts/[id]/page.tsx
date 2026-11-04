import { ContactDetailView } from "@/components/contacts/ContactDetailView";

/** Next.js 16: route `params` are async. */
export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ContactDetailView contactId={decodeURIComponent(id)} />;
}
