// git smart HTTP: protocol v2 upload-pack (ls-refs, fetch) and v0 upload-pack /
// receive-pack, speaking the exact bytes the kit's git-client expects. The server is a thin
// shell over the store: every object it serves comes from the in-memory repo, every push is
// validated (fast-forward only, exact "non-fast-forward" reason) before a ref moves.

import {
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  pktLineDelim,
  pktLineFlush,
  readPack,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  collectReachable,
  peelToCommit,
  type GitObject,
  type GitPacket,
} from './gitcore.ts';
import { type RepoState, type Store } from './store.ts';

export const GIT_AGENT = 'forge/1.0';
export const UPLOAD_PACK_CAPS =
  `side-band-64k multi_ack thin-pack ofs-delta shallow symref=HEAD:refs/heads/main object-format=sha1 agent=${GIT_AGENT}`;
export const RECEIVE_PACK_CAPS =
  `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main object-format=sha1 agent=${GIT_AGENT}`;

const SIDEBAND_MAX_CHUNK = 65515;

export interface GitRequestContext {
  readonly method: string;
  readonly headers: Record<string, string | undefined>;
  readonly body: Buffer;
  readonly query: URLSearchParams;
}

export interface GitResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

/** Split a sideband stream into band-1 (pack data) bytes. */
export function readSideband(bytes: Uint8Array): { pack: Buffer; progress: string[]; errors: string[] } {
  const { packets } = decodePktLines(bytes);
  const chunks: Buffer[] = [];
  const progress: string[] = [];
  const errors: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload.length === 0) continue;
    const band = packet.payload[0] as number;
    const data = packet.payload.subarray(1);
    if (band === 1) chunks.push(Buffer.from(data));
    else if (band === 2) progress.push(data.toString('utf8'));
    else if (band === 3) errors.push(data.toString('utf8'));
  }
  return { pack: Buffer.concat(chunks), progress, errors };
}

function sidebandWrap(pack: Buffer): Buffer {
  if (pack.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_MAX_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + SIDEBAND_MAX_CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(encodePktLine(payload));
  }
  return Buffer.concat(parts);
}

function sidebandText(lines: string[]): Buffer {
  const inner = encodePktLines(lines.map((line) => (line.endsWith('\n') ? line : `${line}\n`)));
  const parts: Buffer[] = [];
  for (let offset = 0; offset < inner.length; offset += SIDEBAND_MAX_CHUNK) {
    const chunk = inner.subarray(offset, Math.min(offset + SIDEBAND_MAX_CHUNK, inner.length));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

interface RefLine {
  readonly oid: string;
  readonly name: string;
  readonly peeled?: string;
  readonly symrefTarget?: string;
  readonly unborn?: boolean;
}

/** Every ref the server advertises, HEAD first, then refs sorted by name. */
export function advertisedRefs(store: Store, repo: RepoState): RefLine[] {
  const lines: RefLine[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip) {
    lines.push({ oid: defaultTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  } else {
    lines.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') {
        const peeled = peelToCommit(store.lookup(repo), oid);
        if (peeled) line.peeled = peeled;
      }
    }
    lines.push(line);
  }
  return lines;
}

function refLineText(line: RefLine, options: { peel: boolean; symrefs: boolean }): string {
  if (line.unborn) {
    return line.symrefTarget && options.symrefs
      ? `unborn HEAD symref-target:${line.symrefTarget}`
      : 'unborn HEAD';
  }
  let text = `${line.oid} ${line.name}`;
  if (line.symrefTarget && options.symrefs) text += ` symref-target:${line.symrefTarget}`;
  if (line.peeled && options.peel) text += ` peeled:${line.peeled}`;
  return text;
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${GIT_AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

function v0Advertisement(store: Store, repo: RepoState, service: string, caps: string): Buffer {
  const preamble = `# service=${service}\n`;
  const parts: Buffer[] = [encodePktLine(preamble), pktLineFlush()];
  const lines = advertisedRefs(store, repo);
  if (repo.refs.size === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      let text: string;
      if (line.name === 'HEAD' && line.unborn) {
        text = `unborn HEAD symref-target:${line.symrefTarget ?? `refs/heads/${repo.defaultBranch}`}`;
      } else if (line.name === 'HEAD') {
        text = `${line.oid} HEAD`;
      } else if (line.peeled) {
        text = `${line.oid} ${line.name}`;
      } else {
        text = `${line.oid} ${line.name}`;
      }
      if (index === 0) text += `\u0000${caps}`;
      parts.push(encodePktLine(`${text}\n`));
      if (line.peeled) parts.push(encodePktLine(`${line.peeled} ${line.name}^{}\n`));
    });
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

export function handleInfoRefs(store: Store, repo: RepoState, ctx: GitRequestContext): GitResponse {
  const service = ctx.query.get('service') ?? '';
  const isV2 = ctx.headers['git-protocol']?.includes('version=2') ?? false;
  if (service === 'git-upload-pack') {
    if (isV2) {
      return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: v2Advertisement() };
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
      body: v0Advertisement(store, repo, service, UPLOAD_PACK_CAPS),
    };
  }
  if (service === 'git-receive-pack') {
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-receive-pack-advertisement' },
      body: v0Advertisement(store, repo, service, RECEIVE_PACK_CAPS),
    };
  }
  return {
    status: 400,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ message: `unknown service ${service}` }), 'utf8'),
  };
}

// ---------------------------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  readonly pack: Buffer;
  readonly sideband: Buffer;
  readonly shallow: string[];
  readonly unshallow: string[];
}

function packCacheKey(repo: RepoState, wants: string[], haves: string[], depth: number | null, shallow: string[]): string {
  return JSON.stringify({
    v: repo.version,
    wants: [...wants].sort(),
    haves: [...haves].sort(),
    depth,
    shallow: [...shallow].sort(),
  });
}

function computeFetchPack(
  store: Store,
  repo: RepoState,
  wants: string[],
  haves: string[],
  depth: number | null,
  clientShallow: string[],
): FetchPlan {
  const lookup = store.lookup(repo);
  const cacheKey = packCacheKey(repo, wants, haves, depth, clientShallow);
  const cached = repo.packCache.get(cacheKey);
  if (cached) {
    const shallowOut = depth === null ? [] : computeShallowLines(store, repo, wants, haves, depth, clientShallow).shallow;
    const unshallowOut = depth === null ? [] : computeShallowLines(store, repo, wants, haves, depth, clientShallow).unshallow;
    return { pack: cached.pack, sideband: cached.sideband, shallow: shallowOut, unshallow: unshallowOut };
  }

  const wantCommits: string[] = [];
  const directObjects = new Set<string>();
  for (const oid of wants) {
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'commit') wantCommits.push(oid);
    else if (object.type === 'tag') {
      // A wanted tag ships the tag object itself, not just the commit it peels to.
      directObjects.add(oid);
      const peeled = peelToCommit(lookup, oid);
      if (peeled) wantCommits.push(peeled);
    } else directObjects.add(oid);
  }

  // The objects the client already has: closure from its haves, stopping at its shallow
  // boundaries (a shallow commit's parents stay on the server).
  const haveSet = new Set<string>();
  const shallowSet = new Set(clientShallow);
  const haveQueue: string[] = [];
  for (const have of haves) {
    const object = lookup(have);
    if (!object) continue;
    if (object.type === 'commit') haveQueue.push(have);
    else if (object.type === 'tag') {
      haveSet.add(have);
      const peeled = peelToCommit(lookup, have);
      if (peeled) haveQueue.push(peeled);
    } else haveSet.add(have);
  }
  const haveSeen = new Set<string>();
  while (haveQueue.length > 0) {
    const oid = haveQueue.pop() as string;
    if (haveSeen.has(oid)) continue;
    haveSeen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    haveSet.add(oid);
    const commit = parseCommit(object.data);
    for (const member of collectReachable([commit.tree], lookup, { allowMissing: true })) haveSet.add(member);
    if (shallowSet.has(oid)) continue;
    for (const parent of commit.parents) haveQueue.push(parent);
  }

  let wantSet: Set<string>;
  let shallowOut: string[] = [];
  let unshallowOut: string[] = [];
  if (depth !== null) {
    const generation = new Map<string, number>();
    const queue: Array<[string, number]> = wantCommits.map((oid) => [oid, 0] as [string, number]);
    const included = new Set<string>();
    while (queue.length > 0) {
      const [oid, gen] = queue.shift() as [string, number];
      if (generation.has(oid)) continue;
      generation.set(oid, gen);
      if (gen >= depth) continue;
      included.add(oid);
      const object = lookup(oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push([parent, gen + 1]);
      }
    }
    wantSet = new Set(directObjects);
    for (const oid of included) {
      wantSet.add(oid);
      const object = lookup(oid);
      if (object?.type === 'commit') {
        const commit = parseCommit(object.data);
        for (const member of collectReachable([commit.tree], lookup, { allowMissing: true })) wantSet.add(member);
      }
    }
    for (const [oid, gen] of generation) {
      if (gen !== depth - 1) continue;
      const object = lookup(oid);
      if (object?.type !== 'commit') continue;
      if (parseCommit(object.data).parents.length === 0) continue;
      if (haveSet.has(oid)) continue;
      shallowOut.push(oid);
    }
    const ancestors = new Set<string>();
    const ancestorQueue = [...wantCommits];
    const ancestorSeen = new Set<string>();
    while (ancestorQueue.length > 0) {
      const oid = ancestorQueue.pop() as string;
      if (ancestorSeen.has(oid)) continue;
      ancestorSeen.add(oid);
      ancestors.add(oid);
      const object = lookup(oid);
      if (object?.type === 'commit') ancestorQueue.push(...parseCommit(object.data).parents);
    }
    for (const boundary of clientShallow) {
      if (ancestors.has(boundary) && haveSet.has(boundary) && !shallowOut.includes(boundary)) {
        unshallowOut.push(boundary);
      }
    }
  } else {
    wantSet = new Set(directObjects);
    for (const member of collectReachable(wantCommits, lookup, { allowMissing: true })) wantSet.add(member);
  }

  const send: GitObject[] = [];
  for (const oid of wantSet) {
    if (haveSet.has(oid)) continue;
    const object = lookup(oid);
    if (object) send.push(object);
  }
  const pack = writePack(send.map((object) => ({ type: object.type, data: object.data })));
  const sideband = sidebandWrap(pack);
  repo.packCache.set(cacheKey, { pack, sideband });
  return { pack, sideband, shallow: shallowOut.sort(), unshallow: unshallowOut.sort() };
}

function computeShallowLines(
  store: Store,
  repo: RepoState,
  wants: string[],
  haves: string[],
  depth: number,
  clientShallow: string[],
): { shallow: string[]; unshallow: string[] } {
  // Recompute only the shallow/unshallow lists (used when the pack itself came from cache).
  const lookup = store.lookup(repo);
  const wantCommits: string[] = [];
  for (const oid of wants) {
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'commit') wantCommits.push(oid);
    else if (object.type === 'tag') {
      const peeled = peelToCommit(lookup, oid);
      if (peeled) wantCommits.push(peeled);
    }
  }
  const generation = new Map<string, number>();
  const queue: Array<[string, number]> = wantCommits.map((oid) => [oid, 0] as [string, number]);
  const included = new Set<string>();
  while (queue.length > 0) {
    const [oid, gen] = queue.shift() as [string, number];
    if (generation.has(oid)) continue;
    generation.set(oid, gen);
    if (gen >= depth) continue;
    included.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push([parent, gen + 1]);
    }
  }
  const haveSet = new Set<string>(haves);
  const shallow: string[] = [];
  for (const [oid, gen] of generation) {
    if (gen !== depth - 1) continue;
    const object = lookup(oid);
    if (object?.type !== 'commit') continue;
    if (parseCommit(object.data).parents.length === 0) continue;
    if (haveSet.has(oid)) continue;
    shallow.push(oid);
  }
  const ancestors = new Set<string>();
  const ancestorQueue = [...wantCommits];
  const ancestorSeen = new Set<string>();
  while (ancestorQueue.length > 0) {
    const oid = ancestorQueue.pop() as string;
    if (ancestorSeen.has(oid)) continue;
    ancestorSeen.add(oid);
    ancestors.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') ancestorQueue.push(...parseCommit(object.data).parents);
  }
  const unshallow: string[] = [];
  for (const boundary of clientShallow) {
    if (ancestors.has(boundary) && haveSet.has(boundary) && !shallow.includes(boundary)) unshallow.push(boundary);
  }
  return { shallow: shallow.sort(), unshallow: unshallow.sort() };
}

// ---------------------------------------------------------------------------------------------
// v2 upload-pack
// ---------------------------------------------------------------------------------------------

interface V2FetchRequest {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly depth: number | null;
}

function parseV2Fetch(packets: GitPacket[]): V2FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
  }
  return { wants, haves, shallow, depth };
}

function handleV2LsRefs(store: Store, repo: RepoState, packets: GitPacket[]): GitResponse {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const lines: string[] = [];
  for (const ref of advertisedRefs(store, repo)) {
    if (ref.unborn && !unborn) continue;
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    lines.push(`${refLineText(ref, { peel, symrefs })}\n`);
  }
  lines.push('flush');
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result' },
    body: encodePktLines(lines),
  };
}

function handleV2Fetch(store: Store, repo: RepoState, packets: GitPacket[]): GitResponse {
  const request = parseV2Fetch(packets);
  const lookup = store.lookup(repo);
  const acks: string[] = [];
  for (const have of request.haves) {
    if (lookup(have)) acks.push(`ACK ${have}\n`);
  }
  const plan = computeFetchPack(store, repo, request.wants, request.haves, request.depth, request.shallow);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  if (acks.length > 0) {
    for (const ack of acks) parts.push(encodePktLine(ack));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(pktLineDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(plan.sideband);
  parts.push(pktLineFlush());
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result' },
    body: Buffer.concat(parts),
  };
}

export function handleUploadPackV2(store: Store, repo: RepoState, ctx: GitRequestContext): GitResponse {
  let packets: GitPacket[];
  try {
    packets = decodePktLines(ctx.body).packets;
  } catch (err) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ message: `malformed pkt-line stream: ${(err as Error).message}` }), 'utf8'),
    };
  }
  let command = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('command=')) {
      command = line.slice('command='.length);
      break;
    }
  }
  if (command === 'ls-refs') return handleV2LsRefs(store, repo, packets);
  if (command === 'fetch') return handleV2Fetch(store, repo, packets);
  return {
    status: 400,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ message: `unsupported upload-pack command ${JSON.stringify(command)}` }), 'utf8'),
  };
}

// ---------------------------------------------------------------------------------------------
// v0 upload-pack
// ---------------------------------------------------------------------------------------------

export function handleUploadPackV0(store: Store, repo: RepoState, ctx: GitRequestContext): GitResponse {
  let packets: GitPacket[];
  try {
    packets = decodePktLines(ctx.body).packets;
  } catch (err) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ message: `malformed pkt-line stream: ${(err as Error).message}` }), 'utf8'),
    };
  }
  const wants: string[] = [];
  const haves: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line === 'done') break;
  }
  const lookup = store.lookup(repo);
  const acks: string[] = [];
  for (const have of haves) {
    if (lookup(have)) acks.push(`ACK ${have}\n`);
  }
  const plan = computeFetchPack(store, repo, wants, haves, null, []);
  const parts: Buffer[] = [];
  if (acks.length > 0) {
    for (const ack of acks) parts.push(encodePktLine(ack));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(plan.sideband);
  parts.push(pktLineFlush());
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result' },
    body: Buffer.concat(parts),
  };
}

// ---------------------------------------------------------------------------------------------
// v0 receive-pack
// ---------------------------------------------------------------------------------------------

interface RefUpdate {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

export function handleReceivePackV0(store: Store, repo: RepoState, ctx: GitRequestContext): GitResponse {
  let packets: GitPacket[];
  let packOffset = 0;
  try {
    const decoded = decodePktLines(ctx.body);
    packets = decoded.packets;
    packOffset = decoded.nextOffset;
  } catch (err) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ message: `malformed pkt-line stream: ${(err as Error).message}` }), 'utf8'),
    };
  }
  const updates: RefUpdate[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3 && isObjectId(parts[0] as string) && isObjectId(parts[1] as string)) {
      updates.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  }

  const report: string[] = [];
  const packBytes = ctx.body.subarray(packOffset);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const pack = readPack(packBytes, { resolveBase: store.lookup(repo) });
      const checksum = verifyPackChecksum(packBytes);
      if (!checksum.ok) throw new Error(`pack checksum mismatch: trailer ${checksum.actual} != computed ${checksum.expected}`);
      store.storePack(repo, pack.objects.values());
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }
  const lookup = store.lookup(repo);
  if (unpackError) {
    report.push(`unpack ${unpackError}\n`);
    for (const update of updates) report.push(`ng ${update.ref} unpack failed\n`);
  } else {
    report.push('unpack ok\n');
    for (const update of updates) {
      const result = applyRefUpdate(store, repo, update);
      report.push(result.ok ? `ok ${update.ref}\n` : `ng ${update.ref} ${result.reason}\n`);
    }
  }
  const body = Buffer.concat([sidebandText(report), pktLineFlush()]);
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-receive-pack-result' },
    body,
  };
}

function applyRefUpdate(
  store: Store,
  repo: RepoState,
  update: RefUpdate,
): { ok: true } | { ok: false; reason: string } {
  const { oldOid, newOid, ref } = update;
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
    return { ok: false, reason: 'invalid refname' };
  }
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (!current) return { ok: false, reason: 'ref does not exist' };
    if (oldOid !== ZERO_OID && oldOid !== current) return { ok: false, reason: 'stale info' };
    repo.refs.delete(ref);
    repo.version += 1;
    repo.packCache.clear();
    return { ok: true };
  }
  const object = store.lookup(repo)(newOid);
  if (!object) return { ok: false, reason: 'object not found' };
  if (ref.startsWith('refs/heads/') && object.type !== 'commit') {
    return { ok: false, reason: 'not a commit' };
  }
  if (!current) {
    if (oldOid !== ZERO_OID) return { ok: false, reason: 'stale info' };
    repo.refs.set(ref, newOid);
    repo.version += 1;
    repo.packCache.clear();
    return { ok: true };
  }
  if (oldOid !== current) return { ok: false, reason: 'stale info' };
  if (newOid === current) return { ok: true };
  if (!store.isAncestor(repo, current, newOid)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, newOid);
  repo.version += 1;
  repo.packCache.clear();
  return { ok: true };
}

export function hashObjectForTest(type: 'commit' | 'tree' | 'blob' | 'tag', data: Uint8Array): string {
  return hashObject(type, data);
}

export { parseTag as parseTagForTest };
