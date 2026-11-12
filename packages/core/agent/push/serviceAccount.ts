/**
 * Firebase service account — the credential the FCM sender signs its OAuth
 * assertions with. Stored encrypted in the vault; this module is the only
 * place that decrypts it, and nothing here ever returns the private key to a
 * caller outside the push area.
 */

import { createPrivateKey } from 'crypto';
import { deleteSecret, getSecret, setSecret } from '../vault';

export const SERVICE_ACCOUNT_SECRET = 'firebase:service-account';

export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  /** Becomes the JWT `kid`, so Google can pick the right public key fast. */
  privateKeyId: string | null;
}

/** What may be shown about the credential (no key material). */
export interface ServiceAccountInfo {
  projectId: string;
  clientEmail: string;
  privateKeyId: string | null;
}

export class ServiceAccountError extends Error {}

// Firebase/GCP project ids: 6–30 chars, lowercase letters, digits and hyphens.
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_INPUT_BYTES = 64 * 1024;

/**
 * Accepts the JSON Google downloads (as an object or as its text) and returns
 * a validated credential. Throws ServiceAccountError with a message that is
 * safe to show — it never quotes the key.
 */
export function parseServiceAccount(input: unknown): ServiceAccount {
  let raw: unknown = input;
  if (typeof input === 'string') {
    if (input.length > MAX_INPUT_BYTES) throw new ServiceAccountError('The service account file is too large');
    try {
      raw = JSON.parse(input);
    } catch {
      throw new ServiceAccountError('The service account is not valid JSON');
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ServiceAccountError('The service account must be a JSON object');
  }
  const r = raw as Record<string, unknown>;
  if (r.type !== 'service_account') {
    throw new ServiceAccountError('Expected a service account key ("type": "service_account") — download it from Project settings → Service accounts');
  }
  const projectId = typeof r.project_id === 'string' ? r.project_id.trim() : '';
  if (!PROJECT_ID_RE.test(projectId)) throw new ServiceAccountError('The service account has no valid "project_id"');
  const clientEmail = typeof r.client_email === 'string' ? r.client_email.trim() : '';
  if (!EMAIL_RE.test(clientEmail)) throw new ServiceAccountError('The service account has no valid "client_email"');
  const privateKey = typeof r.private_key === 'string' ? r.private_key.replace(/\\n/g, '\n').trim() : '';
  if (!privateKey.startsWith('-----BEGIN PRIVATE KEY-----')) {
    throw new ServiceAccountError('The service account has no "private_key" in PEM format');
  }
  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
  } catch {
    throw new ServiceAccountError('The service account "private_key" is not a readable RSA key');
  }
  const privateKeyId = typeof r.private_key_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(r.private_key_id)
    ? r.private_key_id
    : null;
  return { projectId, clientEmail, privateKey: privateKey + '\n', privateKeyId };
}

export function serviceAccountInfo(sa: ServiceAccount): ServiceAccountInfo {
  return { projectId: sa.projectId, clientEmail: sa.clientEmail, privateKeyId: sa.privateKeyId };
}

// Decrypting on every push would hit the vault (and, on macOS, the Keychain
// the first time) for nothing; the cache is dropped whenever the credential
// changes through this module.
let cached: ServiceAccount | null | undefined;

export function loadServiceAccount(): ServiceAccount | null {
  if (cached !== undefined) return cached;
  const stored = getSecret(SERVICE_ACCOUNT_SECRET);
  if (!stored) {
    cached = null;
    return null;
  }
  try {
    cached = parseServiceAccount(stored);
  } catch {
    cached = null;
  }
  return cached;
}

export function saveServiceAccount(sa: ServiceAccount): void {
  setSecret(SERVICE_ACCOUNT_SECRET, JSON.stringify({
    type: 'service_account',
    project_id: sa.projectId,
    client_email: sa.clientEmail,
    private_key: sa.privateKey,
    private_key_id: sa.privateKeyId ?? undefined,
  }));
  cached = sa;
}

export function deleteServiceAccount(): boolean {
  cached = null;
  return deleteSecret(SERVICE_ACCOUNT_SECRET);
}

/** Tests only. */
export function _resetServiceAccountCache(): void {
  cached = undefined;
}
