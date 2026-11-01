'use strict';
// A tiny stand-in for the banking app. Usage: SDK_KEY=<development key> npm run demo
const { Flagship } = require('../sdk/js');
(async () => {
  const flags = await new Flagship({ sdkKey: process.env.SDK_KEY, baseUrl: process.env.BASE_URL || 'http://localhost:3000',
    onChange: keys => console.log('Configuration changed, now evaluating', keys.length, 'flags') }).init();
  if (!flags.ready) { console.error('Cannot reach Flagship and there is no cached configuration yet. Check BASE_URL and SDK_KEY.'); process.exit(1); }
  console.log(flags.fromCache ? 'Server unreachable: started from the cached configuration' : 'Connected to Flagship');
  const users = [{ id: 'u1', country: 'Tunisia', type: 'customer' }, { id: 'u2', country: 'France', type: 'customer' }, { id: 'u3', country: 'Tunisia', type: 'internal-test' }];
  const show = () => { for (const u of users) console.log(u.id, u.country.padEnd(8), 'international_transfers =', flags.isEnabled('international_transfers', u), '| checkout =', flags.variation('checkout_redesign', u, 'control')); };
  show();
  // simulate conversions for the A/B test
  for (let i = 0; i < 500; i++) { const u = { id: 'shopper-' + i }; const v = flags.variation('checkout_redesign', u, 'control'); if (i % (v === 'new_checkout' ? 3 : 5) === 0) flags.track(u.id, 'purchase'); }
  await flags.flush();
  console.log('Change a flag in the dashboard and watch this window. Press Ctrl+C to stop.');
  setInterval(show, 15000);
})().catch(e => { console.error(e.message); process.exit(1); });
