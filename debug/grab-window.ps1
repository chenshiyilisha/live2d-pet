param(
  # 等应用起来再抓（本机 GPU 进程冷启动偶发崩一次，恢复要 ~25s；
  # 只是确认布局的话 8~12s 就够）。0 = 立即抓。
  [int]$Wait = 10,
  # 输出文件名（放脚本旁边），不带扩展名
  [string]$Name = 'pet-screen'
)

$ErrorActionPreference = 'Stop'
$log = "$env:TEMP\pet-screen.log"
"start $(Get-Date -Format o) wait=$Wait" | Out-File -Encoding utf8 $log

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PetWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

if ($Wait -gt 0) { Start-Sleep -Seconds $Wait }

# electron.exe（开发跑法）或 Ayan.exe（打包跑法）都算
$ids = @()
foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
  if ($p.ProcessName -eq 'electron' -or $p.ProcessName -eq 'Ayan') { $ids += $p.Id }
}
"candidate pids: $($ids -join ',')" | Out-File -Append -Encoding utf8 $log
if ($ids.Count -eq 0) { "NO PROCESS" | Out-File -Append -Encoding utf8 $log; exit 1 }

$hits = New-Object System.Collections.ArrayList
$cb = [PetWin+EnumProc]{
  param($h, $l)
  $q = [uint32]0
  [void][PetWin]::GetWindowThreadProcessId($h, [ref]$q)
  if (($ids -contains [int]$q) -and [PetWin]::IsWindowVisible($h)) {
    $rr = New-Object PetWin+RECT
    [void][PetWin]::GetWindowRect($h, [ref]$rr)
    $wid = $rr.Right - $rr.Left
    $hei = $rr.Bottom - $rr.Top
    if ($wid -gt 80 -and $hei -gt 80) {
      [void]$hits.Add([pscustomobject]@{ H = $h; Pid = $q; L = $rr.Left; T = $rr.Top; R = $rr.Right; B = $rr.Bottom; W = $wid; Hh = $hei })
    }
  }
  return $true
}
[void][PetWin]::EnumWindows($cb, [IntPtr]::Zero)

foreach ($x in $hits) {
  "window pid=$($x.Pid) L=$($x.L) T=$($x.T) R=$($x.R) B=$($x.B) $($x.W)x$($x.Hh)" | Out-File -Append -Encoding utf8 $log
}
if ($hits.Count -eq 0) { "NO VISIBLE WINDOW" | Out-File -Append -Encoding utf8 $log; exit 1 }

# 取最宽的那个可见窗口（就是桌宠舞台；devtools 之类一般更窄，且多数不可见）
"pre-sort count=$($hits.Count) type=$($hits.GetType().FullName)" | Out-File -Append -Encoding utf8 $log
$win = $null
foreach ($cand in ($hits | Sort-Object -Property W -Descending)) {
  "cand W=$($cand.W) Hh=$($cand.Hh)" | Out-File -Append -Encoding utf8 $log
  if ($null -eq $win -or $cand.W -gt $win.W) { $win = $cand }
}
"picked: null=$($null -eq $win) W=$($win.W)" | Out-File -Append -Encoding utf8 $log

try {
  ($win | Format-List * | Out-String) -split "`r?`n" | ForEach-Object {
    "win| $_" | Out-File -Append -Encoding utf8 $log
  }
  "step: bitmap $($win.W)x$($win.Hh)" | Out-File -Append -Encoding utf8 $log
  $bmp = New-Object System.Drawing.Bitmap([int]$win.W, [int]$win.Hh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  "step: copyfrom" | Out-File -Append -Encoding utf8 $log
  $g.CopyFromScreen([int]$win.L, [int]$win.T, 0, 0, $bmp.Size)

  $out = Join-Path $PSScriptRoot ($Name + '.png')
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  "png=$out" | Out-File -Append -Encoding utf8 $log
  $g.Dispose(); $bmp.Dispose()
  "done" | Out-File -Append -Encoding utf8 $log
} catch {
  ("capture ERR: " + $_.Exception.GetType().FullName + ' - ' + $_.Exception.Message) |
    Out-File -Append -Encoding utf8 $log
  exit 2
}
