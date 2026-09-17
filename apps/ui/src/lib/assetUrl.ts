const ASSET_VERSION = "20260908-1";

export function assetUrl(path: string) {
  return `${path}?v=${ASSET_VERSION}`;
}