/**
 * Provider logo preparation, ported from the old working plugin.
 *
 * Owner-supplied SVG files live under `assets/logos/<name>.svg` inside the
 * .sdPlugin directory. The Stream Deck key rasterizer does not render nested
 * `<svg>` elements, so the file's root tag is discarded entirely: the inner
 * shapes are re-wrapped in a `<g>` carrying the root's inheritable
 * presentation attributes, and the renderer positions them with a plain
 * transform (translate+scale computed from the file's viewBox). Scripts and
 * event-handler attributes are rejected; `<title>`/`<desc>` metadata is
 * stripped. Returns undefined for anything unusable — logo rendering is
 * always optional and can never break the key.
 */

export type PreparedLogo = {
  /** Inner markup wrapped in a `<g>` that carries the root's inheritable presentation attributes. */
  body: string;
  viewBox: { minX: number; minY: number; width: number; height: number };
};

/** Root presentation attributes that inner shapes may inherit and must survive root-tag removal. */
const INHERITABLE_ATTRS = ["fill", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity", "color"];
const DEFAULT_CURRENT_COLOR = "#e8e8e8";

function getAttr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return match ? (match[2] ?? match[3]) : undefined;
}

export function prepareLogoSvg(raw: string): PreparedLogo | undefined {
  // Event handlers are rejected wherever the attribute boundary sits — after
  // whitespace, a quote, a slash, or a tag bracket.
  if (/<script/i.test(raw) || /[\s"'/>]on[a-z]+\s*=/i.test(raw)) {
    return undefined;
  }
  const markup = raw
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .trim();

  const rootTag = markup.match(/<svg[^>]*>/i);
  const closeIndex = markup.toLowerCase().lastIndexOf("</svg>");
  if (!rootTag || rootTag.index === undefined || closeIndex === -1) {
    return undefined;
  }

  // Scale source: viewBox preferred; numeric root width/height synthesize one when absent.
  const viewBoxRaw = getAttr(rootTag[0], "viewBox");
  let viewBox: PreparedLogo["viewBox"] | undefined;
  if (viewBoxRaw !== undefined) {
    const parts = viewBoxRaw.trim().split(/[\s,]+/).map(Number);
    const [minX, minY, width, height] = parts;
    if (
      parts.length === 4 &&
      parts.every(Number.isFinite) &&
      minX !== undefined &&
      minY !== undefined &&
      width !== undefined &&
      height !== undefined &&
      width > 0 &&
      height > 0
    ) {
      viewBox = { minX, minY, width, height };
    }
  } else {
    // Only unit-less (or px) dimensions are trustworthy user units — `1em`
    // would parseFloat to 1 and synthesize a garbage 1×1 coordinate system.
    const dimension = (name: string): number | undefined => {
      const value = (getAttr(rootTag[0], name) ?? "").trim();
      return /^\d+(\.\d+)?(px)?$/.test(value) ? Number.parseFloat(value) : undefined;
    };
    const width = dimension("width");
    const height = dimension("height");
    if (width !== undefined && height !== undefined && width > 0 && height > 0) {
      viewBox = { minX: 0, minY: 0, width, height };
    }
  }
  if (viewBox === undefined) {
    return undefined;
  }

  const inner = markup
    .slice(rootTag.index + rootTag[0].length, closeIndex)
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, "")
    .replace(/<desc[^>]*>[\s\S]*?<\/desc>/gi, "")
    .trim();
  if (inner.length === 0) {
    return undefined;
  }

  const carried = INHERITABLE_ATTRS.map((name) => {
    const value = getAttr(rootTag[0], name);
    return value !== undefined ? ` ${name}="${value.replaceAll('"', "&quot;")}"` : "";
  }).join("");
  const currentColorFallback = /\bcurrentColor\b/.test(inner) || /\bcurrentColor\b/.test(rootTag[0]);
  const colorAttr = currentColorFallback && getAttr(rootTag[0], "color") === undefined ? ` color="${DEFAULT_CURRENT_COLOR}"` : "";

  return { body: `<g${carried}${colorAttr}>${inner}</g>`, viewBox };
}
