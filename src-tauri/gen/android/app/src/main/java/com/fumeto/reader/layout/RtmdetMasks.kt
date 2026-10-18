package com.fumeto.reader.layout

import java.nio.ByteBuffer
import java.nio.FloatBuffer

/** One detection's mask in the letterboxed input space. */
internal fun interface MaskPlane {
    fun isOn(x: Int, y: Int): Boolean
}

/** The balloon masks of one page, in whichever form the layout model emitted them. */
internal interface BalloonMasks {
    /** The mask of detection [detection], or null when the model emitted none for it. */
    fun plane(detection: Int): MaskPlane?
}

/**
 * The current model's masks: only balloons scoring >= 0.35 carry one, already
 * thresholded to a byte per pixel, and `indices[k]` names the detection that
 * plane `k` belongs to.
 */
internal class SelectedBalloonMasks(
    private val planes: ByteBuffer,
    indices: LongArray,
    private val side: Int,
) : BalloonMasks {
    private val slots = HashMap<Int, Int>(indices.size * 2).apply {
        indices.forEachIndexed { slot, detection -> put(detection.toInt(), slot) }
    }

    override fun plane(detection: Int): MaskPlane? {
        val base = (slots[detection] ?: return null) * side * side
        return MaskPlane { x, y -> planes.get(base + y * side + x).toInt() != 0 }
    }
}

/**
 * A model file from before the selection: a sigmoid mask for every detection.
 * Reading it costs a ~400 MB copy into the Java heap, so it only serves an
 * install that has not downloaded the current model yet.
 */
internal class FullBalloonMasks(
    private val masks: FloatBuffer,
    private val side: Int,
    private val threshold: Float,
) : BalloonMasks {
    override fun plane(detection: Int): MaskPlane {
        val base = detection * side * side
        return MaskPlane { x, y -> masks.get(base + y * side + x) >= threshold }
    }
}

internal object MaskContours {
    /**
     * Moore-neighbor boundary trace of the mask inside the box, simplified with
     * Douglas-Peucker; input-space [x0,y0,x1,y1,...], or null when nothing traces.
     */
    fun trace(plane: MaskPlane, bx: Int, by: Int, bx2: Int, by2: Int): FloatArray? {
        fun on(x: Int, y: Int): Boolean = x in bx..bx2 && y in by..by2 && plane.isOn(x, y)

        var start: Pair<Int, Int>? = null
        outer@ for (y in by..by2) {
            for (x in bx..bx2) {
                if (on(x, y)) {
                    start = x to y
                    break@outer
                }
            }
        }
        val (sx, sy) = start ?: return null
        // 8-neighborhood in clockwise order starting west.
        val dx = intArrayOf(-1, -1, 0, 1, 1, 1, 0, -1)
        val dy = intArrayOf(0, -1, -1, -1, 0, 1, 1, 1)
        val points = ArrayList<IntArray>()
        var cx = sx
        var cy = sy
        // The raster scan guarantees everything left/above the start is off;
        // treat the start as if entered moving east.
        var dir = 4
        val maxSteps = 6 * (bx2 - bx + by2 - by + 2)
        for (step in 0 until maxSteps) {
            points.add(intArrayOf(cx, cy))
            var found = false
            // Scan clockwise starting just past the backtrack pixel; starting
            // two steps early walks straight into the region interior.
            var probe = (dir + 5) % 8
            for (k in 0 until 8) {
                val nx = cx + dx[probe]
                val ny = cy + dy[probe]
                if (on(nx, ny)) {
                    cx = nx
                    cy = ny
                    dir = probe
                    found = true
                    break
                }
                probe = (probe + 1) % 8
            }
            if (!found) break // isolated pixel
            if (cx == sx && cy == sy && points.size > 2) break
        }
        if (points.size < 3) return null
        val simplified = douglasPeucker(points, 2.0)
        if (simplified.size < 3) return null
        val out = FloatArray(simplified.size * 2)
        simplified.forEachIndexed { idx, p ->
            out[idx * 2] = p[0].toFloat()
            out[idx * 2 + 1] = p[1].toFloat()
        }
        return out
    }

    private fun douglasPeucker(points: List<IntArray>, epsilon: Double): List<IntArray> {
        if (points.size < 3) return points
        var maxDist = 0.0
        var index = 0
        val end = points.size - 1
        for (i in 1 until end) {
            val d = perpendicularDistance(points[i], points[0], points[end])
            if (d > maxDist) {
                maxDist = d
                index = i
            }
        }
        return if (maxDist > epsilon) {
            val left = douglasPeucker(points.subList(0, index + 1), epsilon)
            val right = douglasPeucker(points.subList(index, points.size), epsilon)
            left.dropLast(1) + right
        } else {
            listOf(points[0], points[end])
        }
    }

    private fun perpendicularDistance(p: IntArray, a: IntArray, b: IntArray): Double {
        val dx = (b[0] - a[0]).toDouble()
        val dy = (b[1] - a[1]).toDouble()
        val norm = kotlin.math.hypot(dx, dy)
        if (norm == 0.0) {
            return kotlin.math.hypot((p[0] - a[0]).toDouble(), (p[1] - a[1]).toDouble())
        }
        return kotlin.math.abs(dx * (a[1] - p[1]) - (a[0] - p[0]) * dy) / norm
    }
}
