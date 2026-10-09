import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zeldo — The Hollow Sunstone",
  description: "A tiny low-poly overhead 3D adventure.",
  applicationName: "Zeldo",
  appleWebApp: { capable: true, title: "Zeldo", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
  icons: { icon: "/icon.svg", apple: "/apple-icon.png" },
};

/** Phones: no pinch-zoom, draw under the notch (HUD uses safe-area insets), dark chrome. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#1b1424",
  interactiveWidget: "overlays-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
