/* 探测：从 Node 子进程（而不是 WorkBuddy 的工具层）调 PowerShell 能不能加载
 * System.Speech。工具层的 Add-Type 被安全策略拦了，但 execFile 起的是普通
 * 子进程，走的是系统自己的执行策略，两者不是一回事。 */
const { execFile } = require('child_process');

const script = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech
  $rs = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  if ($rs.Count -eq 0) { 'NO_RECOGNIZER' } else { foreach ($r in $rs) { 'REC|' + $r.Culture.Name + '|' + $r.Description } }
} catch { 'ERR: ' + $_.Exception.Message }
`;

execFile('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
  { windowsHide: true, timeout: 20000, maxBuffer: 1 << 20 },
  (err, stdout, stderr) => {
    console.log('=== err ===', err ? (err.message || String(err)) : 'none');
    console.log('=== stdout ===');
    console.log(String(stdout || '').trim() || '(empty)');
    console.log('=== stderr ===');
    console.log(String(stderr || '').trim().slice(0, 600) || '(empty)');
  });
