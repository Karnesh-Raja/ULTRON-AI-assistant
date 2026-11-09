import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "ULTRON — Personal Assistant",
    short_name: "ULTRON",
    description: "Your personal AI assistant.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#05070c",
    theme_color: "#080b12",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
    ],
  };
}
