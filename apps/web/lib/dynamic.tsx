import { lazy, Suspense } from "react";
import type { ComponentType } from "react";

type DynamicComponent =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | ComponentType<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { default: ComponentType<any> };

type DynamicOptions = {
  ssr?: boolean;
  loading?: ComponentType;
};

export function dynamic(
  factory: () => Promise<DynamicComponent>,
  options?: DynamicOptions,
) {
  const LazyComponent = lazy(async () => {
    const mod = await factory();
    if ("default" in mod) {
      return mod;
    }
    return { default: mod };
  });

  return function DynamicComponent(props: Record<string, unknown>) {
    const LoadingFallback = options?.loading;
    return (
      <Suspense fallback={LoadingFallback ? <LoadingFallback /> : null}>
        <LazyComponent {...props} />
      </Suspense>
    );
  };
}
