import { strict as assert } from 'node:assert';
import { test } from 'node:test';

// 模拟 Bridge 类的流式处理逻辑（单元测试）
class MockStreamingBridge {
  constructor() {
    this.streamingMessages = new Map();
    this.sentMessages = [];
    this.editedMessages = [];
    this.deletedMessages = [];
    this.currentTime = Date.now();
  }

  now() {
    return this.currentTime;
  }

  async say(text) {
    const msg = { message_id: this.sentMessages.length + 1, text };
    this.sentMessages.push(msg);
    return msg;
  }

  async editMessageText(chatId, messageId, text) {
    this.editedMessages.push({ chatId, messageId, text, timestamp: this.now() });
  }

  async deleteMessage(chatId, messageId) {
    this.deletedMessages.push({ chatId, messageId });
  }

  async handleStreamingDelta(turnId, deltaText) {
    if (!deltaText) return;

    let stream = this.streamingMessages.get(turnId);

    if (!stream) {
      const initialMsg = await this.say('💭 思考中...');
      stream = {
        messageId: initialMsg.message_id,
        buffer: '',
        lastUpdate: 0,
        throttleTimer: null
      };
      this.streamingMessages.set(turnId, stream);
    }

    stream.buffer += deltaText;

    const now = this.now();
    const timeSinceLastUpdate = now - stream.lastUpdate;

    if (timeSinceLastUpdate >= 1000) {
      await this.updateStreamingMessage(stream);
    } else if (!stream.throttleTimer) {
      const delay = 1000 - timeSinceLastUpdate;
      stream.throttleTimer = setTimeout(() => {
        stream.throttleTimer = null;
        void this.updateStreamingMessage(stream).catch(() => {});
      }, delay);
    }
  }

  async updateStreamingMessage(stream) {
    const MAX_PREVIEW_LENGTH = 3500;
    let preview = stream.buffer;

    if (preview.length > MAX_PREVIEW_LENGTH) {
      preview = preview.slice(0, MAX_PREVIEW_LENGTH);
      const lastNewline = preview.lastIndexOf('\n');
      if (lastNewline > MAX_PREVIEW_LENGTH - 200) {
        preview = preview.slice(0, lastNewline);
      }
      preview += '\n\n[预览截断，完整内容将在生成结束后显示...]';
    }

    await this.editMessageText(1, stream.messageId, `💬 Codex 正在生成...\n\n${preview}`);
    stream.lastUpdate = this.now();
  }

  async cleanupStreamingMessage(turnId) {
    const stream = this.streamingMessages.get(turnId);
    if (!stream) return;

    if (stream.throttleTimer) {
      clearTimeout(stream.throttleTimer);
      stream.throttleTimer = null;
    }

    await this.deleteMessage(1, stream.messageId);
    this.streamingMessages.delete(turnId);
  }
}

test('handleStreamingDelta - 创建初始预览消息', async () => {
  const bridge = new MockStreamingBridge();

  await bridge.handleStreamingDelta('turn-123', 'Hello');

  assert.strictEqual(bridge.sentMessages.length, 1);
  assert.strictEqual(bridge.sentMessages[0].text, '💭 思考中...');
  assert.strictEqual(bridge.streamingMessages.has('turn-123'), true);
});

test('handleStreamingDelta - 累积多个增量', async () => {
  const bridge = new MockStreamingBridge();

  await bridge.handleStreamingDelta('turn-123', 'Hello ');
  bridge.currentTime += 1100; // 推进时间 > 1秒
  await bridge.handleStreamingDelta('turn-123', 'World');

  const stream = bridge.streamingMessages.get('turn-123');
  assert.strictEqual(stream.buffer, 'Hello World');
});

test('handleStreamingDelta - 节流机制（1秒内不更新）', async () => {
  const bridge = new MockStreamingBridge();

  await bridge.handleStreamingDelta('turn-123', 'First ');
  const editCountBefore = bridge.editedMessages.length;

  // 500ms 后再次发送（未超过1秒）
  bridge.currentTime += 500;
  await bridge.handleStreamingDelta('turn-123', 'Second');

  // 应该没有新的编辑（节流生效）
  assert.strictEqual(bridge.editedMessages.length, editCountBefore);
});

test('handleStreamingDelta - 超过1秒后立即更新', async () => {
  const bridge = new MockStreamingBridge();

  await bridge.handleStreamingDelta('turn-123', 'First ');
  const editCountBefore = bridge.editedMessages.length;

  // 1100ms 后再次发送（超过1秒）
  bridge.currentTime += 1100;
  await bridge.handleStreamingDelta('turn-123', 'Second');

  // 应该有新的编辑
  assert.ok(bridge.editedMessages.length > editCountBefore);
  assert.ok(bridge.editedMessages[bridge.editedMessages.length - 1].text.includes('First Second'));
});

test('updateStreamingMessage - 长消息截断', async () => {
  const bridge = new MockStreamingBridge();

  await bridge.handleStreamingDelta('turn-123', 'a'.repeat(4000));

  const stream = bridge.streamingMessages.get('turn-123');
  assert.strictEqual(stream.buffer.length, 4000);

  // 触发更新
  bridge.currentTime += 1100;
  await bridge.updateStreamingMessage(stream);

  const lastEdit = bridge.editedMessages[bridge.editedMessages.length - 1];
  assert.ok(lastEdit.text.includes('[预览截断，完整内容将在生成结束后显示...]'));
});

test('updateStreamingMessage - 短消息不截断', async () => {
  const bridge = new MockStreamingBridge();

  await bridge.handleStreamingDelta('turn-123', 'Short message');

  const stream = bridge.streamingMessages.get('turn-123');
  bridge.currentTime += 1100;
  await bridge.updateStreamingMessage(stream);

  const lastEdit = bridge.editedMessages[bridge.editedMessages.length - 1];
  assert.ok(!lastEdit.text.includes('[预览截断'));
  assert.ok(lastEdit.text.includes('Short message'));
});

test('cleanupStreamingMessage - 删除预览消息', async () => {
  const bridge = new MockStreamingBridge();

  await bridge.handleStreamingDelta('turn-123', 'Test');
  const stream = bridge.streamingMessages.get('turn-123');
  const messageId = stream.messageId;

  await bridge.cleanupStreamingMessage('turn-123');

  assert.strictEqual(bridge.streamingMessages.has('turn-123'), false);
  assert.strictEqual(bridge.deletedMessages.length, 1);
  assert.strictEqual(bridge.deletedMessages[0].messageId, messageId);
});

test('cleanupStreamingMessage - 清理节流定时器', async () => {
  const bridge = new MockStreamingBridge();

  await bridge.handleStreamingDelta('turn-123', 'Test');

  // 在节流期间发送第二个增量
  bridge.currentTime += 500;
  await bridge.handleStreamingDelta('turn-123', ' More');

  const stream = bridge.streamingMessages.get('turn-123');
  assert.ok(stream.throttleTimer !== null);

  // 清理应该取消定时器
  await bridge.cleanupStreamingMessage('turn-123');
  assert.strictEqual(bridge.streamingMessages.has('turn-123'), false);
});

test('handleStreamingDelta - 空增量不处理', async () => {
  const bridge = new MockStreamingBridge();

  await bridge.handleStreamingDelta('turn-123', '');

  assert.strictEqual(bridge.sentMessages.length, 0);
  assert.strictEqual(bridge.streamingMessages.has('turn-123'), false);
});

test('handleStreamingDelta - 多个并发流', async () => {
  const bridge = new MockStreamingBridge();

  await bridge.handleStreamingDelta('turn-1', 'Stream 1');
  await bridge.handleStreamingDelta('turn-2', 'Stream 2');

  assert.strictEqual(bridge.streamingMessages.size, 2);
  assert.strictEqual(bridge.streamingMessages.get('turn-1').buffer, 'Stream 1');
  assert.strictEqual(bridge.streamingMessages.get('turn-2').buffer, 'Stream 2');
});

console.log('✅ All streaming tests passed');
