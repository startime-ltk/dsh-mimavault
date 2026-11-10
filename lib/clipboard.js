import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 内置模式下的系统剪贴板（Host 半部执行，Windows）。
 *
 * 与 PC 密匣的 ClipboardSafe 对齐：写完后 30 秒自动清除，
 * 且只在剪贴板内容仍等于本次写入值时才清（用户已复制别的东西就不动）。
 *
 * 用一个 detached 的 PowerShell 子进程承载「写入 + 等待 + 条件清除」，
 * 明文通过 stdin 传入，不落任何临时文件。命令用 -EncodedCommand
 * 传递（UTF-16LE base64），避免中文/特殊字符在命令行里被编码或引号破坏。
 */

const SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
  '$secret = [Console]::In.ReadToEnd()',
  'if ([string]::IsNullOrEmpty($secret)) { exit 1 }',
  'Set-Clipboard -Value $secret',
  'Start-Sleep -Seconds 30',
  '$cur = Get-Clipboard -Raw',
  'if ($cur -eq $secret) { Set-Clipboard -Value "" }',
].join('\r\n');

function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** 可用的 PowerShell 可执行文件 */
function powerShellBin() {
  return process.platform === 'win32' ? 'powershell.exe' : null;
}

/**
 * 写剪贴板并安排 30 秒后条件清除。
 * @returns {{ ok: boolean, reason?: string }}
 */
export function copyToClipboard(text, { autoClearSeconds = 30 } = {}) {
  if (text == null || text === '') return { ok: false, reason: '内容为空' };
  const bin = powerShellBin();
  if (!bin) return { ok: false, reason: '非 Windows 环境没有系统剪贴板' };

  const script = autoClearSeconds > 0 ? SCRIPT : SCRIPT.replace(/Start-Sleep[\s\S]*$/m, '');
  try {
    const child = spawn(bin, [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-EncodedCommand', encodedCommand(script),
    ], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      detached: true,
    });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(String(text), 'utf8'));
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

/** 清除前留一份恢复副本（明文，用户显式选择时才调用） */
export function writeBackup(snapshotText, backupPath) {
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, snapshotText, 'utf8');
  return backupPath;
}

export function readBackup(backupPath) {
  return fs.readFileSync(backupPath, 'utf8');
}

export function deleteBackup(backupPath) {
  try {
    fs.unlinkSync(backupPath);
    return true;
  } catch {
    return false;
  }
}
