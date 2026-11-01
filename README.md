# Chat Saver

A Chrome extension that backs up your ChatGPT and Claude chats, with every file in them, to a folder on your computer, and lets you search all of them in one place.

- **Automatic backup.** While ChatGPT or Claude is open in a tab, new and changed chats are saved every few minutes to `Downloads/Chat Saver/`. Files saved before are not downloaded again.
- **Library.** Search every saved chat (titles, AI summaries and full transcripts), filter by app, read any chat, open the original, or jump to its files.
- **One click saves.** The **Save chat** button downloads the current chat as a ZIP. The toolbar popup saves several chats at once.
- **Everything in the chat.** Transcript, uploads, generated images, canvas documents and Claude artifacts, cited links, the original JSON, an optional AI summary at the top, and a `continue.md` brief for picking the work up in a new chat (in either app).
- **Official export import.** Turn ChatGPT's "Export data" ZIP into the same folders, offline.
- **Self-test.** The popup's **Run self-test** checks every connection to ChatGPT or Claude and gives a report to copy when something breaks.

Everything runs in your browser. Nothing is sent anywhere except the optional AI summary request, which goes to the provider you choose with your own API key.

## What gets saved

```
Downloads/Chat Saver/
  index.md                          every chat, newest first
  ChatGPT/2025-10-30_marketing-plan-review_0b8e9c3a/
    README.md          AI summary at the top, then what's in the folder and a file list
    transcript.md      the full chat (AI summary at the top), files linked inline
    conversation.json  the complete original data, including edited and regenerated versions
    files/
      uploads/         files you gave the AI
      generated/       images and files it made
      canvas/          canvas documents (ChatGPT) and artifacts (Claude)
    links.md           every web source cited
    continue.md        paste into a new chat to pick up where you left off
    export-report.json what was saved and anything that could not be
  Claude/...
```

## Install (developer mode)

1. Download this repo (Code, Download ZIP) and unzip it.
2. Open `chrome://extensions` in Chrome, Edge or Brave and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the unzipped folder (the one with `manifest.json`). The library opens with a short welcome.
4. Turn on **Back up automatically** and click **Back up now** with ChatGPT or Claude open in another tab.
5. Optional: in **Settings**, choose OpenAI or Anthropic and paste your API key to get AI summaries.

## How it works

- `src/content.js` runs on chatgpt.com and claude.ai: the Save button, bulk saves, auto-backup and the self-test. Site-specific calls live in `src/providers/chatgpt.js` and `src/providers/claude.js`. They use the same internal endpoints the web apps use, from your own logged-in tab.
- Claude chats are converted to the same shape as ChatGPT's (`src/providers/claude-convert.js`), so one exporter handles both (`src/convert.js`, `src/exporter.js`).
- Auto-backup walks the chat list newest first and stops at the first page with no changes. It skips chats still being written (changed in the last 2 minutes), paces requests, and backs off when rate limited. Only one tab backs up at a time.
- `src/background.js` writes backup files through the browser's downloads API (so it needs no folder permission and survives restarts) and keeps the searchable library in IndexedDB (`src/db.js`). `src/library.*` is the library page.

These endpoints are not a public API and can change without notice. When something breaks, the self-test and the export report say which step failed.

## Known limits

- Backups run while a ChatGPT or Claude tab is open. There is no server, so nothing runs when the browser is closed.
- Code Interpreter files (`sandbox:/mnt/data/...`) are deleted by ChatGPT about an hour after the chat goes idle. Older ones are marked "expired" instead of saved.
- Chats inside ChatGPT Projects don't appear in ChatGPT's main chat list, so auto-backup and the bulk list miss them. Open them and use **Save chat**.
- Deleting a chat in the app does not delete its backup.
- Very large official exports (several GB) may run out of browser memory. Import a filtered set of chats if so.
- Voice audio is not saved.

## Development

```
npm install
npm test            # unit tests (Node 18+)
npm run test:e2e    # loads the extension in Chromium against mocked chatgpt.com and claude.ai (needs Playwright)
npm run package     # dist/chat-saver.zip for the Chrome Web Store
```

The end-to-end backup test writes to `~/Downloads/Chat Saver` on the machine that runs it.
