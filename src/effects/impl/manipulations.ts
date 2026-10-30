/**
 * ShareX "Manipulations" effects that run natively in the pixel engine.
 *
 * Every effect keeps the input dimensions (the warp helpers never resize).
 * Percentage parameters stay 0–100 and are converted to image space inside the
 * impl or its helper; pixel-sized parameters are scaled with `env.px` so a
 * downscaled preview matches the full-resolution export. Tier C entries are
 * delegated to the editor and must not appear here.
 */
import { clamp, clamp255, makeImageData, parseColor } from "../pixels.ts";
import { mulberry32 } from "../rand.ts";
import {
    cylinderWrap,
    displacementMap,
    fisheye,
    foldCreaseWarp,
    glassSphere,
    kaleidoscope,
    liquifyPush,
    mirrorTiles,
    perspectiveWarp,
    pinchBulge,
    polarWarp,
    rippleRefraction,
    rotate3d,
    rotate3dBox,
    sampleBilinear,
    skew,
    symmetry,
    tileRepeat,
    tileShuffle,
    twirl,
    waveDistortion,
} from "../ops/warp.ts";
import type {
    CylinderOrientation,
    PageCorner,
    PolarMode,
    SymmetryDirection,
    WaveDirection,
} from "../ops/warp.ts";
import type { EffectRegistry, ParamDict } from "../types.ts";

function num(params: ParamDict, key: string, fallback: number): number {
    const value = params[key];
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    const parsed = typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
}

function flag(params: ParamDict, key: string, fallback: boolean): boolean {
    const value = params[key];
    if (typeof value === "boolean") {
        return value;
    }
    if (value === "true" || value === "false") {
        return value === "true";
    }
    return fallback;
}

function text(params: ParamDict, key: string, fallback: string): string {
    const value = params[key];
    return typeof value === "string" ? value : fallback;
}

function polarMode(value: string): PolarMode {
    return value === "PolarToCartesian" ? "PolarToCartesian" : "CartesianToPolar";
}

function cylinderOrientation(value: string): CylinderOrientation {
    return value === "Horizontal" ? "Horizontal" : "Vertical";
}

function symmetryDirection(value: string): SymmetryDirection {
    switch (value) {
        case "RightToLeft":
        case "TopToBottom":
        case "BottomToTop":
            return value;
        default:
            return "LeftToRight";
    }
}

function waveDirection(value: string): WaveDirection {
    switch (value) {
        case "Vertical":
        case "Both":
            return value;
        default:
            return "Horizontal";
    }
}

function pageCorner(value: string): PageCorner {
    switch (value) {
        case "TopLeft":
        case "TopRight":
        case "BottomLeft":
            return value;
        default:
            return "BottomRight";
    }
}

/** Paper back tone used when a 3D box turns past edge-on. */
const BOX_BACK_TONE: [number, number, number] = [244, 240, 232];

/**
 * Subtle lambert-style shading for the 3D box. The front face brightens as it
 * faces the camera; past 90° it dims and picks up a faint paper-back tint, so
 * the back face reads differently without changing the silhouette.
 */
function shadeBoxFaces(src: ImageData, rotateX: number, rotateY: number): ImageData {
    const out = makeImageData(src.width, src.height);
    out.data.set(src.data);
    const ax = (Math.max(-180, Math.min(180, rotateX)) * Math.PI) / 180;
    const ay = (Math.max(-180, Math.min(180, rotateY)) * Math.PI) / 180;
    const facing = Math.cos(ax) * Math.cos(ay);
    const back = facing < 0 ? Math.min(1, -facing) : 0;
    const light = facing >= 0 ? 0.84 + 0.16 * facing : 1 - 0.2 * back;
    const mix = back * 0.12;
    if (light > 0.999 && mix <= 0) {
        return out;
    }
    const d = out.data;
    for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) {
            continue;
        }
        d[i] = clamp255(d[i] * light * (1 - mix) + BOX_BACK_TONE[0] * mix);
        d[i + 1] = clamp255(d[i + 1] * light * (1 - mix) + BOX_BACK_TONE[1] * mix);
        d[i + 2] = clamp255(d[i + 2] * light * (1 - mix) + BOX_BACK_TONE[2] * mix);
    }
    return out;
}

/**
 * Rounded-corner alpha mask with 1 px antialiasing. `cornerRadius` is a pixel
 * value scaled by `env.px`, so previews round with the same relative radius.
 */
function roundedCorners(src: ImageData, cornerRadius: number): ImageData {
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    out.data.set(src.data);
    const radius = Math.min(cornerRadius, w / 2, h / 2);
    if (!(radius > 0)) {
        return out;
    }
    const halfW = w / 2;
    const halfH = h / 2;
    const innerX = halfW - radius;
    const innerY = halfH - radius;
    const d = out.data;
    for (let y = 0; y < h; y++) {
        const qy = Math.abs(y + 0.5 - halfH) - innerY;
        const outsideY = qy > 0 ? qy : 0;
        for (let x = 0; x < w; x++) {
            const qx = Math.abs(x + 0.5 - halfW) - innerX;
            const outsideX = qx > 0 ? qx : 0;
            const dist =
                Math.sqrt(outsideX * outsideX + outsideY * outsideY) +
                Math.min(Math.max(qx, qy), 0) -
                radius;
            if (dist <= -0.5) {
                continue;
            }
            const coverage = dist >= 0.5 ? 0 : 0.5 - dist;
            const i = (y * w + x) * 4;
            d[i + 3] = Math.round(d[i + 3] * coverage);
        }
    }
    return out;
}

/**
 * Corner page curl built as a true reflection fold: the corner triangle beyond
 * the crease is lifted away (alpha 0), the mirrored flap lands on the page and
 * shows a shaded paper back, and the flap's free edge casts a soft shadow on
 * the page. Uncovered pixels stay transparent; the canvas never grows.
 */
function foldPage(
    src: ImageData,
    corner: PageCorner,
    curlSize: number,
    curlDepth: number,
    shadowStrength: number,
    backColor: string
): ImageData {
    const w = src.width;
    const h = src.height;
    const out = makeImageData(w, h);
    const d = out.data;
    const [br, bg, bb] = parseColor(backColor);
    const depth01 = clamp(curlDepth, 0, 100) / 100;
    const shadow01 = clamp(shadowStrength, 0, 100) / 100;
    const span = Math.max(1, Math.min(w, h));
    const size = Math.max(2, (clamp(curlSize, 1, 100) / 100) * span);
    const fold = Math.max(2, size * (0.78 + depth01 * 0.22));
    const shadowWidth = Math.max(2, fold * (0.1 + shadow01 * 0.22));
    const flapEnd = fold * 2;
    const backMix = 0.6 + depth01 * 0.22;
    const shine = 0.04 + depth01 * 0.1;
    const left = corner === "TopLeft" || corner === "BottomLeft";
    const top = corner === "TopLeft" || corner === "TopRight";
    const px = new Float32Array(4);
    for (let y = 0; y < h; y++) {
        const ly = top ? y : h - 1 - y;
        for (let x = 0; x < w; x++) {
            const lx = left ? x : w - 1 - x;
            const i = (y * w + x) * 4;
            const diagonal = lx + ly;
            if (diagonal >= flapEnd + shadowWidth) {
                d[i] = src.data[i];
                d[i + 1] = src.data[i + 1];
                d[i + 2] = src.data[i + 2];
                d[i + 3] = src.data[i + 3];
                continue;
            }
            if (diagonal < fold - 0.5) {
                // Folded-away corner: nothing is left to draw.
                continue;
            }
            if (diagonal < flapEnd) {
                const t = clamp((diagonal - fold) / fold, 0, 1);
                const mx = fold - ly;
                const my = fold - lx;
                const sx = left ? mx : w - 1 - mx;
                const sy = top ? my : h - 1 - my;
                const sampled = sampleBilinear(src, sx, sy, px);
                const r = sampled ? px[0] * (1 - backMix) + br * backMix : br;
                const g = sampled ? px[1] * (1 - backMix) + bg * backMix : bg;
                const b = sampled ? px[2] * (1 - backMix) + bb * backMix : bb;
                const curlLight =
                    1 + 0.16 * Math.sin(Math.PI * t) * (0.5 + depth01 * 0.5) - 0.06 * t;
                const glow = shine * (1 - t) * (1 - t);
                const edge = clamp(diagonal - fold + 0.5, 0, 1);
                d[i] = clamp255((r * curlLight) * (1 - glow) + 255 * glow);
                d[i + 1] = clamp255((g * curlLight) * (1 - glow) + 255 * glow);
                d[i + 2] = clamp255((b * curlLight) * (1 - glow) + 255 * glow);
                d[i + 3] = Math.round((sampled ? px[3] : 0) * edge);
                continue;
            }
            const fade = 1 - (diagonal - flapEnd) / shadowWidth;
            const shade = 1 - shadow01 * 0.38 * fade;
            d[i] = clamp255(src.data[i] * shade);
            d[i + 1] = clamp255(src.data[i + 1] * shade);
            d[i + 2] = clamp255(src.data[i + 2] * shade);
            d[i + 3] = src.data[i + 3];
        }
    }
    return out;
}

export const MANIPULATION_IMPLS: EffectRegistry = {
    // auto_resize is a no-op: the canvas size is fixed by contract.
    skew: (src, params) =>
        skew(src, num(params, "horizontally", 0), num(params, "vertically", 0)),

    perspective_warp: (src, params, env) =>
        perspectiveWarp(src, {
            topLeftX: env.px(num(params, "top_left_x", 0)),
            topLeftY: env.px(num(params, "top_left_y", 0)),
            topRightX: env.px(num(params, "top_right_x", 0)),
            topRightY: env.px(num(params, "top_right_y", 0)),
            bottomRightX: env.px(num(params, "bottom_right_x", 0)),
            bottomRightY: env.px(num(params, "bottom_right_y", 0)),
            bottomLeftX: env.px(num(params, "bottom_left_x", 0)),
            bottomLeftY: env.px(num(params, "bottom_left_y", 0)),
        }),

    fisheye_lens: (src, params) =>
        fisheye(
            src,
            num(params, "strength", 58),
            num(params, "radius_percentage", 100),
            num(params, "center_x_percentage", 50),
            num(params, "center_y_percentage", 50)
        ),

    twirl: (src, params) =>
        twirl(
            src,
            num(params, "angle", 90),
            num(params, "radius_percentage", 50),
            num(params, "center_x_percentage", 50),
            num(params, "center_y_percentage", 50)
        ),

    pinch_bulge: (src, params) =>
        pinchBulge(
            src,
            num(params, "strength", 35),
            num(params, "radius_percentage", 50),
            num(params, "center_x_percentage", 50),
            num(params, "center_y_percentage", 50)
        ),

    polar_warp: (src, params) =>
        polarWarp(
            src,
            polarMode(text(params, "mode", "CartesianToPolar")),
            num(params, "rotation", 0),
            num(params, "radius_scale", 100),
            num(params, "center_x_percentage", 50),
            num(params, "center_y_percentage", 50)
        ),

    kaleidoscope: (src, params) =>
        kaleidoscope(
            src,
            num(params, "segments", 8),
            num(params, "rotation", 0),
            num(params, "zoom", 100),
            num(params, "center_x_percentage", 50),
            num(params, "center_y_percentage", 50)
        ),

    mirror_tiles: (src, params) =>
        mirrorTiles(
            src,
            num(params, "columns", 3),
            num(params, "rows", 3),
            flag(params, "mirror_alternate_columns", true),
            flag(params, "mirror_alternate_rows", true)
        ),

    tile_repeat: (src, params) =>
        tileRepeat(src, num(params, "columns", 3), num(params, "rows", 3)),

    // Seeded Fisher-Yates inside the helper uses the shared mulberry32 step,
    // so the same env.seed always reproduces the same arrangement.
    tile_shuffle: (src, params, env) =>
        tileShuffle(
            src,
            num(params, "columns", 4),
            num(params, "rows", 4),
            env.px(num(params, "gap", 0)),
            text(params, "gap_color", "#000000"),
            env.seed
        ),

    symmetry: (src, params) =>
        symmetry(src, symmetryDirection(text(params, "direction", "LeftToRight"))),

    wave_distortion: (src, params, env) =>
        waveDistortion(
            src,
            env.px(num(params, "amplitude", 20)),
            env.px(num(params, "wavelength", 100)),
            waveDirection(text(params, "direction", "Horizontal"))
        ),

    ripple_refraction: (src, params, env) =>
        rippleRefraction(
            src,
            env.px(num(params, "amplitude", 12)),
            env.px(num(params, "wavelength", 32)),
            num(params, "phase", 0),
            num(params, "refraction", 35),
            num(params, "center_x_percentage", 50),
            num(params, "center_y_percentage", 50)
        ),

    // map_file_path is unavailable in the headless pixel engine, so a seeded
    // noise field stands in for the uploaded displacement map.
    displacement_map: (src, params, env) =>
        displacementMap(
            src,
            env.px(num(params, "amount_x", 20)),
            env.px(num(params, "amount_y", 20)),
            undefined,
            0,
            0,
            env.seed
        ),

    cylinder_wrap: (src, params) =>
        cylinderWrap(
            src,
            cylinderOrientation(text(params, "orientation", "Vertical")),
            num(params, "curvature", 65),
            num(params, "edge_shading", 35)
        ),

    glass_sphere: (src, params) =>
        glassSphere(src, num(params, "radius", 50), num(params, "refraction", 1.5)),

    fold_crease_warp: (src, params, env) =>
        foldCreaseWarp(
            src,
            cylinderOrientation(text(params, "orientation", "Vertical")),
            num(params, "fold_count", 3),
            env.px(num(params, "fold_depth", 30)),
            num(params, "shadow_strength", 40)
        ),

    liquify_push_smudge: (src, params, env) => {
        // Seeded micro-jitter keeps repeated exports byte-identical while the
        // smear chain avoids looking perfectly mechanical.
        const jitter = mulberry32(env.seed);
        const angle = num(params, "angle", 0) + (jitter() - 0.5) * 3;
        const distance = env.px(num(params, "distance", 40) * (1 + (jitter() - 0.5) * 0.02));
        return liquifyPush(
            src,
            angle,
            distance,
            num(params, "radius_percentage", 25),
            num(params, "smudge", 35),
            num(params, "center_x_percentage", 50),
            num(params, "center_y_percentage", 50)
        );
    },

    page_curl: (src, params) =>
        foldPage(
            src,
            pageCorner(text(params, "corner", "BottomRight")),
            num(params, "curl_size", 28),
            num(params, "curl_depth", 55),
            num(params, "shadow_strength", 60),
            text(params, "back_color", "#F8F4EC")
        ),

    rotate_3d: (src, params) =>
        rotate3d(
            src,
            num(params, "rotate_x", 0),
            num(params, "rotate_y", 0),
            num(params, "rotate_z", 0)
        ),

    rotate_3d_box: (src, params) => {
        const rotateX = num(params, "rotate_x", 0);
        const rotateY = num(params, "rotate_y", 0);
        const rotated = rotate3dBox(
            src,
            num(params, "depth", 50),
            rotateX,
            rotateY,
            num(params, "rotate_z", 0)
        );
        return shadeBoxFaces(rotated, rotateX, rotateY);
    },

    rounded_corners: (src, params, env) =>
        roundedCorners(src, env.px(num(params, "corner_radius", 20))),
};

export const MANIPULATION_FRAME_IDS: string[] = [];
