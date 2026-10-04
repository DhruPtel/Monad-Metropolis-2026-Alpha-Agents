import { Inter, JetBrains_Mono } from "next/font/google";

// Downloaded at build time and served from our own origin: no font request ever
// leaves for a third party at runtime. The variables feed --font-sans and
// --font-mono in packages/ui/src/styles.css.
export const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-inter",
  display: "swap",
});

export const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});
