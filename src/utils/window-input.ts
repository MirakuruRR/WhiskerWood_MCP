export interface ClickResult {
  ok: boolean
  status: string
  screen?: string
  window?: string
  error?: string
}

/**
 * Клик в окно игры по координатам кадра ww_screenshot (они от левого верхнего угла GetWindowRect).
 * Slate бьёт по позиции курсора, поэтому курсор ставится в точку по-настоящему, а нажатие
 * приходит окну сообщениями WM_*BUTTON*; после клика курсор возвращается назад.
 */
export function clickGameWindow(pid: number, x: number, y: number, button: 'left' | 'right', double: boolean, restore: boolean): ClickResult {
  const [down, up, wparam] = button === 'right' ? [0x204, 0x205, 2] : [0x201, 0x202, 1]
  const script =
    `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;using System.Text;public class WwInput{` +
    `public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);` +
    `[DllImport("user32.dll")]public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);` +
    `[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);` +
    `[DllImport("user32.dll")]public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);` +
    `[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr hWnd);` +
    `[DllImport("user32.dll")]public static extern bool IsIconic(IntPtr hWnd);` +
    `[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h, out RECT r);` +
    `[DllImport("user32.dll")]public static extern bool GetCursorPos(out POINT p);` +
    `[DllImport("user32.dll")]public static extern bool SetCursorPos(int x, int y);` +
    `[DllImport("user32.dll")]public static extern bool ScreenToClient(IntPtr h, ref POINT p);` +
    `[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);` +
    `[StructLayout(LayoutKind.Sequential)]public struct RECT{public int L;public int T;public int R;public int B;}` +
    `[StructLayout(LayoutKind.Sequential)]public struct POINT{public int X;public int Y;}}';` +
    `$target=[uint32]${pid};$script:found=[IntPtr]::Zero;` +
    `$cb=[WwInput+EnumWindowsProc]{param($h,$l);$wp=[uint32]0;[void][WwInput]::GetWindowThreadProcessId($h,[ref]$wp);if($wp -eq $target -and [WwInput]::IsWindowVisible($h)){$sb=New-Object System.Text.StringBuilder 256;[void][WwInput]::GetClassName($h,$sb,256);if($sb.ToString() -eq 'UnrealWindow'){$script:found=$h;return $false}};return $true};` +
    `[void][WwInput]::EnumWindows($cb,[IntPtr]::Zero);` +
    `$h=$script:found;if($h -eq [IntPtr]::Zero){'no_game_window';exit 1};` +
    `if([WwInput]::IsIconic($h)){'minimized';exit 1};` +
    `$r=New-Object WwInput+RECT;[void][WwInput]::GetWindowRect($h,[ref]$r);` +
    `$sx=$r.L+${Math.round(x)};$sy=$r.T+${Math.round(y)};` +
    `if($sx -ge $r.R -or $sy -ge $r.B){'outside '+($r.R-$r.L)+'x'+($r.B-$r.T);exit 1};` +
    `$old=New-Object WwInput+POINT;[void][WwInput]::GetCursorPos([ref]$old);` +
    `[void][WwInput]::SetCursorPos($sx,$sy);Start-Sleep -Milliseconds 80;` +
    `$p=New-Object WwInput+POINT;$p.X=$sx;$p.Y=$sy;[void][WwInput]::ScreenToClient($h,[ref]$p);` +
    `$lp=[IntPtr](($p.Y -shl 16) -bor ($p.X -band 0xFFFF));` +
    `[void][WwInput]::PostMessage($h,0x200,[IntPtr]0,$lp);Start-Sleep -Milliseconds 40;` +
    `$n=${double ? 2 : 1};for($i=0;$i -lt $n;$i++){` +
    `[void][WwInput]::PostMessage($h,${down},[IntPtr]${wparam},$lp);Start-Sleep -Milliseconds 60;` +
    `[void][WwInput]::PostMessage($h,${up},[IntPtr]0,$lp);Start-Sleep -Milliseconds 60};` +
    `Start-Sleep -Milliseconds 150;` +
    `${restore ? '[void][WwInput]::SetCursorPos($old.X,$old.Y);' : ''}` +
    `'ok '+$sx+' '+$sy+' '+$r.L+' '+$r.T+' '+($r.R-$r.L)+' '+($r.B-$r.T)`
  const p = Bun.spawnSync(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], { stdout: 'pipe', stderr: 'pipe' })
  const stdout = new TextDecoder().decode(p.stdout).trim()
  const stderr = new TextDecoder().decode(p.stderr).trim()
  const m = /^ok (-?\d+) (-?\d+) (-?\d+) (-?\d+) (\d+) (\d+)$/.exec(stdout)
  if (p.exitCode === 0 && m) {
    return { ok: true, status: 'clicked', screen: `${m[1]},${m[2]}`, window: `${m[5]}x${m[6]} at ${m[3]},${m[4]}` }
  }
  const reason = stdout.split(/\s+/)[0] || 'failed'
  return { ok: false, status: ['no_game_window', 'minimized', 'outside'].includes(reason) ? reason : 'click_failed', error: (stdout || stderr).replace(/\s+/g, ' ').slice(0, 300) }
}
