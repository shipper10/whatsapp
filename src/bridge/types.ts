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
  /** Name the person chose for their own profile. */
  senderName: string;
  /** Name saved for them in the linked account's contacts, when known. */
  savedName?: string;
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
  /** Shared by the pictures/videos sent together as one album. */
  albumId?: string;
  /** Serializable handle the source endpoint can turn back into this message after a restart. */
  ref?: unknown;
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
export interface AlbumItem {
  type: "image" | "video";
  filePath: string;
  fileName?: string;
  /** Caption of this item; Telegram keeps only the first one. */
  text: string;
}

export interface BridgeEndpoint {
  readonly platform: Platform;
  ready(): boolean;
  send(dest: Destination, out: OutgoingBridge): Promise<string | undefined>;
  listChats(): Promise<ChatInfo[]>;
  /** Rebuilds a message from the handle stored with a queued job (after a restart). */
  rehydrate?(ref: unknown): Promise<BridgeMessage | null>;
  /** Replaces the text/caption of a message we posted. False when the platform cannot do it. */
  edit?(dest: Destination, messageId: string, out: OutgoingBridge): Promise<boolean>;
  /** Deletes a message we posted. */
  remove?(dest: Destination, messageId: string): Promise<boolean>;
  /** Sends several pictures/videos as one album; returns the destination message ids in order. */
  sendAlbum?(dest: Destination, items: AlbumItem[], replyToId?: string): Promise<string[]>;
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
  /** profile = their own profile name, saved = name in the account's contacts, custom = customName, none = no header. */
  senderMode: SenderMode;
  customName: string;
  showPhone: boolean;
  /** Also forward messages written by the linked account itself. */
  forwardOwn: boolean;
  /** Mirror edits and deletions of the source message onto its copy. */
  forwardEdits: boolean;
  forwardDeletes: boolean;
  /** Keep a per-rule log of what happened to each message. */
  logEnabled: boolean;
}

export const SENDER_MODES = ["profile", "saved", "custom", "none"] as const;
export type SenderMode = (typeof SENDER_MODES)[number];
