/**
 * Test mock for `leaflet`. Provides the small surface LiveMap / BoatMarker
 * touch (icon, divIcon, latLng, latLngBounds, control.scale) without
 * pulling in the real lib. Exports both named (for `import { latLng }`)
 * and default (for `import L from "leaflet"`) so both import styles work.
 */
export const icon = () => ({});
export const divIcon = () => ({});
export const latLng = (lat: number, lng: number) => ({ lat, lng });
export const latLngBounds = () => ({});

const control = {
    scale: () => ({
        addTo: () => {},
    }),
};

const L = { icon, divIcon, latLng, latLngBounds, control };
export default L;
