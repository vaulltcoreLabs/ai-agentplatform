import {
  requireAuthenticatedUser,
  requireOwnedSessionChat,
} from "@/app/api/sessions/_lib/session-context";
import type { WebAgentUIMessage } from "@/app/types";
import type { Chat } from "@/lib/db/schema";
import {
  deleteChat,
  getChatMessages,
  getChatsBySessionId,
  updateChat,
} from "@/lib/db/sessions";
import { getUserPreferences } from "@/lib/db/user-preferences";
import { sanitizeSelectedModelIdForSession } from "@/lib/model-access";
import { getAllVariants } from "@/lib/model-variants";
import { getServerSession } from "@/lib/session/get-server-session";

type RouteContext = {
  params: Promise<{ sessionId: string; chatId: string }>;
};

interface UpdateChatRequest {
  title?: string;
  modelId?: string;
}

export interface ChatRefreshResponse {
  chat: Chat;
  isStreaming: boolean;
  messages: WebAgentUIMessage[];
  messageDurationMap: Record<string, number>;
  messageStartedAtMap: Record<string, string>;
  lastUserMessageSentAt: string | null;
}

export async function GET(req: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser(req.headers);
  if (!authResult.ok) {
    return authResult.response;
  }

  const session = await getServerSession(req.headers);
  const { sessionId, chatId } = await context.params;

  const chatContext = await requireOwnedSessionChat({
    userId: authResult.userId,
    sessionId,
    chatId,
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  const [messages, preferences] = await Promise.all([
    getChatMessages(chatId),
    getUserPreferences(authResult.userId),
  ]);
  const modelId =
    sanitizeSelectedModelIdForSession(
      chatContext.chat.modelId,
      getAllVariants(preferences.modelVariants),
      session,
      req.url,
    ) ??
    chatContext.chat.modelId ??
    null;

  const sanitizedChat = {
    ...chatContext.chat,
    modelId,
  };

  // Compute message timing: duration for each assistant message based on
  // the gap from the preceding user message's createdAt
  const messageDurationMap: Record<string, number> = {};
  const messageStartedAtMap: Record<string, string> = {};

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "assistant" && i > 0) {
      const prev = messages[i - 1];
      if (prev && prev.role === "user") {
        messageDurationMap[m.id] =
          m.createdAt.getTime() - prev.createdAt.getTime();
        messageStartedAtMap[m.id] = prev.createdAt.toISOString();
      }
    }
  }

  const lastUserMessage = messages
    .slice()
    .toReversed()
    .find((m) => m.role === "user");
  const lastUserMessageSentAt = lastUserMessage
    ? lastUserMessage.createdAt.toISOString()
    : null;

  return Response.json({
    chat: sanitizedChat,
    isStreaming: sanitizedChat.activeStreamId !== null,
    messages: messages.map((message) => message.parts as WebAgentUIMessage),
    messageDurationMap,
    messageStartedAtMap,
    lastUserMessageSentAt,
  } satisfies ChatRefreshResponse);
}

export async function PATCH(req: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser(req.headers);
  if (!authResult.ok) {
    return authResult.response;
  }

  const session = await getServerSession(req.headers);
  const { sessionId, chatId } = await context.params;

  const chatContext = await requireOwnedSessionChat({
    userId: authResult.userId,
    sessionId,
    chatId,
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  let body: UpdateChatRequest;
  try {
    body = (await req.json()) as UpdateChatRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const nextTitle = body.title?.trim();
  const nextModelId = body.modelId?.trim();

  if (!nextTitle && !nextModelId) {
    return Response.json(
      { error: "At least one field is required" },
      { status: 400 },
    );
  }

  const updatePayload: { title?: string; modelId?: string } = {};
  if (nextTitle) {
    updatePayload.title = nextTitle;
  }
  if (nextModelId) {
    const preferences = await getUserPreferences(authResult.userId);
    const sanitizedModelId = sanitizeSelectedModelIdForSession(
      nextModelId,
      getAllVariants(preferences.modelVariants),
      session,
      req.url,
    );
    updatePayload.modelId = sanitizedModelId ?? nextModelId;
  }

  const updatedChat = await updateChat(chatId, updatePayload);
  if (!updatedChat) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  const preferences = await getUserPreferences(authResult.userId);
  const sanitizedChat = {
    ...updatedChat,
    modelId:
      sanitizeSelectedModelIdForSession(
        updatedChat.modelId,
        getAllVariants(preferences.modelVariants),
        session,
        req.url,
      ) ?? updatedChat.modelId,
  };
  return Response.json({
    chat: sanitizedChat,
  });
}

export async function DELETE(req: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser(req.headers);
  if (!authResult.ok) {
    return authResult.response;
  }

  const { sessionId, chatId } = await context.params;

  const chatContext = await requireOwnedSessionChat({
    userId: authResult.userId,
    sessionId,
    chatId,
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  const chats = await getChatsBySessionId(sessionId);
  if (chats.length <= 1) {
    return Response.json(
      { error: "Cannot delete the only chat in a session" },
      { status: 400 },
    );
  }

  await deleteChat(chatId);
  return Response.json({ success: true });
}
