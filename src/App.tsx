import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import Footer from "./components/Footer";
import Header from "./components/Header";
import Fleet from "./pages/Fleet";
import Gallery from "./pages/Gallery";
import Home from "./pages/Home";
import LiveMap from "./pages/LiveMap";
import OurTeam from "./pages/OurTeam";
import Sponsors from "./pages/Sponsors";

export default function App() {
    const location = useLocation();

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
                <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/ourteam" element={<OurTeam />} />
                    <Route path="/fleet" element={<Fleet />} />
                    <Route path="/sponsors" element={<Sponsors />} />
                    <Route path="/gallery" element={<Gallery />} />
                    <Route path="/live" element={<LiveMap />} />
                    <Route path="*" element={<Home />} />
                </Routes>
            </main>
            <Footer />
        </>
    );
}
