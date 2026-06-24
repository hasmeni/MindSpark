// MindSpark app worker: serves the static app (public/) and the GPT import endpoint.
// Deployed by the root wrangler.jsonc (name "mindspark") at your app URL.
import { handleImport } from './import-core.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/import' && request.method === 'POST') {
      return handleImport(request, env);
    }
    // Everything else is a static asset (index.html, app.js, etc.).
    return env.ASSETS.fetch(request);
  }
};
