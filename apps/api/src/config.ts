const allowedOrigins = new Set<string>([
  "http://localhost:3000",
  "http://localhost:5173",
  "https://localhost:3000",
  "https://localhost:5173",
]);

for (const value of [
  process.env.BETTER_AUTH_URL,
  process.env.VERCEL_URL,
  process.env.VERCEL_PROJECT_PRODUCTION_URL,
  process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL,
]) {
  if (!value) continue;
  try {
    const url = new URL(
      value.startsWith("http://") || value.startsWith("https://")
        ? value
        : `https://${value}`,
    );
    allowedOrigins.add(url.origin);
    allowedOrigins.add(`*.${url.host}`);
  } catch {
    // ignore
  }
}

export const config = {
  auth: {
    allowedHosts: [...allowedOrigins],
  },
};
