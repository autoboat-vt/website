import { Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import Footer from "./components/Footer";
import Header from "./components/Header";
import { usePageMeta } from "./hooks/usePageMeta";
import Home from "./pages/Home";

/**
 * Every route except Home is code-split.
 *
 * WHY LAZY: with all nine pages imported eagerly the app shipped one ~546 kB
 * chunk, so a visitor landing on the home page downloaded Leaflet, the
 * calendar, the gallery viewer, and the whole event-management UI before
 * anything rendered. Splitting per route keeps the first paint small and loads
 * the heavy pages only when someone opens them.
 *
 * WARNING: Home stays eager on purpose. It is the landing page and the `*`
 * fallback, so splitting it would add a round trip before the first thing
 * anyone sees (and the prerendered HTML already contains its content).
 *
 * WARNING: `src/test/lib/seo.test.ts` extracts the route paths from this file with a
 * regex over the Route elements below, to check them against
 * `src/lib/seoRoutes.json`. Keep each real Route on one line with `path` first,
 * and do NOT write a literal path attribute in a comment: the regex cannot tell
 * prose from JSX, so an example becomes a phantom route and the sync test fails.
 */
const Calendar = lazy(() => import("./pages/Calendar"));
const Fleet = lazy(() => import("./pages/Fleet"));
const Gallery = lazy(() => import("./pages/Gallery"));
const LiveMap = lazy(() => import("./pages/LiveMap"));
const Officers = lazy(() => import("./pages/Officers"));
const OtherPages = lazy(() => import("./pages/OtherPages"));
const OurTeam = lazy(() => import("./pages/OurTeam"));
const Sponsors = lazy(() => import("./pages/Sponsors"));

/**
 * Shown while a route's chunk loads.
 *
 * Matches the Calendar page's own loading state so a slow chunk does not look
 * different from slow data. `role="status"` plus `aria-live` announces it, and
 * the text is deliberately generic -- it renders over an empty `<main>` with
 * no header context yet, so naming a page would be guessing.
 */
function RouteFallback() {
    return (
        <div className="flex items-center justify-center gap-2 py-12 text-hovercolor" role="status" aria-live="polite">
            <Loader2 className="animate-spin" size={22} aria-hidden="true" />
            <span>Loading...</span>
        </div>
    );
}

export default function App() {
    const location = useLocation();

    // Per-route <title>, description, canonical, and Open Graph tags.
    // Route metadata lives in src/lib/seoRoutes.json.
    usePageMeta();

    // Scroll to top on route change, or to the #hash target if present.
    // React Router doesn't trigger the browser's native :target scroll on
    // client-side navigation, so we do it manually.
    useEffect(() => {
        if (!location.hash) {
            window.scrollTo(0, 0);
            return;
        }
        const id = location.hash.slice(1);
        const navHeight = parseInt(
            getComputedStyle(document.documentElement).getPropertyValue("--nav-height") || "0",
            10,
        );
        let lastAbsTop = -1;
        const scrollToTarget = (smooth: boolean) => {
            const el = document.getElementById(id);
            if (!el) return;
            // Offset by --nav-height so the section heading isn't hidden
            // under the fixed header. We can't rely on :target + scroll-margin-top
            // because React Router's pushState doesn't activate the :target
            // pseudo-class in all browsers.
            const absTop = el.getBoundingClientRect().top + window.scrollY;
            // Skip if the target's absolute position hasn't changed since the
            // last scroll (layout has settled). Comparing absolute position
            // means a user's manual scroll won't trigger a re-scroll fight.
            if (absTop === lastAbsTop) return;
            lastAbsTop = absTop;
            window.scrollTo({ top: absTop - navHeight, behavior: smooth ? "smooth" : "instant" });
        };
        // Jump close immediately, then re-scroll on a decay schedule so
        // lazy-loaded gallery images (which shift layout) don't leave us
        // offset. We can't use the window `load` event because it may have
        // already fired by the time React mounts and this effect runs.
        const raf = requestAnimationFrame(() => scrollToTarget(false));
        const timers = [200, 400, 700, 1100, 1600].map((ms) => setTimeout(() => scrollToTarget(true), ms));
        return () => {
            cancelAnimationFrame(raf);
            for (const t of timers) clearTimeout(t);
        };
    }, [location]);

    return (
        <>
            <Header />
            <main>
                <Suspense fallback={<RouteFallback />}>
                    <Routes>
                        <Route path="/" element={<Home />} />
                        <Route path="/ourteam" element={<OurTeam />} />
                        <Route path="/fleet" element={<Fleet />} />
                        <Route path="/sponsors" element={<Sponsors />} />
                        <Route path="/other-pages" element={<OtherPages />} />
                        <Route path="/calendar" element={<Calendar />} />
                        <Route path="/gallery" element={<Gallery />} />
                        <Route path="/gallery/:photoId" element={<Gallery />} />
                        <Route path="/live" element={<LiveMap />} />
                        <Route path="/calendar/officers" element={<Officers />} />
                        <Route path="*" element={<Home />} />
                    </Routes>
                </Suspense>
            </main>
            <Footer />
        </>
    );
}
