function createHeaders(): Headers {
  const h = new Headers();
  if (typeof window !== "undefined") {
    h.set("host", window.location.host);
    h.set("origin", window.location.origin);
    h.set("referer", window.location.href);
    if (document.cookie) {
      h.set("cookie", document.cookie);
    }
    const userAgent = navigator.userAgent;
    if (userAgent) {
      h.set("user-agent", userAgent);
    }
  }
  return h;
}

export function headers(): Headers {
  return createHeaders();
}

export function cookies(): {
  get: (name: string) => { value: string } | undefined;
} {
  const cookies: Record<string, string> = {};
  if (typeof document !== "undefined") {
    for (const cookie of document.cookie.split("; ")) {
      const [name, ...rest] = cookie.split("=");
      if (name) {
        cookies[name] = rest.join("=");
      }
    }
  }
  return {
    get: (name: string) => {
      const value = cookies[name];
      return value !== undefined ? { value } : undefined;
    },
  };
}
