# Chat Saver for ChatGPT

A Chrome extension that saves any ChatGPT chat, with everything in it, as a ZIP you keep on your computer:

```
2025-10-30_marketing-plan-review/
  README.md          AI summary at the top, then what's in the folder and a file list
  transcript.md      the full chat (AI summary at the top), files linked inline
  conversation.json  the complete original data, including edited and regenerated versions
  files/
    uploads/         files you gave ChatGPT
    generated/       images and files ChatGPT made
    canvas/          canvas documents
  links.md           every web source ChatGPT cited
  continue.md        paste into a new ChatGPT or Claude chat to pick up where you left off
  export-report.json what was saved and anything that could not be
```

Everything runs in your browser. Nothing is sent anywhere except the AI summary request, which goes to the provider you choose with your own API key.

## Install (developer mode)

1. Download this repo (Code, Download ZIP) and unzip it.
2. Open `chrome://extensions` in Chrome, Edge or Brave and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the unzipped folder (the one with `manifest.json`).
4. Click the Chat Saver icon in the toolbar, choose OpenAI or Anthropic, paste your API key and click **Save settings**. Skip this if you don't want the AI summary.
5. Open a chat on chatgpt.com and click **Save chat** (green button, bottom right).

## Saving many chats

- **From ChatGPT:** click the Chat Saver toolbar icon, then **Show my chats**. Tick the ones you want (filter, select all, load more) and click **Save**. You get one ZIP with a folder per chat plus `index.md` and `index.json` listing them all. Progress shows on the ChatGPT page.
- **From the official export:** request it in ChatGPT (Settings, Data controls, Export data). Then open the toolbar icon, click **Import it here** and pick the ZIP from the email. This works offline and makes the same folders. ChatGPT's export leaves out Code Interpreter files, so the index lists those as missing.

## How it works

- `src/content.js` runs on chatgpt.com. When you click Save, it reads your session from the page and calls the same internal endpoints the ChatGPT web app uses (`/backend-api/conversation/{id}`, `/backend-api/files/download/{id}`, the Code Interpreter download endpoint and `/textdocs` for canvas).
- Download links expire within minutes, so each file is fetched right after its link is issued. Files on other hosts are fetched by `src/background.js`.
- `src/convert.js` turns the conversation tree into Markdown, following the branch you ended on, and fixes up file links and citations.
- `src/exporter.js` assembles the folder and ZIP. `src/summary.js` builds the AI summary prompt.

These endpoints are not a public API and can change without notice. When something breaks, the export report says which step failed.

## Known limits

- Code Interpreter files (`sandbox:/mnt/data/...`) are deleted by ChatGPT about an hour after the chat goes idle. Older ones are marked "expired" instead of saved.
- Chats inside ChatGPT Projects don't show in the bulk list yet. Open them and use **Save chat**.
- Very large official exports (several GB) may run out of browser memory. Import a filtered set of chats if so.
- Voice audio is not saved.

## Development

```
npm install
npm test            # unit tests (Node 18+)
npm run test:e2e    # loads the extension in Chromium against a mocked chatgpt.com (needs Playwright)
npm run package     # dist/chat-saver.zip for the Chrome Web Store
```
