// Screenplay reading is presentation-only. It does not write to the game's timeline,
// change prompts, rewrite model output or alter the authoritative text in the archive.
const TAVERN_THEATER_KEY = "dsh-tavern-theater-v1/";
const TAVERN_THEATER_EXCLUDED_SPEAKERS = new Set([
    "旁白", "叙述", "场景", "时间", "地点", "镜头", "人物", "动作",
    "事件", "选择", "选项", "备注", "提示", "标题", "第一幕", "第二幕",
    "第三幕", "环境", "系统", "状态", "日期", "剧情", "舞台"
]);
const TAVERN_THEATER_MAX_CHARS = 160000;

const tavernTheaterReading = (function () {
    const values = new Map();
    const listeners = new Map();
    const keyOf = sessionId => TAVERN_THEATER_KEY + String(sessionId);
    function get(sessionId) {
        if (!sessionId) return false;
        if (!values.has(sessionId)) {
            let enabled = false;
            try { enabled = window.localStorage.getItem(keyOf(sessionId)) === "screenplay"; } catch (_) {}
            values.set(sessionId, enabled);
        }
        return values.get(sessionId) === true;
    }
    function publish(sessionId) {
        const group = listeners.get(sessionId);
        if (group) for (const listener of [...group]) listener();
    }
    function set(sessionId, enabled) {
        if (!sessionId) return;
        const next = Boolean(enabled);
        if (get(sessionId) === next) return;
        values.set(sessionId, next);
        try {
            if (next) window.localStorage.setItem(keyOf(sessionId), "screenplay");
            else window.localStorage.removeItem(keyOf(sessionId));
        } catch (_) {}
        publish(sessionId);
    }
    function subscribe(sessionId, listener) {
        if (!sessionId) return () => {};
        let group = listeners.get(sessionId);
        if (!group) listeners.set(sessionId, group = new Set());
        group.add(listener);
        return () => {
            group.delete(listener);
            if (!group.size) listeners.delete(sessionId);
        };
    }
    function start() {
        if (typeof window === "undefined") return () => {};
        const update = event => {
            if (typeof event.key !== "string" || !event.key.startsWith(TAVERN_THEATER_KEY)) return;
            const sessionId = event.key.slice(TAVERN_THEATER_KEY.length);
            if (!sessionId) return;
            const old = get(sessionId);
            values.set(sessionId, event.newValue === "screenplay");
            if (old !== values.get(sessionId)) publish(sessionId);
        };
        window.addEventListener("storage", update);
        return () => window.removeEventListener("storage", update);
    }
    return Object.freeze({ get, set, subscribe, start });
})();

function useTavernTheaterReading(sessionId) {
    const subscribe = React.useCallback(
        listener => tavernTheaterReading.subscribe(sessionId, listener), [sessionId]);
    const snapshot = React.useCallback(
        () => tavernTheaterReading.get(sessionId), [sessionId]);
    return React.useSyncExternalStore(subscribe, snapshot, () => false);
}

// Recognise only a complete, standalone dialogue line. Ambiguous metadata,
// multiline speeches, code, quotes and explicit @bubble protocols remain untouched.
function tavernTheaterDialogueLine(line) {
    const raw = String(line || "").trim();
    if (!raw || raw.length > 900 || /^[#>|@\-+\d]/.test(raw) || /^\s*\[/.test(raw)) return null;
    const match = /^\*\*([^*:\n：]{1,24})[：:]\*\*\s*(.+)$/.exec(raw)
        || /^\*\*([^*\n]{1,24})\*\*\s*[：:]\s*(.+)$/.exec(raw)
        || /^([\p{L}][\p{L}\p{N}·\s]{0,23})\s*[：:]\s*(.+)$/u.exec(raw);
    if (!match) return null;
    const name = match[1].trim();
    const speech = match[2].trim();
    if (!name || Array.from(name).length > 12 || !speech || /[|｜\[\]\r]/.test(name + speech)
        || /\*\*|<\/?[a-z]|^@bubble/i.test(speech)
        || TAVERN_THEATER_EXCLUDED_SPEAKERS.has(name)) return null;
    return { name, speech };
}

// Reuse DSH's existing bubble renderer and its figure/portrait resolver.
// Only the displayed copy changes. The text passed to the model and exports
// stays exactly as generated. Code fences and pre-existing @bubble stay exact.
function tavernTheaterFormatText(source) {
    const text = String(source || "");
    if (!text || text.length > TAVERN_THEATER_MAX_CHARS) return text;
    let fence = "";
    let changed = false;
    const lines = text.split("\n").map(line => {
        const mark = /^[ \t]*(`{3,}|~{3,})/.exec(line);
        if (mark) {
            if (!fence) fence = mark[1];
            else if (mark[1][0] === fence[0] && mark[1].length >= fence.length && line.trim() === mark[1]) fence = "";
            return line;
        }
        if (fence || /^[ \t]{4}/.test(line)) return line;
        const dialogue = tavernTheaterDialogueLine(line);
        if (!dialogue) return line;
        changed = true;
        return "@bubble:" + dialogue.name + "|" + dialogue.name + "|neutral|[" + dialogue.speech + "]";
    });
    return changed ? lines.join("\n") : text;
}

// A single adapter for all markdown parts (normal model text and settled
// projection). Switching the reading mode re-renders existing visible floors,
// without a second model request and without altering the persisted message.
function TheaterStoryPublication(props) {
    const enabled = useTavernTheaterReading(props.sessionId);
    const adapted = enabled && !props.streaming && !props.voicePreview
        ? tavernTheaterFormatText(props.text) : props.text;
    const next = adapted === props.text ? props : { ...props, text: adapted };
    return React.createElement(bubblePublicationType(), next);
}

function TavernTheaterReadingSetting(props) {
    const enabled = useTavernTheaterReading(props.sessionId);
    const h = React.createElement;
    return h("div", { className: "dsh-local-field dsh-tavern-theater-setting" },
        h("div", { className: "dsh-tavern-theater-setting-head" },
            h("span", null, h("strong", null, "影视剧本阅读"), h("small", null, "人物独立对白 · 头像 · 简洁旁白")),
            h("button", {
                type: "button", role: "switch", "aria-checked": enabled,
                className: "dsh-tavern-btn", onClick: () => tavernTheaterReading.set(props.sessionId, !enabled)
            }, enabled ? "已开启" : "开启")),
        h("p", { className: "dsh-tavern-settings-desc" },
            "自动将「人物：台词」和「**人物：** 台词」按现有头像气泡展示。只改变本机的阅读排版，不修改原文、人物卡、AI 提示词或游戏存档。"));
}

function installTavernTheaterStyles(doc) {
    const style = doc.createElement("style");
    style.dataset.dshTavernTheater = "";
    style.textContent = `
.dsh-tavern-theater-setting { display: grid; gap: 5px; }
.dsh-tavern-theater-setting-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsh-tavern-theater-setting-head > span { display: grid; gap: 3px; }
.dsh-tavern-theater-setting-head small { font-size: 12px; font-weight: 400; color: var(--fork-ink-2, inherit); }
.dsh-tavern-theater-setting p { margin: 0; }
.dsh-tavern-assistant[data-theater-mode="screenplay"] .fork-bubbles > .fork-bubble { margin-block: 12px; }
.dsh-tavern-assistant[data-theater-mode="screenplay"] .fork-bubble-head { font-weight: 700; }
.dsh-tavern-assistant[data-theater-mode="screenplay"] .fork-bubble-text { line-height: 1.7; }
@media (max-width: 520px) {
 .dsh-tavern-theater-setting-head { align-items: flex-start; }
 .dsh-tavern-assistant[data-theater-mode="screenplay"] .fork-bubbles > .fork-bubble { margin-block: 9px; }
}
`;
    doc.head.appendChild(style);
    return () => style.remove();
}
