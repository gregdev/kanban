import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC_DIR = resolve(WEB_UI_ROOT, "public");
const MANIFEST_PATH = resolve(PUBLIC_DIR, "manifest.json");
const INDEX_HTML_PATH = resolve(WEB_UI_ROOT, "index.html");

// W3C Web App Manifest: orientation and icon `purpose` keywords. Keep these
// lists small on purpose - they exist to catch typos, not to model every value
// a browser may one day accept.
const ORIENTATIONS = new Set([
	"any",
	"natural",
	"landscape",
	"landscape-primary",
	"landscape-secondary",
	"portrait",
	"portrait-primary",
	"portrait-secondary",
]);
const ICON_PURPOSES = new Set(["any", "maskable", "monochrome"]);

interface ManifestImage {
	src: string;
	sizes: string;
	type: string;
	purpose?: string;
	form_factor?: string;
	label?: string;
}

interface WebAppManifest {
	id?: string;
	name: string;
	short_name: string;
	description?: string;
	start_url: string;
	scope?: string;
	display?: string;
	display_override?: string[];
	orientation?: string;
	background_color?: string;
	theme_color?: string;
	categories?: string[];
	icons: ManifestImage[];
	screenshots?: ManifestImage[];
}

interface PngDimensions {
	width: number;
	height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_IHDR_CHUNK = 0x49484452;

function readManifestText(): string {
	return readFileSync(MANIFEST_PATH, "utf8");
}

function readManifest(): WebAppManifest {
	return JSON.parse(readManifestText()) as WebAppManifest;
}

/** Maps a manifest `src` (site-root absolute) to the file served from `public/`. */
function resolvePublicAsset(src: string): string {
	return resolve(PUBLIC_DIR, src.replace(/^\/+/, ""));
}

/**
 * Reads the intrinsic PNG size straight out of the IHDR chunk so a manifest
 * entry cannot claim a size the asset does not actually have.
 */
function readPngDimensions(filePath: string): PngDimensions {
	const bytes: Uint8Array = readFileSync(filePath);
	if (bytes.byteLength < 24) {
		throw new Error(`${filePath} is too small to contain a PNG header.`);
	}
	for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
		if (bytes[index] !== PNG_SIGNATURE[index]) {
			throw new Error(`${filePath} is not a PNG file (bad signature).`);
		}
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(12) !== PNG_IHDR_CHUNK) {
		throw new Error(`${filePath} does not start with an IHDR chunk.`);
	}
	return {
		width: view.getUint32(16),
		height: view.getUint32(20),
	};
}

function formatDimensions({ width, height }: PngDimensions): string {
	return `${width}x${height}`;
}

function assertAssetMatchesDeclaredSize(image: ManifestImage): void {
	const filePath = resolvePublicAsset(image.src);
	const relativePath = relative(PUBLIC_DIR, filePath);
	expect(relativePath.startsWith(".."), `${image.src} must live under web-ui/public`).toBe(false);

	const dimensions = readPngDimensions(filePath);
	expect(image.sizes, `${image.src} declares a size that matches the file`).toBe(formatDimensions(dimensions));
	expect(image.type, `${image.src} is served as a PNG`).toBe("image/png");
}

function hasPurpose(image: ManifestImage, purpose: string): boolean {
	return (image.purpose ?? "any").split(/\s+/).includes(purpose);
}

describe("PWA manifest", () => {
	it("is valid JSON", () => {
		expect(() => JSON.parse(readManifestText())).not.toThrow();
	});

	it("installs the app as Kanban, matching the document title", () => {
		const manifest = readManifest();
		expect(manifest.name).toBe("Kanban");
		expect(manifest.short_name).toBe("Kanban");

		const indexHtml = readFileSync(INDEX_HTML_PATH, "utf8");
		expect(indexHtml).toMatch(/<title>\s*Kanban\s*<\/title>/);
		expect(indexHtml).toContain('rel="manifest"');
	});

	it("brands the offline wait page as Kanban", () => {
		// The service worker's fallback page is what an installed app shows when
		// the runtime is stopped, so it has to use the same app name as the
		// manifest rather than the agent brand.
		const serviceWorkerSource = readFileSync(resolve(PUBLIC_DIR, "sw.js"), "utf8");
		expect(serviceWorkerSource).toContain("<title>Kanban</title>");
		expect(serviceWorkerSource).toContain("Waiting for Kanban");
		expect(serviceWorkerSource).not.toContain("Cline");
	});

	it("declares the install-required metadata", () => {
		const manifest = readManifest();
		expect(manifest.id).toBe("/");
		expect(manifest.start_url).toBe("/");
		expect(manifest.scope).toBe("/");
		expect(manifest.display).toBe("standalone");
		expect(manifest.display_override).toEqual(["window-controls-overlay"]);
		expect(ORIENTATIONS.has(manifest.orientation ?? "")).toBe(true);
		expect((manifest.description ?? "").trim().length).toBeGreaterThan(0);
		expect(manifest.categories?.length).toBeGreaterThan(0);
		for (const category of manifest.categories ?? []) {
			expect(category.trim().length).toBeGreaterThan(0);
		}
	});

	it("keeps the existing colours", () => {
		const manifest = readManifest();
		expect(manifest.background_color).toBe("#1F2428");
		expect(manifest.theme_color).toBe("#24292E");
	});

	it("points every icon at a real PNG of the declared size", () => {
		const manifest = readManifest();
		expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
		for (const icon of manifest.icons) {
			assertAssetMatchesDeclaredSize(icon);
			for (const purpose of (icon.purpose ?? "any").split(/\s+/)) {
				expect(ICON_PURPOSES.has(purpose), `${icon.src} has a known purpose`).toBe(true);
			}
		}
	});

	it("ships a maskable 512px icon that is not the full-bleed launcher icon", () => {
		const manifest = readManifest();
		const maskableIcons = manifest.icons.filter((icon) => hasPurpose(icon, "maskable"));
		expect(maskableIcons.length).toBeGreaterThan(0);

		const maskable512 = maskableIcons.find((icon) => icon.sizes === "512x512");
		expect(maskable512, "a 512x512 maskable icon is registered").toBeDefined();
		if (!maskable512) {
			return;
		}
		// The full-bleed artwork loses its rounded-square edges once Android
		// applies a mask, so it must not double as the maskable asset.
		expect(maskable512.src).not.toBe("/assets/icon-512.png");
		assertAssetMatchesDeclaredSize(maskable512);
	});

	it("points every screenshot at a real PNG of the declared size", () => {
		const manifest = readManifest();
		const screenshots = manifest.screenshots ?? [];
		expect(screenshots.length).toBeGreaterThan(0);
		for (const screenshot of screenshots) {
			assertAssetMatchesDeclaredSize(screenshot);
			expect(screenshot.form_factor, `${screenshot.src} targets a form factor`).toBe("narrow");
			expect((screenshot.label ?? "").trim().length).toBeGreaterThan(0);
		}
	});
});
