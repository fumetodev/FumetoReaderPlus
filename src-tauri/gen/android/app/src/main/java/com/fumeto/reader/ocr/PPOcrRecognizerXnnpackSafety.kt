package com.fumeto.reader.ocr

/**
 * Fail-closed allowlist for recognizer graphs that are safe to present to
 * ONNX Runtime 1.27's XNNPACK capability checker.
 *
 * The official PP-OCRv6 small opset-11 graph contains attention Softmax
 * nodes with symbolic reduced dimensions. ORT 1.27 incorrectly claims those
 * nodes for XNNPACK and passes SIZE_MAX to its reduction kernel. The reviewed
 * opset-13 conversion makes ORT reject only those dynamic nodes to CPU.
 *
 * The shipped asset is now the manga fine-tune, exported straight to opset 13
 * and normalised by tools/prepare_ppocr_recognizer_asset.py, which enforces the
 * same graph property (all three Softmax nodes on axis -1) that made the stock
 * conversion safe. tools/convert_ppocr_recognizer_opset13.py still reproduces
 * the stock asset and pins its own, now historical, digest.
 */
internal object PPOcrRecognizerXnnpackSafety {
    const val REVIEWED_OPSET13_SHA256 =
        "c5cc5038a98c3df3e2d37de5716f603e2b0bcd3536c74078fdd91876a48a25ef"

    fun requireCompatible(provider: PPOcrExecutionProvider, modelSha256: String) {
        if (provider != PPOcrExecutionProvider.XNNPACK) return
        require(modelSha256 == REVIEWED_OPSET13_SHA256) {
            "Refusing unsafe PP-OCR recognizer XNNPACK session: the model is not the reviewed " +
                "opset-13 dynamic-Softmax conversion"
        }
    }
}
