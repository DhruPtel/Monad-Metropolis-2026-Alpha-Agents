import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  FundAgentPanel,
  QrCode,
  RUN_STATUSES,
  RUN_STATUS_RENDERING,
  RunStatusBadge,
  SpendPanel,
} from "./my-agent";

const ADDRESS = "0x9F8e2B1C0d3a4E5f60718293A4B5c6D7E8f90a1B";

// The package ships its TypeScript source, which does not pass this repo's strict settings,
// so the decoder is loaded by a path the type checker does not follow.
const DECODER = "@paulmillr/qr/decode.js";
const { default: decodeQR } = (await import(/* @vite-ignore */ DECODER)) as {
  default: (img: { width: number; height: number; data: Uint8ClampedArray }) => string;
};

/** Rebuilds the QR's pixels from the rendered SVG path, four pixels a module, and decodes them. */
function decodeRendered(svg: SVGSVGElement): string {
  const total = Number(svg.getAttribute("viewBox")?.split(" ")[2]);
  const dark = new Set(
    [...(svg.querySelector("path")?.getAttribute("d") ?? "").matchAll(/M(\d+) (\d+)/g)].map(
      (m) => `${m[1]},${m[2]}`,
    ),
  );
  const scale = 4;
  const side = total * scale;
  const data = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y += 1)
    for (let x = 0; x < side; x += 1) {
      const v = dark.has(`${Math.floor(x / scale)},${Math.floor(y / scale)}`) ? 0 : 255;
      data.set([v, v, v, 255], (y * side + x) * 4);
    }
  return decodeQR({ width: side, height: side, data });
}

describe("RunStatusBadge", () => {
  it("renders every run status with its label and meaning", () => {
    for (const status of RUN_STATUSES) {
      const { unmount } = render(<RunStatusBadge status={status} />);
      const badge = screen.getByText(RUN_STATUS_RENDERING[status].label);
      expect(badge.getAttribute("title")).toBe(RUN_STATUS_RENDERING[status].meaning);
      expect(badge.getAttribute("data-run-status")).toBe(status);
      unmount();
    }
    expect(RUN_STATUS_RENDERING.restricted.meaning).toMatch(/safety checks keep running/);
  });
});

describe("QrCode", () => {
  it("encodes exactly the address, and scans back to it", () => {
    render(<QrCode value={ADDRESS} label="QR code of the funding address" />);
    const svg = screen.getByRole("img", { name: "QR code of the funding address" });
    expect(decodeRendered(svg as unknown as SVGSVGElement)).toBe(ADDRESS);
  });
});

describe("FundAgentPanel", () => {
  it("shows the funding address with a copy button, a QR code, credits, held USDC and the Trading placeholder", () => {
    render(
      <FundAgentPanel
        agentName="Alpha Agent #7"
        funding={{ fundingAddress: ADDRESS, spendableUsdcE6: 4_994_400n, heldUsdcE6: 2_000_000n }}
      />,
    );
    const panel = screen.getByRole("region", { name: "Fund Alpha Agent #7" });
    expect(within(panel).getByText("4.9944")).toBeTruthy();
    expect(within(panel).getByRole("img", { name: /QR code/ })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: /Copy/ })).toBeTruthy();
    expect(panel.textContent).toContain("held");
    expect(panel.textContent).toContain("capped at 50 USDC");
    expect(panel.textContent).toContain("Trading capital arrives with the next phase");
  });

  it("says when there is no funding address yet, and shows no held line when nothing is held", () => {
    const { unmount } = render(<FundAgentPanel agentName="Alpha Agent #8" funding={null} />);
    expect(screen.getByText(/appears here as soon as/)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    unmount();
    render(
      <FundAgentPanel
        agentName="Alpha Agent #9"
        funding={{ fundingAddress: ADDRESS, spendableUsdcE6: 0n, heldUsdcE6: 0n }}
      />,
    );
    expect(screen.queryByText(/held/)).toBeNull();
  });
});

describe("SpendPanel", () => {
  it("lists charges as amounts taken and reversals as given back", () => {
    render(
      <SpendPanel
        agentName="Alpha Agent #7"
        spent24hUsdcE6={22_000n}
        charges={[
          {
            entryId: "3",
            at: "2026-10-06T16:42:00.000Z",
            kind: "reversal",
            label: "web_search",
            amountUsdcE6: -12_000n,
          },
          {
            entryId: "2",
            at: "2026-10-06T16:41:00.000Z",
            kind: "tool",
            label: "web_search",
            amountUsdcE6: 12_000n,
          },
          {
            entryId: "1",
            at: "2026-10-06T16:40:00.000Z",
            kind: "model",
            label: "scan-cheap",
            amountUsdcE6: 10_000n,
          },
        ]}
      />,
    );
    const items = within(
      screen.getByRole("list", { name: "Recent charges of Alpha Agent #7" }),
    ).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(/Given back: web_search.*16:42 UTC.*0\.012/),
      expect.stringMatching(/Tool call: web_search.*-0\.012/),
      expect.stringMatching(/Model call: scan-cheap.*-0\.01/),
    ]);
    expect(screen.getByText("0.022")).toBeTruthy();
  });

  it("says when there are no charges", () => {
    render(<SpendPanel agentName="Alpha Agent #8" spent24hUsdcE6={0n} charges={[]} />);
    expect(screen.getByText("No charges yet.")).toBeTruthy();
  });
});
