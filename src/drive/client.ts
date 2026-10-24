import { readFileSync } from "node:fs";
import { drive as createDrive } from "@googleapis/drive";
import { GoogleAuth } from "google-auth-library";
import { DriveAccessError, type DriveClient, type DriveListEntry } from "./types.js";

/**
 * Resolves drive_sources.credential_ref to a service-account key file path.
 *   "default"      -> GOOGLE_SERVICE_ACCOUNT_JSON_PATH
 *   "env:NAME"     -> value of env var NAME (path), lets different sources use different accounts
 */
export function resolveCredentialPath(ref: string, env: NodeJS.ProcessEnv = process.env): string {
  const name =
    ref === "default"
      ? "GOOGLE_SERVICE_ACCOUNT_JSON_PATH"
      : ref.startsWith("env:")
        ? ref.slice(4)
        : null;
  if (!name)
    throw new Error(`Unsupported credential_ref "${ref}". Use "default" or "env:VAR_NAME".`);
  const path = env[name];
  if (!path) throw new Error(`Credential env var ${name} is not set (credential_ref "${ref}").`);
  return path;
}

const FIELDS = "nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink)";

export class GoogleDriveClient implements DriveClient {
  readonly identity: string;
  private api: ReturnType<typeof createDrive>;

  constructor(keyFilePath: string) {
    const key = JSON.parse(readFileSync(keyFilePath, "utf8")) as { client_email?: string };
    this.identity = key.client_email ?? "the service account";
    const auth = new GoogleAuth({
      keyFile: keyFilePath,
      // Read-only, metadata scope: the bot can neither change files nor read their content.
      scopes: ["https://www.googleapis.com/auth/drive.metadata.readonly"],
    });
    this.api = createDrive({ version: "v3", auth });
  }

  async listChildren(folderId: string): Promise<DriveListEntry[]> {
    const out: DriveListEntry[] = [];
    let pageToken: string | undefined;
    try {
      do {
        const res = await this.api.files.list({
          q: `'${folderId.replace(/'/g, "")}' in parents and trashed = false`,
          fields: FIELDS,
          pageSize: 1000,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        for (const f of res.data.files ?? []) {
          if (f.id && f.name) {
            out.push({
              id: f.id,
              name: f.name,
              mimeType: f.mimeType ?? "",
              size: f.size,
              modifiedTime: f.modifiedTime,
              webViewLink: f.webViewLink,
            });
          }
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 403 || code === 404) throw new DriveAccessError(folderId, this.identity);
      throw err;
    }
    return out;
  }
}
