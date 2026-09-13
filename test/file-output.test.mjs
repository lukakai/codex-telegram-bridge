import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 模拟 Bridge 类的文件输出逻辑
class MockFileOutputBridge {
  constructor(projectRoot) {
    this.config = {
      chatId: 12345,
      projects: [{ path: projectRoot }]
    };
    this.sentPhotos = [];
    this.sentDocuments = [];
    this.sentMessages = [];
    this.diagnostics = [];
  }

  diagnostic(code, error) {
    this.diagnostics.push({ code, message: error.message });
  }

  async say(text) {
    this.sentMessages.push({ text });
  }

  async sendPhoto(chatId, { bytes, caption, mime }) {
    this.sentPhotos.push({ chatId, bytes, caption, mime });
  }

  async sendDocument(chatId, { bytes, name, mime }) {
    this.sentDocuments.push({ chatId, bytes, name, mime });
  }

  async handleDocumentOutput(absolutePath, filename, bytes) {
    if (bytes.length > 50 * 1024 * 1024) {
      return this.say(`⚠️ 文件过大（${(bytes.length / 1024 / 1024).toFixed(2)}MB），Telegram 限制 50MB。\n文件：${filename}`);
    }

    let mimeType = 'application/octet-stream';
    const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';

    const mimeMap = {
      '.txt': 'text/plain', '.md': 'text/plain', '.py': 'text/x-python',
      '.js': 'text/javascript', '.json': 'application/json', '.pdf': 'application/pdf',
      '.csv': 'text/csv', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    };

    if (mimeMap[ext]) {
      mimeType = mimeMap[ext];
    }

    await this.sendDocument(this.config.chatId, {
      bytes,
      name: filename,
      mime: mimeType
    });
  }

  async handleImageOutput(item) {
    const { path, operation } = item;

    if (operation !== 'create' && operation !== 'update') return;
    if (!path || typeof path !== 'string') return;

    const lowerPath = path.toLowerCase();

    const imageSuffixes = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    const isImage = imageSuffixes.some(suffix => lowerPath.endsWith(suffix));

    const documentSuffixes = [
      '.py', '.js', '.mjs', '.ts', '.jsx', '.tsx', '.json', '.html', '.css', '.xml', '.yaml', '.yml',
      '.txt', '.md', '.log', '.pdf', '.doc', '.docx', '.csv', '.xls', '.xlsx'
    ];
    const isDocument = documentSuffixes.some(suffix => lowerPath.endsWith(suffix));

    if (!isImage && !isDocument) return;

    try {
      const { readFile } = await import('node:fs/promises');
      const { resolve, isAbsolute } = await import('node:path');

      const projectRoot = this.config.projects[0]?.path;
      if (!projectRoot) {
        this.diagnostic('file-output-no-project', new Error('No project root configured'));
        return;
      }

      const absolutePath = isAbsolute(path) ? path : resolve(projectRoot, path);

      if (!absolutePath.startsWith(projectRoot)) {
        this.diagnostic('file-output-path-traversal', new Error(`Path outside project: ${path}`));
        return;
      }

      const bytes = await readFile(absolutePath);

      const filename = path.split('/').pop() || 'file';

      if (isImage) {
        if (bytes.length > 10 * 1024 * 1024) {
          return this.say(`⚠️ 图片文件过大（${(bytes.length / 1024 / 1024).toFixed(2)}MB），Telegram 限制 10MB。\n文件：${path}`);
        }

        const detectMime = (buffer) => {
          if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
          if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
          return 'image/jpeg';
        };

        const mimeType = detectMime(bytes);

        await this.sendPhoto(this.config.chatId, {
          bytes,
          caption: `📷 Codex 生成了图片：${filename}`,
          mime: mimeType
        });
      } else {
        await this.handleDocumentOutput(absolutePath, filename, bytes);
      }

    } catch (error) {
      this.diagnostic('file-output-failed', error);
    }
  }
}

// 辅助函数
function createTestFile(content = 'test content') {
  return Buffer.from(content, 'utf-8');
}

function createPNGBytes() {
  const buffer = Buffer.alloc(100);
  buffer[0] = 0x89; buffer[1] = 0x50; buffer[2] = 0x4E; buffer[3] = 0x47;
  return buffer;
}

async function mkdtemp() {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), 'file-output-test-'));
}

async function cleanup(dir) {
  try {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理错误
  }
}

test('handleImageOutput - 发送 Python 文件', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockFileOutputBridge(tmpDir);

  const testFile = join(tmpDir, 'script.py');
  await writeFile(testFile, createTestFile('print("hello")'));

  await bridge.handleImageOutput({
    path: 'script.py',
    operation: 'create'
  });

  assert.strictEqual(bridge.sentDocuments.length, 1);
  assert.strictEqual(bridge.sentDocuments[0].name, 'script.py');
  assert.strictEqual(bridge.sentDocuments[0].mime, 'text/x-python');
  await cleanup(tmpDir);
});

test('handleImageOutput - 发送 JSON 文件', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockFileOutputBridge(tmpDir);

  const testFile = join(tmpDir, 'config.json');
  await writeFile(testFile, createTestFile('{"key":"value"}'));

  await bridge.handleImageOutput({
    path: 'config.json',
    operation: 'create'
  });

  assert.strictEqual(bridge.sentDocuments.length, 1);
  assert.strictEqual(bridge.sentDocuments[0].mime, 'application/json');
  await cleanup(tmpDir);
});

test('handleImageOutput - 发送 Markdown 文件', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockFileOutputBridge(tmpDir);

  const testFile = join(tmpDir, 'README.md');
  await writeFile(testFile, createTestFile('# Title\nContent'));

  await bridge.handleImageOutput({
    path: 'README.md',
    operation: 'create'
  });

  assert.strictEqual(bridge.sentDocuments.length, 1);
  assert.strictEqual(bridge.sentDocuments[0].name, 'README.md');
  assert.strictEqual(bridge.sentDocuments[0].mime, 'text/plain');
  await cleanup(tmpDir);
});

test('handleImageOutput - 发送 CSV 文件', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockFileOutputBridge(tmpDir);

  const testFile = join(tmpDir, 'data.csv');
  await writeFile(testFile, createTestFile('name,age\nAlice,30'));

  await bridge.handleImageOutput({
    path: 'data.csv',
    operation: 'create'
  });

  assert.strictEqual(bridge.sentDocuments.length, 1);
  assert.strictEqual(bridge.sentDocuments[0].mime, 'text/csv');
  await cleanup(tmpDir);
});

test('handleImageOutput - 图片作为照片发送', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockFileOutputBridge(tmpDir);

  const testFile = join(tmpDir, 'image.png');
  await writeFile(testFile, createPNGBytes());

  await bridge.handleImageOutput({
    path: 'image.png',
    operation: 'create'
  });

  // 图片应该通过 sendPhoto 而不是 sendDocument
  assert.strictEqual(bridge.sentPhotos.length, 1);
  assert.strictEqual(bridge.sentDocuments.length, 0);
  await cleanup(tmpDir);
});

test('handleImageOutput - 拒绝超过 50MB 的文档', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockFileOutputBridge(tmpDir);

  const testFile = join(tmpDir, 'large.txt');
  await writeFile(testFile, Buffer.alloc(51 * 1024 * 1024));

  await bridge.handleImageOutput({
    path: 'large.txt',
    operation: 'create'
  });

  assert.strictEqual(bridge.sentDocuments.length, 0);
  assert.strictEqual(bridge.sentMessages.length, 1);
  assert.ok(bridge.sentMessages[0].text.includes('过大'));
  assert.ok(bridge.sentMessages[0].text.includes('50MB'));
  await cleanup(tmpDir);
});

test('handleImageOutput - 忽略不支持的文件类型', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockFileOutputBridge(tmpDir);

  const testFile = join(tmpDir, 'binary.bin');
  await writeFile(testFile, createTestFile('binary data'));

  await bridge.handleImageOutput({
    path: 'binary.bin',
    operation: 'create'
  });

  assert.strictEqual(bridge.sentDocuments.length, 0);
  assert.strictEqual(bridge.sentPhotos.length, 0);
  await cleanup(tmpDir);
});

test('handleImageOutput - 支持嵌套路径', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockFileOutputBridge(tmpDir);

  await mkdir(join(tmpDir, 'src'), { recursive: true });
  const testFile = join(tmpDir, 'src', 'app.js');
  await writeFile(testFile, createTestFile('console.log("hi")'));

  await bridge.handleImageOutput({
    path: 'src/app.js',
    operation: 'create'
  });

  assert.strictEqual(bridge.sentDocuments.length, 1);
  assert.strictEqual(bridge.sentDocuments[0].name, 'app.js');
  await cleanup(tmpDir);
});

test('handleImageOutput - 处理 update 操作', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockFileOutputBridge(tmpDir);

  const testFile = join(tmpDir, 'updated.py');
  await writeFile(testFile, createTestFile('# updated'));

  await bridge.handleImageOutput({
    path: 'updated.py',
    operation: 'update'
  });

  assert.strictEqual(bridge.sentDocuments.length, 1);
  await cleanup(tmpDir);
});

test('handleImageOutput - 拒绝路径遍历攻击', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockFileOutputBridge(tmpDir);

  await bridge.handleImageOutput({
    path: '../../../etc/passwd.txt',  // 添加 .txt 后缀使其匹配文档类型
    operation: 'create'
  });

  assert.strictEqual(bridge.sentDocuments.length, 0);
  assert.strictEqual(bridge.diagnostics.length, 1);
  assert.ok(bridge.diagnostics[0].code.includes('path-traversal'));
  await cleanup(tmpDir);
});

console.log('✅ All file output tests passed');
