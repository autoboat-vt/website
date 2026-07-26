---
description: "Use when creating or editing shared UI components (Card, Gallery, ImageModal, Hyperlink) or adding new pages. Covers the page component pattern, the Card content container, Gallery thumbnail grid, ImageModal overlay, and the Hyperlink inline link with UrlString type."
applyTo: "src/components/Card.tsx, src/components/Gallery.tsx, src/components/ImageModal.tsx, src/components/Hyperlink.tsx, src/pages/**"
---

# Component patterns

- **Pages** (`src/pages/`): one default export per route, no props. Compose `Card`, `Gallery`, `ImageModal`, and page-specific sections. Pages set a root `<div className="page-<name>">` for page-scoped CSS.
- **`Card`** (`src/components/Card.tsx`): the standard content container. Props: `as?: ElementType = "section"`, `className?`, `children?`, `id?`, `[key: string]: unknown` (spread to the rendered element). Renders `<h2>` title slot + children. Default width `w-[min(1100px,90%)]`. Used by Fleet, Sponsors, LiveMap panels. If you need a new content box, prefer `Card` over a bespoke container.
- **`Gallery`** (`src/components/Gallery.tsx`): responsive thumbnail grid. Props: `images: GalleryImage[]` (`{ src, alt, caption? }`), `onImageClick?: (image) => void`, `ariaLabel? = "Gallery"`. Grid: `grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3`. Renders a `<button>` wrapper when `onImageClick` is provided, else a bare `<img>`. All images are `loading="lazy"` with hover scale + shadow.
- **`ImageModal`** (`src/components/ImageModal.tsx`): full-screen overlay. Props: `src?`, `alt?`, `caption?`, `onClose: () => void`. Two-phase mount state (`mounted` + `isOpen`) so the enter/exit CSS transition plays. Focus management: stores `document.activeElement` on open, focuses the close button, restores focus on unmount. Closes on Escape key or backdrop click. `role="dialog"` `aria-modal="true"` `aria-label="Image preview"`.
- **`Hyperlink`** (`src/components/Hyperlink.tsx`): reusable inline link with a branded `UrlString` type. Props: `href: UrlString`, `children: ReactNode`, `hash?`, `className?`, `space?: "before"|"after"|"around"|"both"|"none"`. Internal paths (starting with `/`) render as a react-router `<Link>`; external URLs render as `<a target="_blank" rel="noopener noreferrer">` with an sr-only "opens in a new tab" span. Construct `UrlString` via the exported `url(s)` helper (validates with `new URL()`, accepts bare paths like `/ourteam`). The `space` prop inserts surrounding whitespace so you don't need `{" "}` in JSX.

# React 19 notes

- React 19 supports the `fetchPriority` prop on `<img>` (React 18 did not — it caused a console warning). The codebase uses `fetchPriority="high"` on the site logo in `Header.tsx` and conditionally on hero images in `Fleet.tsx`.
- Components using `<Link>` from `react-router-dom` must be wrapped in `<MemoryRouter>` in tests.
