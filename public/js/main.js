/* BUSY Web OS portal — entry point */

import { initDevice } from './device.js';
import { startRouter } from './router.js';

// Official BUSY wordmark (fill="currentColor", tinted by CSS)
fetch('/busy-logo.svg')
  .then((res) => res.text())
  .then((svg) => { document.getElementById('logo-svg').innerHTML = svg; })
  .catch(() => { document.getElementById('logo-svg').textContent = 'BUSY'; });

initDevice();
startRouter();
