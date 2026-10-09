import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zeldo — The Hollow Sunstone",
  description: "A tiny low-poly overhead 3D adventure.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
