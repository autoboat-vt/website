import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import Footer from "./components/Footer";
import Header from "./components/Header";
import Fleet from "./pages/Fleet";
import Gallery from "./pages/Gallery";
import Home from "./pages/Home";
import HowToJoin from "./pages/HowToJoin";
import OurTeam from "./pages/OurTeam";
import Sponsors from "./pages/Sponsors";

export default function App() {
    const location = useLocation();

    // Scroll to top on route change (unless there's a hash, e.g. #software)
    useEffect(() => {
        if (!location.hash) {
            window.scrollTo(0, 0);
        }
    }, [location]);

    return (
        <>
            <Header />
            <main>
                <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/ourteam" element={<OurTeam />} />
                    <Route path="/fleet" element={<Fleet />} />
                    <Route path="/how-to-join" element={<HowToJoin />} />
                    <Route path="/sponsors" element={<Sponsors />} />
                    <Route path="/gallery" element={<Gallery />} />
                    <Route path="*" element={<Home />} />
                </Routes>
            </main>
            <Footer />
        </>
    );
}
