import { eq } from "drizzle-orm";
import { getChatById, getChatMessages } from "@/lib/db/sessions";
import {
  getSessionByIdCached,
  getShareByIdCached,
} from "@/lib/db/sessions-cache";
import { getUserPreferences } from "@/lib/db/user-preferences";
import { getAllVariants, MODEL_VARIANT_ID_PREFIX } from "@/lib/model-variants";
import { getServerSession } from "@/lib/session/get-server-session";
import type { WebAgentUIMessage } from "@/app/types";
import type { Chat } from "@/lib/db/schema";
import { redactSharedEnvContent } from "@/app/shared/[shareId]/redact-shared-env-content";

type RouteContext = {
  params: Promise<{ shareId: string }>;
};

export interface SharedChatDataResponse {
  session: {
    title: string;
    repoOwner: string | null;
    repoName: string | null;
    branch: string | null;
    cloneUrl: string | null;
    prNumber: number | null;
    prStatus: "open" | "merged" | "closed" | null;
  };
  chat: Chat;
  messages: Array<{
    message: WebAgentUIMessage;
    durationMs: number | null;
  }>;
  modelId: string | null;
  modelName: string | null;
  sharedBy: {
    username: string;
    name: string | null;
    avatarUrl: string | null;
  } | null;
  isStreaming: boolean;
  lastUserMessageSentAt: string | null;
  ownerSessionHref: string | null;
  shareId: string;
}

async function resolveSharedModelName(
  userId: string,
  modelId: string | null | undefined,
): Promise<string | null> {
  if (!modelId || !modelId.startsWith(MODEL_VARIANT_ID_PREFIX)) {
    return null;
  }

  try {
    const preferences = await getUserPreferences(userId);
    const variant = getAllVariants(preferences.modelVariants).find(
      (item) => item.id === modelId,
    );
    return variant?.name ?? null;
  } catch {
    return null;
  }
}

export async function GET(req: Request, context: RouteContext) {
  const { shareId } = await context.params;

  const [viewerSession, share] = await Promise.all([
    getServerSession(req.headers),
    getShareByIdCached(shareId),
  ]);

  if (!share) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const sharedChat = await getChatById(share.chatId);
  if (!sharedChat) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const session = await getSessionByIdCached(sharedChat.sessionId);
  if (!session) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const dbMessages = await getChatMessages(sharedChat.id);

  interface ChatMsg {
    id: string;
    role: string;
    parts: unknown;
    createdAt: Date;
  }
  const typedMessages = dbMessages as ChatMsg[];

  const messagesWithTiming = typedMessages.map((m, idx) => {
    const message = redactSharedEnvContent(m.parts as WebAgentUIMessage);
    let durationMs: number | null = null;

    if (m.role === "assistant" && idx > 0) {
      const prev = typedMessages[idx - 1];
      if (prev && prev.role === "user") {
        durationMs = m.createdAt.getTime() - prev.createdAt.getTime();
      }
    }

    return { message, durationMs };
  });

  const isStreaming = sharedChat.activeStreamId != null;
  const lastUserMessage = typedMessages
    .slice()
    .toReversed()
    .find((m) => m.role === "user");
  const lastUserMessageSentAt = lastUserMessage
    ? lastUserMessage.createdAt.toISOString()
    : null;

  let sharedBy = null;
  try {
    const { db } = await import("@/lib/db/client");
    const { users } = await import("@/lib/db/schema");
    const sessionUser = await db.query.users.findFirst({
      where: eq(users.id, session.userId),
      columns: {
        username: true,
        name: true,
        avatarUrl: true,
      },
    });
    if (sessionUser) {
      sharedBy = {
        username: sessionUser.username,
        name: sessionUser.name,
        avatarUrl: sessionUser.avatarUrl,
      };
    }
  } catch {
    // ignore
  }

  const modelName = await resolveSharedModelName(
    session.userId,
    sharedChat.modelId,
  );

  const ownerSessionHref =
    viewerSession?.user?.id === session.userId
      ? `/sessions/${sharedChat.sessionId}/chats/${sharedChat.id}`
      : null;

  return Response.json({
    session: {
      title: session.title,
      repoOwner: session.repoOwner,
      repoName: session.repoName,
      branch: session.branch,
      cloneUrl: session.cloneUrl,
      prNumber: session.prNumber,
      prStatus: session.prStatus,
    },
    chat: sharedChat,
    messages: messagesWithTiming,
    modelId: sharedChat.modelId,
    modelName,
    sharedBy,
    isStreaming,
    lastUserMessageSentAt,
    ownerSessionHref,
    shareId,
  } satisfies SharedChatDataResponse);
}
