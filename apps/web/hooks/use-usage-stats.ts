import useSWR from "swr";
import { fetcher } from "@/lib/swr";

interface UsageStats {
  totalTokens: number;
  totalCost: number;
  totalMessages: number;
  totalToolCalls: number;
  modelBreakdown: Array<{
    modelId: string;
    tokens: number;
    cost: number;
    messages: number;
  }>;
  dailyUsage: Array<{
    date: string;
    tokens: number;
    cost: number;
    messages: number;
  }>;
}

interface UsageResponse {
  usage: UsageStats;
}

export function useUsage() {
  const { data, error, isLoading } = useSWR<UsageResponse>(
    "/api/usage",
    fetcher,
    { revalidateOnFocus: false },
  );

  return {
    usage: data?.usage ?? null,
    loading: isLoading,
    error,
  };
}

export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return count.toString();
}

export function formatCost(cents: number): string {
  if (cents >= 100) {
    return `$${(cents / 100).toFixed(2)}`;
  }
  if (cents >= 1) {
    return `$${(cents / 100).toFixed(2)}`;
  }
  return `$${(cents / 100).toFixed(3)}`;
}
