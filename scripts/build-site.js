'use strict';

// Assembles the static dashboard into _site/ for GitHub Pages.
//
// There is no bundler. The shared modules are plain CommonJS so Node can
// require them; this wraps each one in a function scope and hands it to the
// browser under a global name, which keeps a single copy of the analysis code
// instead of a browser fork that drifts.
//
//   node scripts/build-site.js            build for Pages
//   node scripts/build-site.js --local    build for local preview

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_site');
const local = process.argv.includes('--local');

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  copy('site/index.html', 'index.html');
  copy('site/app.js', 'app.js');
  copy('public/styles.css', 'styles.css');
  copy('site/styles-extra.css', 'styles-extra.css');
  copy('lib/dashboard.js', 'dashboard.js');

  browserify('lib/metrics.js', 'metrics.js', 'TrackerMetrics');
  browserify('lib/parse-link.js', 'parse-link.js', 'TrackerLinks');

  fs.writeFileSync(path.join(OUT, 'config.js'), config());
  console.log(`Built ${OUT}${local ? ' (local preview)' : ''}`);
}

// `module.exports = {...}` becomes `globalThis.Name = {...}`, and the whole
// file goes inside an IIFE so its helpers cannot collide with another script's.
function browserify(from, to, globalName) {
  const source = fs.readFileSync(path.join(ROOT, from), 'utf8');
  if (!source.includes('module.exports =')) {
    throw new Error(`${from} has no "module.exports =" to rewrite`);
  }
  const body = source.replace('module.exports =', `globalThis.${globalName} =`);
  fs.writeFileSync(path.join(OUT, to), `(function () {\n${body}\n})();\n`);
}

function config() {
  const [owner, repo] = repoSlug().split('/');
  const branch = process.env.GITHUB_REF_NAME || 'main';

  if (local) {
    // Preview against the working copy's own data files.
    fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
    for (const name of ['videos.json', 'history.json']) {
      copy(path.join('data', name), path.join('data', name));
    }
  }

  return `globalThis.TRACKER_CONFIG = ${JSON.stringify({
    owner, repo, branch,
    dataBase: local ? './data' : `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/data`,
    local,
  }, null, 2)};\n`;
}

// On Actions this comes free; locally it is read from the git remote so a
// preview build points at the same repo the real one would.
function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const config = fs.readFileSync(path.join(ROOT, '.git', 'config'), 'utf8');
    const match = config.match(/github\.com[:/]([^/\s]+\/[^/\s.]+)(\.git)?/);
    if (match) return match[1];
  } catch { /* fall through */ }
  return 'owner/repo';
}

function copy(from, to) {
  const target = path.join(OUT, to);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(ROOT, from), target);
}

main();
