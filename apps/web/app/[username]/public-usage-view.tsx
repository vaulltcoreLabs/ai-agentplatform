import useSWR from "swr";
import { useSearchParams } from "react-router-dom";
import { formatTokens } from "@vaulltcore/shared/lib/tool-state";
import { Image } from "@/components/ui/image";
import { Link } from "@/lib/navigation";
import { ContributionChart } from "@/components/contribution-chart";
import { UsageInsightsSection } from "@/app/settings/usage/usage-insights-section";
import type { PublicUsageProfile } from "@/lib/db/public-usage-profile";

interface ProfileApiResponse {
  profile: PublicUsageProfile;
}

interface StatsProps {
  label: string;
  value: string;
}

function StatItem({ label, value }: StatsProps) {
  return (
    <div className="py-2">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-sm font-semibold font-mono tabular-nums">
          {value}
        </span>
      </div>
    </div>
  );
}

function RankedList({
  title,
  items,
}: {
  title: string;
  items: { label: string; value: string }[];
}) {
  if (items.length === 0) return null;

  return (
    <div className="space-y-2.5">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <div key={item.label} className="flex items-center gap-2.5 text-sm">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                [
                  "bg-neutral-100 dark:bg-neutral-200",
                  "bg-neutral-300 dark:bg-neutral-400",
                  "bg-neutral-400 dark:bg-neutral-500",
                  "bg-neutral-500 dark:bg-neutral-600",
                  "bg-neutral-600 dark:bg-neutral-700",
                ][i % 5]
              }`}
            />
            <span className="min-w-0 truncate">{item.label}</span>
            <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {item.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function displayModelId(modelId: string): string {
  const slashIndex = modelId.indexOf("/");
  return slashIndex >= 0 ? modelId.slice(slashIndex + 1) : modelId;
}

export function PublicUsageView({ username }: { username: string }) {
  const [searchParams] = useSearchParams();
  const dateParam = searchParams.get("date");
  const dateQuery = dateParam ?? undefined;
  const apiUrl = `/api/users/${username}/usage${dateQuery ? `?date=${dateQuery}` : ""}`;

  const { data, error } = useSWR<ProfileApiResponse>(
    apiUrl,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error("not-found");
      }
      return res.json();
    },
    { revalidateOnMount: true },
  );

  const profile = data?.profile;

  if (!profile) {
    if (error?.message === "not-found") {
      return (
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-muted-foreground">User not found</div>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-muted-foreground">Failed to load profile</div>
        </div>
      );
    }

    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading…</div>
      </div>
    );
  }

  const displayName = profile.user.name?.trim() || profile.user.username;
  const publicProfilePath = `/u/${profile.user.username}`;
  const totalTokens = profile.totals.totalTokens;

  const presets = [
    { label: "All time", value: null },
    { label: "7d", value: "7d" },
    { label: "30d", value: "30d" },
    { label: "90d", value: "90d" },
  ];

  const agentItems = [
    { label: "Main agent", value: formatTokens(profile.agentSplit.mainTokens) },
    {
      label: "Subagents",
      value: formatTokens(profile.agentSplit.subagentTokens),
    },
  ].filter((i) => i.value !== "0");

  const modelItems = profile.topModels.slice(0, 5).map((m) => ({
    label: displayModelId(m.modelId),
    value: formatTokens(m.totalTokens),
  }));

  const codeChurnItems = [
    {
      label: "Lines added",
      value: profile.insights.code.linesAdded.toLocaleString(),
    },
    {
      label: "Lines removed",
      value: profile.insights.code.linesRemoved.toLocaleString(),
    },
    {
      label: "Total changed",
      value: profile.insights.code.totalLinesChanged.toLocaleString(),
    },
  ];

  const hasUsage = profile.hasUsage;
  const hasRankedData =
    hasUsage || modelItems.length > 0 || codeChurnItems.length > 0;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-6 py-8 pb-16 sm:py-12 sm:pb-20">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold">Profile</h1>
          <nav className="flex gap-1">
            {presets.map((preset) => {
              const href = preset.value
                ? `${publicProfilePath}?date=${preset.value}`
                : publicProfilePath;
              const isActive = profile.dateSelection.value === preset.value;
              return (
                <Link
                  key={preset.label}
                  href={href}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                  }`}
                >
                  {preset.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {profile.invalidDateError ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Invalid date filter — showing all-time data.
          </p>
        ) : null}

        <div className="mt-8 flex flex-col gap-8 lg:flex-row lg:gap-10">
          <div className="w-full shrink-0 lg:w-56">
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                {profile.user.avatarUrl ? (
                  <Image
                    src={profile.user.avatarUrl}
                    alt={profile.user.username}
                    width={56}
                    height={56}
                    className="shrink-0 rounded-full"
                  />
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-medium text-muted-foreground">
                    {profile.user.username.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  {displayName !== profile.user.username ? (
                    <p className="truncate text-base font-semibold leading-tight">
                      {displayName}
                    </p>
                  ) : null}
                  <p className="truncate text-sm text-muted-foreground">
                    @{profile.user.username}
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Usage · {profile.dateSelection.label}
                </h3>
                <div className="rounded-lg border border-border/50 bg-muted/10 px-4 py-1 divide-y divide-border/50">
                  <StatItem
                    label="Total tokens"
                    value={formatTokens(totalTokens)}
                  />
                  <StatItem
                    label="Messages"
                    value={profile.totals.messageCount.toLocaleString()}
                  />
                  <StatItem
                    label="Tool calls"
                    value={profile.totals.toolCallCount.toLocaleString()}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="min-w-0 flex-1 space-y-8">
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-medium text-muted-foreground">
                  Activity
                </h2>
              </div>
              <ContributionChart data={profile.dailyActivity} />
            </div>

            {hasRankedData && (
              <div className="grid gap-8 sm:grid-cols-3">
                {hasUsage && (
                  <RankedList title="Agent split" items={agentItems} />
                )}
                {modelItems.length > 0 && (
                  <RankedList title="Top models" items={modelItems} />
                )}
                {codeChurnItems.length > 0 && (
                  <RankedList title="Code churn" items={codeChurnItems} />
                )}
              </div>
            )}

            <UsageInsightsSection insights={profile.insights} />
          </div>
        </div>

        <div className="mt-16 flex items-center justify-between gap-4 border-t border-border/50 pt-6">
          <span className="font-mono text-xs text-muted-foreground">
            vaulltcore.dev{publicProfilePath}
            {profile.dateSelection.value
              ? `?date=${profile.dateSelection.value}`
              : ""}
          </span>
          <a
            href="https://vaulltcore.dev"
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Vaulltcore ↗
          </a>
        </div>
      </div>
    </main>
  );
}
