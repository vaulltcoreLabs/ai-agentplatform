import { checkBotId } from "botid/server";
import type { IncomingHttpHeaders } from "node:http";

/**
 * Shared Vercel BotID server-side configuration.
 *
 * `extraAllowedHosts` tells BotID which frontend origins are permitted to
 * call the protected endpoints — anything on our own domains plus Vercel
 * preview / sandbox URLs.
 */
export const botIdConfig = {
  advancedOptions: {
    extraAllowedHosts: [
      "vercel.com",
      "*.vercel.com",
      "*.vercel.dev",
      "*.vercel.run",
      "*.vaulltcore.dev",
    ],
  },
};

export async function checkBotProtection(
  requestHeaders?: HeadersInit,
): Promise<{
  isHuman: boolean;
  isBot: boolean;
  isVerifiedBot: boolean;
  bypassed: boolean;
}> {
  if (process.env.NODE_ENV !== "production") {
    return {
      isHuman: true,
      isBot: false,
      isVerifiedBot: false,
      bypassed: true,
    };
  }

  const headers: IncomingHttpHeaders = {};
  if (requestHeaders) {
    const h = new Headers(requestHeaders);
    for (const [key, value] of h.entries()) {
      headers[key] = value;
    }
  }

  const result = await checkBotId({
    ...botIdConfig,
    advancedOptions: {
      ...botIdConfig.advancedOptions,
      headers,
      returnResponseHeaders: false,
    },
  });

  return {
    isHuman: result.isHuman,
    isBot: result.isBot,
    isVerifiedBot: result.isVerifiedBot,
    bypassed: result.bypassed,
  };
}
