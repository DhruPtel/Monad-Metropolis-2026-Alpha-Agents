import { ComingLaterPage } from "@/components/shell/coming-later-page";

/** Any page the beta does not have yet (the gallery, the marketplace, the leaderboard, the creator portal): what it will be, and where the live pages are (UI-U1). */
export default function NotFound() {
  return (
    <ComingLaterPage
      title="This page comes after the beta"
      description="The gallery, the marketplace, the leaderboard and the creator portal are built after the beta (D-368). Everything that works today is below."
    />
  );
}
