/**
 * Resource popularity came from a shared community hub. A private instance has
 * none, so the map is always empty and the item list falls back to best match.
 */
const EMPTY = new Map<string, number>();

export function getResourcePopularity(): Map<string, number> {
  return EMPTY;
}
