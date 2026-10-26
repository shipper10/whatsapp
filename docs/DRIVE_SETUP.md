# Linking Google Drive (optional)

The bot works from the Telegram channel alone. Drive only adds extra copies/links (matched to the Telegram files by name and size). You can skip this and add it later.

Everything below is free and needs no credit card.

## 1. Create a service account (once)
1. Open <https://console.cloud.google.com/> and sign in with any Google account.
2. Top bar > project list > **New project** (name it e.g. `library-bot`) > Create.
3. Menu > **APIs & Services > Library** > search **Google Drive API** > **Enable**.
4. Menu > **IAM & Admin > Service Accounts** > **Create service account** (name `library-bot`) > Done.
5. Click the new account > **Keys** > **Add key > Create new key > JSON** > Create. A `.json` file downloads. Keep it secret.
6. Copy the account's email (it looks like `library-bot@library-bot-123456.iam.gserviceaccount.com`; also written as `client_email` inside the JSON).

## 2. Share the Drive folders with it
For each Drive folder the bot should index: open it in Drive > **Share** > paste the service-account email > role **Viewer** > Send. (Folders owned by different people each need this done by their owner.) Subfolders are included automatically.

## 3. Give the key file to the bot
- **Render**: Dashboard > your service > **Environment > Secret Files > Add** > file name `drive.json`, paste the whole JSON content. Then add the variable `GOOGLE_SERVICE_ACCOUNT_JSON_PATH=/etc/secrets/drive.json`. Redeploy.
- **bot-hosting.net / Wispbyte / any host with a file manager**: upload the JSON next to the app (outside any public Git repo) and set `GOOGLE_SERVICE_ACCOUNT_JSON_PATH` to its path.
- Never commit the JSON to GitHub.

## 4. Register the folders from WhatsApp (as an admin, private chat)
```
/source add Year1 https://drive.google.com/drive/folders/<folder-id>
/sync drive
/status
```
`/sources` lists them, `/source off <id>` pauses one. `/status` shows a source error if the folder was not shared with the service-account email.

## How Drive links appear
A Drive file is attached to a Telegram file when they are clearly the same file: same name and size, or (if the name differs) the same size and extension and no other candidate. The Drive link is then added to the file's caption when it is sent. Files that cannot be matched safely stay as separate library entries found by search (`؟ كلمة`).

## Notes
- Indexing reads **metadata only** (names, sizes, folder paths).
- Sending Drive files themselves is off by default. Turn it on only if you want it: `/set delivery.driveDownload true` (the key then needs read access to file contents, which the Viewer share already gives).
- Drive links never make files public; the bot only shows links for files that people can open with their own access.
