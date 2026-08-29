import { useParams } from "react-router-dom";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import type { SharedChatDataResponse } from "@/app/api/shared/[shareId]/route";
import { SharedChatContent } from "@/app/shared/[shareId]/shared-chat-content";
import type { MessageWithTiming } from "@/app/shared/[shareId]/shared-chat-content";
import type { Chat } from "@/lib/db/schema";

export function SharedChatRoute() {
  const { shareId } = useParams<{ shareId: string }>();

  const { data, error } = useSWR<SharedChatDataResponse>(
    shareId ? `/api/shared/${shareId}` : null,
    fetcher,
    { revalidateOnMount: true },
  );

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Shared chat not found</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading shared chat…</div>
      </div>
    );
  }

  return (
    <SharedChatContent
      session={data.session}
      chats={[
        {
          chat: data.chat as Chat,
          messagesWithTiming: data.messages as MessageWithTiming[],
        },
      ]}
      modelId={data.modelId}
      modelName={data.modelName}
      sharedBy={data.sharedBy}
      ownerSessionHref={data.ownerSessionHref}
      isStreaming={data.isStreaming}
      lastUserMessageSentAt={data.lastUserMessageSentAt}
      shareId={data.shareId}
    />
  );
}
