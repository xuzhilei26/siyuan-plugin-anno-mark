import test from "node:test";
import assert from "node:assert/strict";

import {
    effectCacheKey,
    isRunnable,
    stackSignature,
} from "../src/effects/engine.ts";
import { applyColorMatrix, brightness, buildLut, identityColorMatrix, applyLut, grayscale, invert } from "../src/effects/ops/color.ts";
import { convolve, gaussianBlur, boxBlur, sharpen } from "../src/effects/ops/kernels.ts";
import { sampleBilinear, warp } from "../src/effects/ops/warp.ts";
import { makeImageData } from "../src/effects/pixels.ts";

/** Builds a solid 2x2 / n-pixel image from one RGBA tuple. */
function solid(width: number, height: number, rgba: [number, number, number, number]): ImageData {
    const img = makeImageData(width, height);
    for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = rgba[0];
        img.data[i + 1] = rgba[1];
        img.data[i + 2] = rgba[2];
        img.data[i + 3] = rgba[3];
    }
    return img;
}

function pixel(img: ImageData, index = 0): number[] {
    const i = index * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

test("identity color matrix leaves pixels untouched", () => {
    const src = solid(2, 2, [12, 200, 73, 255]);
    const out = applyColorMatrix(src, identityColorMatrix());
    assert.deepEqual(pixel(out), [12, 200, 73, 255]);
});

test("color matrix applies gains and offsets", () => {
    const src = solid(1, 1, [100, 100, 100, 255]);
    const m = identityColorMatrix();
    m[0] = 0.5; // r * 0.5
    m[6] = 2; // g * 2
    m[14] = 10; // b + 10
    const out = applyColorMatrix(src, m);
    assert.deepEqual(pixel(out), [50, 200, 110, 255]);
});

test("brightness clamps and invert flips channels", () => {
    assert.deepEqual(pixel(brightness(solid(1, 1, [200, 200, 200, 255]), 100)), [255, 255, 255, 255]);
    assert.deepEqual(pixel(brightness(solid(1, 1, [200, 200, 200, 255]), -100)), [0, 0, 0, 255]);
    assert.deepEqual(pixel(invert(solid(1, 1, [0, 255, 30, 128]))), [255, 0, 225, 128]);
});

test("grayscale keeps luminance and respects strength", () => {
    const out = grayscale(solid(1, 1, [255, 0, 0, 255]), 100);
    assert.deepEqual(pixel(out), [76, 76, 76, 255]);
    const half = grayscale(solid(1, 1, [255, 0, 0, 255]), 0);
    assert.deepEqual(pixel(half), [255, 0, 0, 255]);
});

test("buildLut + applyLut run a transfer curve per channel", () => {
    const lut = buildLut((v) => 255 - v);
    assert.equal(lut.length, 256);
    const out = applyLut(solid(1, 1, [0, 128, 255, 255]), lut);
    assert.deepEqual(pixel(out), [255, 127, 0, 255]);
    const alphaPreserved = applyLut(solid(1, 1, [10, 10, 10, 33]), lut);
    assert.equal(alphaPreserved.data[3], 33);
});

test("convolve on a uniform image preserves the colour", () => {
    const src = solid(4, 4, [90, 140, 210, 255]);
    const kernel = [1, 1, 1, 1, 1, 1, 1, 1, 1];
    const out = convolve(src, kernel, 3, 3, 9);
    for (let i = 0; i < 4; i++) {
        assert.deepEqual(pixel(out, i), [90, 140, 210, 255]);
    }
});

test("box / gaussian blur and sharpen keep flat areas stable", () => {
    const src = solid(5, 5, [64, 128, 192, 255]);
    for (const out of [boxBlur(src, 2), gaussianBlur(src, 2), sharpen(src, 50)]) {
        assert.deepEqual(pixel(out, 12), [64, 128, 192, 255]);
    }
});

test("sharpen boosts an edge between two flat halves", () => {
    const src = makeImageData(4, 1);
    for (let x = 0; x < 4; x++) {
        const value = x < 2 ? 40 : 200;
        src.data[x * 4] = value;
        src.data[x * 4 + 1] = value;
        src.data[x * 4 + 2] = value;
        src.data[x * 4 + 3] = 255;
    }
    const out = sharpen(src, 100);
    assert.ok(out.data[4] <= 40, "dark side must not brighten");
    assert.ok(out.data[8] >= 200, "light side must not darken");
});

test("sampleBilinear interpolates and rejects out-of-range samples", () => {
    const src = makeImageData(2, 2);
    src.data.set([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    const out = new Float32Array(4);
    assert.equal(sampleBilinear(src, 0.5, 0.5, out), true);
    assert.deepEqual([...out], [127.5, 127.5, 127.5, 255]);
    assert.equal(sampleBilinear(src, 0, 0, out), true);
    assert.deepEqual([...out], [0, 0, 0, 255]);
    assert.equal(sampleBilinear(src, 9, 9, out), false);
    assert.deepEqual([...out], [0, 0, 0, 0]);
});

test("warp uses the mapper and falls back to the background", () => {
    const src = solid(2, 2, [10, 20, 30, 255]);
    const same = warp(src, (x, y, sample) => {
        sample.sx = x;
        sample.sy = y;
        sample.ok = true;
    });
    assert.deepEqual(pixel(same, 0), [10, 20, 30, 255]);
    const outside = warp(src, (x, y, sample) => {
        sample.sx = x - 100;
        sample.sy = y - 100;
        sample.ok = true;
    }, [1, 2, 3, 4]);
    assert.deepEqual(pixel(outside, 0), [1, 2, 3, 4]);
});

test("stackSignature is order independent inside params but not across entries", () => {
    const a = [
        { id: "brightness", params: { amount: 10, unused: 1 }, seed: 1 },
        { id: "blur", params: { radius: 3 }, seed: 2 },
    ];
    const b = [
        { id: "brightness", params: { unused: 1, amount: 10 }, seed: 1 },
        { id: "blur", params: { radius: 3 }, seed: 2 },
    ];
    assert.equal(stackSignature(a), stackSignature(b));
    assert.notEqual(stackSignature(a), stackSignature([...a].reverse()));
    assert.notEqual(stackSignature(a), stackSignature([a[0], { ...a[1], seed: 3 }]));
});

test("effectCacheKey separates base, preview limit and stack", () => {
    const stack = [{ id: "invert", params: {}, seed: 1 }];
    const key = effectCacheKey("base-a", stack, 1600);
    assert.equal(key, effectCacheKey("base-a", stack, 1600));
    assert.notEqual(key, effectCacheKey("base-b", stack, 1600));
    assert.notEqual(key, effectCacheKey("base-a", stack));
    assert.notEqual(key, effectCacheKey("base-a", stack, 800));
});

test("isRunnable skips delegates, unknown ids and accepts custom filters", () => {
    assert.equal(isRunnable("brightness"), true);
    assert.equal(isRunnable("border"), true);
    assert.equal(isRunnable("custom_filter"), true);
    assert.equal(isRunnable("crop_image"), false);
    assert.equal(isRunnable("draw_text"), false);
    assert.equal(isRunnable("not_a_real_effect"), false);
});
