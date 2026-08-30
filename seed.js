'use strict';

// Fills the dashboard with four videos whose histories show the four shapes the
// tracker is meant to tell apart. Handy for a first look, and for checking the
// charts without waiting days for real data.
//
//   node seed.js          add demo rows
//   node seed.js --reset  remove them first

const db = require('./lib/db');

const HOUR = 3600 * 1000;
const DAYS = 14;

const DEMOS = [
  {
    slug: 'breakout-900',
    title: 'Tiny kitchen, huge lasagna — the 12-layer experiment',
    author: 'Weeknight Chaos',
    shape: (h) => 40 * Math.pow(1.022, h),          // accelerating hard
  },
  {
    slug: 'cooling-400',
    title: 'We drove 1,400 km on a single charge (and nearly failed)',
    author: 'Range Anxiety',
    shape: (h) => 9000 * Math.pow(0.985, h),        // big launch, now fading
  },
  {
    slug: 'steady-300',
    title: 'How compound interest actually works, in 6 minutes',
    author: 'Plain Numbers',
    shape: () => 300 + Math.random() * 60,          // evergreen
  },
  {
    slug: 'flat-20',
    title: 'Board meeting recap — Q2 highlights',
    author: 'Internal Comms',
    shape: () => 2 + Math.random() * 3,             // barely watched
  },
];

function seed({ reset }) {
  const now = Date.now();
  const hours = DAYS * 24;

  for (const demo of DEMOS) {
    const id = `demo:${demo.slug}`;
    if (reset) db.deleteVideo(id);
    if (db.getVideo(id)) {
      console.log(`  skipped ${demo.title} (already present)`);
      continue;
    }

    db.addVideo({
      id,
      provider: 'demo',
      externalId: demo.slug,
      url: `https://example.com/demo/${demo.slug}`,
      title: demo.title,
      author: demo.author,
      thumbnail: null,
      publishedAt: new Date(now - hours * HOUR).toISOString(),
    });

    let views = 500 + Math.round(Math.random() * 2000);
    for (let h = hours; h >= 0; h--) {
      views += Math.max(0, Math.round(demo.shape(hours - h)));
      db.insertSnapshotRaw(id, new Date(now - h * HOUR).toISOString(), views);
    }
    console.log(`  seeded ${demo.title} → ${views.toLocaleString()} views`);
  }
}

seed({ reset: process.argv.includes('--reset') });
console.log('\nDone. Start the app with: npm start\n');
