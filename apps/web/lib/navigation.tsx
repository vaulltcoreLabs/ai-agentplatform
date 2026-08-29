import {
  Link as RouterLink,
  useNavigate,
  useSearchParams as useRRSearchParams,
  useLocation,
  useParams as useRRParams,
  type LinkProps,
} from "react-router-dom";

export function Link(
  props: Omit<LinkProps, "to" | "prefetch"> & {
    href: string;
    prefetch?: boolean;
  },
) {
  const { href, children, prefetch: _prefetch, ...rest } = props;
  return (
    <RouterLink to={href} {...rest}>
      {children}
    </RouterLink>
  );
}

type Router = {
  push: (href: string, options?: { scroll?: boolean }) => void;
  replace: (href: string, options?: { scroll?: boolean }) => void;
  refresh: () => void;
  prefetch: (href: string) => void;
  back: () => void;
  forward: () => void;
};

export function useRouter(): Router {
  const navigate = useNavigate();

  const push = (href: string, _options?: { scroll?: boolean }) => {
    navigate(href);
  };

  const replace = (href: string, _options?: { scroll?: boolean }) => {
    navigate(href, { replace: true });
  };

  const refresh = () => {
    navigate(0);
  };

  const prefetch = () => {};

  return {
    push,
    replace,
    refresh,
    prefetch,
    back: () => navigate(-1),
    forward: () => navigate(1),
  };
}

export { useRRParams as useParams };

/**
 * Wrapper around react-router-dom's useSearchParams to match Next.js behavior.
 * Returns only the URLSearchParams object (the setter is available via useSearchParamsSetter).
 */
export function useSearchParams(): URLSearchParams {
  const [searchParams] = useRRSearchParams();
  return searchParams;
}

export function usePathname(): string {
  return useLocation().pathname;
}

export function redirect(href: string): never {
  throw new Response(null, {
    status: 302,
    headers: { Location: href },
  });
}

export function notFound(): never {
  throw new Response("Not Found", { status: 404 });
}
