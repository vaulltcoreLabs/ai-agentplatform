import Cloudflare from "cloudflare";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. Add it in Settings → Environment.`);
  }
  return value;
}

let clientInstance: Cloudflare | null = null;

export function getCloudflareClient(): Cloudflare {
  if (clientInstance) return clientInstance;

  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!apiToken) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN is not set. Add it in Settings → Environment.",
    );
  }

  clientInstance = new Cloudflare({ apiToken });
  return clientInstance;
}

/**
 * Reset the cached client instance — only for testing.
 * @internal
 */
export function _resetQueueClientForTesting(): void {
  clientInstance = null;
}

function getAccountId(): string {
  return requireEnv("CLOUDFLARE_ACCOUNT_ID");
}

// ---------------------------------------------------------------------------
// Message schema
// ---------------------------------------------------------------------------

export const QueueMessageSchema = z.record(z.string(), z.unknown());
export type QueueMessage = z.infer<typeof QueueMessageSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueueResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Queue management
// ---------------------------------------------------------------------------

export async function createQueue(
  queueName: string,
): Promise<QueueResult<{ queueId: string; queueName: string }>> {
  try {
    const client = getCloudflareClient();
    const result = await client.queues.create({
      account_id: getAccountId(),
      queue_name: queueName,
    });

    return {
      ok: true,
      data: {
        queueId: result.queue_id ?? "",
        queueName: result.queue_name ?? queueName,
      },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to create queue",
    };
  }
}

export async function listQueues(): Promise<
  QueueResult<Array<{ queueId: string; queueName: string }>>
> {
  try {
    const client = getCloudflareClient();
    const queues: Array<{ queueId: string; queueName: string }> = [];

    for await (const queue of client.queues.list({
      account_id: getAccountId(),
    })) {
      queues.push({
        queueId: queue.queue_id ?? "",
        queueName: queue.queue_name ?? "",
      });
    }

    return { ok: true, data: queues };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to list queues",
    };
  }
}

export async function deleteQueue(
  queueId: string,
): Promise<QueueResult<boolean>> {
  try {
    const client = getCloudflareClient();
    await client.queues.delete(queueId, {
      account_id: getAccountId(),
    });
    return { ok: true, data: true };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to delete queue",
    };
  }
}

// ---------------------------------------------------------------------------
// Message operations
// ---------------------------------------------------------------------------

export async function pushMessage(
  queueId: string,
  body: unknown,
  options?: { delaySeconds?: number },
): Promise<QueueResult<{ backlogCount: number }>> {
  const parsed = QueueMessageSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid message body: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
    };
  }

  try {
    const client = getCloudflareClient();
    const result = await client.queues.messages.push(queueId, {
      account_id: getAccountId(),
      body: parsed.data,
      content_type: "json",
      delay_seconds: options?.delaySeconds,
    });

    return {
      ok: true,
      data: {
        backlogCount: result.metadata?.metrics?.backlog_count ?? 0,
      },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to push message",
    };
  }
}

export async function pushMessages(
  queueId: string,
  messages: unknown[],
  options?: { delaySeconds?: number },
): Promise<QueueResult<{ pushedCount: number; backlogCount: number }>> {
  const validated = messages.map((body) => QueueMessageSchema.parse(body));

  try {
    const client = getCloudflareClient();
    const result = await client.queues.messages.bulkPush(queueId, {
      account_id: getAccountId(),
      delay_seconds: options?.delaySeconds,
      messages: validated.map((body) => ({
        body,
        content_type: "json" as const,
      })),
    });

    return {
      ok: true,
      data: {
        pushedCount: validated.length,
        backlogCount: result.metadata?.metrics?.backlog_count ?? 0,
      },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to push messages",
    };
  }
}

export type PulledMessage = {
  id: string;
  leaseId: string;
  body: unknown;
  attempts: number;
  timestampMs: number;
};

export async function pullMessages(
  queueId: string,
  options?: { batchSize?: number; visibilityTimeoutMs?: number },
): Promise<QueueResult<{ messages: PulledMessage[]; backlogCount: number }>> {
  try {
    const client = getCloudflareClient();
    const result = await client.queues.messages.pull(queueId, {
      account_id: getAccountId(),
      batch_size: options?.batchSize,
      visibility_timeout_ms: options?.visibilityTimeoutMs,
    });

    const messages: PulledMessage[] = (result.messages ?? []).map((msg) => ({
      id: msg.id ?? "",
      leaseId: msg.lease_id ?? "",
      body: msg.body ? JSON.parse(String(msg.body)) : null,
      attempts: msg.attempts ?? 0,
      timestampMs: msg.timestamp_ms ?? 0,
    }));

    return {
      ok: true,
      data: {
        messages,
        backlogCount: result.message_backlog_count ?? 0,
      },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to pull messages",
    };
  }
}

export async function ackMessage(
  queueId: string,
  leaseId: string,
): Promise<QueueResult<{ ackCount: number }>> {
  try {
    const client = getCloudflareClient();
    const result = await client.queues.messages.ack(queueId, {
      account_id: getAccountId(),
      acks: [{ lease_id: leaseId }],
    });

    return {
      ok: true,
      data: { ackCount: result.ackCount ?? 0 },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to acknowledge message",
    };
  }
}

export async function retryMessage(
  queueId: string,
  leaseId: string,
  delaySeconds?: number,
): Promise<QueueResult<{ retryCount: number }>> {
  try {
    const client = getCloudflareClient();
    const result = await client.queues.messages.ack(queueId, {
      account_id: getAccountId(),
      retries: [{ lease_id: leaseId, delay_seconds: delaySeconds }],
    });

    return {
      ok: true,
      data: { retryCount: result.retryCount ?? 0 },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to retry message",
    };
  }
}

// ---------------------------------------------------------------------------
// Queue metrics
// ---------------------------------------------------------------------------

export type QueueMetrics = {
  backlogBytes: number;
  backlogCount: number;
  oldestMessageTimestampMs: number;
};

export async function getQueueMetrics(
  queueId: string,
): Promise<QueueResult<QueueMetrics>> {
  try {
    const client = getCloudflareClient();
    const result = await client.queues.getMetrics(queueId, {
      account_id: getAccountId(),
    });

    return {
      ok: true,
      data: {
        backlogBytes: result.backlog_bytes,
        backlogCount: result.backlog_count,
        oldestMessageTimestampMs: result.oldest_message_timestamp_ms,
      },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Failed to get queue metrics",
    };
  }
}
