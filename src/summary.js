// Builds the AI summary prompt and parses the reply. Shared by background.js and tests.
(function (root) {
  'use strict';

  const DEFAULT_MODELS = { openai: 'gpt-5-mini', anthropic: 'claude-haiku-5-5' };

  function buildPrompt(title, transcript) {
    return [
      'You are summarising a saved ChatGPT conversation so the user can find and reuse it later.',
      `The conversation is titled "${title || 'Untitled'}". The transcript is between <transcript> tags.`,
      '',
      'Reply with exactly two parts, in Markdown, separated by a line containing only ===CONTINUE===',
      '',
      'Part 1, the summary. Use these headings:',
      '## Summary (3 to 5 sentences: what the chat was about and where it ended)',
      '## Key points and decisions (bullets)',
      '## Action items and open questions (bullets, or "None")',
      '## Important outputs (code, documents, numbers or files worth reusing, with one line each)',
      '',
      'Part 2, a briefing the user will paste into a brand-new chat to continue the work.',
      'Write it to the new assistant in the second person ("We have been working on..."). Include the goal,',
      'the context and constraints, decisions already made, the current state, and the next step.',
      'Keep it under 1,500 words and end with: "Please confirm you understand, then continue from the next step."',
      '',
      '<transcript>',
      transcript,
      '</transcript>',
    ].join('\n');
  }

  function parseReply(text) {
    const [summary, brief] = String(text || '').split(/^\s*===CONTINUE===\s*$/m);
    return {
      summary: `# AI summary\n\n${(summary || '').trim()}`,
      continueBrief: (brief || '').trim() || null,
    };
  }

  // Returns { url, init, extract } for a fetch call to the chosen provider.
  function buildRequest(settings, prompt) {
    const provider = settings.provider === 'anthropic' ? 'anthropic' : 'openai';
    const model = settings.model || DEFAULT_MODELS[provider];
    if (provider === 'anthropic') {
      return {
        url: 'https://api.anthropic.com/v1/messages',
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': settings.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({ model, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
        },
        extract: (json) => (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
      };
    }
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
      },
      extract: (json) => (json.choices && json.choices[0] && json.choices[0].message.content) || '',
    };
  }

  const api = { DEFAULT_MODELS, buildPrompt, parseReply, buildRequest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChatSaverSummary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
