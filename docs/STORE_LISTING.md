# Chrome Web Store listing (draft)

Copy these into the Chrome Web Store developer dashboard. Avoid OpenAI's logo and don't present the extension as official.

## Basics

- **Name:** Chat Saver: back up ChatGPT and Claude chats
- **Category:** Productivity
- **Language:** English

**Short description** (132 characters max):

> Automatic backup of your ChatGPT and Claude chats, with every file, plus search across all of them. Private: no server.

## Detailed description

Never lose an AI chat again. Chat Saver backs up your ChatGPT and Claude chats automatically, with every file in them, to a folder on your computer. Then it lets you search all of them in one place.

Automatic backup: keep ChatGPT or Claude open as usual, and new and changed chats are saved every few minutes. No clicking.

Search everything: one library for all your AI chats. Find that prompt, code snippet or decision in seconds.

One click turns a chat into a tidy folder:

- AI summary at the top: key points, decisions, action items
- Full transcript in Markdown, with images and files linked in place
- Every file from the chat: your uploads, generated images, canvas documents
- All web sources ChatGPT cited
- A "continue" brief you can paste into a new ChatGPT or Claude chat to pick up where you left off
- The complete original data as JSON, including edited and regenerated replies

Save many chats at once. Pick them from a list and get one ZIP with an index of everything.

Already have ChatGPT's data export? Import it and get the same organised folders, offline.

Private by design. Chat Saver has no server. Your chats are saved straight to your computer. The optional AI summary uses your own OpenAI or Anthropic API key and goes only to the provider you choose.

Not affiliated with OpenAI or Anthropic. ChatGPT is a trademark of OpenAI; Claude is a trademark of Anthropic.

## Privacy tab answers

- **Single purpose:** Back up the user's ChatGPT and Claude conversations and their files to the user's computer, and let them search those backups.
- **Permission justifications:**
  - `storage`: keeps the user's settings (AI provider, model, API key, backup on/off) in the browser.
  - `unlimitedStorage`: the searchable library of backed-up chats is kept in the browser's IndexedDB and can exceed the default quota.
  - `downloads`: writes backup files into the user's Downloads folder.
  - `downloads.ui`: hides the download bubble while automatic backups write files, so backups stay quiet.
  - `alarms`: checks for changed chats every few minutes.
  - Host `claude.ai`: reads the Claude chat the user chooses to save (or that auto-backup finds changed), through the user's own session.
  - Hosts `chatgpt.com`, `chat.openai.com`: read the ChatGPT chats being saved, through the user's own session.
  - Host `*.oaiusercontent.com`: downloads the files attached to that chat.
  - Hosts `api.openai.com`, `api.anthropic.com`: send the chat to the user's chosen AI provider for the optional summary, with the user's own key.
  - `tabs` is not requested. Host permissions let the extension find open ChatGPT and Claude tabs to back up.
- **Data usage:** collects "Website content" (the chats being saved) for the extension's core function only. Not sold, not used for anything else, not used for creditworthiness.
- **Remote code:** none. All code ships in the package.
- **Privacy policy URL:** host `docs/PRIVACY.md` (for example via GitHub Pages) and paste the link.

## Assets still needed

- [ ] Store icon 128×128 (a placeholder is in `icons/icon128.png`; a designed one is better)
- [ ] At least one screenshot at 1280×800 (drafts in `docs/screenshots/`)
- [ ] Contact email in `docs/PRIVACY.md`
- [ ] Developer account ($5 one-time) at https://chrome.google.com/webstore/devconsole
