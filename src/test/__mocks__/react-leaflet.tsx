/**
 * Test mock for `react-leaflet`. Leaflet needs a real layout engine and
 * doesn't run cleanly in jsdom, so we stub the entire react-leaflet surface.
 * Wired up via jest.config.js moduleNameMapper so `jest.mock()` hoisting
 * (unreliable under SWC ESM) isn't required.
 */
import type { ReactNode } from "react";

export function MapContainer({ children }: { children: ReactNode }) {
    return <div data-testid="map-container">{children}</div>;
}

export function TileLayer() {
    return <div data-testid="tile-layer" />;
}

export function useMap() {
    return {
        setView: () => {},
        fitBounds: () => {},
        addControl: () => {},
        removeControl: () => {},
    };
}
