import type { Metadata } from "next";
import { DesignSystem } from "./design-system";

export const metadata: Metadata = { title: "Design system · Alpha Agents" };

export default function DesignPage() {
  return <DesignSystem />;
}
