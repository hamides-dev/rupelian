import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = args => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(result.stderr?.trim() || 'Git could not inspect the repository.');
  return result.stdout;
};
const files = git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
const errors = [];
for (const entry of files) {
  const [metadata, path] = entry.split('\t');
  const [, object, stage] = metadata.split(' ');
  if (stage !== '0') { errors.push(`Unresolved merge: ${path}`); continue; }
  if (/(^|\/)(node_modules|dist|target|artifacts|WebView2Runtime|\.cache|\.playwright-mcp)(\/|$)|\.(exe|dll|pdb|lib|exp|sfx|zip|7z|pem|key|p12|pfx|sqlite3?|db)(-|$)|(^|\/)(credentials\.json|youtube-session\.json|cookies\.txt|settings\.json|\.env(?:\..*)?)$|\.local(?:\.|$)/i.test(path)) {
    errors.push(`Forbidden generated, credential, or runtime file: ${path}`);
    continue;
  }
  const size = Number(git(['cat-file', '-s', object]).trim());
  if (size > 5 * 1024 * 1024) { errors.push(`File exceeds the 5 MiB source limit: ${path}`); continue; }
  if (/\.(png|jpe?g|ico|icns)$/i.test(path)) continue;
  const content = git(['cat-file', 'blob', object]);
  const secret = /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_]{32,}|AIza[A-Za-z0-9_-]{35}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
  if (secret.test(content)) errors.push(`Possible credential detected in ${path}; inspect locally before publishing.`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Repository hygiene passed for ${files.length} staged/tracked files.`);
}
