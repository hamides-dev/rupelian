import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if (existsSync('.git')) {
  const current = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { encoding: 'utf8', windowsHide: true });
  const configured = current.stdout?.trim();
  if (configured && configured !== '.githooks') {
    console.warn(`Existing Git hooks path preserved: ${configured}. Run npm run check before committing and pushing.`);
  } else {
    const result = spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) process.exitCode = 1;
  }
}
