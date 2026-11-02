// Tauri normally selects only the binary target. The Windows entry EXE loads
// its matching cdylib at runtime, so build that target on every source rebuild.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const args = process.argv.slice(2);
const cargoEnv = { ...process.env };
if (process.platform === 'win32' && !cargoEnv.CARGO_TARGET_DIR && cargoEnv.LOCALAPPDATA) {
  cargoEnv.CARGO_TARGET_DIR = join(cargoEnv.LOCALAPPDATA, 'Rupelian', 'cargo-target');
}
const runCargo = values => {
  const result = spawnSync('cargo', values, {
    env: cargoEnv,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error?.code === 'ENOENT') {
    console.error('Cargo was not found. Install the Rust MSVC toolchain, then open a new PowerShell window.');
    process.exit(1);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};
if (process.platform === 'win32' && args[0] === 'run') {
  const separator = args.indexOf('--');
  const buildArgs = args.slice(1, separator < 0 ? undefined : separator);
  // A selected bin is a run target, not the DLL build target.
  const libraryArgs = [];
  for (let i = 0; i < buildArgs.length; i++) {
    if (buildArgs[i] === '--bin') { i++; continue; }
    if (buildArgs[i].startsWith('--bin=') || buildArgs[i] === '--bins') continue;
    libraryArgs.push(buildArgs[i]);
  }
  runCargo(['build', '--lib', ...libraryArgs]);
} else if (process.platform === 'win32' && args[0] === 'build') {
  if (!args.includes('--lib')) args.splice(1, 0, '--lib');
  if (!args.includes('--bins') && !args.includes('--bin') && !args.some(arg => arg.startsWith('--bin='))) args.splice(1, 0, '--bins');
}
runCargo(args);
