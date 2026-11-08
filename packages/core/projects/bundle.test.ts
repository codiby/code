import { describe, expect, test } from 'bun:test';
import {
  applyPeerProjects, bundleOf, mergeProjects, resolveFolderHosts, stampProjects,
  type OrgPrefs, type StoredProject, type TabGroupInfo,
} from './bundle';

const MAC = 'host_mac', RYZEN = 'host_ryzen';
const g = (id: string, extra: Partial<TabGroupInfo> = {}): TabGroupInfo => ({ id, name: id, ...extra });
const project = (extra: Partial<StoredProject> = {}): StoredProject => ({
  id: 'up', name: 'UtilityProfit', folders: [{ path: '/Users/j/src/up', hostId: MAC }, { path: '/home/j/up', hostId: RYZEN }],
  updatedAt: 100, ...extra,
});
const prefs = (projects: Record<string, StoredProject>, org: Partial<OrgPrefs> = {}) => ({
  tabGroups: {}, tabGroupMap: {}, groupOrder: {}, pinnedSessionIds: [], ...org, projects,
});

describe('stampProjects', () => {
  test('a changed definition or organization is a new version; an unchanged one is not', () => {
    const p = project();
    const first = stampProjects({ up: p }, prefs({ up: p }), 1000);
    expect(first.changed).toEqual(['up']);
    const stamped = first.projects.up!;
    expect(stamped.updatedAt).toBe(1000);
    // Same content again: nothing moves.
    expect(stampProjects(first.projects, prefs(first.projects), 2000).changed).toEqual([]);
    // GitHub orgs are part of the definition.
    const withOrgs = { up: { ...stamped, githubOrgs: ['SunroomOrg'] } };
    expect(stampProjects(withOrgs, prefs(withOrgs), 3000).changed).toEqual(['up']);
    // So is the organization: a session moved into one of its groups.
    const org = { tabGroups: { bug: g('bug', { projectId: 'up' }) }, tabGroupMap: { s1: 'bug' } };
    expect(stampProjects(first.projects, prefs(first.projects, org), 4000).changed).toEqual(['up']);
  });
});

describe('mergeProjects', () => {
  test('a stale window can neither drop a project nor take its version back', () => {
    const stored = { up: project({ updatedAt: 500, fp: 'new' }), code: project({ id: 'code', name: 'Codiby' }) };
    const incoming = { up: project({ updatedAt: 300, fp: 'old', githubOrgs: ['X'] }) };
    const out = mergeProjects(stored, incoming);
    expect(Object.keys(out).sort()).toEqual(['code', 'up']);
    expect(out.up!.updatedAt).toBe(500);
    expect(out.up!.githubOrgs).toEqual(['X']);   // the content still lands, and stamping versions it
  });
});

describe('resolveFolderHosts', () => {
  test('registry ids become host identities', () => {
    const legacy = { up: project({ folders: [{ path: '/a', remoteId: null }, { path: '/b', remoteId: 'rmt_1' }] }) };
    const out = resolveFolderHosts(legacy, MAC, id => (id === 'rmt_1' ? RYZEN : undefined));
    expect(out.up!.folders).toEqual([{ path: '/a', hostId: MAC }, { path: '/b', hostId: RYZEN }]);
  });
});

describe('two hosts exchanging', () => {
  test('the newer version wins, its organization comes with it, and neither side then sees a change', () => {
    // The Mac edits: adds an org and files a session into a project group.
    const macOrg = { tabGroups: { bug: g('bug', { projectId: 'up' }) }, tabGroupMap: { s1: 'bug' } };
    const macProjects = stampProjects({ up: project({ githubOrgs: ['SunroomOrg'] }) }, prefs({ up: project() }, macOrg), 2000).projects;
    const mac = prefs(macProjects, macOrg);
    // ryzen9 still holds the old version and a group of its own.
    const ryzen = prefs({ up: project({ updatedAt: 1000 }) }, { tabGroups: { mine: g('mine') }, tabGroupMap: { r1: 'mine' } });

    const wire = [{ project: mac.projects.up!, bundle: bundleOf(mac, 'up') }];
    const after = applyPeerProjects(ryzen, wire, RYZEN)!;
    expect(after.projects.up!.githubOrgs).toEqual(['SunroomOrg']);
    expect(after.tabGroups.bug).toBeDefined();
    expect(after.tabGroups.mine).toBeDefined();          // its own groups untouched
    expect(after.tabGroupMap).toEqual({ r1: 'mine', s1: 'bug' });

    // Converged: re-stamping on either side changes nothing, so nothing bounces back.
    expect(stampProjects(after.projects, after, 9999).changed).toEqual([]);
    expect(stampProjects(mac.projects, mac, 9999).changed).toEqual([]);
    // And an older copy coming back is ignored.
    expect(applyPeerProjects(after, [{ project: project({ updatedAt: 1500 }), bundle: null }], RYZEN)).toBeNull();
  });

  test('a project that does not span this host is not taken; a tombstone deletes', () => {
    const elsewhere = project({ id: 'p2', folders: [{ path: '/x', hostId: 'host_other' }], updatedAt: 5 });
    expect(applyPeerProjects(prefs({}), [{ project: elsewhere, bundle: null }], RYZEN)).toBeNull();
    const held = prefs({ up: project({ updatedAt: 10 }) });
    const gone = applyPeerProjects(held, [{ project: { ...project(), deleted: true, updatedAt: 20 }, bundle: null }], RYZEN)!;
    expect(gone.projects.up!.deleted).toBe(true);
  });
});
