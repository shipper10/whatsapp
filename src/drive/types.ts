export interface DriveSourceConfig {
  id: number;
  label: string;
  folderId: string;
  credentialRef: string;
  recursiveScan: boolean;
  enabled: boolean;
}

/** Metadata of one Drive file. Content is never read. */
export interface DriveFileMeta {
  driveFileId: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  modifiedTime: Date | null;
  parentFolderId: string;
  folderPath: string;
  webViewLink: string;
}

export interface DriveListEntry {
  id: string;
  name: string;
  mimeType: string;
  size?: string | null;
  modifiedTime?: string | null;
  webViewLink?: string | null;
}

/** Port over the Drive API so sync logic is testable offline. */
export interface DriveClient {
  /** Lists non-trashed direct children of a folder (all pages). */
  listChildren(folderId: string): Promise<DriveListEntry[]>;
  /** Identity that must be granted access, for error messages. */
  readonly identity: string;
}

export class DriveAccessError extends Error {
  constructor(
    readonly folderId: string,
    identity: string,
  ) {
    super(`Cannot read Drive folder ${folderId}. Share the folder (Viewer) with ${identity}.`);
  }
}
