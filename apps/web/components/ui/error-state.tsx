import {
  AlertTriangle,
  RefreshCw,
  ArrowLeft,
  ShieldAlert,
  WifiOff,
  ServerCrash,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ErrorVariant =
  | "default"
  | "not-found"
  | "unauthorized"
  | "forbidden"
  | "network"
  | "server"
  | "timeout"
  | "rate-limited";

interface ErrorStateProps {
  variant?: ErrorVariant;
  title?: string;
  description?: string;
  onRetry?: () => void;
  onBack?: () => void;
  className?: string;
}

const variantConfig: Record<
  ErrorVariant,
  {
    icon: typeof AlertTriangle;
    title: string;
    description: string;
    iconClass?: string;
  }
> = {
  default: {
    icon: AlertTriangle,
    title: "Something went wrong",
    description: "An unexpected error occurred. Please try again.",
  },
  "not-found": {
    icon: AlertTriangle,
    title: "Not found",
    description: "The resource you're looking for doesn't exist or has been removed.",
  },
  unauthorized: {
    icon: ShieldAlert,
    title: "Sign in required",
    description: "You need to sign in to access this resource.",
    iconClass: "text-amber-500",
  },
  forbidden: {
    icon: ShieldAlert,
    title: "Access denied",
    description: "You don't have permission to view this resource.",
    iconClass: "text-destructive",
  },
  network: {
    icon: WifiOff,
    title: "Connection lost",
    description:
      "Unable to reach the server. Check your connection and try again.",
    iconClass: "text-orange-500",
  },
  server: {
    icon: ServerCrash,
    title: "Server error",
    description: "The server encountered an error. Please try again in a moment.",
    iconClass: "text-destructive",
  },
  timeout: {
    icon: Clock,
    title: "Request timed out",
    description: "The request took too long. Please try again.",
    iconClass: "text-amber-500",
  },
  "rate-limited": {
    icon: Clock,
    title: "Too many requests",
    description: "You've made too many requests. Please wait and try again.",
    iconClass: "text-amber-500",
  },
};

export function mapHttpToErrorVariant(status: number): ErrorVariant {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server";
  return "default";
}

export function ErrorState({
  variant = "default",
  title,
  description,
  onRetry,
  onBack,
  className,
}: ErrorStateProps) {
  const config = variantConfig[variant];
  const Icon = config.icon;

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-xl border border-border/50 bg-card p-8 text-center",
        className,
      )}
    >
      <div
        className={cn(
          "rounded-lg bg-muted p-3",
          config.iconClass,
        )}
      >
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title ?? config.title}</h3>
        <p className="text-xs text-muted-foreground">
          {description ?? config.description}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {onBack && (
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Go back
          </Button>
        )}
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5" />
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
