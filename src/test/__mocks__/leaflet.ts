/**
 * Test mock for `leaflet`. Provides the small surface LiveMap / BoatMarker
 * touch (divIcon, latLng, latLngBounds) without pulling in the real lib.
 * Exports both named (for `import { latLng }`) and default (for
 * `import L from "leaflet"`) so both import styles work.
 */
export const divIcon = () => ({});
export const latLng = (lat: number, lng: number) => ({ lat, lng });
export const latLngBounds = () => ({});

const L = { divIcon, latLng, latLngBounds };
export default L;
