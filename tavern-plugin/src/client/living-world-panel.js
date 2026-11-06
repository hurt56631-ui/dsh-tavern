// Optional simulation controls, shown only in the game's own status sidebar.
// The save is authoritative; the client does not run an independent timer.
function TavernLivingWorldPanel({sessionId, view, busy: hostBusy}) {
    const h = React.createElement;
    const askConfirm = useTavernConfirm(sessionId);
    const world = view.livingWorld || {enabled:false,timelineRevision:0};
    const [pending, setPending] = React.useState(false);
    const [error, setError] = React.useState("");
    const [notice, setNotice] = React.useState("");
    const [expanded, setExpanded] = React.useState(false);
    const [selectedNpc, setSelectedNpc] = React.useState("");
    const [goal, setGoal] = React.useState("work");
    const [travelTo, setTravelTo] = React.useState("");
    const [routeDuration, setRouteDuration] = React.useState(240);
    const blocked = pending || hostBusy || view.regenInProgress;
    const canSeed = Array.isArray(view.ledger?.npcs) && view.ledger.npcs.some(row=>row?.name?.trim());
    const npcs = Array.isArray(world.people) ? world.people : [];
    const npc = npcs.find(item=>item.id===selectedNpc) || npcs[0] || null;
    const actorNames = new Map([["player","你"], ...npcs.map(item=>[item.id,item.name])]);
    const labels = {idle:"待命",work:"工作",socialize:"社交",wander:"游历"};
    const eventLabel = {"npc.worked":"工作","npc.rested":"休息","npc.socialized":"交往",
        "npc.goal.changed":"调整日程","travel.started":"出发","travel.arrived":"抵达",
        "letter.sent":"寄信","letter.delivered":"收到信","letter.missed":"投递失败",
        "fact.told":"告知","fact.witnessed":"见证",
        "route.connected":"路线确认","npc.rumor.shared":"公开消息传播",
        "npc.acquainted":"初次结识","npc.friendship.formed":"建立友谊",
        "npc.aid.offered":"提出互助","npc.aid.completed":"互助完成",
        "npc.aid.cancelled":"互助取消"};
    const newActionId = () => {
        try { if (window.crypto?.randomUUID) return window.crypto.randomUUID(); } catch (_) {}
        return "world-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,11);
    };
    async function invoke(method, params) {
        if (blocked || (world.suspended && method !== 'resetLivingWorld')) return;
        setPending(true); setError(""); setNotice("");
        try {
            await rpc(method, {expectedTimelineRevision:world.timelineRevision, ...params}, sessionId);
            liveTavernView.invalidate(sessionId);
            setNotice("已更新并写入本局存档。")
        } catch (err) {
            setError(String(err?.message || err))
        } finally {
            setPending(false)
        }
    }
    const advance = minutes => invoke("advanceLivingWorld", {minutes,actionId:newActionId()});
    const knownPlaces = Array.isArray(world.locations) ? world.locations : [];
    const currentPlace = knownPlaces.find(item => item.id === world.playerLocationId);
    const destinations = knownPlaces.filter(item =>
        item.id !== world.playerLocationId && !item.id.startsWith("unknown_") && item.id !== "unknown");
    const target = destinations.find(item=>item.id===travelTo) || destinations[0] || null;
    const directRoad = currentPlace?.links?.find(link=>link.to === target?.id);
    const playerInTransit = Boolean(world.playerTransit);
    const heading = h("header", {className:"dsh-living-world-head"},
        h("strong", null, "活世界"),
        h("span", null, world.enabled ? "第 "+Math.floor(world.minute/1440)+" 天 · "+
            String(Math.floor(world.minute%1440/60)).padStart(2,"0")+":"+
            String(world.minute%60).padStart(2,"0") : "可选 · 本地模拟"),
        h("button", {type:"button", "aria-expanded":expanded,
            onClick:()=>setExpanded(value=>!value)},expanded?"收起":"管理"));
    return h("section", {className:"fork-status-section dsh-living-world",
        "aria-label":"活世界（不消耗额外 AI）"}, heading,
        expanded ? h("div", {className:"dsh-living-world-body"},
            h("p", null, "NPC 的日常由本地规则结算，只有点击推进时间才运行；不自动消耗 AI。路线必须由玩家确认，秘密不会通过普通社交传播。"),
            !world.enabled ? h(React.Fragment,null,
                h("p",null,canSeed?"从现有游玩台账的角色姓名建立世界。默认待命，不自动编造人物经历。":"请先在游玩台账添加至少一名 NPC，然后开启。"),
                h("button",{type:"button",className:"dsh-tavern-btn",disabled:blocked||!canSeed,
                    onClick:()=>invoke("initLivingWorld",{})},"开启本局活世界")) :
                h(React.Fragment,null,
                    world.suspended ? h("div", {role:"alert"},
                        h("p",null,"正文编辑后，世界进程已暂停。旧事件可能不再成立。"),
                        h("button",{type:"button",className:"dsh-tavern-btn",disabled:pending||hostBusy,
                            onClick:async()=>{
                                const accepted=await askConfirm("重建活世界会清除这一局旧的模拟事件、NPC 行动和独立记忆；故事正文、游玩台账不变。确定继续吗？");
                                if(accepted) await invoke("resetLivingWorld",{});
                            }},"重新建立活世界")) : null,
                    world.backlog ? h("button",{type:"button",className:"dsh-tavern-btn",disabled:blocked||world.suspended,
                        onClick:()=>advance(0)},"继续处理待办事件") :
                    h("div",{className:"dsh-living-world-actions"},
                        [[60,"过一小时"],[1440,"过一天"],[10080,"过七天"]].map(([minutes,label])=>
                            h("button",{key:minutes,type:"button",className:"dsh-tavern-btn",
                                disabled:blocked||world.suspended,onClick:()=>advance(minutes)},label))),
                    npcs.length ? h("div",{className:"dsh-living-world-actions"},
                        h("label",null,"人物",
                            h("select",{"aria-label":"调整哪名 NPC",value:npc?.id||"",
                                onChange:e=>{setSelectedNpc(e.target.value);setGoal("work")}},
                                npcs.map(item=>h("option",{key:item.id,value:item.id},item.name)))),
                        h("label",null,"日常",
                            h("select",{"aria-label":"NPC 的行动目标",value:goal,
                                onChange:e=>setGoal(e.target.value)},
                                Object.entries(labels).map(([id,label])=>h("option",{key:id,value:id},label)))),
                        h("button",{type:"button",className:"dsh-tavern-btn",
                            disabled:blocked||world.suspended||world.backlog||!npc,
                            onClick:()=>invoke("setLivingNpcGoal",{
                                npcId:npc.id,goal,actionId:newActionId()})},"设置日程")
                    ) : h("p",null,"本局尚无 NPC，可在游玩台账中登记人物，后续再扩展到世界角色。"),
                    h("div", {className:"dsh-living-world-actions"},
                        h("strong",null,"地区与旅行"),
                        h("p",null,playerInTransit
                            ? "正在前往 "+(knownPlaces.find(place=>place.id===world.playerTransit.to)?.name||"目的地")+
                                "；需推进游戏时间才能抵达。"
                            : "当前地点："+(currentPlace?.name||"位置未知")),
                        destinations.length ? h(React.Fragment,null,
                            h("label",null,"目的地",h("select",{"aria-label":"旅行目的地",
                                value:target?.id||"",disabled:blocked||world.suspended,
                                onChange:event=>setTravelTo(event.target.value)},
                                destinations.map(place=>h("option",{key:place.id,value:place.id},place.name)))),
                            directRoad ? h("button", {type:"button",className:"dsh-tavern-btn",
                                disabled:blocked||world.suspended||world.backlog||playerInTransit,
                                onClick:()=>invoke("travelLivingWorld",{toLocationId:target.id,actionId:newActionId()})},
                                "出发 · "+directRoad.minutes+" 分钟") :
                            h(React.Fragment,null,
                                h("label",null,"行程",h("select",{"aria-label":"路线预计时间",
                                    value:String(routeDuration),onChange:e=>setRouteDuration(Number(e.target.value))},
                                    [[60,"1 小时"],[240,"4 小时"],[1440,"1 天"],[4320,"3 天"]].map(
                                        ([value,label])=>h("option",{key:value,value:String(value)},label)))),
                                h("button",{type:"button",className:"dsh-tavern-btn",
                                    disabled:blocked||world.suspended||world.backlog||playerInTransit||!currentPlace,
                                    onClick:async()=>{
                                        const ok=await askConfirm("确认 "+currentPlace.name+" 与 "+target.name+
                                            " 之间已有可通行路线，单程约 "+routeDuration+" 分钟？这不会自动推进时间。");
                                        if(ok) await invoke("connectLivingWorldRoute",{
                                            fromLocationId:currentPlace.id,toLocationId:target.id,
                                            minutes:routeDuration,actionId:newActionId()});
                                    }},"确认路线"))):
                        h("p",null,"暂无其他已确认地点。请先在游玩台账记录人物所在地。")),
                    h("p",null,"附近人物：" + (world.nearby?.map(p=>p.name).join("、") || "暂无")),
                    world.events?.length ? h("div",null,
                        h("strong",null,"已知事件"),
                        h("ul",null,world.events.slice(-6).reverse().map(item=>
                            h("li",{key:item.id},"第 "+Math.floor(item.at/1440)+" 天 · "+
                                (eventLabel[item.kind]||"事件")+" · "+
                                (item.actorIds||[]).map(id=>actorNames.get(id)||id).join("、"))))) : null
                ),
            notice?h("p",{role:"status"},notice):null,
            error?h("p",{role:"alert"},error):null
        ) : null);
}
