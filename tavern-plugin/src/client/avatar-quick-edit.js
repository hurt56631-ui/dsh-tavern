// The stage transcript is a separate on-demand bundle. Listen for its
// avatar edit intents here, where the core's asset workbench navigation lives.
// Only refs belonging to the event's current game are accepted.
function bubbleAvatarEditorTarget(character) {
    const ref = character && character.ref;
    if (!ref || typeof ref.packId !== "string" || typeof ref.figureId !== "string") return null;
    const packId = ref.packId.trim(), figureId = ref.figureId.trim();
    if (!packId || !figureId || packId.length > 160 || figureId.length > 160) return null;
    return { packId, kind: "figures", figureId };
}
function bubbleAvatarEditorLookup(data, alias, requested) {
    const figures = data?.config?.characters;
    if (!Array.isArray(figures)) return null;
    // Only a stable alias can select a figure; human-facing display names
    // can collide, and untrusted events cannot choose an arbitrary pack.
    if (typeof alias !== "string" || !alias) return null;
    const figure = figures.find(entry => entry?.alias === alias);
    const target = bubbleAvatarEditorTarget(figure);
    if (!target || !requested || target.packId !== requested.packId
        || target.figureId !== requested.figureId) return null;
    return target;
}
function installBubbleAvatarQuickEdit(hostWindow) {
    const handle = event => {
        const detail = event?.detail || {};
        const sessionId = detail.sessionId;
        if (typeof sessionId !== "string" || !sessionId || sessionId.length > 500) return;
        const current = bubbleStore.get(sessionId);
        // Never navigate from a stale transcript after a game/card switch.
        if (!current?.cardPath) return;
        const target = bubbleAvatarEditorLookup(current, detail.alias, detail.ref);
        const nav = stageNav(sessionId);
        if (target) void nav.openLibrary(target);
        else if (detail.ref == null) void nav.openTab("dsh-tavern:bubbles");
    };
    hostWindow.addEventListener("dsh-tavern:edit-figure-avatar", handle);
    return () => hostWindow.removeEventListener("dsh-tavern:edit-figure-avatar", handle);
}
