# Chrome Web Store listing (draft)

Copy these into the Chrome Web Store developer dashboard. Avoid OpenAI's logo and don't present the extension as official.

## Basics

- **Name:** Chat Saver for ChatGPT
- **Category:** Productivity
- **Language:** English

**Short description** (132 characters max):

> Save any ChatGPT chat with its files, an AI summary, and a brief to continue it in a new chat. Everything stays on your computer.

## Detailed description

Save your ChatGPT work properly, not just the text.

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

Not affiliated with OpenAI. ChatGPT is a trademark of OpenAI.

## Privacy tab answers

- **Single purpose:** Save the user's ChatGPT conversations and their files to the user's computer.
- **Permission justifications:**
  - `storage`: keeps the user's settings (AI provider, model, API key) in the browser.
  - Host `chatgpt.com`: reads the chat the user chooses to save, through the user's own session.
  - Host `*.oaiusercontent.com`: downloads the files attached to that chat.
  - Hosts `api.openai.com`, `api.anthropic.com`: send the chat to the user's chosen AI provider for the optional summary, with the user's own key.
  - `tabs` is not requested. The popup only messages the active ChatGPT tab.
- **Data usage:** collects "Website content" (the chats being saved) for the extension's core function only. Not sold, not used for anything else, not used for creditworthiness.
- **Remote code:** none. All code ships in the package.
- **Privacy policy URL:** host `docs/PRIVACY.md` (for example via GitHub Pages) and paste the link.

## Assets still needed

- [ ] Store icon 128×128 (a placeholder is in `icons/icon128.png`; a designed one is better)
- [ ] At least one screenshot at 1280×800 (drafts in `docs/screenshots/`)
- [ ] Contact email in `docs/PRIVACY.md`
- [ ] Developer account ($5 one-time) at https://chrome.google.com/webstore/devconsole
