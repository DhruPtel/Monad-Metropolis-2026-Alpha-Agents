/**
 * The 3D scene's colors, read from the design tokens at runtime (P1-U11).
 * Raw colors live only in packages/ui/src/styles.css; the scene asks the
 * document for the computed value of each token, so a token change restyles
 * the scene with no change here.
 */
export interface SceneColors {
  readonly keyLight: string;
  readonly rimLight: string;
  readonly fillLight: string;
  readonly platform: string;
  readonly grid: string;
  readonly gridMajor: string;
  readonly accent: string;
  readonly wing: string;
}

const TOKENS: Readonly<Record<keyof SceneColors, string>> = {
  keyLight: "--viewer-key-light",
  rimLight: "--viewer-rim-light",
  fillLight: "--viewer-fill-light",
  platform: "--viewer-platform",
  grid: "--viewer-grid",
  gridMajor: "--viewer-grid-major",
  accent: "--primary",
  wing: "--viewer-wing",
};

/** Reads every scene color from the document; throws if a token is missing. */
export function readSceneColors(root: Element = document.documentElement): SceneColors {
  const style = getComputedStyle(root);
  const read = (token: string) => {
    const value = style.getPropertyValue(token).trim();
    if (!value) throw new Error(`design token ${token} is not defined`);
    return value;
  };
  return Object.fromEntries(
    Object.entries(TOKENS).map(([key, token]) => [key, read(token)]),
  ) as unknown as SceneColors;
}
