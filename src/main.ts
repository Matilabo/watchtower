import { bootstrapApplication } from '@angular/platform-browser';

import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

bootstrapApplication(AppComponent, appConfig).catch((error: unknown) => {
  // Last line of defence: if the app cannot start there is no UI to report it
  // in, so say something in the document itself rather than failing silently.
  const message = error instanceof Error ? error.message : 'Unknown startup failure';
  const host = document.querySelector('wt-root');
  if (host !== null) {
    host.textContent = `Watchtower could not start: ${message}`;
  }
});
