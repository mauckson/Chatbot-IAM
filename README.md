# IAM-bot-1

A general-purpose AI chatbot powered by [Groq](https://groq.com). Ask questions on any topic, write, brainstorm, explain concepts and follow up. Plain HTML, CSS and JavaScript, with one Vercel serverless function for the Groq call.

## Project layout

```
api/chat.js            POST /api/chat → Groq (the API key stays on the server)
public/index.html      The page
public/styles.css      Styles (dark default + light theme)
public/app.js          Chat client: messages, loading/error states, Markdown, theme
public/theme-init.js   Applies the saved theme before first paint
public/assets/         robot.png (the IAM-bot-1 mascot) and favicon.svg
scripts/dev-server.mjs Zero-dependency local server that mirrors Vercel
tests/chat.test.mjs    Tests for the endpoint (Groq is stubbed)
vercel.json            Output directory, function timeout, security headers
.env.example           Template for local environment variables
```

There are no npm dependencies. You need Node.js 18 or newer.

## Run it locally

1. Copy `.env.example` to `.env.local` and set `GROQ_API_KEY` (from https://console.groq.com/keys).
   `.env.local` is git-ignored. Never commit a real key.
2. Start the server:
   ```bash
   npm run dev
   ```
3. Open http://localhost:3000

Without a key, the app still loads and shows a clear setup error when you send a message.

Run the endpoint tests (no key or network needed):

```bash
npm test
```

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. In Vercel: **Add New → Project**, import the repository. Leave the framework preset as **Other**; `vercel.json` already sets the output directory to `public`, and there is no build command.
3. Under **Environment Variables**, add:
   - `GROQ_API_KEY`: your Groq key (required)
   - `GROQ_MODEL`: optional; defaults to `openai/gpt-oss-120b`
4. Deploy. If you add or change a variable later, redeploy for it to take effect.

## Configuration and limits

| Setting | Where | Value |
| --- | --- | --- |
| Model | `GROQ_MODEL` env var | default `openai/gpt-oss-120b` (e.g. `openai/gpt-oss-20b` for faster replies). Check https://console.groq.com/docs/deprecations before choosing one |
| Max message length | client + server | 4,000 characters |
| Conversation context | client + server | last 12 messages, max 24,000 characters; older replies clipped to 6,000 |
| Reply length | server | 2,048 tokens, including the model's brief thinking (replies cut short are flagged in the UI) |
| Groq request timeout | server | 25 s (function `maxDuration` is 30 s) |
| Browser request timeout | client | 35 s |
| Request body size | server | 200 KB |

The constants live at the top of `api/chat.js` and `public/app.js`.

## Notes

- **The key never reaches the browser.** The page only calls `/api/chat`; the function reads `GROQ_API_KEY` from the environment.
- **The endpoint is public.** There's no login, by design, so anyone with the URL can use your Groq quota. Groq's own rate limits apply and show up as a friendly "rate-limited" message. If you need more control, add a rate-limit rule in Vercel Firewall.
- **Embedding:** only `https://ianmauck.lovable.app` (and IAM-bot-1 itself) may show IAM-bot-1 in an iframe, via `frame-ancestors` in `vercel.json`. To embed it on another domain, such as a custom domain, add that origin there and to `EMBED_PARENT_ORIGIN` in `public/app.js`, then redeploy.
- **Inside an iframe** the page switches to a compact layout: no robot scene and no visible title, since the site's panel shows the name. Pressing Escape asks the parent page to close the panel with `postMessage({ type: "iam-bot:close" })`, sent only to `https://ianmauck.lovable.app`. If a reply is still loading, the first Escape stops it instead.
- **Site guide:** the server fetches `https://ianmauck.lovable.app/site-guide.txt`, caches it for an hour, and adds it to the system prompt under `SITE GUIDE`, with rules to answer site questions from it, give exact links, and never invent pages. If the fetch fails or returns an HTML page, the bot answers without it and retries after 5 minutes. Whether or not the guide loads, the bot never shares contact details beyond email, LinkedIn and Calendly.
- The endpoint only accepts JSON `POST` requests, ignores any `system` messages sent by the client, and uses a short built-in system prompt. No custom rules or knowledge files are loaded.
- Replies are rendered from Markdown with HTML escaped first, so model output can't inject markup.
- The UI respects `prefers-reduced-motion`, has visible focus styles and a skip link, and works with the keyboard: **Enter** sends, **Shift+Enter** adds a new line, **Esc** stops a reply.
