package com.fumeto.reader.ocr

import org.json.JSONArray
import org.json.JSONObject

/** Wire codec shared by the WebView bridge and local JVM contract tests. */
internal object PPOcrRegionJsonCodec {
    fun parse(encoded: String): List<PPOcrRegion> {
        val values = JSONArray(encoded)
        return List(values.length()) { index ->
            val value = values.getJSONObject(index)
            val boxId = value.getInt("boxId")
            val confidence = value.optDouble("confidence", 0.0).toFiniteFloatOr(0f)
            val sourceComponents = parseSourceComponents(value.optJSONArray("sourceComponents"))
            val explicitSourceIds = parseIds(
                value.optJSONArray("sourceComponentIds")
                    ?: value.optJSONArray("componentIds"),
            )
            val componentSourceIds = sourceComponents.map { it.componentId }
            require(
                explicitSourceIds.isEmpty() || componentSourceIds.isEmpty() ||
                    explicitSourceIds == componentSourceIds,
            ) { "PP-OCR source component IDs do not match their geometry records" }
            PPOcrRegion(
                boxId = boxId,
                x = value.getInt("x"),
                y = value.getInt("y"),
                width = value.getInt("width"),
                height = value.getInt("height"),
                confidence = confidence,
                polygon = parsePolygon(value.optJSONArray("polygon")),
                orientationDegrees =
                    value.optDouble("orientationDegrees", 0.0).toFiniteFloatOr(0f),
                sourceComponentIds =
                    explicitSourceIds.ifEmpty { componentSourceIds }.ifEmpty { listOf(boxId) },
                sourceComponents = sourceComponents,
                foregroundPixelCount = value.optInt("foregroundPixelCount", 0).coerceAtLeast(0),
                meanConfidence =
                    value.optDouble("meanConfidence", confidence.toDouble())
                        .toFiniteFloatOr(confidence),
                maxConfidence =
                    value.optDouble("maxConfidence", confidence.toDouble())
                        .toFiniteFloatOr(confidence),
            )
        }
    }

    fun toJson(regions: List<PPOcrRegion>): JSONArray = JSONArray().apply {
        regions.forEach { region ->
            put(JSONObject().apply {
                put("boxId", region.boxId)
                put("x", region.x)
                put("y", region.y)
                put("width", region.width)
                put("height", region.height)
                put("confidence", region.confidence.toDouble())
                put("polygon", polygonToJson(
                    region.polygon,
                    region.x,
                    region.y,
                    region.width,
                    region.height,
                ))
                put("orientationDegrees", region.orientationDegrees.toDouble())
                put("sourceComponentIds", JSONArray().apply {
                    region.sourceComponentIds.ifEmpty { listOf(region.boxId) }.forEach { put(it) }
                })
                put("sourceComponents", JSONArray().apply {
                    region.sourceComponents.forEach { component ->
                        put(JSONObject().apply {
                            put("componentId", component.componentId)
                            put("x", component.x)
                            put("y", component.y)
                            put("width", component.width)
                            put("height", component.height)
                            put("confidence", component.confidence.toDouble())
                            put("polygon", polygonToJson(
                                component.polygon,
                                component.x,
                                component.y,
                                component.width,
                                component.height,
                            ))
                            put("orientationDegrees", component.orientationDegrees.toDouble())
                            put("foregroundPixelCount", component.foregroundPixelCount)
                            put("meanConfidence", component.meanConfidence.toDouble())
                            put("maxConfidence", component.maxConfidence.toDouble())
                        })
                    }
                })
                put("foregroundPixelCount", region.foregroundPixelCount)
                put("meanConfidence", region.meanConfidence.toDouble())
                put("maxConfidence", region.maxConfidence.toDouble())
            })
        }
    }

    private fun polygonToJson(
        input: List<Float>,
        x: Int,
        y: Int,
        width: Int,
        height: Int,
    ): JSONArray {
        val polygon = input.takeIf(::isValidPolygon) ?: listOf(
            x.toFloat(),
            y.toFloat(),
            (x + width).toFloat(),
            y.toFloat(),
            (x + width).toFloat(),
            (y + height).toFloat(),
            x.toFloat(),
            (y + height).toFloat(),
        )
        return JSONArray().apply {
            polygon.chunked(2).forEach { point ->
                put(JSONArray().apply {
                    put(point[0].toDouble())
                    put(point[1].toDouble())
                })
            }
        }
    }

    private fun parseSourceComponents(value: JSONArray?): List<PPOcrSourceComponent> {
        if (value == null) return emptyList()
        val components = ArrayList<PPOcrSourceComponent>(value.length())
        for (index in 0 until value.length()) {
            val component = value.optJSONObject(index) ?: return emptyList()
            val componentId = component.optInt("componentId", Int.MIN_VALUE)
            if (componentId < 0 || componentId == Int.MIN_VALUE) return emptyList()
            val confidence = component.optDouble("confidence", 0.0).toFiniteFloatOr(0f)
            components += PPOcrSourceComponent(
                componentId = componentId,
                x = component.getInt("x"),
                y = component.getInt("y"),
                width = component.getInt("width"),
                height = component.getInt("height"),
                confidence = confidence,
                polygon = parsePolygon(component.optJSONArray("polygon")),
                orientationDegrees =
                    component.optDouble("orientationDegrees", 0.0).toFiniteFloatOr(0f),
                foregroundPixelCount =
                    component.optInt("foregroundPixelCount", 0).coerceAtLeast(0),
                meanConfidence =
                    component.optDouble("meanConfidence", confidence.toDouble())
                        .toFiniteFloatOr(confidence),
                maxConfidence =
                    component.optDouble("maxConfidence", confidence.toDouble())
                        .toFiniteFloatOr(confidence),
            )
        }
        require(components.map { it.componentId }.distinct().size == components.size) {
            "PP-OCR source components must have unique IDs"
        }
        return components.sortedBy { it.componentId }
    }

    private fun parsePolygon(value: JSONArray?): List<Float> {
        if (value == null || value.length() == 0) return emptyList()
        val polygon = ArrayList<Float>(8)
        if (value.optJSONArray(0) != null) {
            for (index in 0 until value.length()) {
                val point = value.optJSONArray(index) ?: return emptyList()
                if (point.length() != 2) return emptyList()
                polygon += point.optDouble(0, Double.NaN).toFiniteFloatOrNull() ?: return emptyList()
                polygon += point.optDouble(1, Double.NaN).toFiniteFloatOrNull() ?: return emptyList()
            }
        } else {
            for (index in 0 until value.length()) {
                polygon += value.optDouble(index, Double.NaN).toFiniteFloatOrNull() ?: return emptyList()
            }
        }
        return polygon.takeIf(::isValidPolygon) ?: emptyList()
    }

    private fun parseIds(value: JSONArray?): List<Int> {
        if (value == null) return emptyList()
        val ids = ArrayList<Int>(value.length())
        for (index in 0 until value.length()) {
            val id = value.optInt(index, Int.MIN_VALUE)
            if (id >= 0 && id != Int.MIN_VALUE) ids += id
        }
        return ids.distinct().sorted()
    }

    private fun isValidPolygon(polygon: List<Float>): Boolean =
        polygon.size >= 6 && polygon.size % 2 == 0 && polygon.all(Float::isFinite)

    private fun Double.toFiniteFloatOr(fallback: Float): Float =
        toFiniteFloatOrNull() ?: fallback

    private fun Double.toFiniteFloatOrNull(): Float? =
        takeIf(Double::isFinite)?.toFloat()?.takeIf(Float::isFinite)
}
