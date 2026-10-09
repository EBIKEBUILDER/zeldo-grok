import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Zeldo — The Hollow Sunstone",
    short_name: "Zeldo",
    description: "A tiny low-poly overhead 3D adventure.",
    start_url: "/",
    display: "fullscreen",
    orientation: "landscape",
    background_color: "#1b1424",
    theme_color: "#1b1424",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
