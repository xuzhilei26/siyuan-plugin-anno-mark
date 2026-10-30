import test from "node:test";
import assert from "node:assert/strict";

import { annotationBounds, drawArrow } from "../src/canvas.ts";
import type { Annotation } from "../src/types.ts";

interface Call {
    op: "moveTo" | "lineTo";
    x: number;
    y: number;
}

/** Minimal recording stand-in for the 2D context used by drawArrow. */
function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
    const calls: Call[] = [];
    const ctx = {
        beginPath() {},
        closePath() {},
        moveTo(x: number, y: number) {
            calls.push({ op: "moveTo", x, y });
        },
        lineTo(x: number, y: number) {
            calls.push({ op: "lineTo", x, y });
        },
        stroke() {},
        fill() {},
        fillStyle: "",
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function arrow(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    width: number
): Annotation {
    return {
        id: "a",
        type: "arrow",
        x1,
        y1,
        x2,
        y2,
        width,
        stroke: "#ff3b30",
    } as unknown as Annotation;
}

const HEAD_HALF = (26 * Math.PI) / 180;
const EPS = 1e-9;

/** Tip-followed-by-left/right head vertices; shaft is the first two calls. */
function draw(a: Annotation): Call[] {
    const { ctx, calls } = recordingCtx();
    drawArrow(ctx, a);
    assert.equal(calls.length, 5);
    return calls;
}

function expectedTrim(a: Annotation): number {
    const dist = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
    const len = Math.max(10, (a.width ?? 4) * 3.4);
    return Math.min(dist, len * Math.cos(HEAD_HALF));
}

test("arrow head apex stays at the authored endpoint", () => {
    const cases: Array<[number, number, number, number, number]> = [
        [0, 0, 100, 0, 4],
        [0, 0, 0, 100, 12],
        [0, 0, -80, 60, 1],
        [10, 20, 10, 20, 4],
    ];
    for (const [x1, y1, x2, y2, width] of cases) {
        const calls = draw(arrow(x1, y1, x2, y2, width));
        assert.equal(calls[2].op, "moveTo");
        assert.ok(Math.abs(calls[2].x - x2) < EPS);
        assert.ok(Math.abs(calls[2].y - y2) < EPS);
    }
});

test("shaft never reaches past the tip for widths 1 / 4 / 12", () => {
    for (const width of [1, 4, 12]) {
        for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI, -2.5]) {
            const x1 = 0;
            const y1 = 0;
            const x2 = 100 * Math.cos(angle);
            const y2 = 100 * Math.sin(angle);
            const a = arrow(x1, y1, x2, y2, width);
            const calls = draw(a);
            const shaftEnd = calls[1];
            const ux = Math.cos(angle);
            const uy = Math.sin(angle);
            const projection =
                (shaftEnd.x - x2) * ux + (shaftEnd.y - y2) * uy;
            assert.ok(projection <= 0, `width=${width} angle=${angle}`);
            assert.ok(Math.abs(projection + expectedTrim(a)) < 1e-6);
        }
    }
});

test("shaft end follows the head base for each line width", () => {
    for (const width of [1, 4, 12]) {
        const a = arrow(0, 0, 200, 0, width);
        const calls = draw(a);
        const shaftEnd = calls[1];
        const len = Math.max(10, width * 3.4);
        assert.ok(Math.abs(200 - shaftEnd.x - len * Math.cos(HEAD_HALF)) < 1e-6);
        assert.ok(Math.abs(shaftEnd.y) < EPS);
    }
});

test("short arrows clamp the shaft to the start point", () => {
    const a = arrow(0, 0, 5, 0, 12);
    const calls = draw(a);
    assert.ok(Math.abs(calls[1].x - 0) < EPS);
    assert.ok(Math.abs(calls[1].y - 0) < EPS);
});

test("zero-length arrows stay finite and keep the tip", () => {
    const a = arrow(30, 40, 30, 40, 4);
    const calls = draw(a);
    for (const call of calls) {
        assert.ok(Number.isFinite(call.x));
        assert.ok(Number.isFinite(call.y));
    }
    assert.ok(Math.abs(calls[2].x - 30) < EPS);
    assert.ok(Math.abs(calls[2].y - 40) < EPS);
});

test("arrow bounds contain start, tip and both head base vertices", () => {
    for (const width of [1, 4, 12]) {
        for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
            const x1 = 0;
            const y1 = 0;
            const x2 = 100 * Math.cos(angle);
            const y2 = 100 * Math.sin(angle);
            const a = arrow(x1, y1, x2, y2, width);
            const b = annotationBounds(a);

            const len = Math.max(10, width * 3.4);
            const leftX = x2 - len * Math.cos(angle - HEAD_HALF);
            const leftY = y2 - len * Math.sin(angle - HEAD_HALF);
            const rightX = x2 - len * Math.cos(angle + HEAD_HALF);
            const rightY = y2 - len * Math.sin(angle + HEAD_HALF);
            const points = [
                [x1, y1],
                [x2, y2],
                [leftX, leftY],
                [rightX, rightY],
            ];

            for (const [px, py] of points) {
                assert.ok(px >= b.x && px <= b.x + b.w, `x of ${px}`);
                assert.ok(py >= b.y && py <= b.y + b.h, `y of ${py}`);
            }
            assert.ok(b.w > 0 && b.h > 0);
            assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
        }
    }
});

test("zero-length arrow bounds stay finite and positive", () => {
    const b = annotationBounds(arrow(30, 40, 30, 40, 4));
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
    assert.ok(Number.isFinite(b.w) && Number.isFinite(b.h));
    assert.ok(b.w > 0 && b.h > 0);
});
