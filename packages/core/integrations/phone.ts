/**
 * Phone agent: lets agent sessions read and drive the user's Android phone.
 *
 *   agent ──MCP phone_*──▶ bridge ──/phone/ws──▶ Codiby Android
 *                                                 (AccessibilityService +
 *                                                  NotificationListener)
 *
 * The phone dials in (it is the one behind NAT), authenticated with the same
 * mobile token as /ws. It owns every safety decision: the capability
 * switches, the confirmation prompt for sensitive actions, and the audit log
 * all live on the device, so a bridge — or an agent fooled by text it read on
 * screen — cannot widen what the user allowed there.
 *
 * Phone → bridge
 *   {type:'hello', deviceId, name, model, android, appVersion, capabilities}
 *   {type:'capabilities', capabilities}     a switch changed on the phone
 *   {type:'result', id, ok:true, result} | {type:'result', id, ok:false, error}
 * Bridge → phone
 *   {type:'welcome'}
 *   {type:'command', id, command, args, requester:{sessionId, sessionName}}
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CODIBY_DIR } from '../config/config';
import { log } from '../lib/logger';

export interface PhoneCapabilities {
  /** Read the screen and the list of apps. */
  readonly read: boolean;
  /** Tap, type, scroll, swipe, press keys, open apps. */
  readonly act: boolean;
  /** Read notifications and reply to them. */
  readonly notifications: boolean;
}

export interface PhoneInfo {
  readonly deviceId: string;
  readonly name: string;
  readonly model: string;
  readonly android: string;
  readonly appVersion: string;
  readonly capabilities: PhoneCapabilities;
  readonly connectedAt: number;
}

export interface PhoneRequester {
  readonly sessionId: string;
  readonly sessionName: string;
}

/** Just what this module needs from a Bun `ServerWebSocket`. */
export interface PhoneSocket {
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

interface Pending {
  readonly deviceId: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const NO_CAPABILITIES: PhoneCapabilities = { read: false, act: false, notifications: false };
/** A socket that never says hello is not a phone. */
const HELLO_TIMEOUT_MS = 10_000;
/** Covers the on-phone confirmation prompt, which waits up to 60 s. */
export const DEFAULT_TIMEOUT_MS = 75_000;
/**
 * After the phone switches networks it resends unanswered results on the new
 * socket. This long, then the request fails instead of waiting the full timeout.
 */
let replacedGraceMs = 8_000;

const devices = new Map<string, PhoneInfo & { ws: PhoneSocket }>();
const deviceOf = new Map<PhoneSocket, string>();
const helloTimers = new Map<PhoneSocket, ReturnType<typeof setTimeout>>();
const pending = new Map<string, Pending>();

let knownFile = join(CODIBY_DIR, 'phone-devices.json');

/**
 * Whether a phone ever connected here. The phone tools are listed to agents
 * only then: six tools in every session's context are a cost nobody without
 * the Android app should pay.
 */
export function hasKnownPhone(): boolean {
  if (devices.size > 0) return true;
  try {
    return existsSync(knownFile) && Object.keys(JSON.parse(readFileSync(knownFile, 'utf8'))).length > 0;
  } catch {
    return false;
  }
}

function remember(info: PhoneInfo) {
  try {
    const known = existsSync(knownFile) ? JSON.parse(readFileSync(knownFile, 'utf8')) : {};
    known[info.deviceId] = { name: info.name, model: info.model, lastSeen: Date.now() };
    writeFileSync(knownFile, JSON.stringify(known, null, 2));
  } catch {
    /* Only gates the tool list; a failed write just keeps it as it was. */
  }
}

function asText(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function parseCapabilities(value: unknown): PhoneCapabilities {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return { read: raw.read === true, act: raw.act === true, notifications: raw.notifications === true };
}

export function openPhone(ws: PhoneSocket) {
  helloTimers.set(ws, setTimeout(() => {
    helloTimers.delete(ws);
    try { ws.close(4400, 'Expected hello'); } catch {}
  }, HELLO_TIMEOUT_MS));
}

export function phoneMessage(ws: PhoneSocket, message: string | ArrayBuffer | Uint8Array) {
  let frame: Record<string, unknown>;
  try {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return;
    frame = parsed;
  } catch {
    return;
  }

  if (frame.type === 'hello') {
    const deviceId = asText(frame.deviceId, 80);
    if (!deviceId) { try { ws.close(4400, 'Missing deviceId'); } catch {} return; }
    clearTimeout(helloTimers.get(ws));
    helloTimers.delete(ws);
    // The same phone reconnecting (new route, app restart) replaces itself.
    const previous = devices.get(deviceId);
    if (previous && previous.ws !== ws) {
      deviceOf.delete(previous.ws);
      try { previous.ws.close(4409, 'Replaced by a newer connection'); } catch {}
      // The phone resends unanswered results on the new socket; give them a
      // moment, then fail instead of letting the agent wait the full timeout.
      for (const [id, waiter] of pending) {
        if (waiter.deviceId !== deviceId) continue;
        clearTimeout(waiter.timer);
        waiter.timer = setTimeout(() => {
          pending.delete(id);
          waiter.reject(new Error('The phone switched networks before answering. Read the screen to see whether it happened.'));
        }, replacedGraceMs);
      }
    }
    const info: PhoneInfo = {
      deviceId,
      name: asText(frame.name, 80) || 'Android phone',
      model: asText(frame.model, 80),
      android: asText(frame.android, 20),
      appVersion: asText(frame.appVersion, 40),
      capabilities: parseCapabilities(frame.capabilities),
      connectedAt: Date.now(),
    };
    devices.set(deviceId, { ...info, ws });
    deviceOf.set(ws, deviceId);
    remember(info);
    log(`[phone] ${info.name} connected (read=${info.capabilities.read} act=${info.capabilities.act} notifications=${info.capabilities.notifications})`);
    ws.send(JSON.stringify({ type: 'welcome' }));
    return;
  }

  const deviceId = deviceOf.get(ws);
  if (!deviceId) return;

  if (frame.type === 'capabilities') {
    const device = devices.get(deviceId);
    if (device) devices.set(deviceId, { ...device, capabilities: parseCapabilities(frame.capabilities) });
    return;
  }

  if (frame.type === 'result') {
    const id = asText(frame.id, 80);
    const waiter = pending.get(id);
    // A result from another phone than the one asked is ignored, not trusted.
    if (!waiter || waiter.deviceId !== deviceId) return;
    pending.delete(id);
    clearTimeout(waiter.timer);
    if (frame.ok === true) waiter.resolve(frame.result ?? null);
    else waiter.reject(new Error(asText(frame.error, 2000) || 'The phone could not do it'));
  }
}

export function closePhone(ws: PhoneSocket) {
  clearTimeout(helloTimers.get(ws));
  helloTimers.delete(ws);
  const deviceId = deviceOf.get(ws);
  deviceOf.delete(ws);
  if (!deviceId || devices.get(deviceId)?.ws !== ws) return;
  devices.delete(deviceId);
  log(`[phone] ${deviceId} disconnected`);
  failPending(deviceId, 'The phone disconnected before answering');
}

function failPending(deviceId: string, message: string) {
  for (const [id, waiter] of pending) {
    if (waiter.deviceId !== deviceId) continue;
    pending.delete(id);
    clearTimeout(waiter.timer);
    waiter.reject(new Error(message));
  }
}

export function listPhones(): PhoneInfo[] {
  return [...devices.values()]
    .map(({ ws: _ws, ...info }) => info)
    .sort((a, b) => b.connectedAt - a.connectedAt);
}

/** The named phone, or the most recently connected one. */
export function pickPhone(deviceId?: string): PhoneInfo {
  const all = listPhones();
  if (all.length === 0) {
    throw new Error('No phone is connected. Open Codiby Code on the phone and turn on Phone access in Settings.');
  }
  if (!deviceId) return all[0]!;
  const match = all.find(p => p.deviceId === deviceId || p.name.toLowerCase() === deviceId.toLowerCase());
  if (!match) throw new Error(`No connected phone matches "${deviceId}". Connected: ${all.map(p => p.name).join(', ')}`);
  return match;
}

export function phoneRequest(
  command: string,
  args: Record<string, unknown>,
  options: { deviceId?: string; requester: PhoneRequester; timeoutMs?: number },
): Promise<unknown> {
  let phone: PhoneInfo;
  try {
    phone = pickPhone(options.deviceId);
  } catch (error) {
    return Promise.reject(error);
  }
  const device = devices.get(phone.deviceId)!;
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${phone.name} did not answer in time. If it asked for confirmation, nobody approved it.`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    pending.set(id, { deviceId: phone.deviceId, resolve, reject, timer });
    try {
      device.ws.send(JSON.stringify({ type: 'command', id, command, args, requester: options.requester }));
    } catch {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error(`Could not reach ${phone.name}`));
    }
  });
}

/** Tests only. */
export function resetPhonesForTest(file: string, graceMs = 8_000) {
  knownFile = file;
  replacedGraceMs = graceMs;
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  for (const timer of helloTimers.values()) clearTimeout(timer);
  pending.clear();
  helloTimers.clear();
  devices.clear();
  deviceOf.clear();
}

export { NO_CAPABILITIES };
