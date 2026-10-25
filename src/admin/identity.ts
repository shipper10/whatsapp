/** "249911111111@c.us" and "249911111111:12@s.whatsapp.net" both reduce to the same phone digits. */
export const idDigits = (id: string) => id.split("@")[0]?.split(":")[0]?.replace(/\D/g, "") ?? "";

export function sameIdentity(a: string, b: string): boolean {
  const da = idDigits(a);
  return da.length > 0 && da === idDigits(b);
}
