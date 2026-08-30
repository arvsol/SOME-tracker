'use strict';

// Answers one question: can this machine read view counts without an API key?
//
//   node scripts/check-source.js                      check a known-good video
//   node scripts/check-source.js <url or video id>    check a specific one
//
// Run it locally, and let the workflow run it too — a CI runner and your
// laptop get treated very differently by YouTube, and this says which of the
// routes actually worked from where it ran.

const providers = require('../lib/providers');
const { parseLink } = require('../lib/parse-link');

// "Me at the zoo" — the first YouTube video, public since 2005.
const DEFAULT_VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

const SOURCES = {
  api: 'the YouTube Data API (key set)',
  'watch-page': 'the public watch page',
  'player-api': "YouTube's own player endpoint",
  piped: 'a Piped instance',
  vimeo: 'the Vimeo API',
};

async function main() {
  const input = process.argv[2] || DEFAULT_VIDEO;
  const link = parseLink(/^[\w-]{11}$/.test(input) ? `https://youtu.be/${input}` : input);

  console.log(`Checking ${link.url}`);
  console.log(`  YOUTUBE_API_KEY: ${providers.hasApiKey() ? 'set' : 'not set (no-key mode)'}`);
  console.log(`  PIPED_API:       ${providers.usingPiped() ? process.env.PIPED_API : 'not set'}\n`);

  const started = Date.now();
  try {
    const stats = await providers.fetchStats(link);
    const took = Date.now() - started;

    console.log(`  Worked, via ${SOURCES[stats.source] || stats.source}, in ${took} ms.\n`);
    console.log(`    title:  ${stats.title ?? '(none)'}`);
    console.log(`    author: ${stats.author ?? '(none)'}`);
    console.log(`    views:  ${stats.views?.toLocaleString() ?? '(none)'}`);
    console.log(`    likes:  ${stats.likes?.toLocaleString() ?? '(none)'}\n`);

    if (stats.views == null) {
      console.error('  No view count came back, so tracking would not work.');
      process.exitCode = 1;
      return;
    }
    console.log('  This machine can track videos without an API key.');
  } catch (err) {
    console.error(`  Failed: ${err.message}\n`);
    console.error('  Options, cheapest first:');
    console.error('    - Run the poller somewhere else (your own machine usually works');
    console.error('      where a CI runner does not).');
    console.error('    - Set PIPED_API to a working Piped instance.');
    console.error('    - Set YOUTUBE_API_KEY.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
