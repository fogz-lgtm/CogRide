// Two apps from one codebase:
//  - CogRide: a KICKR Core with a Zwift Cog and Click (virtual shifting).
//  - FluxRide: a Tacx Flux S ridden with the bike's own gears, no controllers.
// build.js stamps the variant into each build; in development,
// ?variant=flux previews FluxRide.

const STAMPED = '__VARIANT__';

function asked() {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('variant');
  } catch {
    return null;
  }
}

export const VARIANT = STAMPED === 'flux' || (STAMPED.startsWith('__') && asked() === 'flux') ? 'flux' : 'cog';

const APPS = {
  cog: {
    name: 'CogRide',
    storage: 'cogride',
    setup: 'a KICKR Core with a Zwift Cog and Click',
    virtualGears: true,
    controllers: true,
  },
  flux: {
    name: 'FluxRide',
    storage: 'fluxride',
    setup: 'a Tacx Flux S and your bike’s own gears',
    virtualGears: false,
    controllers: false,
  },
};

export const APP = APPS[VARIANT];
export const isFlux = VARIANT === 'flux';

// This app's localStorage / sessionStorage key. Both apps live on the same
// site, so everything is kept apart except the Strava connection, which
// they share (see services/strava.js).
export const storeKey = (name) => `${APP.storage}.${name}`;
