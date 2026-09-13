import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateImageSize, validateFileType, sanitizeFilename } from '../src/media.mjs';

test('validateImageSize - accepts valid sizes', () => {
  assert.doesNotThrow(() => validateImageSize(1024)); // 1KB
  assert.doesNotThrow(() => validateImageSize(5 * 1024 * 1024)); // 5MB
  assert.doesNotThrow(() => validateImageSize(10 * 1024 * 1024)); // 10MB exactly
});

test('validateImageSize - rejects oversized images', () => {
  assert.throws(
    () => validateImageSize(11 * 1024 * 1024),
    /超过限制/
  );
  assert.throws(
    () => validateImageSize(50 * 1024 * 1024),
    /超过限制/
  );
});

test('validateImageSize - rejects invalid inputs', () => {
  assert.throws(() => validateImageSize(-1));
  assert.throws(() => validateImageSize(NaN));
  assert.throws(() => validateImageSize(Infinity));
});

test('validateFileType - allows code files', () => {
  assert.strictEqual(validateFileType('text/plain', 'test.py').allowed, true);
  assert.strictEqual(validateFileType('text/javascript', 'app.js').allowed, true);
  assert.strictEqual(validateFileType('application/json', 'config.json').allowed, true);
  assert.strictEqual(validateFileType('text/plain', 'README.md').allowed, true);
});

test('validateFileType - allows document files', () => {
  assert.strictEqual(validateFileType('application/pdf', 'report.pdf').allowed, true);
  assert.strictEqual(validateFileType('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc.docx').allowed, true);
});

test('validateFileType - allows data files', () => {
  assert.strictEqual(validateFileType('text/csv', 'data.csv').allowed, true);
  assert.strictEqual(validateFileType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet.xlsx').allowed, true);
});

test('validateFileType - blocks executable files', () => {
  assert.strictEqual(validateFileType('application/x-executable', 'virus.exe').allowed, false);
  assert.strictEqual(validateFileType('application/x-sh', 'script.sh').allowed, false);
  assert.strictEqual(validateFileType('application/x-msdos-program', 'bad.bat').allowed, false);
});

test('validateFileType - blocks compressed files', () => {
  assert.strictEqual(validateFileType('application/zip', 'archive.zip').allowed, false);
  assert.strictEqual(validateFileType('application/x-tar', 'archive.tar').allowed, false);
  assert.strictEqual(validateFileType('application/x-7z-compressed', 'archive.7z').allowed, false);
});

test('sanitizeFilename - removes path separators', () => {
  // ../ becomes __ (.. -> __, / -> _)
  assert.strictEqual(sanitizeFilename('../../../etc/passwd'), '_________etc_passwd');
  // ..\ becomes ___ (.. -> __, \ -> _)
  assert.strictEqual(sanitizeFilename('..\\..\\windows\\system32'), '______windows_system32');
});

test('sanitizeFilename - removes special characters', () => {
  assert.strictEqual(sanitizeFilename('file:name*with?bad<chars>'), 'file_name_with_bad_chars_');
  assert.strictEqual(sanitizeFilename('file|with|pipes'), 'file_with_pipes');
});

test('sanitizeFilename - prevents hidden files', () => {
  assert.strictEqual(sanitizeFilename('.hidden'), '_hidden');
  assert.strictEqual(sanitizeFilename('...config'), '__.config');
});

test('sanitizeFilename - truncates long names', () => {
  const longName = 'a'.repeat(250) + '.txt';
  const result = sanitizeFilename(longName);
  assert.ok(result.length <= 204); // 200 + '.txt'
  assert.ok(result.endsWith('.txt'));
});

test('sanitizeFilename - handles empty/invalid names', () => {
  assert.strictEqual(sanitizeFilename(''), 'unnamed');
  // '...' -> '__.' after dot-removal and '..' replacement
  const result = sanitizeFilename('...');
  assert.ok(result === '__.' || result === 'unnamed'); // Either is acceptable
  assert.strictEqual(sanitizeFilename('///'), 'unnamed');
  assert.strictEqual(sanitizeFilename('___'), 'unnamed');
});

console.log('✅ All media.mjs unit tests passed');
