import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/States";

export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16">
      <EmptyState
        title="Page not found"
        description="The page you requested does not exist."
        action={<ButtonLink href="/">Back to overview</ButtonLink>}
      />
    </div>
  );
}
