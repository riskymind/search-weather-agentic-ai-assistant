import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import "./globals.css";

// Fonts are vendored (Latin subset, SIL OFL; see ./fonts) so builds never depend on
// downloading from Google Fonts. next/font still self-hosts them with size-adjusted fallbacks.
const display = localFont({
  variable: "--font-bricolage",
  display: "swap",
  src: [
    { path: "./fonts/bricolage-grotesque-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/bricolage-grotesque-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
});

const sans = localFont({
  variable: "--font-plex",
  display: "swap",
  src: [
    { path: "./fonts/ibm-plex-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
});

export const metadata: Metadata = {
  title: "Search + Weather Assistant",
  description: "An AI assistant that searches the web for current information and checks live weather.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F3F6F8" },
    { media: "(prefers-color-scheme: dark)", color: "#0F1722" },
  ],
};

// Applies the saved theme before first paint to avoid a light/dark flash.
// Keep the storage key in sync with THEME_STORAGE_KEY in hooks/useTheme.ts.
const themeScript = `(function(){try{var t=localStorage.getItem("sw-assistant:theme");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
