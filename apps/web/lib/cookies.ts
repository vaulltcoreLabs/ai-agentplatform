export interface CookieOption {
  path?: string;
  expires?: Date;
  secure?: boolean;
  httpOnly?: boolean;
  maxAge?: number;
  sameSite?: "strict" | "lax" | "none";
}

export interface CookieHelper {
  get: (name: string) => { value: string } | undefined;
  set: (name: string, value: string, options?: CookieOption) => void;
  delete: (name: string, options?: CookieOption) => void;
  getAll: () => Array<{ name: string; value: string }>;
}

const DEFAULT_COOKIE_OPTIONS: CookieOption = {
  secure: process.env.NODE_ENV === "production",
  httpOnly: true,
  maxAge: 60 * 60 * 24 * 7,
  sameSite: "lax",
  path: "/",
};

function parseCookies(cookieHeader: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader) {
    return cookies;
  }

  const items = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of items) {
    const eq = item.indexOf("=");
    if (eq > 0) {
      const name = item.slice(0, eq).trim();
      const value = item.slice(eq + 1).trim();
      cookies.set(decodeURIComponent(name), decodeURIComponent(value));
    }
  }

  return cookies;
}

function serializeCookie(
  name: string,
  value: string,
  options: CookieOption,
): string {
  const parts: string[] = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
  ];

  const opts: CookieOption = { ...DEFAULT_COOKIE_OPTIONS, ...options };

  if (opts.path) {
    parts.push(`Path=${opts.path}`);
  }
  if (opts.secure) {
    parts.push("Secure");
  }
  if (opts.httpOnly) {
    parts.push("HttpOnly");
  }
  if (opts.maxAge !== undefined) {
    parts.push(`Max-Age=${opts.maxAge}`);
  }
  if (opts.sameSite) {
    parts.push(`SameSite=${opts.sameSite}`);
  }

  return parts.join("; ");
}

export function createCookieHelper(
  requestHeaders: Headers,
  setCookie: (cookie: string) => void,
): CookieHelper {
  const cookies = parseCookies(requestHeaders.get("cookie"));

  return {
    get: (name: string) => {
      const value = cookies.get(name);
      return value ? { value } : undefined;
    },
    set: (name: string, value: string, options?: CookieOption) => {
      setCookie(
        serializeCookie(name, value, options ?? DEFAULT_COOKIE_OPTIONS),
      );
    },
    delete: (name: string, options?: CookieOption) => {
      setCookie(
        serializeCookie(name, "", {
          ...options,
          maxAge: 0,
          expires: new Date(0),
        }),
      );
    },
    getAll: () =>
      Array.from(cookies.entries()).map(([name, value]) => ({ name, value })),
  };
}

export function createRedirectResponse(
  url: string | URL,
  cookies?: string[],
): Response {
  const headers: Record<string, string> = {
    Location: url.toString(),
  };

  if (cookies && cookies.length > 0) {
    headers["Set-Cookie"] = cookies.join("\n");
  }

  return new Response(null, {
    status: 307,
    headers,
  });
}

export function serializeCookieHeader(
  name: string,
  value: string,
  options?: CookieOption,
): string {
  return serializeCookie(name, value, {
    ...DEFAULT_COOKIE_OPTIONS,
    ...options,
  });
}
