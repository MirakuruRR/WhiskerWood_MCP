import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { ServerConfig } from '../config'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface PngStamp {
  mtimeMs: number
  size: number
}

export function screenshotsDir(config: ServerConfig): string {
  return `${dirname(config.saveDir)}/Screenshots/Windows`
}

export function screenshotPngs(dir: string): Map<string, PngStamp> {
  const out = new Map<string, PngStamp>()
  try {
    for (const f of readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.png')) continue
      try {
        const st = statSync(`${dir}/${f}`)
        out.set(f, { mtimeMs: st.mtimeMs, size: st.size })
      } catch {
        /* файл исчез между readdir и stat */
      }
    }
  } catch {
    /* каталога ещё нет: игра ни разу не писала скриншоты */
  }
  return out
}

export async function waitForNewScreenshot(
  dir: string,
  before: Map<string, PngStamp>,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const now = screenshotPngs(dir)
    let candidate: { name: string; mtimeMs: number } | null = null
    for (const [name, st] of now) {
      const prev = before.get(name)
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue
      if (!candidate || st.mtimeMs > candidate.mtimeMs) candidate = { name, mtimeMs: st.mtimeMs }
    }
    if (candidate) {
      const path = `${dir}/${candidate.name}`
      const first = statSync(path).size
      await sleep(500)
      if (statSync(path).size === first) return path
    }
    await sleep(400)
  }
  return null
}

// Снимок игрового окна (класс UnrealWindow) через PrintWindow: кадр с HUD, каким его
// видит игрок, работает даже перекрытым. Главное окно процесса — консоль UE4SS, поэтому
// окно вьюпорта ищется обходом EnumWindows, а не через MainWindowHandle.
export function captureWindowPng(config: ServerConfig, pid: number): { ok: boolean; path: string; error?: string } {
  const dir = `${config.stateDir}/screenshots`
  mkdirSync(dir, { recursive: true })
  const out = `${dir}/wwmcp-window-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')}.png`
  const script =
    `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;using System.Text;public class WwShot{` +
    `public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);` +
    `[DllImport("user32.dll")]public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);` +
    `[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);` +
    `[DllImport("user32.dll")]public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);` +
    `[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr hWnd);` +
    `[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h, out RECT r);` +
    `[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);` +
    `[StructLayout(LayoutKind.Sequential)]public struct RECT{public int L;public int T;public int R;public int B;}}';` +
    `Add-Type -AssemblyName System.Drawing;` +
    `$target=[uint32]${pid};$script:found=[IntPtr]::Zero;` +
    `$cb=[WwShot+EnumWindowsProc]{param($h,$l);$wp=[uint32]0;[void][WwShot]::GetWindowThreadProcessId($h,[ref]$wp);if($wp -eq $target -and [WwShot]::IsWindowVisible($h)){$sb=New-Object System.Text.StringBuilder 256;[void][WwShot]::GetClassName($h,$sb,256);if($sb.ToString() -eq 'UnrealWindow'){$script:found=$h;return $false}};return $true};` +
    `[void][WwShot]::EnumWindows($cb,[IntPtr]::Zero);` +
    `if($script:found -eq [IntPtr]::Zero){'no_game_window';exit 1};` +
    `$r=New-Object WwShot+RECT;[void][WwShot]::GetWindowRect($script:found,[ref]$r);` +
    `$w=$r.R-$r.L;$hgt=$r.B-$r.T;if($w -le 0 -or $hgt -le 0){'bad_rect';exit 1};` +
    `$bmp=New-Object System.Drawing.Bitmap $w,$hgt;$g=[System.Drawing.Graphics]::FromImage($bmp);$hdc=$g.GetHdc();` +
    `$okP=[WwShot]::PrintWindow($script:found,$hdc,2);if(-not $okP){$okP=[WwShot]::PrintWindow($script:found,$hdc,0)};` +
    `$g.ReleaseHdc($hdc);if(-not $okP){'print_failed';exit 1};` +
    `$bmp.Save('${out}',[System.Drawing.Imaging.ImageFormat]::Png);$g.Dispose();$bmp.Dispose();'ok'`
  const p = Bun.spawnSync(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = new TextDecoder().decode(p.stdout).trim()
  const stderr = new TextDecoder().decode(p.stderr).trim()
  if (p.exitCode === 0 && stdout === 'ok') return { ok: true, path: out }
  return { ok: false, path: out, error: (stderr || stdout).replace(/\s+/g, ' ').slice(0, 300) }
}
