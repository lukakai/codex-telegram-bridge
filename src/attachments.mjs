import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { allowedThread, assertUnprotected, within } from './util.mjs';

const UPLOAD_LIMIT = 20_000_000;
const EXPORT_LIMIT = 50_000_000;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
const STRIP_UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu;
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const FILE_FIELDS = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'];
const PROPOSAL_FIELDS = ['path', 'name', ...FILE_FIELDS, 'cwd', 'cwdDev', 'cwdIno'];
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY
  | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const own = (value, key) => Object.hasOwn(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function changed() {
  throw new Error('File or directory changed; request fresh confirmation.');
}

function originalName(value, fallback) {
  const leaf = value.replace(STRIP_UNSAFE_TEXT, '').split(/[\\/]/).at(-1).trim();
  let name = '';
  for (const character of leaf) {
    if (name.length + character.length > 120) break;
    name += character;
  }
  return !name || name === '.' || name === '..' ? fallback : name;
}

function declaredSize(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > UPLOAD_LIMIT) {
    throw new Error('Invalid attachment size or declared size exceeds 20 MB.');
  }
  return value;
}

function declaredMime(value) {
  if (typeof value !== 'string' || value.length > 255 || !MIME.test(value)) {
    throw new Error('Invalid attachment MIME metadata.');
  }
  return value.toLowerCase();
}

function fileId(value) {
  if (typeof value !== 'string' || !value || /\s/u.test(value) || UNSAFE_TEXT.test(value)) {
    throw new Error('Invalid attachment file ID.');
  }
  return value;
}

function mediaMetadata(media) {
  if (!record(media)) throw new Error('Invalid attachment metadata.');
  const result = { fileId: fileId(media.file_id) };
  if (own(media, 'file_size')) result.size = declaredSize(media.file_size);
  if (own(media, 'mime_type')) result.mime = declaredMime(media.mime_type);
  return result;
}

// Ordinary messages have no attachment. Photo selection is by pixel area, then
// declared byte size; a complete tie keeps the first entry, independent of sort.
export function incomingAttachment(message) {
  if (!record(message)) throw new Error('Invalid message metadata.');
  if (own(message, 'media_group_id')) throw new Error('Albums are not supported.');
  const photo = own(message, 'photo');
  const document = own(message, 'document');
  if (photo && document) throw new Error('Ambiguous attachment metadata.');
  if (photo) {
    if (!Array.isArray(message.photo) || message.photo.length === 0) {
      throw new Error('Invalid photo metadata.');
    }
    let best;
    for (const entry of message.photo) {
      const metadata = mediaMetadata(entry);
      if (!Number.isSafeInteger(entry.width) || entry.width <= 0
          || !Number.isSafeInteger(entry.height) || entry.height <= 0) {
        throw new Error('Invalid photo dimensions.');
      }
      const area = BigInt(entry.width) * BigInt(entry.height);
      if (!best || area > best.area
          || area === best.area && (metadata.size ?? -1) > (best.metadata.size ?? -1)) {
        best = { area, metadata };
      }
    }
    return { ...best.metadata, originalName: 'photo.jpg', image: true };
  }
  if (document) {
    const metadata = mediaMetadata(message.document);
    const name = message.document.file_name;
    if (own(message.document, 'file_name') && (typeof name !== 'string' || !name)) {
      throw new Error('Invalid attachment filename metadata.');
    }
    return { ...metadata, originalName: originalName(name ?? 'document', 'document'), image: false };
  }
  return null;
}

// Signature sniffing only, NOT decoding or an assertion that the image is valid.
export function imageKind(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { extension: 'png', mime: 'image/png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: 'jpg', mime: 'image/jpeg' };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF'))
      && bytes.subarray(8, 12).equals(Buffer.from('WEBP'))) {
    return { extension: 'webp', mime: 'image/webp' };
  }
  return null;
}

function identity(stat) {
  if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino)) {
    throw new Error('Filesystem identity cannot be represented exactly.');
  }
  return stat;
}

function sameIdentity(a, b) {
  if (a.dev !== b.dev || a.ino !== b.ino) changed();
}

function sameFields(a, b, fields = FILE_FIELDS) {
  if (fields.some(field => a[field] !== b[field])) changed();
}

function directoryStat(directory) {
  const before = identity(fs.lstatSync(directory));
  if (!before.isDirectory() || before.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    throw new Error('Directory must remain canonical and must not be a symlink.');
  }
  const after = identity(fs.lstatSync(directory));
  if (!after.isDirectory() || after.isSymbolicLink()) changed();
  sameIdentity(before, after);
  return after;
}

function checkDirectory(pin) {
  const opened = identity(fs.fstatSync(pin.fd));
  if (!opened.isDirectory()) changed();
  sameIdentity(pin, opened);
  sameIdentity(pin, directoryStat(pin.path));
}

function pinDirectory(directory) {
  const stat = directoryStat(directory);
  const fd = fs.openSync(directory, DIRECTORY_FLAGS);
  const pin = { path: directory, dev: stat.dev, ino: stat.ino, fd };
  try {
    checkDirectory(pin);
    return pin;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function checkCwd(config, thread, pin) {
  if (allowedThread(config, thread) !== pin.path) changed();
  checkDirectory(pin);
}

function regularFile(stat, limit, allowEmpty = false) {
  identity(stat);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || !Number.isSafeInteger(stat.size) || stat.size < (allowEmpty ? 0 : 1)
      || stat.size > limit || !Number.isFinite(stat.mtimeMs) || !Number.isFinite(stat.ctimeMs)) {
    throw new Error('File must be regular, unlinked elsewhere, nonempty, and within the size limit.');
  }
  return stat;
}

function uploadPath(config, thread, cwd, directory, target) {
  checkCwd(config, thread, cwd);
  checkDirectory(directory);
  if (directory.dev !== cwd.dev || path.dirname(directory.path) !== cwd.path
      || path.dirname(target) !== directory.path || !within(cwd.path, target)
      || (fs.fstatSync(directory.fd).mode & 0o777) !== 0o700) changed();
  assertUnprotected(config, target);
}

function uploadedFile(target, expected) {
  const actual = regularFile(fs.lstatSync(target), UPLOAD_LIMIT, true);
  if (fs.realpathSync(target) !== target) changed();
  sameFields(actual, expected);
  if ((actual.mode & 0o777) !== 0o600) changed();
}

// These checks pin open descriptors and revalidate paths, but Node's path-based
// APIs cannot make this raceproof against a hostile same-user process. Such a
// process can race between checks (or mutate bytes without detectable metadata).
// Use OS isolation for that threat model. Failures deliberately leave artifacts;
// never delete a path that could have been replaced by another process.
export function saveAttachment(config, thread, descriptor, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > UPLOAD_LIMIT) {
    throw new Error('Attachment bytes must be a nonempty Buffer of at most 20 MB.');
  }
  if (!record(descriptor) || typeof descriptor.image !== 'boolean'
      || typeof descriptor.originalName !== 'string' || !descriptor.originalName) {
    throw new Error('Invalid attachment descriptor.');
  }
  fileId(descriptor.fileId);
  if (own(descriptor, 'size')) declaredSize(descriptor.size);
  if (own(descriptor, 'mime')) declaredMime(descriptor.mime);
  const name = originalName(descriptor.originalName, 'attachment');
  const kind = descriptor.image ? imageKind(bytes) : null;
  if (descriptor.image && !kind) throw new Error('Photos must have PNG, JPEG, or WEBP magic.');
  const suffix = path.extname(name).slice(1).toLowerCase();
  const extension = kind?.extension ?? (/^[a-z0-9]{1,10}$/.test(suffix) ? suffix : 'bin');
  const cwd = pinDirectory(allowedThread(config, thread));
  let directory;
  let fd;
  try {
    checkCwd(config, thread, cwd);
    const destination = path.join(cwd.path, `.tg-upload-${crypto.randomBytes(16).toString('hex')}`);
    assertUnprotected(config, destination);
    checkCwd(config, thread, cwd);
    fs.mkdirSync(destination, { mode: 0o700 });
    checkCwd(config, thread, cwd);
    directory = pinDirectory(destination);
    fs.fchmodSync(directory.fd, 0o700);
    const target = path.join(destination, `received.${extension}`);
    uploadPath(config, thread, cwd, directory, target);
    fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT
      | fs.constants.O_NOFOLLOW | fs.constants.O_EXCL | fs.constants.O_NONBLOCK, 0o600);
    fs.fchmodSync(fd, 0o600);
    const initial = regularFile(fs.fstatSync(fd), UPLOAD_LIMIT, true);
    if (initial.size !== 0 || initial.dev !== directory.dev) changed();
    uploadPath(config, thread, cwd, directory, target);
    uploadedFile(target, initial);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isInteger(count) || count <= 0 || count > bytes.length - offset) changed();
      offset += count;
    }
    const final = regularFile(fs.fstatSync(fd), UPLOAD_LIMIT);
    sameIdentity(initial, final);
    if (final.size !== bytes.length || (final.mode & 0o777) !== 0o600) changed();
    uploadPath(config, thread, cwd, directory, target);
    uploadedFile(target, final);
    sameFields(final, regularFile(fs.fstatSync(fd), UPLOAD_LIMIT));
    checkCwd(config, thread, cwd);
    // Documents stay opaque even when their declared MIME or bytes look like images.
    return { path: target, originalName: name, image: descriptor.image,
      mime: kind?.mime ?? 'application/octet-stream', size: bytes.length };
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } finally {
      try {
        if (directory) fs.closeSync(directory.fd);
      } finally {
        fs.closeSync(cwd.fd);
      }
    }
  }
}

function exportPath(config, cwd, userPath) {
  if (typeof userPath !== 'string' || !userPath || UNSAFE_TEXT.test(userPath)
      || /^[a-z][a-z0-9+.-]*:/i.test(userPath) || userPath.includes('\\')
      || userPath.split('/').includes('..')) {
    throw new Error('Export path contains invalid text, a URI, or parent traversal.');
  }
  const target = path.resolve(cwd, userPath);
  if (target === cwd || !within(cwd, target)) {
    throw new Error('Export must be inside the exact selected working directory.');
  }
  assertUnprotected(config, target);
  const components = path.relative(cwd, target).split(path.sep);
  // Deliberately conservative, case-insensitive credential-name deny rules.
  if (components.some(name => name.startsWith('.')
      || /auth|credentials?|tokens?|secrets?|private[._ -]*keys?/i.test(name)
      || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[._-])/i.test(name)
      || /\.(?:pem|key|p12|pfx)$/i.test(name))) {
    throw new Error('Hidden or sensitive export paths are not allowed.');
  }
  return target;
}

function walkExport(cwd, target) {
  const components = path.relative(cwd, target).split(path.sep);
  let current = cwd;
  let stat;
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]);
    stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('Symlink export components are not allowed.');
    if (index < components.length - 1 && !stat.isDirectory()) {
      throw new Error('Export parent must be a directory.');
    }
  }
  return regularFile(stat, EXPORT_LIMIT);
}

function inspectExport(config, thread, cwd, userPath) {
  checkCwd(config, thread, cwd);
  const target = exportPath(config, cwd.path, userPath);
  const before = walkExport(cwd.path, target);
  const canonical = fs.realpathSync(target);
  assertUnprotected(config, canonical);
  if (!within(cwd.path, canonical) || canonical !== target) changed();
  const after = walkExport(cwd.path, target);
  sameFields(before, after);
  checkCwd(config, thread, cwd);
  return { path: canonical, name: path.basename(canonical), size: after.size,
    dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs,
    cwd: cwd.path, cwdDev: cwd.dev, cwdIno: cwd.ino };
}

// Metadata only: never open or read the proposed file before confirmation.
export function describeExport(config, thread, userPath) {
  const cwd = pinDirectory(allowedThread(config, thread));
  try {
    return inspectExport(config, thread, cwd, userPath);
  } finally {
    fs.closeSync(cwd.fd);
  }
}

export function readExport(config, thread, proposal) {
  if (!record(proposal)) throw new Error('Invalid export proposal.');
  const expected = Object.fromEntries(PROPOSAL_FIELDS.map(field => [field, proposal[field]]));
  const current = describeExport(config, thread, expected.path);
  sameFields(expected, current, PROPOSAL_FIELDS);
  const cwd = pinDirectory(allowedThread(config, thread));
  let fd;
  try {
    sameFields(expected, inspectExport(config, thread, cwd, expected.path), PROPOSAL_FIELDS);
    fd = fs.openSync(expected.path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    sameFields(expected, regularFile(fs.fstatSync(fd), EXPORT_LIMIT));
    sameFields(expected, inspectExport(config, thread, cwd, expected.path), PROPOSAL_FIELDS);
    const bytes = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isInteger(count) || count <= 0 || count > bytes.length - offset) changed();
      offset += count;
    }
    // One bounded EOF probe catches growth as well as the metadata checks below.
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0) changed();
    sameFields(expected, regularFile(fs.fstatSync(fd), EXPORT_LIMIT));
    sameFields(expected, inspectExport(config, thread, cwd, expected.path), PROPOSAL_FIELDS);
    sameFields(expected, regularFile(fs.fstatSync(fd), EXPORT_LIMIT));
    checkCwd(config, thread, cwd);
    return { bytes, name: current.name, mime: imageKind(bytes)?.mime ?? 'application/octet-stream' };
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } finally {
      fs.closeSync(cwd.fd);
    }
  }
}
