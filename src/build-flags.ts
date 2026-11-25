declare const __TANGROW_OWNER_BUILD__: boolean | undefined;

/**
 * True only in bundles made by `npm run build:owner` for the maintainer's own vaults. Such a build never restricts
 * access and never contacts the license service. Release packaging rejects it.
 */
export const OWNER_BUILD = typeof __TANGROW_OWNER_BUILD__ !== 'undefined' && __TANGROW_OWNER_BUILD__ === true;
