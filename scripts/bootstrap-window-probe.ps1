param([Parameter(Mandatory=$true)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
# Inspect and send native test messages only to the loading window belonging
# to the exact child process launched by cdp-bootstrap-interaction-smoke.mjs.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class BootstrapProbe {
  public delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static IntPtr Find(uint process) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((window, parameter) => {
      uint owner; GetWindowThreadProcessId(window, out owner);
      if (owner != process) return true;
      var name = new StringBuilder(256); GetClassName(window, name, name.Capacity);
      if (!name.ToString().EndsWith("-bootstrap")) return true;
      found = window; return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@
# Match the per-monitor-aware app; otherwise GetWindowRect is virtualized at
# desktop scaling and cannot be compared with Tauri's physical position.
[void][BootstrapProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
$window = [BootstrapProbe]::Find($ProcessId)
if ($window -eq [IntPtr]::Zero) { throw 'The test child has no loading window' }
$before = [BootstrapProbe+Rect]::new()
[void][BootstrapProbe]::GetWindowRect($window,[ref]$before)
$hits = @()
foreach ($fractionY in @(0.05,0.5,0.95)) {
  foreach ($fractionX in @(0.05,0.5,0.95)) {
    $x = $before.Left + [int](($before.Right-$before.Left)*$fractionX)
    $y = $before.Top + [int](($before.Bottom-$before.Top)*$fractionY)
    $point = [IntPtr](($y -shl 16) -bor ($x -band 65535))
    $hit = [BootstrapProbe]::SendMessage($window,0x84,[IntPtr]::Zero,$point).ToInt64()
    if ($hit -ne 2) { throw 'The entire loading surface must route native caption dragging' }
    $hits += $hit
  }
}
if (-not [BootstrapProbe]::SetWindowPos($window,[IntPtr]::Zero,$before.Left+23,$before.Top+19,0,0,0x15)) { throw 'Could not move test loading window' }
$moved = [BootstrapProbe+Rect]::new()
[void][BootstrapProbe]::GetWindowRect($window,[ref]$moved)
if ($moved.Left -ne $before.Left+23 -or $moved.Top -ne $before.Top+19) { throw 'The loading window did not move' }
# Application deactivation is what Windows delivers when the user clicks away.
[void][BootstrapProbe]::SendMessage($window,0x1C,[IntPtr]::Zero,[IntPtr]::Zero)
if (-not [BootstrapProbe]::IsIconic($window)) { throw 'Click-away deactivation did not minimize the loading window' }
[pscustomobject]@{dragHitTests=$hits; before=$before; moved=$moved; minimized=$true} | ConvertTo-Json -Depth 4 -Compress
