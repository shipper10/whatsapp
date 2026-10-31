/** Every fixed message the bot sends in conversations. English only. */
const M = {
  searchHint: "Type a subject name to jump to its index, or [ ? word ] to search files",
  footerNav: "[ 0 ] Home   [ - ] Back",
  next: "[ + ] Next",
  prev: "[ < ] Previous",
  recent: "🆕 Recently added",
  searchTitle: "🔎 Results for",
  empty: "Nothing here yet.",
  noResults: "No results. Try fewer words or the subject name, or send 0 for the main menu.",
  invalid: "Invalid choice. Send a number from the list, or 0 for home.",
  indexFooter:
    "──────────\nCommands:\n• Send files by their 【】 number:   5   |   1-5   |   3,7,9\n• By type:   sheet 1-5   |   lecture 2-4   |   all sheets\n• Jump to a subject index:   chemistry   |   2nd semester\n• [ 0 ] Home    [ - ] Back    [ ? word ] Search files",
  indexesTitle: "Indexes matching",
  didYouMean: "Did you mean one of these? Send its number.",
  indexMissing: "This index isn't available yet (not synced). Send 0 for home.",
  noTyped:
    "I couldn't find those items in this index. Use the 【】 numbers shown next to each file.",
  notSynced: "⚠️ Some files aren't synced yet and were skipped:",
  navSkipped: "ℹ️ I skipped the selected indexes; open an index by sending only its number.",
  capped: "ℹ️ I'll send only the first {n} files per request. Ask again for the rest.",
  sendingMany: "⏳ Sending {n} files…",
  noMore: "No more pages.",
  groupPrivateOnly: "Please message me privately to use the library 🔒",
  rateLimited: "⏳ Please slow down for a moment.",
  unavailable: "This resource is currently unavailable.",
  errorGeneric: "A temporary error occurred. Please try again shortly.",
  help: "📖 *How to use the bot*\n\n• Send *0* for the main menu and *-* to go back.\n• Type a subject name (e.g. chemistry) to jump to its index.\n• To get a file send its 【】 number; several: 1-5 or 3,7,9.\n• By type: sheet 1-5 or all lectures.\n• To search files: ? word\n• *new* for the latest additions.\n• *subscribe* to be told when new files arrive, *unsubscribe* to stop.",
  subscribed: "🔔 Subscribed. I'll tell you when new files arrive. To stop send: unsubscribe",
  alreadySubscribed: "You're already subscribed. To stop send: unsubscribe",
  unsubscribed: "🔕 Notifications stopped. To resume send: subscribe",
  notSubscribed: "You're not subscribed. To subscribe send: subscribe",
  notifyOff: "Notifications are currently off.",
  newFiles:
    "🆕 {n} new files arrived:\n{list}\n\nSend *new* to see them. To stop notifications: unsubscribe",
} as const;

export type MsgKey = keyof typeof M;
export const t = (key: MsgKey) => M[key];

export const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
