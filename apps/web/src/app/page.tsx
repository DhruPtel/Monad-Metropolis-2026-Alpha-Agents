import { LayoutDashboard } from "lucide-react";
import Link from "next/link";
import { Button, EmptyState } from "@alpha-agents/ui";

export default function DashboardPage() {
  return (
    <EmptyState
      icon={LayoutDashboard}
      title="The dashboard is not built yet"
      description="Pages arrive in their own units. The design system they are built from is on the design page."
      action={
        <Button asChild variant="secondary">
          <Link href="/design">Open the design system</Link>
        </Button>
      }
    />
  );
}
