// Transcript shortcuts reuse the official figure editor, not another upload store.
// A figure reference, not its display name, is the only writable identity.
// Unknown or ambiguous speakers go to the stage setup page to create/bind a figure.
function bubbleAvatarEditorTarget(character) {
    const ref = character && character.ref;
    if (!ref || typeof ref.packId !== "string" || typeof ref.figureId !== "string") return null;
    const packId = ref.packId.trim(), figureId = ref.figureId.trim();
    if (!packId || !figureId || packId.length > 160 || figureId.length > 160) return null;
    return { packId, kind: "figures", figureId };
}

function openBubbleAvatarEditor(sessionId, character) {
    if (typeof sessionId !== "string" || !sessionId) return;
    // stageNav is the core workbench's existing sidebar/deep-link adapter.
    // The figure modal already owns image upload, cropping and revision-safe save.
    const nav = stageNav(sessionId);
    const target = bubbleAvatarEditorTarget(character);
    return target ? nav.openLibrary(target) : nav.openTab("dsh-tavern:bubbles");
}
