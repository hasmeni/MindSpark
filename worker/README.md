# MindSpark — GitHub OAuth Worker (optional)

MindSpark works fully static with the **personal access token (PAT)** login and
no backend. This optional Cloudflare Worker adds a friendlier **"Sign in with
GitHub"** button by performing the OAuth `code → token` exchange (which needs the
OAuth App *client secret*, so it can't run in the browser).

If you don't deploy this and leave `GH_OAUTH` blank in `public/app.js`, only the
PAT login shows — nothing else changes.

## Deploy

1. **Create a GitHub OAuth App** → https://github.com/settings/developers → *New OAuth App*
   - **Homepage URL:** your MindSpark URL
   - **Authorization callback URL:** `https://<your-worker>.workers.dev/callback`
   - Copy the **Client ID**; click **Generate a new client secret** and copy it.

2. **Set the secrets** (from this `worker/` folder):
   ```sh
   npm i -g wrangler        # or use: npx wrangler ...
   wrangler secret put GITHUB_CLIENT_ID
   wrangler secret put GITHUB_CLIENT_SECRET
   ```

3. **Restrict token delivery (strongly recommended)** — in `wrangler.toml` add:
   ```toml
   [vars]
   ALLOWED_ORIGIN = "https://your-mindspark-app.example.com"
   ```
   With this set, the Worker will hand the token only to your app's origin.
   Without it, the token is posted with `'*'`, which a malicious page that
   opens the OAuth flow itself could intercept.

4. **Deploy:**
   ```sh
   wrangler deploy
   ```

5. **Point the app at it** — in `public/app.js`:
   ```js
   const GH_OAUTH = {
     clientId:  '<your client id>',
     workerUrl: 'https://<your-worker>.workers.dev'
   };
   ```

That's it. The login overlay now shows **Sign in with GitHub** above the existing
token option. Both produce a GitHub token that the app uses identically.

## How it works / security

- The popup hits GitHub's authorize page, then GitHub redirects to the Worker's
  `/callback` with a one-time `code` and your `state` nonce.
- The Worker exchanges the `code` for a token using the **client secret** (never
  exposed to the browser) and `postMessage`s the token back to the app window.
- The app accepts it only if the message **origin == your Worker origin** and the
  **`state` matches** the nonce it generated — guarding against CSRF / spoofing.
- The OAuth App `repo` scope lets MindSpark create and read/write its private
  `mindspark-maps` repository. For tighter, per-repo access, use a GitHub *App*
  instead of an OAuth App (more setup; not required).

## GPT map import (`POST /api/import`)

The Worker can also accept a generated map from a Custom GPT and write it into your
`mindspark-maps` repo, so it appears in the app. This is what the GPT Action calls.

1. **Create a fine-grained PAT** → GitHub → Settings → Developer settings → *Fine-grained tokens*.
   - Repository access: only `mindspark-maps`.
   - Permissions: **Contents → Read and write**.
   - (Sign in to MindSpark once first so the repo exists.)
2. **Generate an import secret**: `openssl rand -hex 32`
3. **Set them on the Worker**:
   ```
   wrangler secret put IMPORT_TOKEN     # paste the hex secret
   wrangler secret put GITHUB_PAT       # paste the fine-grained PAT
   wrangler deploy
   ```
   `ALLOWED_ORIGIN` should already be your app URL (used to build the returned link).
4. **In the Custom GPT Action**: set `servers.url` to this Worker's URL, and under
   Authentication choose **API Key → Bearer**, pasting the same `IMPORT_TOKEN`.

The Worker writes `maps/<id>.json` + an `_index.json` entry, then returns
`{ "id", "url" }` where `url` opens the laid-out map in your app.
