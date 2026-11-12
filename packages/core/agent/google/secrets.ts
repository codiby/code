/**
 * Saved website logins for the browser area's `browser_fill_secret`.
 *
 * Stored in the vault as `site:<hostname>` → {username, password, updatedAt}.
 * The hostname is lower-case ASCII (IDNs in punycode), without port or
 * path — what `new URL(pageUrl).hostname` returns. Routes only ever return
 * names and timestamps: a value written here never comes back over HTTP.
 */

import { HttpError, json, readBody } from '../http';
import type { AgentRoute } from '../types';
import { deleteSecret, hasSecret, listSecrets, setSecretJson } from '../vault';

export const SITE_PREFIX = 'site:';

export interface SiteLogin {
  username: string;
  password: string;
  updatedAt: number;
}

/** Vault names are capped at 128 characters. */
const MAX_HOST_LENGTH = 128 - SITE_PREFIX.length;
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** Canonical hostname for a site login, or throws a 400 the UI can show. */
export function normalizeSiteDomain(input: string): string {
  const raw = input.trim().toLowerCase().replace(/\.$/, '');
  if (!raw) throw new HttpError(400, 'Enter a domain, e.g. github.com');
  // Only name characters: no scheme, port, path, credentials or wildcards.
  if (!/^[\p{L}\p{N}.-]+$/u.test(raw)) throw new HttpError(400, `"${input.slice(0, 80)}" is not a domain — enter just the host, e.g. accounts.google.com`);
  let host: string;
  try {
    host = new URL(`https://${raw}`).hostname; // IDN → punycode
  } catch {
    throw new HttpError(400, `"${input.slice(0, 80)}" is not a valid domain`);
  }
  if (host.length > MAX_HOST_LENGTH) throw new HttpError(400, `Domain is too long (max ${MAX_HOST_LENGTH} characters)`);
  if (IPV4_RE.test(host)) return host;
  const labels = host.split('.');
  if (labels.length < 2 && host !== 'localhost') throw new HttpError(400, 'Enter a full domain, e.g. example.com');
  if (!labels.every(l => LABEL_RE.test(l))) throw new HttpError(400, `"${input.slice(0, 80)}" is not a valid domain`);
  return host;
}

export const siteSecretName = (domain: string) => `${SITE_PREFIX}${domain}`;

const PREFIX_RE = /^[a-z0-9._:-]{0,64}$/i;

function readCredentials(body: Record<string, unknown>): { username: string; password: string } {
  const { username, password } = body;
  if (typeof username !== 'string') throw new HttpError(400, 'username must be a string (it may be empty)');
  if (typeof password !== 'string' || !password) throw new HttpError(400, 'password is required');
  if (username.length > 320) throw new HttpError(400, 'username is too long');
  if (/[\r\n\0]/.test(username)) throw new HttpError(400, 'username must be a single line');
  if (password.length > 1024) throw new HttpError(400, 'password is too long');
  if (password.includes('\0')) throw new HttpError(400, 'password contains an invalid character');
  return { username: username.trim(), password };
}

export const SECRET_ROUTES: AgentRoute[] = [
  {
    method: 'GET',
    path: '/agent/secrets',
    handler: (_req, _params, url) => {
      const prefix = url.searchParams.get('prefix') ?? '';
      if (!PREFIX_RE.test(prefix)) throw new HttpError(400, 'Invalid prefix');
      const secrets = listSecrets(prefix).map(s => ({
        name: s.name,
        updatedAt: s.updatedAt,
        ...(s.name.startsWith(SITE_PREFIX) ? { domain: s.name.slice(SITE_PREFIX.length) } : {}),
      }));
      return json({ secrets });
    },
  },
  {
    method: 'PUT',
    path: '/agent/secrets/site/:domain',
    handler: async (req, params) => {
      const domain = normalizeSiteDomain(params.domain ?? '');
      const creds = readCredentials(await readBody<Record<string, unknown>>(req));
      const updatedAt = Date.now();
      setSecretJson(siteSecretName(domain), { ...creds, updatedAt } satisfies SiteLogin);
      return json({ ok: true, name: siteSecretName(domain), domain, updatedAt });
    },
  },
  {
    method: 'DELETE',
    path: '/agent/secrets/site/:domain',
    handler: (_req, params) => {
      const domain = normalizeSiteDomain(params.domain ?? '');
      const name = siteSecretName(domain);
      if (!hasSecret(name)) throw new HttpError(404, `No saved login for ${domain}`);
      deleteSecret(name);
      return json({ ok: true, domain });
    },
  },
];
