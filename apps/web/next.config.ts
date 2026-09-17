import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      // YouTube thumbnails (oEmbed metadata)
      { protocol: "https", hostname: "i.ytimg.com" },
      { protocol: "https", hostname: "img.youtube.com" },
      // MinIO presigned URLs in development
      { protocol: "http", hostname: "localhost" },
    ],
  },
};

export default nextConfig;
