import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "autoboat-theme";

function getInitialTheme(): Theme {
    if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
        return "dark";
    }
    if (typeof window !== "undefined") {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === "dark" || stored === "light") return stored;
        if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    }
    return "light";
}

/**
 * Toggles the `.dark` class on <html> and persists the choice to localStorage.
 * The initial class is set before first paint by the inline script in index.html
 * to avoid FOUC; this hook just keeps React state in sync with the DOM.
 */
export function useTheme() {
    const [theme, setTheme] = useState<Theme>(getInitialTheme);

    useEffect(() => {
        const root = document.documentElement;
        root.classList.toggle("dark", theme === "dark");
        localStorage.setItem(STORAGE_KEY, theme);
    }, [theme]);

    const toggleTheme = () => setTheme((prev) => (prev === "dark" ? "light" : "dark"));

    return { theme, toggleTheme };
}
