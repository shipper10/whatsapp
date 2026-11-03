export type Platform = "whatsapp" | "telegram";

export const MESSAGE_TYPES = [
  "text",
  "image",
  "video",
  "document",
  "audio",
  "voice",
  "sticker",
  "contact",
  "location",
  "poll",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** A message from either platform in one shape. View-once media is treated like any other media. */
export interface BridgeMessage {
  platform: Platform;
  chatId: string;
  /** Telegram forum topic, when the chat has topics. */
  topicId?: string;
  messageId: string;
  chatTitle: string;
  senderId: string;
  senderName: string;
  /** Digits only; absent when the platform hides it. */
  senderPhone?: string;
  senderUsername?: string;
  type: MessageType;
  /** Text, or the caption of a media message. */
  text: string;
  fileName?: string;
  mimeType?: string;
  location?: { lat: number; lng: number; name?: string };
  contact?: { name: string; phone?: string };
  poll?: { question: string; options: string[] };
  replyToId?: string;
  timestamp: number;
  fromMe: boolean;
  /** Downloads the media to a temp file (media types only). The caller removes the file. */
  downloadMedia?: (destDir: string) => Promise<string>;
}

export interface Destination {
  chatId: string;
  topicId?: string;
}

export interface OutgoingBridge {
  type: MessageType;
  text: string;
  filePath?: string;
  fileName?: string;
  mimeType?: string;
  location?: { lat: number; lng: number; name?: string };
  /** Message id on the destination platform to reply to. */
  replyToId?: string;
}

export interface ChatInfo {
  platform: Platform;
  chatId: string;
  topicId?: string;
  title: string;
  /** group | channel | community | private | topic | supergroup | ... */
  kind: string;
  /** Community or forum the chat belongs to. */
  parentId?: string;
}

/** What the bridge needs from each platform. */
export interface BridgeEndpoint {
  readonly platform: Platform;
  ready(): boolean;
  send(dest: Destination, out: OutgoingBridge): Promise<string | undefined>;
  listChats(): Promise<ChatInfo[]>;
}

export interface BridgeRule {
  id: number;
  name: string;
  enabled: boolean;
  srcPlatform: Platform;
  srcChatId: string;
  /** "" = every topic of the source chat. */
  srcTopicId: string;
  dstPlatform: Platform;
  dstChatId: string;
  dstTopicId: string;
  types: MessageType[];
  showSender: boolean;
  showPhone: boolean;
}
