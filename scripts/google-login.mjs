#!/usr/bin/env node
// Signs the user in to Google once, in their own browser, and keeps the refresh token on this computer.
//
//   node scripts/google-login.mjs --client ~/Downloads/client_secret_XXXX.json   (first time)
//   node scripts/google-login.mjs                                                 (sign in again)
//   --no-browser   only print the link (e.g. over SSH; the browser must run on this same computer)
//
// Uses the OAuth "Desktop app" loopback flow with PKCE: Google redirects back to http://127.0.0.1:<port>
// on this computer, so no server anywhere is involved. Waits up to 10 minutes for the user.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { ensureHome, paths, readJson, writePrivateJson } from './lib/config.mjs';
import { buildAuthUrl, readOAuthClient, SCOPES } from './lib/google.mjs';
import { parseArgs, run, UserError } from './lib/util.mjs';

const b64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* the printed link still works */ }
}

const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui;max-width:520px;margin:15vh auto;padding:0 16px"><h2>${title}</h2><p>${text}</p></body>`;

run(async () => {
  const { flags } = parseArgs();
  ensureHome();

  if (flags.client) {
    const source = String(flags.client).replace(/^~(?=$|\/|\\)/, process.env.HOME ?? process.env.USERPROFILE ?? '~');
    if (!fs.existsSync(source)) throw new UserError(`File not found: ${source}`, 'Give the path of the JSON downloaded from Google Cloud → Clients → Desktop app.');
    const json = readJson(source);
    if (!(json?.installed ?? json?.web)?.client_id) throw new UserError(`${source} is not a Google OAuth client file.`);
    if (!json.installed) {
      throw new UserError('This OAuth client is not a "Desktop app" client.', 'In Google Cloud → Clients → Create client, choose Application type "Desktop app" and download that JSON.');
    }
    writePrivateJson(paths.oauthClient, json);
    console.log(`Saved the OAuth client to ${paths.oauthClient}`);
  }

  const { clientId, clientSecret } = readOAuthClient();
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const result = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') { res.writeHead(404).end(); return; }
      const finish = (status, title, text, outcome) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(page(title, text));
        clearTimeout(timer);
        server.close();
        outcome();
      };
      if (url.searchParams.get('state') !== state) { res.writeHead(400).end('Wrong state'); return; }
      const error = url.searchParams.get('error');
      if (error) {
        finish(400, 'Sign-in cancelled', 'Nothing was saved. Go back to Claude.', () => reject(new UserError(`Google sign-in was cancelled (${error}).`, 'Run node scripts/google-login.mjs again.')));
        return;
      }
      try {
        const response = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: url.searchParams.get('code') ?? '', client_id: clientId, client_secret: clientSecret,
            redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        const body = await response.json();
        if (!response.ok || !body.refresh_token) {
          throw new UserError(`Google did not return a refresh token (${body.error ?? response.status}).`,
            'Remove this app at myaccount.google.com/permissions and run node scripts/google-login.mjs again.');
        }
        finish(200, 'Connected ✓', 'Google is connected. You can close this tab and go back to Claude.', () => resolve(body));
      } catch (e) {
        finish(500, 'Sign-in failed', 'Go back to Claude for details.', () => reject(e));
      }
    });
    let redirectUri = '';
    const timer = setTimeout(() => { server.close(); reject(new UserError('Timed out after 10 minutes waiting for the Google sign-in.', 'Run node scripts/google-login.mjs again.')); }, 600_000);
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`;
      const url = buildAuthUrl({ clientId, redirectUri, challenge, state });
      console.log('A browser window opens for the Google sign-in. If it does not, open this link:\n');
      console.log(url);
      console.log('\nSign in with the Google user that can see your Google Ads, GA4 and Search Console, and tick every permission.');
      console.log('"Google hasn\'t verified this app" is expected for your own app: Advanced → Go to … (unsafe).\n');
      if (!flags['no-browser']) openBrowser(url);
    });
  });

  const granted = String(result.scope ?? '').split(/\s+/);
  writePrivateJson(paths.token, {
    refresh_token: result.refresh_token,
    scope: result.scope,
    created: new Date().toISOString(),
  });
  const missing = SCOPES.filter((s) => !granted.includes(s));
  console.log(`Signed in. Token saved to ${paths.token}`);
  if (missing.length) {
    console.log(`WARNING: these permissions were not granted: ${missing.map((s) => s.split('/').pop()).join(', ')}.`);
    console.log('Run the login again and tick every box if you want those sources.');
  }
});
