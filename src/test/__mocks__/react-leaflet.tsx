/**
 * Test mock for `react-leaflet`. Leaflet needs a real layout engine and
 * doesn't run cleanly in jsdom, so we stub the entire react-leaflet surface.
 * Wired up via jest.config.js moduleNameMapper so `jest.mock()` hoisting
 * (unreliable under SWC ESM) isn't required.
 *
 * Stubs render plain divs tagged with a data-testid so tests can assert
 * which layers were placed on the map. Props are forwarded to data-*
 * attributes where useful (e.g. Polyline positions, CircleMarker center).
 */
import type { ReactNode } from "react";

interface LayerProps {
    children?: ReactNode;
}

interface PolylineProps extends LayerProps {
    positions?: Array<[number, number]>;
}

interface CircleMarkerProps extends LayerProps {
    center?: [number, number];
}

function MapContainer({ children }: { children: ReactNode }) {
    return <div data-testid="map-container">{children}</div>;
}

function TileLayer() {
    return <div data-testid="tile-layer" />;
}

function Polyline({ positions }: PolylineProps) {
    return <div data-testid="polyline" data-positions={JSON.stringify(positions ?? [])} />;
}

function CircleMarker({ center, children }: CircleMarkerProps) {
    return (
        <div data-testid="circle-marker" data-center={JSON.stringify(center ?? null)}>
            {children}
        </div>
    );
}

function Tooltip({ children, permanent }: { children: ReactNode; permanent?: boolean }) {
    return (
        <div data-testid="tooltip" data-permanent={permanent ? "true" : "false"}>
            {children}
        </div>
    );
}

function useMap() {
    return {
        setView: () => {},
        fitBounds: () => {},
        addControl: () => {},
        removeControl: () => {},
    };
}

export { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap };
