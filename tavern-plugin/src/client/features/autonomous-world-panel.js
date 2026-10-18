// Status-tab controls for the opt-in server-side autonomous world.
// The world advances independently of browser visibility while Tavern runs.
function TavernAutonomousWorldPanel(props) {
  const h = React.createElement
  const [world, setWorld] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  React.useEffect(function () {
    let active = true
    async function refresh() {
      try {
        const state = await rpc("getAutonomousWorld", {}, props.sessionId)
        if (active) { setWorld(state); setError("") }
      } catch (err) {
        if (active) setError(String(err && err.message || err))
      }
    }
    setWorld(null)
    refresh()
    const timer = window.setInterval(refresh, 15000)
    return function () { active = false; window.clearInterval(timer) }
  }, [props.sessionId])

  async function run(method, args, message) {
    if (busy) return
    setBusy(true); setNotice(""); setError("")
    try {
      const state = await rpc(method, args || {}, props.sessionId)
      setWorld(state)
      if (message) setNotice(message)
    } catch (err) { setError(String(err && err.message || err)) }
    finally { setBusy(false) }
  }
  const time = world?.nextAt ? new Date(world.nextAt).toLocaleTimeString("zh-CN", {hour:"2-digit", minute:"2-digit"}) : ""
  const actors = (world?.actors || []).filter(person => person.lastTick).slice(-6)
  const events = (world?.events || []).slice(-8).reverse()
  return h("section", { className: "dsh-tavern-status-section dsh-tavern-autonomous-world", "aria-label": "活世界" },
    h("div", { className: "dsh-tavern-status-label" }, "活世界 · NPC 自主生活",
      world?.unread ? h("span", { style: { marginLeft: 8 } }, "未读 " + world.unread) : null),
    h("p", { className: "dsh-tavern-settings-desc" },
      "实验功能：服务器开启期间，不用发消息也会推进时间、更新人物日程并收到传闻或来信。默认关闭；不调用 AI，不替玩家决定，也不直接修改正文、军队或国库。"),
    world ? h(React.Fragment, null,
      h("label", { className: "dsh-tavern-compaction-field" }, "自动推进",
        h("input", { type: "checkbox", checked: world.enabled, disabled: busy,
          onChange: event => run("configureAutonomousWorld", { patch: { enabled: event.target.checked } },
            event.target.checked ? "已开启，酒馆服务运行时将继续推进" : "已暂停，不会继续自动推进") }),
        world.enabled ? " 已开启" : " 已暂停"),
      h("label", { className: "dsh-tavern-compaction-field" }, "真实时间间隔",
        h("select", { className: "dsh-tavern-settings-select", value: world.intervalMinutes, disabled: busy,
          onChange: event => run("configureAutonomousWorld", { patch: { intervalMinutes: Number(event.target.value) } }) },
          [1, 5, 15, 30, 60].map(minutes => h("option", { value: minutes, key: minutes }, minutes + " 分钟")))),
      h("label", { className: "dsh-tavern-compaction-field" }, "每步游戏时间",
        h("select", { className: "dsh-tavern-settings-select", value: world.gameMinutesPerTick, disabled: busy,
          onChange: event => run("configureAutonomousWorld", { patch: { gameMinutesPerTick: Number(event.target.value) } }) },
          [[30, "半小时"], [60, "一小时"], [180, "三小时"], [360, "六小时"], [1440, "一天"]]
            .map(pair => h("option", { value: pair[0], key: pair[0] }, pair[1])))),
      h("p", { className: "dsh-tavern-status-empty" },
        "已推进 " + world.tick + " 步，共 " + world.elapsedGameMinutes + " 游戏分钟；人物档案 " +
        world.actors.length + " 名。" + (time && world.enabled ? " 下次约 " + time + "。" : "")),
      h("div", { className: "dsh-tavern-guide-actions" },
        h("button", { type: "button", className: "dsh-tavern-btn", disabled: busy || !world.enabled,
          onClick: () => run("tickAutonomousWorld", {}, "已模拟一个世界时间步") },
          busy ? "处理中…" : "现在推进一步"),
        h("button", { type: "button", className: "dsh-tavern-btn", disabled: busy || !world.unread,
          onClick: () => run("readAutonomousWorld", {}, "已标记为已读") }, "全部标为已读")),
      events.length ? h("div", { className: "dsh-tavern-guide-list" },
        events.map(e => h("div", { key: e.id, className: "dsh-tavern-guide-item" },
          h("span", null, e.readAt ? "◦ " : "● ", e.text)))) :
        h("div", { className: "dsh-tavern-status-empty" }, "暂无消息。启用后按定时间隔推进，或点击“现在推进一步”。"),
      actors.length ? h("details", null,
        h("summary", null, "查看最近 NPC 行动"),
        h("div", { className: "dsh-tavern-guide-list" },
          actors.map(a => h("p", { key: a.id, className: "dsh-tavern-status-empty" }, a.name + "：" + a.lastAction)))) : null
    ) : h("div", { className: "dsh-tavern-status-empty" }, "正在读取活世界设置…"),
    h("p", { className: "dsh-tavern-settings-desc" },
      "当前阶段仅生成待核实的背景活动，不会自动替你上朝、打仗或改变已结算的战争结果。关闭电脑或服务器后停止；下次打开可继续本局。"),
    notice ? h("p", { role: "status", className: "dsh-tavern-settings-desc" }, notice) : null,
    error ? h("p", { role: "alert", className: "dsh-card-error" }, error) : null
  )
}
