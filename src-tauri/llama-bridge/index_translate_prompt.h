#pragma once

#include <string>
#include <unordered_map>

// The prompt contract of the Index-Translate model family (Qwen3.5 based),
// which shares nothing with Hy-MT2's: the instruction is written in Chinese,
// languages are named in Chinese, there is no terminology block, and the turn
// is wrapped in plain ChatML.
namespace fumeto::index_translate {

// Language names as the model's published client writes them into the
// instruction. A code missing here falls back to the name the caller supplies,
// which is what that client does with a language outside its own table.
inline const std::unordered_map<std::string, std::string> & chineseLanguageNames() {
    static const std::unordered_map<std::string, std::string> NAMES = {
        {"en", "英语"}, {"ja", "日语"}, {"ko", "韩语"},
        {"zh", "中文"}, {"zh-Hans", "中文"}, {"zh-Hant", "繁体中文"},
        {"es", "西班牙语"}, {"fr", "法语"}, {"de", "德语"}, {"pt", "葡萄牙语"},
        {"it", "意大利语"}, {"sv", "瑞典语"}, {"fi", "芬兰语"}, {"pl", "波兰语"},
        {"uk", "乌克兰语"}, {"ru", "俄语"}, {"vi", "越南语"}, {"th", "泰语"},
        {"id", "印尼语"}, {"tl", "菲律宾语"}, {"hi", "印地语"}, {"fa", "波斯语"},
        {"tr", "土耳其语"}, {"ar", "阿拉伯语"},
        {"nl", "荷兰语"}, {"ro", "罗马尼亚语"}, {"ms", "马来语"}, {"cs", "捷克语"},
        {"el", "希腊语"}, {"da", "丹麦语"}, {"hu", "匈牙利语"}, {"sk", "斯洛伐克语"},
        {"bg", "保加利亚语"}
    };
    return NAMES;
}

inline std::string languageName(const std::string & code, const std::string & fallbackName) {
    const auto & names = chineseLanguageNames();
    const auto it = names.find(code);
    return it != names.end() ? it->second : fallbackName;
}

// Everything in the user turn that precedes the source text.
//
// Japanese to English is the pair the manga fine-tune was trained on, and its
// sentence names the genre (漫画对白). Every other pair gets the base model's
// own default sentence unchanged: the fine-tune never saw the genre word
// beside another pair, so adding it there would be an untested prompt.
inline std::string instructionPrefix(
        const std::string & sourceCode,
        const std::string & targetCode,
        const std::string & sourceFallbackName,
        const std::string & targetFallbackName) {
    if (sourceCode == "ja" && targetCode == "en") {
        return "请将以下日语漫画对白翻译为英语，直接输出翻译结果，不要进行任何解释。\n\n";
    }
    return "请将以下" + languageName(sourceCode, sourceFallbackName) + "文本翻译为" +
           languageName(targetCode, targetFallbackName) +
           "，直接输出翻译结果，不要进行任何解释。\n\n";
}

inline std::string buildInstruction(
        const std::string & text,
        const std::string & sourceCode,
        const std::string & targetCode,
        const std::string & sourceFallbackName,
        const std::string & targetFallbackName) {
    return instructionPrefix(sourceCode, targetCode, sourceFallbackName, targetFallbackName) + text;
}

// One user turn and the assistant cue. The answer starts directly after the
// cue: the fine-tune was trained without the empty think block the base
// model's own template inserts there, and translates measurably worse behind
// one.
inline std::string wrapChatML(const std::string & userContent) {
    return "<|im_start|>user\n" + userContent + "<|im_end|>\n<|im_start|>assistant\n";
}

} // namespace fumeto::index_translate
