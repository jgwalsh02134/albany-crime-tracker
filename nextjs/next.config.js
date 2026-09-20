/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable React strict mode for better development experience
  reactStrictMode: true,

  // Allow images from external sources if needed
  images: {
    remotePatterns: [],
  },

  // Rewrites so Next.js API routes proxy to the FastAPI backend
  // The FASTAPI_URL env var should point to the FastAPI service (e.g. http://localhost:8080)
  async rewrites() {
    const fastapiUrl = process.env.FASTAPI_URL || "http://localhost:8080";
    return [
      // Proxy all /api/* calls that are NOT handled by Next.js route handlers
      // to the FastAPI backend. Next.js route handlers take precedence.
      {
        source: "/api/:path*",
        destination: `${fastapiUrl}/api/:path*`,
        // Only applies when no matching Next.js route handler exists
      },
    ];
  },

  // Environment variables exposed to the browser
  env: {
    NEXT_PUBLIC_APP_NAME: "Albany County Crime Tracker",
  },
};

module.exports = nextConfig;
