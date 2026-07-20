/**
 * Virginia Tech official brand colors.
 *
 * Source: https://brand.vt.edu/identity/color.html
 * Fetched: 2026-07-20
 *
 * Two palettes:
 *   - Primary:   Chicago Maroon, Burnt Orange (+ Hokie Stone, Yardline White neutrals)
 *   - Secondary: Pylon Purple, Boundless Pink, Triumphant Yellow, Sustainable Teal,
 *                Vibrant Turquoise, Land Grant Grey, Skipper Smoke, Impact Orange
 *
 * Brand rules (see brand.vt.edu):
 *   - Logo files must always be Chicago Maroon + Burnt Orange.
 *   - Shading (darkening) of maroon/orange is permitted; tinting (lightening) is NOT.
 *     For a translucent look, use a multiply treatment instead.
 *   - Hokie Stone, Yardline White, and all secondary colors may be shaded OR tinted.
 *   - "Impact Orange" replaces Burnt Orange for digital text — it's darker with
 *     higher contrast for WCAG AA accessibility.
 *   - WCAG 2.1 Level AA contrast required (≥4.5:1 normal text, ≥3:1 large text/UI).
 *
 * Usage in TS/CSS:
 *   import { VT_COLORS } from "../lib/vtColors";
 *   VT_COLORS.primary.maroon.hex    // "#861F41"
 *   VT_COLORS.primary.maroon.rgb    // "134, 31, 65"
 *
 *   In CSS, use the official variable names:
 *   color: var(--vt-maroon);
 *
 * The CSS custom properties are NOT defined here — this file is a reference.
 * To use them in CSS, define them in your @theme or :root block, e.g.:
 *   --vt-maroon: #861F41;
 */

export interface VtColor {
    /** Human-readable name (e.g. "Chicago Maroon"). */
    name: string;
    /** Uppercase hex without alpha (e.g. "#861F41"). */
    hex: string;
    /** RGB triplet as a comma-separated string (e.g. "134, 31, 65"). */
    rgb: string;
    /** Official CSS custom property name from brand.vt.edu (e.g. "--vt-maroon"). */
    cssVar: string;
    /** CMYK percentages (e.g. "15, 100, 37, 45"). */
    cmyk: string;
    /** Pantone match (e.g. "PMS 208"). */
    pantone: string;
}

export const VT_COLORS = {
    primary: {
        maroon: {
            name: "Chicago Maroon",
            hex: "#861F41",
            rgb: "134, 31, 65",
            cssVar: "--vt-maroon",
            cmyk: "15, 100, 37, 45",
            pantone: "PMS 208",
        },
        burntOrange: {
            name: "Burnt Orange",
            hex: "#E5751F",
            rgb: "229, 117, 31",
            cssVar: "--vt-burntOrange",
            cmyk: "0, 62, 95, 0",
            pantone: "PMS 158",
        },
        hokieStone: {
            name: "Hokie Stone",
            hex: "#75787B",
            rgb: "117, 120, 123",
            cssVar: "--vt-hokieStone",
            cmyk: "26, 21, 19, 45",
            pantone: "PMS Cool Gray 9C",
        },
        yardlineWhite: {
            name: "Yardline White",
            hex: "#FFFFFF",
            rgb: "255, 255, 255",
            cssVar: "--vt-white",
            cmyk: "0, 0, 0, 0",
            pantone: "PMS White",
        },
    },
    secondary: {
        pylonPurple: {
            name: "Pylon Purple",
            hex: "#642667",
            rgb: "100, 38, 103",
            cssVar: "--vt-purple",
            cmyk: "65, 100, 22, 18",
            pantone: "PMS 260C",
        },
        boundlessPink: {
            name: "Boundless Pink",
            hex: "#CE0058",
            rgb: "206, 0, 88",
            cssVar: "--vt-pink",
            cmyk: "0, 100, 43, 12",
            pantone: "PMS Rubine Red",
        },
        triumphantYellow: {
            name: "Triumphant Yellow",
            hex: "#F7EA48",
            rgb: "247, 234, 72",
            cssVar: "--vt-yellow",
            cmyk: "5, 0, 85, 1",
            pantone: "PMS 101C",
        },
        sustainableTeal: {
            name: "Sustainable Teal",
            hex: "#508590",
            rgb: "80, 133, 144",
            cssVar: "--vt-teal",
            cmyk: "75, 35, 40, 3",
            pantone: "PMS 2212C",
        },
        vibrantTurquoise: {
            name: "Vibrant Turquoise",
            hex: "#2CD5C4",
            rgb: "44, 213, 196",
            cssVar: "--vt-turquoise",
            cmyk: "70, 0, 30, 0",
            pantone: "PMS 319C",
        },
        landGrantGrey: {
            name: "Land Grant Grey",
            hex: "#D7D2CB",
            rgb: "215, 210, 203",
            cssVar: "--vt-grey",
            cmyk: "",
            pantone: "",
        },
        skipperSmoke: {
            name: "Skipper Smoke",
            hex: "#E5E1E6",
            rgb: "229, 225, 230",
            cssVar: "--vt-smoke",
            cmyk: "",
            pantone: "",
        },
        impactOrange: {
            name: "Impact Orange",
            hex: "#CA4F00",
            rgb: "202, 79, 0",
            cssVar: "--vt-impactOrange",
            cmyk: "",
            pantone: "",
            notes: "Darker than Burnt Orange. Use INSTEAD of Burnt Orange for digital text (WCAG AA).",
        },
    },
} as const;

/**
 * Flat lookup by hex value (case-insensitive).
 * @example byHex("#861f41") → VT_COLORS.primary.maroon
 */
export function byHex(hex: string): VtColor | undefined {
    const target = hex.toUpperCase();
    for (const group of Object.values(VT_COLORS)) {
        for (const color of Object.values(group)) {
            if (color.hex.toUpperCase() === target) return color;
        }
    }
    return undefined;
}

/**
 * Flat lookup by official CSS variable name (case-insensitive).
 * @example byCssVar("--vt-maroon") → VT_COLORS.primary.maroon
 */
export function byCssVar(name: string): VtColor | undefined {
    const target = name.toLowerCase();
    for (const group of Object.values(VT_COLORS)) {
        for (const color of Object.values(group)) {
            if (color.cssVar.toLowerCase() === target) return color;
        }
    }
    return undefined;
}
