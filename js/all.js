// add and remove mobile navbar
const mobileNavbarLinksContainer = document.getElementById(
    "mobile-navbar-links-container"
);
const mobileTopNavbar = document.getElementById("mobile-top-navbar");
let mobileIsDisplayed = false;
// Handle navbar scroll effect
const topNavbar = document.getElementById("top-navbar");
window.addEventListener("scroll", () => {
    if (window.scrollY > 50) {
        topNavbar.classList.add("navbar-scrolled");
    } else {
        topNavbar.classList.remove("navbar-scrolled");
    }
});

// Create floating bubbles
function createBubbles() {
    const container = document.body;
    const bubbleCount = 20;

    // Remove any existing bubbles
    const existingBubbles = document.querySelectorAll(".particle");
    existingBubbles.forEach(bubble => bubble.remove());

    for (let i = 0; i < bubbleCount; i++) {
        const bubble = document.createElement("div");
        bubble.className = "particle";

        // Random size between 8 and 16 pixels
        const size = Math.random() * 4 + 8;
        bubble.style.width = `${size}px`;
        bubble.style.height = `${size}px`;

        // Random starting position
        bubble.style.left = `${Math.random() * 100}%`;
        bubble.style.bottom = `${Math.random() * 20 - 20}%`; // Start from bottom

        // Random animation
        const duration = Math.random() * 3 + 4; // Faster animation
        const delay = Math.random() * 3;
        const swayAmount = Math.random() * 30 + 20; // Random sway amount

        // Create unique animation for each bubble
        const animationName = `float-${i}`;
        const style = document.createElement("style");
        style.textContent = `
            @keyframes ${animationName} {
                0% {
                    transform: translateY(0) translateX(0);
                    opacity: 0;
                }
                10% {
                    opacity: 0.6;
                }
                90% {
                    opacity: 0.6;
                }
                100% {
                    transform: translateY(-120vh) translateX(${swayAmount}px);
                    opacity: 0;
                }
            }
        `;
        document.head.appendChild(style);

        bubble.style.animation = `${animationName} ${duration}s ease-out ${delay}s infinite`;
        container.appendChild(bubble);
    }
}

// Create animated sand waves
function createSandWaves() {
    const bottomNavbar = document.getElementById("bottom-navbar");
    if (!bottomNavbar) return;

    // Remove existing wave element if it exists
    const existingWave = bottomNavbar.querySelector(".sand-wave");
    if (existingWave) existingWave.remove();

    // Create wave element
    const wave = document.createElement("div");
    wave.className = "sand-wave";
    bottomNavbar.appendChild(wave);

    // Animation variables
    let time = 0;
    const amplitude = 3; // Wave height
    const frequency = 0.02; // Wave frequency
    const speed = 0.05; // Animation speed

    // Animation function
    function animateWave() {
        time += speed;
        const points = [];
        const segments = 20; // Number of Bezier curves

        // Generate Bezier curve points
        for (let i = 0; i <= segments; i++) {
            const x = (i / segments) * 100;
            const y = 15 + Math.sin(x * frequency + time) * amplitude;

            if (i === 0) {
                // Start point
                points.push(`M ${x}% ${y}%`);
            } else {
                // Control points and end point for each Bezier curve
                const prevX = ((i - 1) / segments) * 100;
                const prevY =
                    15 + Math.sin(prevX * frequency + time) * amplitude;
                const cp1x = prevX + (x - prevX) * 0.5;
                const cp1y = prevY;
                const cp2x = prevX + (x - prevX) * 0.5;
                const cp2y = y;
                points.push(
                    `C ${cp1x}% ${cp1y}%, ${cp2x}% ${cp2y}%, ${x}% ${y}%`
                );
            }
        }

        // Add bottom corners to close the path
        points.push("L 100% 100%");
        points.push("L 0% 100%");
        points.push("Z");

        // Update wave shape
        wave.style.clipPath = `path('${points.join(" ")}')`;
        requestAnimationFrame(animateWave);
    }

    // Start animation
    animateWave();
}

// Create random sand grains
function createSandGrains() {
    const bottomNavbar = document.getElementById("bottom-navbar");
    if (!bottomNavbar) return;

    // Remove existing sand grains
    const existingGrains = bottomNavbar.querySelectorAll(".sand-grain");
    existingGrains.forEach(grain => grain.remove());

    // Create new sand grains
    const grainCount = 200; // Increased number of grains
    for (let i = 0; i < grainCount; i++) {
        const grain = document.createElement("div");
        grain.className = "sand-grain";

        // Random size between 0.5 and 4 pixels for more variety
        const size = Math.random() * 3.5 + 0.5;
        grain.style.width = `${size}px`;
        grain.style.height = `${size}px`;

        // Random position with better distribution
        grain.style.left = `${Math.random() * 100}%`;
        grain.style.top = `${Math.random() * 100}%`;

        // Random opacity for depth
        grain.style.opacity = (Math.random() * 0.15 + 0.05).toString();

        // Random rotation
        grain.style.transform = `rotate(${Math.random() * 360}deg)`;

        // Random shape (some grains are more oval)
        if (Math.random() > 0.7) {
            grain.style.borderRadius = "25%";
        }

        // Random color variation
        const colorVariation = Math.random() * 0.2 + 0.8;
        grain.style.background = `rgba(255, 255, 255, ${0.3 * colorVariation})`;

        bottomNavbar.appendChild(grain);
    }
}

// Initialize animations when the page loads
window.addEventListener("load", () => {
    createBubbles();
    createSandWaves();
    createSandGrains();
});

// Recreate animations when window is resized
window.addEventListener("resize", () => {
    createBubbles();
    createSandWaves();
    createSandGrains();
});

// Recreate animations periodically to ensure they're always present
setInterval(() => {
    createBubbles();
    createSandWaves();
    createSandGrains();
}, 30000);

const hamburgerIcon = document.getElementById("hamburger-icon");

function checkMobileMenu() {
    if (window.innerWidth <= 750) {
        hamburgerIcon.style.display = "block";
        if (!mobileIsDisplayed) {
            mobileTopNavbar.classList.add("navhidden");
        }
    } else {
        hamburgerIcon.style.display = "none";
        mobileTopNavbar.classList.add("navhidden");
        mobileIsDisplayed = false;
    }
}

hamburgerIcon.addEventListener("click", function () {
    mobileIsDisplayed = !mobileIsDisplayed;
    if (mobileIsDisplayed) {
        mobileTopNavbar.classList.remove("navhidden");
    } else {
        mobileTopNavbar.classList.add("navhidden");
    }
});

window.addEventListener("resize", checkMobileMenu);
window.addEventListener("DOMContentLoaded", checkMobileMenu);
