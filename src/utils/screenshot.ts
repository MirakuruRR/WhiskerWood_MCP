import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
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

export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PostProcessResult {
  ok: boolean
  master: string
  attach: string
  attachMime: 'image/png' | 'image/jpeg'
  error?: string
}

const KEEP_PER_PREFIX = 20

function sweepScreenshotDir(dir: string): void {
  for (const prefix of ['wwmcp-attach-', 'wwmcp-crop-', 'wwmcp-window-']) {
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.startsWith(prefix))
    } catch {
      continue
    }
    const stamped = files
      .map((f) => ({ f, m: statSync(`${dir}/${f}`).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    for (const old of stamped.slice(KEEP_PER_PREFIX)) {
      try {
        rmSync(`${dir}/${old.f}`)
      } catch {
        /* файл занят читателем — уйдёт в следующий раз */
      }
    }
  }
}

// Пост-обработка мастер-кадра: кроп в нативе (PNG) либо ужатая копия JPEG q82 по боксу.
// Мастер не переписывается: путь до него отдаётся в field file для сравнения между правками.
export function postProcessScreenshot(
  config: ServerConfig,
  src: string,
  crop: CropRect | null,
  boxW: number,
  boxH: number,
  limitBytes: number,
): PostProcessResult {
  const dir = `${config.stateDir}/screenshots`
  mkdirSync(dir, { recursive: true })
  sweepScreenshotDir(dir)
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')
  const outMaster = `${dir}/wwmcp-crop-${ts}.png`
  const outAttach = `${dir}/wwmcp-attach-${ts}.jpg`
  const c = crop
    ? { x: Math.max(0, Math.round(crop.x)), y: Math.max(0, Math.round(crop.y)), w: Math.round(crop.w), h: Math.round(crop.h) }
    : null
  const script =
    `Add-Type -AssemblyName System.Drawing;` +
    `$src='${src}';$cx=${c ? c.x : -1};$cy=${c ? c.y : 0};$cw=${c ? c.w : 0};$ch=${c ? c.h : 0};` +
    `$om='${outMaster}';$oa='${outAttach}';$bw=${boxW};$bh=${boxH};$limit=${limitBytes};` +
    `$img=[System.Drawing.Image]::FromFile($src);$work=$img;$master=$src;` +
    `if($cx -ge 0){$bx=$cx;$by=$cy;$wd=[Math]::Min($img.Width-$bx,$cw);$ht=[Math]::Min($img.Height-$by,$ch);` +
    `if($wd -le 0 -or $ht -le 0 -or $bx -ge $img.Width -or $by -ge $img.Height){'crop_out_of_bounds';exit 1};` +
    `$rect=New-Object System.Drawing.Rectangle $bx,$by,$wd,$ht;` +
    `$work=([System.Drawing.Bitmap]$img).Clone($rect,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb);` +
    `$work.Save($om,[System.Drawing.Imaging.ImageFormat]::Png);$master=$om};` +
    `'master='+$master;` +
    `if(($cx -ge 0) -and ((Get-Item $master).Length -le $limit)){'attach='+$master;'attach_mime=image/png'}` +
    `else{$scale=[Math]::Min(1.0,[Math]::Min($bw/$work.Width,$bh/$work.Height));` +
    `$nw=[int][Math]::Max(1.0,$work.Width*$scale);$nh=[int][Math]::Max(1.0,$work.Height*$scale);` +
    `$dst=New-Object System.Drawing.Bitmap $nw,$nh;$g=[System.Drawing.Graphics]::FromImage($dst);` +
    `$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;` +
    `$g.DrawImage($work,0,0,$nw,$nh);` +
    `$codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' };` +
    `$ep=New-Object System.Drawing.Imaging.EncoderParameters 1;` +
    `$ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]82);` +
    `$dst.Save($oa,$codec,$ep);$g.Dispose();$dst.Dispose();'attach='+$oa;'attach_mime=image/jpeg'};` +
    `if($work -ne $img){$work.Dispose()};$img.Dispose();'ok'`
  const p = Bun.spawnSync(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = new TextDecoder().decode(p.stdout).trim()
  const stderr = new TextDecoder().decode(p.stderr).trim()
  if (p.exitCode !== 0 || !stdout.split(/\r?\n/).includes('ok')) {
    return { ok: false, master: src, attach: '', attachMime: 'image/jpeg', error: (stderr || stdout).replace(/\s+/g, ' ').slice(0, 300) }
  }
  const line = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(stdout)?.[1]?.trim() ?? ''
  return { ok: true, master: line('master'), attach: line('attach'), attachMime: line('attach_mime') === 'image/png' ? 'image/png' : 'image/jpeg' }
}
