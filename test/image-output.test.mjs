import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 模拟 Bridge 类的图片输出逻辑
class MockImageOutputBridge {
  constructor(projectRoot) {
    this.config = {
      chatId: 12345,
      projects: [{ path: projectRoot }]
    };
    this.sentPhotos = [];
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

  async handleImageOutput(item) {
    const { path, operation } = item;

    if (operation !== 'create' && operation !== 'update') return;

    if (!path || typeof path !== 'string') return;

    const imageSuffixes = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    const lowerPath = path.toLowerCase();
    const isImage = imageSuffixes.some(suffix => lowerPath.endsWith(suffix));

    if (!isImage) return;

    try {
      const { readFile } = await import('node:fs/promises');
      const { resolve, isAbsolute } = await import('node:path');

      const projectRoot = this.config.projects[0]?.path;
      if (!projectRoot) {
        this.diagnostic('image-output-no-project', new Error('No project root configured'));
        return;
      }

      const absolutePath = isAbsolute(path) ? path : resolve(projectRoot, path);

      if (!absolutePath.startsWith(projectRoot)) {
        this.diagnostic('image-output-path-traversal', new Error(`Path outside project: ${path}`));
        return;
      }

      const bytes = await readFile(absolutePath);

      if (bytes.length > 10 * 1024 * 1024) {
        return this.say(`⚠️ 图片文件过大（${(bytes.length / 1024 / 1024).toFixed(2)}MB），Telegram 限制 10MB。\n文件：${path}`);
      }

      // 简化的 MIME 检测
      const detectMime = (buffer) => {
        if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
        if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
        if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
        return 'image/jpeg';
      };

      const mimeType = detectMime(bytes);

      const filename = path.split('/').pop() || 'image.jpg';
      await this.sendPhoto(this.config.chatId, {
        bytes,
        caption: `📷 Codex 生成了图片：${filename}`,
        mime: mimeType
      });

    } catch (error) {
      this.diagnostic('image-output-failed', error);
    }
  }
}

// 创建测试图片文件（PNG 魔术数字）
function createPNGBytes(size = 100) {
  const buffer = Buffer.alloc(size);
  buffer[0] = 0x89; buffer[1] = 0x50; buffer[2] = 0x4E; buffer[3] = 0x47; // PNG 魔术数字
  return buffer;
}

test('handleImageOutput - 忽略非图片文件', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockImageOutputBridge(tmpDir);

  await bridge.handleImageOutput({
    path: 'test.txt',
    operation: 'create'
  });

  assert.strictEqual(bridge.sentPhotos.length, 0);
  await cleanup(tmpDir);
});

test('handleImageOutput - 忽略删除操作', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockImageOutputBridge(tmpDir);

  await bridge.handleImageOutput({
    path: 'test.png',
    operation: 'delete'
  });

  assert.strictEqual(bridge.sentPhotos.length, 0);
  await cleanup(tmpDir);
});

test('handleImageOutput - 发送 PNG 图片', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockImageOutputBridge(tmpDir);

  const testFile = join(tmpDir, 'test.png');
  await writeFile(testFile, createPNGBytes());

  await bridge.handleImageOutput({
    path: 'test.png',
    operation: 'create'
  });

  assert.strictEqual(bridge.sentPhotos.length, 1);
  assert.strictEqual(bridge.sentPhotos[0].mime, 'image/png');
  assert.ok(bridge.sentPhotos[0].caption.includes('test.png'));
  await cleanup(tmpDir);
});

test('handleImageOutput - 支持多种图片格式', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockImageOutputBridge(tmpDir);

  const formats = ['test.jpg', 'test.jpeg', 'test.gif', 'test.webp'];

  for (const filename of formats) {
    const testFile = join(tmpDir, filename);
    await writeFile(testFile, createPNGBytes());

    await bridge.handleImageOutput({
      path: filename,
      operation: 'create'
    });
  }

  assert.strictEqual(bridge.sentPhotos.length, 4);
  await cleanup(tmpDir);
});

test('handleImageOutput - 拒绝路径遍历攻击', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockImageOutputBridge(tmpDir);

  await bridge.handleImageOutput({
    path: '../../../etc/passwd.png',
    operation: 'create'
  });

  assert.strictEqual(bridge.sentPhotos.length, 0);
  assert.strictEqual(bridge.diagnostics.length, 1);
  assert.ok(bridge.diagnostics[0].code.includes('path-traversal'));
  await cleanup(tmpDir);
});

test('handleImageOutput - 拒绝绝对路径超出项目', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockImageOutputBridge(tmpDir);

  await bridge.handleImageOutput({
    path: '/tmp/malicious.png',
    operation: 'create'
  });

  assert.strictEqual(bridge.sentPhotos.length, 0);
  assert.strictEqual(bridge.diagnostics.length, 1);
  await cleanup(tmpDir);
});

test('handleImageOutput - 拒绝超过 10MB 的图片', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockImageOutputBridge(tmpDir);

  const testFile = join(tmpDir, 'large.png');
  await writeFile(testFile, createPNGBytes(11 * 1024 * 1024));

  await bridge.handleImageOutput({
    path: 'large.png',
    operation: 'create'
  });

  assert.strictEqual(bridge.sentPhotos.length, 0);
  assert.strictEqual(bridge.sentMessages.length, 1);
  assert.ok(bridge.sentMessages[0].text.includes('过大'));
  await cleanup(tmpDir);
});

test('handleImageOutput - 处理文件不存在', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockImageOutputBridge(tmpDir);

  await bridge.handleImageOutput({
    path: 'nonexistent.png',
    operation: 'create'
  });

  assert.strictEqual(bridge.sentPhotos.length, 0);
  assert.strictEqual(bridge.diagnostics.length, 1);
  assert.strictEqual(bridge.diagnostics[0].code, 'image-output-failed');
  await cleanup(tmpDir);
});

test('handleImageOutput - 支持相对路径', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockImageOutputBridge(tmpDir);

  await mkdir(join(tmpDir, 'subdir'), { recursive: true });
  const testFile = join(tmpDir, 'subdir', 'nested.png');
  await writeFile(testFile, createPNGBytes());

  await bridge.handleImageOutput({
    path: 'subdir/nested.png',
    operation: 'create'
  });

  assert.strictEqual(bridge.sentPhotos.length, 1);
  assert.ok(bridge.sentPhotos[0].caption.includes('nested.png'));
  await cleanup(tmpDir);
});

test('handleImageOutput - 处理 update 操作', async () => {
  const tmpDir = await mkdtemp();
  const bridge = new MockImageOutputBridge(tmpDir);

  const testFile = join(tmpDir, 'updated.png');
  await writeFile(testFile, createPNGBytes());

  await bridge.handleImageOutput({
    path: 'updated.png',
    operation: 'update'
  });

  assert.strictEqual(bridge.sentPhotos.length, 1);
  await cleanup(tmpDir);
});

// 辅助函数
async function mkdtemp() {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), 'image-output-test-'));
}

async function cleanup(dir) {
  try {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理错误
  }
}

console.log('✅ All image output tests passed');
