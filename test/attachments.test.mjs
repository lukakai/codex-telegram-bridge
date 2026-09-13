import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { incomingAttachment, imageKind, saveAttachment, describeExport, readExport } from '../src/attachments.mjs';

const TEST_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const JPEG = Buffer.from('ffd8ff', 'hex');
const WEBP = Buffer.from('524946460400000057454250', 'hex');
const document = (overrides = {}) => ({ file_id: 'opaque-id', file_name: 'report.txt', ...overrides });
const photo = (overrides = {}) => ({ file_id: 'photo-id', width: 10, height: 10, ...overrides });
const descriptor = (overrides = {}) => ({ fileId: 'opaque-id', originalName: 'report.txt', image: false, ...overrides });

// Only new, synthetic fixtures in this test directory are accessed. Intentionally
// retain them: neither production failures nor tests invoke recursive deletion or
// a cleanup shim that might follow a replaced path. No real state/config is read.
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(TEST_DIRECTORY, '.fixture-attachments-')));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd, { mode: 0o700 });
  const config = { projects: [{ id: 'synthetic', cwd }], protectedPaths: [] };
  const thread = { id: 'synthetic-thread', cwd };
  return { root, cwd, config, thread,
    file(name, bytes = Buffer.from('synthetic content')) {
      const target = path.join(cwd, name);
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      return target;
    },
    dir(name) {
      const target = path.join(cwd, name);
      fs.mkdirSync(target, { mode: 0o700 });
      return target;
    },
  };
}

function forbiddenCall(t, name) {
  const mocked = t.mock.method(fs, name, () => assert.fail(`${name} must not be called`));
  t.after(() => assert.equal(mocked.mock.callCount(), 0, `${name} must not be called`));
}

function noReads(t) {
  forbiddenCall(t, 'readSync');
  forbiddenCall(t, 'readFileSync');
}

function setDifferentMtime(target, milliseconds) {
  fs.utimesSync(target, new Date(milliseconds + 10_000), new Date(milliseconds + 10_000));
}

test('ordinary messages have no attachment; albums and malformed messages fail closed', () => {
  assert.equal(incomingAttachment({ text: 'hello' }), null);
  for (const message of [null, [], 'text', { media_group_id: 'album' },
    { media_group_id: undefined }, { photo: [] }, { photo: null }, { document: [] },
    { document: null }, { photo: [photo()], document: document() }]) {
    assert.throws(() => incomingAttachment(message));
  }
});

test('largest photo uses area, byte-size tie-break, and stable first-entry ties', () => {
  const message = { photo: [
    photo({ file_id: 'small', width: 2, height: 2, file_size: 1000 }),
    photo({ file_id: 'large', width: 40, height: 30, file_size: 20 }),
    photo({ file_id: 'medium', width: 20, height: 20, file_size: 30 }),
    photo({ file_id: 'large-tie', width: 30, height: 40, file_size: 21 }),
    photo({ file_id: 'last-tie', width: 30, height: 40, file_size: 21 }),
  ] };
  assert.deepEqual(incomingAttachment(message), {
    fileId: 'large-tie', size: 21, originalName: 'photo.jpg', image: true,
  });
  assert.equal(incomingAttachment({ photo: [photo({ width: Number.MAX_SAFE_INTEGER,
    height: Number.MAX_SAFE_INTEGER })] }).fileId, 'photo-id');
});

test('all photo variants and document metadata are validated', () => {
  for (const file_size of [-1, 20_000_001, 1.5, NaN, Infinity, '1', null, undefined]) {
    assert.throws(() => incomingAttachment({ document: document({ file_size }) }));
    assert.throws(() => incomingAttachment({ photo: [photo(), photo({ width: 1, height: 1, file_size })] }));
  }
  for (const width of [0, -1, 1.5, NaN, Infinity, '10', undefined]) {
    assert.throws(() => incomingAttachment({ photo: [photo({ width })] }));
  }
  for (const height of [0, -1, null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => incomingAttachment({ photo: [photo({ height })] }));
  }
  for (const file_id of ['', 'with space', 'line\nfeed', 'bidi\u202eid', 123, null]) {
    assert.throws(() => incomingAttachment({ document: document({ file_id }) }));
  }
  for (const mime_type of ['', 'image', 'image/png\nX: bad', 'text/html; charset=utf-8', null, 5]) {
    assert.throws(() => incomingAttachment({ document: document({ mime_type }) }));
  }
  for (const file_name of ['', null, 12, {}]) {
    assert.throws(() => incomingAttachment({ document: document({ file_name }) }));
  }
  assert.equal(incomingAttachment({ document: document({ file_size: 20_000_000 }) }).size, 20_000_000);
  assert.equal(incomingAttachment({ document: { file_id: 'no-name' } }).originalName, 'document');
});

test('incoming document names strip paths, controls and bidi, and have a 120-code-unit cap', () => {
  const incoming = incomingAttachment({ document: document({
    file_name: '../../folder\\AGENTS.md\u0000\n\u202e\u2066\u2028', mime_type: 'IMAGE/PNG',
  }) });
  assert.equal(incoming.originalName, 'AGENTS.md');
  assert.equal(incoming.mime, 'image/png');
  assert.equal(incoming.image, false);
  const long = incomingAttachment({ document: document({ file_name: 'x'.repeat(119) + '\u{10400}.txt' }) });
  assert.equal(long.originalName.length, 119);
  assert.equal(incomingAttachment({ document: document({ file_name: '\u202e\u0000' }) }).originalName, 'document');
});

test('image magic accepts only exact PNG, JPEG and WEBP signatures, without decoding', () => {
  for (const [bytes, extension, mime] of [[PNG, 'png', 'image/png'], [JPEG, 'jpg', 'image/jpeg'],
    [WEBP, 'webp', 'image/webp']]) {
    assert.deepEqual(imageKind(bytes), { extension, mime });
    assert.equal(imageKind(bytes.subarray(0, bytes.length - 1)), null);
  }
  const highBitWebp = Buffer.from(WEBP);
  for (const index of [0, 1, 2, 3, 8, 9, 10, 11]) highBitWebp[index] |= 0x80;
  for (const bytes of [null, new Uint8Array(PNG), Buffer.alloc(0), highBitWebp,
    Buffer.from('GIF89a'), Buffer.from('<svg></svg>'), Buffer.from('%PDF-1.7'),
    Buffer.from('524946460400000057415645', 'hex'), Buffer.from('89504e470d0a1a00', 'hex')]) {
    assert.equal(imageKind(bytes), null);
  }
});

test('invalid upload bytes, metadata and photo magic are rejected before mkdir', t => {
  const f = fixture();
  forbiddenCall(t, 'mkdirSync');
  for (const bytes of [null, 'data', new Uint8Array(3), Buffer.alloc(0), Buffer.alloc(20_000_001)]) {
    assert.throws(() => saveAttachment(f.config, f.thread, descriptor(), bytes));
  }
  for (const value of [null, descriptor({ image: 'yes' }), descriptor({ fileId: '' }),
    descriptor({ originalName: null }), descriptor({ size: 20_000_001 }),
    descriptor({ size: NaN }), descriptor({ mime: 'image/png\r\n' })]) {
    assert.throws(() => saveAttachment(f.config, f.thread, value, PNG));
  }
  assert.throws(() => saveAttachment(f.config, f.thread, descriptor({ image: true }), Buffer.from('not an image')));
});

test('uploads use private randomized directories and never the original instruction-bearing stem', () => {
  const f = fixture();
  const incoming = incomingAttachment({ document: document({
    file_name: '../../AGENTS.md\u202e\n', mime_type: 'image/png',
  }) });
  const first = saveAttachment(f.config, f.thread, incoming, PNG);
  const second = saveAttachment(f.config, f.thread, incoming, PNG);
  assert.notEqual(first.path, second.path);
  assert.equal(path.dirname(path.dirname(first.path)), f.cwd);
  assert.match(path.basename(path.dirname(first.path)), /^\.tg-upload-[a-f0-9]{32}$/);
  assert.equal(path.basename(first.path), 'received.md');
  assert.equal(first.originalName, 'AGENTS.md');
  assert.equal(first.image, false);
  assert.equal(first.mime, 'application/octet-stream');
  assert.equal(first.size, PNG.length);
  assert.equal(fs.statSync(path.dirname(first.path)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(first.path), PNG);
  assert.equal(fs.existsSync(path.join(f.cwd, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(f.cwd, 'state')), false);
});

for (const [bytes, extension, mime] of [[PNG, 'png', 'image/png'], [JPEG, 'jpg', 'image/jpeg'],
  [WEBP, 'webp', 'image/webp']]) {
  test(`photo upload uses ${extension} magic rather than filename or declared MIME`, () => {
    const f = fixture();
    const result = saveAttachment(f.config, f.thread,
      descriptor({ image: true, originalName: 'spoof.exe', mime: 'text/plain' }), bytes);
    assert.equal(path.basename(result.path), `received.${extension}`);
    assert.equal(result.image, true);
    assert.equal(result.mime, mime);
  });
}

test('document extensions are limited to safe short alphanumerics', () => {
  const f = fixture();
  for (const [name, extension] of [['report.PDF', 'pdf'], ['payload.sh;run', 'bin'],
    ['file.verylongextension', 'bin'], ['.env', 'bin'], ['README', 'bin']]) {
    const result = saveAttachment(f.config, f.thread, descriptor({ originalName: name }), Buffer.from('opaque'));
    assert.equal(path.basename(result.path), `received.${extension}`);
    assert.equal(result.image, false);
  }
});

test('nested selected cwd, not the broader grant, is the attachment boundary', () => {
  const f = fixture();
  const nested = f.dir('nested');
  f.file('sibling.txt');
  fs.writeFileSync(path.join(nested, 'inside.txt'), 'inside', { flag: 'wx' });
  f.thread.cwd = nested;
  const result = saveAttachment(f.config, f.thread, descriptor(), Buffer.from('upload'));
  assert.equal(path.dirname(path.dirname(result.path)), nested);
  const proposal = describeExport(f.config, f.thread, 'inside.txt');
  assert.equal(proposal.cwd, nested);
  assert.equal(readExport(f.config, f.thread, proposal).bytes.toString(), 'inside');
  for (const value of ['../sibling.txt', path.join(f.cwd, 'sibling.txt')]) {
    assert.throws(() => describeExport(f.config, f.thread, value));
  }
});

test('allowedThread canonical selected cwd is used rather than a lexical alias', () => {
  const f = fixture();
  const nested = f.dir('nested');
  const alias = path.join(f.root, 'selected-alias');
  fs.symlinkSync(nested, alias, 'dir');
  f.thread.cwd = alias;
  const result = saveAttachment(f.config, f.thread, descriptor(), Buffer.from('upload'));
  assert.equal(path.dirname(path.dirname(result.path)), nested);
  fs.writeFileSync(path.join(nested, 'report.txt'), 'synthetic', { flag: 'wx' });
  assert.equal(describeExport(f.config, f.thread, 'report.txt').cwd, nested);
});

test('unauthorized and protected cwd fail without creating upload directories', t => {
  const f = fixture();
  const elsewhere = path.join(f.root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  forbiddenCall(t, 'mkdirSync');
  assert.throws(() => saveAttachment(f.config, { ...f.thread, cwd: elsewhere }, descriptor(), PNG));
  f.config.protectedPaths.push(f.cwd);
  assert.throws(() => saveAttachment(f.config, f.thread, descriptor(), PNG), { code: 'DIRECTORY_PROTECTED' });
});

test('upload directory collisions neither overwrite nor remove existing content', t => {
  const f = fixture();
  const random = Buffer.alloc(16, 7);
  const destination = f.dir(`.tg-upload-${random.toString('hex')}`);
  const existing = path.join(destination, 'received.txt');
  fs.writeFileSync(existing, 'keep', { flag: 'wx' });
  t.mock.method(crypto, 'randomBytes', () => random);
  assert.throws(() => saveAttachment(f.config, f.thread, descriptor(), Buffer.from('replace')), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep');
});

for (const symlink of [false, true]) {
  test(`upload target creation is exclusive and no-follow (${symlink ? 'symlink' : 'existing file'})`, t => {
    const f = fixture();
    const existing = f.file('existing.txt', 'keep');
    const open = fs.openSync;
    let target;
    t.mock.method(fs, 'openSync', (name, flags, mode) => {
      if (path.basename(String(name)) === 'received.txt') {
        target = name;
        assert.ok(flags & fs.constants.O_EXCL);
        assert.ok(flags & fs.constants.O_NOFOLLOW);
        assert.equal(mode, 0o600);
        if (symlink) fs.symlinkSync(existing, name);
        else fs.writeFileSync(name, 'do not overwrite', { flag: 'wx' });
      }
      return open(name, flags, mode);
    });
    // Use the original open inside fixture injection to avoid intercepting itself.
    const writeFile = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (name, content) => {
      const fd = open(name, 'wx', 0o600);
      try { writeFile(fd, content); } finally { fs.closeSync(fd); }
    });
    assert.throws(() => saveAttachment(f.config, f.thread, descriptor(), Buffer.from('new')));
    assert.equal(fs.readFileSync(existing, 'utf8'), 'keep');
    assert.ok(fs.lstatSync(target));
  });
}

test('cwd replacement during mkdir is rejected and artifacts are retained', t => {
  const f = fixture();
  const mkdir = fs.mkdirSync;
  let destination;
  t.mock.method(fs, 'mkdirSync', (name, options) => {
    if (path.basename(String(name)).startsWith('.tg-upload-')) {
      destination = name;
      fs.renameSync(f.cwd, path.join(f.root, 'original-project'));
      mkdir(f.cwd, { mode: 0o700 });
    }
    return mkdir(name, options);
  });
  assert.throws(() => saveAttachment(f.config, f.thread, descriptor(), PNG));
  assert.ok(fs.statSync(destination).isDirectory());
  assert.deepEqual(fs.readdirSync(destination), []);
});

for (const replacement of ['directory', 'symlink', 'file-symlink']) {
  test(`upload detects ${replacement} replacement before writing`, t => {
    const f = fixture();
    const victim = f.file('keep.txt', 'keep');
    const open = fs.openSync;
    let retained;
    t.mock.method(fs, 'openSync', (name, flags, mode) => {
      const fd = open(name, flags, mode);
      if (path.basename(String(name)) === 'received.txt') {
        if (replacement === 'file-symlink') {
          retained = `${name}.retained`;
          fs.renameSync(name, retained);
          fs.symlinkSync(victim, name);
        } else {
          const directory = path.dirname(name);
          const moved = `${directory}-retained`;
          fs.renameSync(directory, moved);
          retained = path.join(moved, 'received.txt');
          if (replacement === 'symlink') fs.symlinkSync(moved, directory, 'dir');
          else fs.mkdirSync(directory, { mode: 0o700 });
        }
      }
      return fd;
    });
    forbiddenCall(t, 'writeSync');
    assert.throws(() => saveAttachment(f.config, f.thread, descriptor(), PNG));
    assert.equal(fs.statSync(retained).size, 0);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  });
}

for (const mutation of ['directory', 'permissions', 'hardlink', 'file']) {
  test(`upload revalidates after writing: ${mutation}`, t => {
    const f = fixture();
    const open = fs.openSync;
    const write = fs.writeSync;
    let target;
    let mutated = false;
    t.mock.method(fs, 'openSync', (name, flags, mode) => {
      if (path.basename(String(name)) === 'received.txt') target = name;
      return open(name, flags, mode);
    });
    t.mock.method(fs, 'writeSync', (fd, bytes, offset, length, position) => {
      const count = write(fd, bytes, offset, length, position);
      if (!mutated) {
        mutated = true;
        if (mutation === 'directory') {
          const directory = path.dirname(target);
          fs.renameSync(directory, `${directory}-retained`);
          fs.mkdirSync(directory, { mode: 0o700 });
        } else if (mutation === 'permissions') fs.chmodSync(path.dirname(target), 0o755);
        else if (mutation === 'hardlink') fs.linkSync(target, path.join(f.cwd, 'linked.txt'));
        else {
          fs.renameSync(target, `${target}.retained`);
          const other = open(target, 'wx', 0o600);
          try { write(other, Buffer.from('replacement')); } finally { fs.closeSync(other); }
        }
      }
      return count;
    });
    assert.throws(() => saveAttachment(f.config, f.thread, descriptor(), PNG));
    assert.equal(mutated, true);
  });
}

test('partial upload writes make bounded progress; zero progress fails without cleanup', t => {
  const f = fixture();
  const write = fs.writeSync;
  t.mock.method(fs, 'writeSync', (fd, bytes, offset, length, position) =>
    write(fd, bytes, offset, Math.min(length, 2), position));
  const result = saveAttachment(f.config, f.thread, descriptor(), PNG);
  assert.deepEqual(fs.readFileSync(result.path), PNG);
  t.mock.restoreAll();
  for (const name of ['unlinkSync', 'rmSync', 'rmdirSync']) {
    forbiddenCall(t, name);
  }
  t.mock.method(fs, 'writeSync', () => 0);
  assert.throws(() => saveAttachment(f.config, f.thread, descriptor(), PNG));
  assert.equal(fs.readdirSync(f.cwd).filter(name => name.startsWith('.tg-upload-')).length, 2);
});

test('describeExport gathers metadata only and returns the complete proposal contract', t => {
  const f = fixture();
  const target = f.file('report.bin', PNG);
  const stat = fs.statSync(target);
  const cwdStat = fs.statSync(f.cwd);
  const open = fs.openSync;
  noReads(t);
  t.mock.method(fs, 'openSync', (name, flags, mode) => {
    assert.notEqual(name, target, 'The proposed file must not be opened');
    assert.ok(flags & fs.constants.O_DIRECTORY);
    return open(name, flags, mode);
  });
  assert.deepEqual(describeExport(f.config, f.thread, './report.bin'), {
    path: target, name: 'report.bin', size: PNG.length, dev: stat.dev, ino: stat.ino,
    mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    cwd: f.cwd, cwdDev: cwdStat.dev, cwdIno: cwdStat.ino,
  });
});

test('exports reject traversal, URIs, controls and lexical escapes without reading bytes', t => {
  const f = fixture();
  const sibling = path.join(f.root, 'project-other');
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'report.txt'), 'synthetic', { flag: 'wx' });
  noReads(t);
  for (const userPath of ['', null, 42, '.', '..', '../project-other/report.txt',
    'nested/../report.txt', 'nested\\..\\report.txt', 'file:///synthetic/report.txt',
    'https://invalid.test/report.txt', 'C:\\synthetic\\report.txt', 'report\u0000.txt',
    'report\n.txt', 'report\u202e.txt', 'report\u2066.txt', 'report\u2028.txt',
    path.join(sibling, 'report.txt'), path.join(f.root, 'outside.txt')]) {
    assert.throws(() => describeExport(f.config, f.thread, userPath), String(userPath));
  }
});

test('hidden and sensitive names are denied case-insensitively at every relative component', t => {
  const f = fixture();
  noReads(t);
  for (const name of ['.env', '.env.local', '.git/config', '.npmrc', '.hidden/report.txt',
    'nested/.file', 'auth', 'AUTH.json', 'oauth.json', 'credentials.json', 'credential.txt',
    'access_token.txt', 'token/report.txt', 'secrets.json', 'my-secret.txt', 'private_key',
    'private-key.txt', 'id_rsa', 'id_ed25519.pub', 'certificate.PEM', 'server.KEY',
    'bundle.p12', 'bundle.PFX', 'keys.pem/report.txt']) {
    assert.throws(() => describeExport(f.config, f.thread, name), /Hidden or sensitive/, name);
  }
});

test('symlinks in final and intermediate components, including dangling links, are denied', t => {
  const f = fixture();
  f.dir('nested');
  const target = f.file('nested/report.txt');
  fs.symlinkSync(target, path.join(f.cwd, 'link.txt'));
  fs.symlinkSync(path.dirname(target), path.join(f.cwd, 'linked-dir'), 'dir');
  fs.symlinkSync(path.join(f.cwd, 'missing'), path.join(f.cwd, 'dangling'));
  noReads(t);
  for (const name of ['link.txt', 'linked-dir/report.txt', 'dangling']) {
    assert.throws(() => describeExport(f.config, f.thread, name), /Symlink/);
  }
});

test('hardlinks, empty files, directories, and oversized exports are denied', t => {
  const f = fixture();
  const original = f.file('original.bin');
  fs.linkSync(original, path.join(f.cwd, 'hardlink.bin'));
  f.file('empty.bin', Buffer.alloc(0));
  f.dir('directory');
  const large = f.file('large.bin');
  const fd = fs.openSync(large, 'r+');
  try { fs.ftruncateSync(fd, 50_000_001); } finally { fs.closeSync(fd); }
  noReads(t);
  for (const name of ['original.bin', 'hardlink.bin', 'empty.bin', 'directory', 'large.bin']) {
    assert.throws(() => describeExport(f.config, f.thread, name), /regular/);
  }
});

test('protected lexical paths and protected canonical paths are both checked', t => {
  const f = fixture();
  const target = f.file('report.txt');
  const protectedDirectory = f.dir('vault');
  const protectedTarget = f.file('vault/record.txt');
  f.config.protectedPaths = [protectedDirectory.toUpperCase()];
  noReads(t);
  assert.throws(() => describeExport(f.config, f.thread, protectedTarget), { code: 'DIRECTORY_PROTECTED' });
  const realpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', (name, options) =>
    name === target ? protectedTarget : realpath(name, options));
  assert.throws(() => describeExport(f.config, f.thread, target), { code: 'DIRECTORY_PROTECTED' });
});

test('confirmed exports use bounded positioned fd reads and magic-based MIME', t => {
  const f = fixture();
  const target = f.file('misleading.txt', WEBP);
  const proposal = describeExport(f.config, f.thread, target);
  const open = fs.openSync;
  const read = fs.readSync;
  let fileDescriptor;
  let total = 0;
  const positions = [];
  t.mock.method(fs, 'readFileSync', () => assert.fail('Unbounded reads are forbidden'));
  t.mock.method(fs, 'openSync', (name, flags, mode) => {
    if (name === target) {
      assert.ok(flags & fs.constants.O_NOFOLLOW);
      assert.ok(flags & fs.constants.O_NONBLOCK);
      assert.equal(flags & (fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_RDWR), 0);
    }
    const fd = open(name, flags, mode);
    if (name === target) fileDescriptor = fd;
    return fd;
  });
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    assert.equal(fd, fileDescriptor);
    assert.ok(position >= 0 && position <= proposal.size);
    assert.ok(length <= (position === proposal.size ? 1 : proposal.size - position));
    positions.push(position);
    const count = read(fd, buffer, offset, Math.min(length, 2), position);
    total += count;
    return count;
  });
  const result = readExport(f.config, f.thread, proposal);
  assert.deepEqual(result, { bytes: WEBP, name: 'misleading.txt', mime: 'image/webp' });
  assert.equal(total, proposal.size);
  assert.deepEqual(positions, [0, 2, 4, 6, 8, 10, 12]);
});

for (const [bytes, mime] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'],
  [Buffer.from('<svg>opaque</svg>'), 'application/octet-stream']]) {
  test(`export MIME is ${mime} based on magic, not extension`, () => {
    const f = fixture();
    const target = f.file('claimed.png', bytes);
    assert.equal(readExport(f.config, f.thread, describeExport(f.config, f.thread, target)).mime, mime);
  });
}

test('exactly 50 MB export is accepted and read with a bounded buffer', () => {
  const f = fixture();
  const target = f.file('boundary.bin');
  const fd = fs.openSync(target, 'r+');
  try { fs.ftruncateSync(fd, 50_000_000); } finally { fs.closeSync(fd); }
  const proposal = describeExport(f.config, f.thread, target);
  assert.equal(proposal.size, 50_000_000);
  const result = readExport(f.config, f.thread, proposal);
  assert.equal(result.bytes.length, 50_000_000);
  assert.equal(result.bytes.at(-1), 0);
});

test('every proposal field is compared, including name, ctime and cwd identity', t => {
  const f = fixture();
  const target = f.file('report.txt');
  const proposal = describeExport(f.config, f.thread, target);
  noReads(t);
  for (const [field, value] of Object.entries(proposal)) {
    const altered = { ...proposal, [field]: typeof value === 'number' ? value + 1 : `${value}-changed` };
    assert.throws(() => readExport(f.config, f.thread, altered), field);
    const missing = { ...proposal };
    delete missing[field];
    assert.throws(() => readExport(f.config, f.thread, missing), `missing ${field}`);
  }
  for (const value of [null, [], {}, 'proposal']) assert.throws(() => readExport(f.config, f.thread, value));
});

for (const mutation of ['contents', 'inode', 'cwd-inode', 'selected-cwd', 'authorization']) {
  test(`stale export confirmation is rejected before reading: ${mutation}`, t => {
    const f = fixture();
    const target = f.file('report.txt', 'original');
    const proposal = describeExport(f.config, f.thread, target);
    if (mutation === 'contents') {
      fs.writeFileSync(target, 'modified');
      setDifferentMtime(target, proposal.mtimeMs);
    } else if (mutation === 'inode') {
      fs.renameSync(target, `${target}.retained`);
      fs.writeFileSync(target, 'original', { flag: 'wx' });
      fs.utimesSync(target, new Date(proposal.mtimeMs), new Date(proposal.mtimeMs));
    } else if (mutation === 'cwd-inode') {
      fs.renameSync(f.cwd, `${f.cwd}-retained`);
      fs.mkdirSync(f.cwd);
      fs.writeFileSync(target, 'original', { flag: 'wx' });
    } else if (mutation === 'selected-cwd') {
      const other = f.dir('other');
      fs.writeFileSync(path.join(other, 'report.txt'), 'original', { flag: 'wx' });
      f.thread.cwd = other;
    } else f.config.projects = [];
    noReads(t);
    assert.throws(() => readExport(f.config, f.thread, proposal));
  });
}

test('ctime-only change invalidates an export even if mtime and size are identical', t => {
  const f = fixture();
  const target = f.file('report.txt');
  const proposal = describeExport(f.config, f.thread, target);
  const lstat = fs.lstatSync;
  noReads(t);
  t.mock.method(fs, 'lstatSync', (name, options) => {
    const stat = lstat(name, options);
    if (name === target) stat.ctimeMs += 1;
    return stat;
  });
  assert.throws(() => readExport(f.config, f.thread, proposal), /changed/);
});

test('change between metadata validation and file open is caught by fstat before reading', t => {
  const f = fixture();
  const target = f.file('report.txt', 'original');
  const proposal = describeExport(f.config, f.thread, target);
  const open = fs.openSync;
  noReads(t);
  t.mock.method(fs, 'openSync', (name, flags, mode) => {
    if (name === target) setDifferentMtime(target, proposal.mtimeMs);
    return open(name, flags, mode);
  });
  assert.throws(() => readExport(f.config, f.thread, proposal), /changed/);
});

for (const mutation of ['growth', 'truncation', 'mtime', 'path', 'parent-symlink', 'hardlink', 'cwd']) {
  test(`export changes during fd reading fail closed: ${mutation}`, t => {
    const f = fixture();
    const nested = f.dir('nested');
    const target = f.file('nested/report.txt', 'original bytes');
    const proposal = describeExport(f.config, f.thread, target);
    const read = fs.readSync;
    let mutated = false;
    t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
      const count = read(fd, buffer, offset, Math.min(length, 2), position);
      if (!mutated) {
        mutated = true;
        if (mutation === 'growth') fs.appendFileSync(target, 'extra');
        else if (mutation === 'truncation') fs.truncateSync(target, 1);
        else if (mutation === 'mtime') setDifferentMtime(target, proposal.mtimeMs);
        else if (mutation === 'path') {
          fs.renameSync(target, `${target}.retained`);
          fs.writeFileSync(target, 'original bytes', { flag: 'wx' });
        } else if (mutation === 'parent-symlink') {
          fs.renameSync(nested, `${nested}-retained`);
          fs.symlinkSync(`${nested}-retained`, nested, 'dir');
        } else if (mutation === 'hardlink') fs.linkSync(target, path.join(f.cwd, 'hardlink.txt'));
        else {
          fs.renameSync(f.cwd, `${f.cwd}-retained`);
          fs.mkdirSync(f.cwd);
        }
      }
      return count;
    });
    assert.throws(() => readExport(f.config, f.thread, proposal));
    assert.equal(mutated, true);
  });
}

test('final fstat after path checks is compared as well', t => {
  const f = fixture();
  const target = f.file('report.txt');
  const proposal = describeExport(f.config, f.thread, target);
  const fstat = fs.fstatSync;
  let checks = 0;
  t.mock.method(fs, 'fstatSync', (fd, options) => {
    const stat = fstat(fd, options);
    if (stat.isFile() && ++checks === 3) stat.ctimeMs += 1;
    return stat;
  });
  assert.throws(() => readExport(f.config, f.thread, proposal), /changed/);
  assert.equal(checks, 3);
});

test('file and directory descriptors are closed on success and failure', t => {
  const f = fixture();
  const target = f.file('report.txt');
  const open = fs.openSync;
  const close = fs.closeSync;
  const opened = new Set();
  t.mock.method(fs, 'openSync', (...args) => {
    const fd = open(...args);
    opened.add(fd);
    return fd;
  });
  t.mock.method(fs, 'closeSync', fd => {
    const result = close(fd);
    assert.equal(opened.delete(fd), true);
    return result;
  });
  const proposal = describeExport(f.config, f.thread, target);
  assert.equal(opened.size, 0);
  readExport(f.config, f.thread, proposal);
  assert.equal(opened.size, 0);
  saveAttachment(f.config, f.thread, descriptor(), PNG);
  assert.equal(opened.size, 0);
  t.mock.method(fs, 'readSync', () => 0);
  assert.throws(() => readExport(f.config, f.thread, proposal));
  assert.equal(opened.size, 0);
  t.mock.method(fs, 'writeSync', () => 0);
  assert.throws(() => saveAttachment(f.config, f.thread, descriptor(), PNG));
  assert.equal(opened.size, 0);
});
