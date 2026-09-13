import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * 下载 Telegram 图片并转换为 base64 编码
 * @param {Telegram} telegram - Telegram 客户端实例
 * @param {string} fileId - Telegram 文件 ID
 * @returns {Promise<{base64Data: string, mimeType: string, sizeBytes: number}>}
 */
export async function downloadAndEncodeImage(telegram, fileId) {
  let tmpPath = null;

  try {
    // 1. 下载图片二进制数据（使用现有的 download 方法）
    const buffer = await telegram.download(fileId, { maxBytes: MAX_IMAGE_SIZE });

    // 2. 验证大小
    validateImageSize(buffer.length);

    // 3. 检测 MIME 类型（简单的魔术数字检测）
    const mimeType = detectImageMimeType(buffer);

    // 4. 转换为 base64
    const base64Data = buffer.toString('base64');

    return {
      base64Data,
      mimeType,
      sizeBytes: buffer.length
    };
  } finally {
    // 清理临时文件（如果创建了）
    if (tmpPath) {
      try {
        await unlink(tmpPath);
      } catch {
        // 忽略清理错误
      }
    }
  }
}

/**
 * 验证图片大小是否在限制范围内
 * @param {number} sizeBytes - 文件大小（字节）
 * @throws {Error} 如果超过大小限制
 */
export function validateImageSize(sizeBytes) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error('无效的文件大小');
  }

  if (sizeBytes > MAX_IMAGE_SIZE) {
    const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);
    const limitMB = (MAX_IMAGE_SIZE / 1024 / 1024).toFixed(0);
    throw new Error(`图片大小 ${sizeMB}MB 超过限制 ${limitMB}MB`);
  }

  return true;
}

/**
 * 通过魔术数字检测图片 MIME 类型
 * @param {Buffer} buffer - 文件二进制数据
 * @returns {string} MIME 类型
 */
export function detectImageMimeType(buffer) {
  if (buffer.length < 4) {
    return 'application/octet-stream';
  }

  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }

  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'image/gif';
  }

  // WebP: 52 49 46 46 ... 57 45 42 50
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp';
  }

  // 默认返回通用类型
  return 'image/jpeg'; // Telegram 主要使用 JPEG
}

/**
 * 验证文件类型是否在白名单中
 * @param {string} mimeType - MIME 类型
 * @param {string} filename - 文件名
 * @returns {{allowed: boolean, reason: string}}
 */
export function validateFileType(mimeType, filename) {
  // 白名单：代码文件、文档、数据文件
  const ALLOWED_TYPES = {
    // 代码文件
    'text/plain': ['.txt', '.md', '.log', '.py', '.js', '.mjs', '.ts', '.jsx', '.tsx', '.json', '.html', '.css', '.xml', '.yaml', '.yml'],
    'text/x-python': ['.py'],
    'text/javascript': ['.js', '.mjs'],
    'application/javascript': ['.js', '.mjs'],
    'text/html': ['.html', '.htm'],
    'text/css': ['.css'],
    'application/json': ['.json'],
    'text/xml': ['.xml'],
    'application/xml': ['.xml'],

    // 文档
    'application/pdf': ['.pdf'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    'application/msword': ['.doc'],

    // 数据
    'text/csv': ['.csv'],
    'application/vnd.ms-excel': ['.xls'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx']
  };

  // 禁止的扩展名（可执行文件、脚本、压缩包）
  const FORBIDDEN_EXTENSIONS = [
    '.exe', '.dll', '.so', '.dylib', '.sh', '.bat', '.cmd', '.com', '.app',
    '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz'
  ];

  // 提取文件扩展名
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';

  // 检查禁止的扩展名
  if (FORBIDDEN_EXTENSIONS.includes(ext)) {
    return {
      allowed: false,
      reason: `不支持可执行文件或压缩包（${ext}）`
    };
  }

  // 检查 MIME 类型白名单
  const allowedExtensions = ALLOWED_TYPES[mimeType];
  if (allowedExtensions && allowedExtensions.includes(ext)) {
    return { allowed: true, reason: '' };
  }

  // 如果 MIME 类型不在白名单，但扩展名是常见的代码/文档类型，也允许
  const commonExtensions = ['.txt', '.md', '.py', '.js', '.json', '.csv', '.pdf'];
  if (commonExtensions.includes(ext)) {
    return { allowed: true, reason: '' };
  }

  return {
    allowed: false,
    reason: `不支持的文件类型（${mimeType || '未知'}, ${ext || '无扩展名'}）`
  };
}

/**
 * 清理文件名（防止路径遍历攻击）
 * @param {string} filename - 原始文件名
 * @returns {string} 安全的文件名
 */
export function sanitizeFilename(filename) {
  // 移除路径分隔符和特殊字符
  let safe = filename.replace(/[\/\\:*?"<>|]/g, '_');

  // 替换 .. 序列防止路径遍历
  safe = safe.replace(/\.\./g, '__');

  // 防止隐藏文件（以点开头）
  safe = safe.replace(/^\.+/, '_');

  // 限制长度
  if (safe.length > 200) {
    const ext = safe.match(/\.[^.]+$/)?.[0] || '';
    safe = safe.slice(0, 200 - ext.length) + ext;
  }

  // 如果清理后为空或只有下划线，返回默认名
  if (!safe || /^_+$/.test(safe)) {
    return 'unnamed';
  }

  return safe;
}

/**
 * 下载文件并保存到指定目录
 * @param {Telegram} telegram - Telegram 客户端实例
 * @param {string} fileId - Telegram 文件 ID
 * @param {string} targetDir - 目标目录路径
 * @param {string} originalName - 原始文件名
 * @returns {Promise<string>} 保存后的文件绝对路径
 */
export async function downloadAndSaveFile(telegram, fileId, targetDir, originalName) {
  // 1. 确保目标目录存在
  await mkdir(targetDir, { recursive: true, mode: 0o700 });

  // 2. 下载文件
  const buffer = await telegram.download(fileId, { maxBytes: 50 * 1024 * 1024 }); // 50MB 限制

  // 3. 生成安全的文件名
  const safeName = sanitizeFilename(originalName);
  const timestamp = Date.now();
  const filename = `${timestamp}-${safeName}`;
  const filePath = join(targetDir, filename);

  // 4. 保存文件（仅所有者可读写）
  await writeFile(filePath, buffer, { mode: 0o600 });

  return filePath;
}

/**
 * 清理过期文件
 * @param {string} uploadDir - 上传目录路径
 * @param {number} maxAgeHours - 最大保留时间（小时）
 */
export async function cleanupOldFiles(uploadDir, maxAgeHours = 24) {
  const { readdir, stat, unlink } = await import('node:fs/promises');

  try {
    const files = await readdir(uploadDir);
    const now = Date.now();
    const maxAge = maxAgeHours * 60 * 60 * 1000;

    for (const file of files) {
      const filePath = join(uploadDir, file);

      try {
        const stats = await stat(filePath);
        if (now - stats.mtimeMs > maxAge) {
          await unlink(filePath);
          console.log(`[Cleanup] 已删除过期文件: ${file}`);
        }
      } catch (error) {
        // 忽略单个文件的错误，继续清理其他文件
        console.error(`[Cleanup] 清理文件失败 ${file}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[Cleanup] 清理目录失败:', error.message);
  }
}
