# DSH Tavern「活世界」二开技术评审方案 v0.1

> 状态：方案评审稿，不代表功能已实现。2026-11-05。
>
> 目标仓库：https://github.com/hurt56631-ui/dsh-tavern
> 原仓库：https://github.com/flizzywine/dsh-tavern
> 参考仓库：https://github.com/hurt56631-ui/tianming
> 记忆参考：https://github.com/MiaoWuNYA/rikkahub-sillytavern-android

## 1. 产品定位与非目标

开发「DSH Tavern 开放世界增强版」：文字酒馆自由互动 + 影视剧本式演出 + 有持久状态的 NPC + 会随游戏时间演进的世界。古代宫廷、微服私访、西部小镇、现代都市共享同一套朝代无关的底层引擎；具体身份、职业、货币、地图、官职等归世界包/剧本配置。

「活」须可验证：玩家未与某 NPC 对话时，该 NPC 的生活、位置、工作、关系、待办仍可在**正式推进的游戏时间**下变化；再次相遇能查得出原因、知情范围、事件和存档，不是 AI 当场凭空捏造。默认不要求现实时间 24 小时联网后台运行；离线场景在玩家提交行动、休息、旅行、跳过时间等游戏时钟节点结算。未来可选服务器后台或受控离线补算。

非目标：每个 NPC 都调用一次 LLM；每条普通行动请求生图；把华灯 Kotlin 客户端完整嵌入 DSH；一次性实现 CK3 全量经济政治模型；无约束地用 AI 文本替代真实状态。

## 2. 基线核对与避免重复

- 华灯：FACT/EPISODIC、向量+词法检索、近期生活流、滚动摘要、主动消息。它是 AI 角色聊天客户端，不能据此宣称自带全世界 NPC 持续自主模拟。
- 天命：已有回合世界账本、事件与人物状态、长程记忆、关系、日常行动、真实旅行、传书、派系和 GameHooks 等；参考 docs/local-npc-daily-20260929 与 docs/character-travel-20260930。正式大规模世界推进仍以 endTurn 和部分 AI 流程为核心。移植思想前需查重。
- DSH：已有对话气泡、素材人物/头像、剧本、世界书、Guide、MVU、历史原文召回、Timeline、后台任务及插件 API。CONTEXT.md 有 Native LLM Game / Cast / Context Disclosure / Continuity 的领域定义，但定义不等于全套系统均已实现。禁止重复开发已存在的资源上传、头像裁切和历史存档。

## 3. 玩家体验

1. 阅读模式：小说 / 影视剧本 / GAL 舞台切换，默认影视剧本：短旁白 + 分角色对白 + 头像 + 表情；保留原始剧情文本可导出。
2. 头像：人物拥有稳定 ID；点击头像可看人物档案、上传/裁剪/替换本地头像。没有图片可显示文字头像。历史对白由 ID 关联当前或历史头像策略，避免同名串图；重要人物可绑定多套表情。
3. 玩家自由输入：不仅按钮选项，可旅行、写信、秘密派遣、交友恋爱、查案、投资、对抗/协助人物。AI 不擅自替玩家做重大决定。
4. 世界动：人物会按目标、资源、位置、性格、关系、知情范围发起有限行动：工作、谋生、交往、恋爱、传信、调查、争吵、结盟、搬家、婚育等。随机事件有具体触发与后果，而不是凭空抽卡。
5. 长期可追溯：人物档案、时间线、关系、秘密、未了事项、来信和世界状态可查看；死者不能无解释复活，未抵达的人不能瞬移，同一任务不能重复完成。
6. 故事中心：玩家身边的关键人物详细推演，远方普通 NPC 粗粒度结算；只有重大冲突交给 AI 写丰富叙事。

## 4. 活世界基础数据（建议新增独立版本化领域，而非盲目扩展旧人物卡 JSON）

建议实体和最小字段：

WorldState = { worldId, branchId, revision, schemaVersion, gameTime, rngSeed, playerCharacterId, locationIds, activeEventIds, pendingActionIds }
Person = { id, name, aliases, sex?, birth?, alive, locationId, occupation?, factionIds, familyIds, appearanceRef?, persona, goals, needs, resources, schedule, nextDecisionAt, stateRevision }
Relationship = { fromId, toId, kind, trust, affection, fear, hostility, debt, reasonEventIds, revision }。关系具方向，双向关系不能默认对称。
Event = { eventId, type, worldTime, locationId, actorIds, targetIds, source, causes, preconditions, effects, visibility, lifecycle, branchId, revision }
Knowledge = { ownerPersonId, subjectId, propositionId, belief, confidence, status: 'known'|'rumor'|'disproved', learnedFrom, learnedAt, eventId, secrecyLevel }
Memory = { id, ownerPersonId, kind: 'fact'|'episode', eventIds, summary, importance, lastAccess, sourceRevision, expiryPolicy }
PendingAction = { id, actorId, targetIds, actionType, plannedAt, dueAt, status, evidence, idempotencyKey, branchId }
AssetBinding = { personId, defaultAvatarAssetId, emotionAssets?, outfitAssets? }

重要：角色设定档（稳定身份、性格）与当前状态（位置、伤病、钱、婚姻、关系）分开；资源和地名用世界包配置；时间与地点只允许一个权威来源。秘密在 Knowledge 表，不通过全局世界书无条件泄露给所有 NPC。人物要能对同一事实持不同信念，且谣言不改变客观世界事实。

## 5. 推进/结算循环

输入玩家行动或时间跳跃 → 锁定 branch/revision → 验证命令/权限/地图/资源 → 推进 WorldClock（明确经过多久） → 处理到期的信件、旅行和待办 → 按预算评估 NPC 行动（优先未了事项，再按动机和资源） → 生成 Event/StateEffect 候选 → 本地硬约束校验与原子提交 → 生成可见世界变化摘要 → AI 编写当前场景的叙事与对白 → 保存 Checkpoint 与索引。

- 应避免「AI 正文写了结果，状态并未落库」，以及「后台写成了但正文叙述相反」。建议先明确预期 StateEffect 或双阶段校验，再批准正式存档。
- 单次玩家行为不一定推进整天；只按明确经过的时间推进。普通交谈可能耗时分钟；旅行按路线耗时。
- 仅提交成功事件可以成为长期事实；未生效的草稿、失败动作、模型猜测不得记入历史。
- 支持可重复的固定随机种子；每次模拟有动作预算、持久游标、幂等键、截止时间、防循环退避。
- 回退、重新生成和游戏分叉须与 DSH Timeline 分支 revision 绑定；旧分支异步任务一律作废，不串档。

## 6. NPC 自主行为（先规则，后 AI）

本地效用评分示例：utility = goalWeight + needUrgency + relationshipBias + opportunity - risk - travelCost - cooldown。根据行动条件挑选前几名，用确定性种子选择一项合理动作；无可用行动时允许什么也不做。行动必须对应实际资源和地点；一次行为产生事件和可核查变更。

分层模拟：
A：当前场景 3-10 名 NPC——全状态、即时对话、细颗粒度反应；
B：相关城镇或势力几十名 NPC——按事件/游戏小时或天触发；
C：远方或无关 NPC——按周/月汇总、延后按需展开；
D：路人——只在真正进入故事且有后续价值时升级为持久人物。

不要把一切都写成预制事件：事件规则产生可信约束和后果，AI 写意料外的发展、个性化表达；当 AI 提议新事件类型时须受 schema/权限/平衡审查。

## 7. 记忆与知情

第一层：权威世界状态和正式事件日志（事实，不用 embedding 决定真假）。
第二层：每个 NPC 的已知事实、传闻、误会和秘密；按其经历与实际传播渠道改变。
第三层：个人情节摘要 / 重要关系 / 未尽目标，用于低成本连续性。
第四层：按需检索原始剧情正文和已有 DSH 历史工具，用于核实台词与细节。

借鉴华灯的 FACT / EPISODIC 分层、近期流、词项+可选向量 RAG 和记忆管理 UI；不搬整套 Android 程序，也不让摘要直接覆盖权威账本。优先本地关键词/BM25/ID 检索，无 embedding 时功能照常；只在需要时生成记忆摘要与向量。每次生成的可见上下文从「当前场景+关键人物+必知事实+相关事件+少量原文」构成，并做权限过滤。

## 8. 叙事与演出协议

复用 DSH 现成对话气泡及素材包。建议将本轮输出分离为 sceneBlocks 与 worldEffects，UI 不靠自由文本正则猜人物身份。sceneBlocks 支持 narration、dialogue {speakerId, emotion?, text}、sceneChange、choices。稳定 speakerId 对应素材人物；临时 NPC 可先得到分配的 id + 默认头像。展示原始正文与结构化协议保持可恢复映射。玩家发言禁止由 AI 自动代写为已发生事件。

提供三个用户切换模式：小说、影视剧本、全屏舞台；切换外观不改变权威事件与存档。

## 9. 剧情和系统模块

- 旅行与通信：伪装身份、地图、跨地行程、信件在途/送达/被截获、失联和延迟。
- 社会网络：朋友、恋爱、婚姻、亲属、雇佣、师徒、恩仇、派系；重大关系不因一轮对话暴涨。
- 事件链：犯罪调查、政治阴谋、经济危机、疾病与死亡、失踪、复仇、继承；嫌犯/真凶/证据在案发时建立权威记录，AI 不随意改凶手。
- 世界新闻：玩家不在场时发生的关键变化通过流言、公告、密报或书信进入玩家视野，未获知的不显示为玩家已知事实。
- 世界包：古代、现代、西部等使用统一动作/人物/知识协议，专有官制、资产、地图、人名和剧情只在世界包定义。

## 10. 工程接入

建议先作为 DSH 独立插件/模块集完成世界引擎，复用宿主的 turn settlement、Timeline、素材与头像接口；仅当 API 不足时改宿主最小 seam。优先研究：tavern-plugin/lib/plugin-api.js、tavern-plugin/lib/domain/story-timeline.js、tavern-plugin/lib/domain/history-recall.js、tavern-plugin/src/client/asset-pack-figure-ui.js 和对话气泡相关包。

建议新模块职责：world-state/schema+validators、world-clock、npc-registry、npc-policy、world-events、npc-knowledge、world-memory、world-settlement、world-projection、theater-renderer、avatar-manager、save-migrations。文件名仅建议，不表示这些文件已经存在。

用户已有 fork 的 main 最后推送为 2026-10-18，官方截至 2026-11-05 已有更多更新，2026-10-31 发布 v3.2。正式开发前先审查 fork 与上游差异，再选稳定基线同步，避免在旧版本上大量修改。当前仅建立计划分支，不改主分支。

## 11. API 成本与稳态

- 禁止每个 NPC 每轮单独请求 AI。
- 世界普通调度和账本不使用 API；前台 AI 只写玩家当前重要场景；需要复杂裁决时允许有限次后台调用，可关闭。
- 给玩家可见：每轮文字请求数、后台请求数、token 成本、缓存命中和模拟行动数。
- 离线/断网时仍能推进受规则支持的日常活动；模型缺席就不声称已生成复杂自由剧情。
- 避免频繁更改稳定提示词前缀和大规模重做向量。

## 12. 分期与可验收范围

P0：现有 fork 备份、差异审计、基线测试、剧本式界面、头像上传/人物 ID 防串。
P1：WorldState + Event/Effect + WorldClock + 存档版本与回退。
P2：10-30 人单镇模拟，职业日常、来信、关系、个人秘密传播；本地逻辑无需 API。
P3：知识权限与分层记忆、历史回查、调查/阴谋/爱情关系事件链。
P4：多地区、多势力、微服旅行、世界新闻、事件追踪图谱、按需异步模拟。
P5：稳定运行测试后再处理 Windows 打包和 Android 构建（官方目前提供独立 Android APK；改源码后的自定义 APK 需真实构建验证）。

建议自动验收场景：
1. 皇帝只告诉王体乾一个秘密；魏忠贤在收到可靠密报前不知道。
2. 玩家离开江南 30 游戏日再返回：相关人物有时间推进的行为、位置/婚姻/关系变化和可查证事件；无事者不强行变。
3. 离线、不配置模型也可执行本地人物日常，且不伪称大模型叙事成功。
4. 回退到告密前，所有由告密引起的知识和后果同步消失，旧后台任务不跨分支写入。
5. 同名人物和改名人物不会串头像、串记忆；重启、导出、导入状态一致。
6. 100/500/1000 轮回归关注内存、耗时、token、幂等和存档一致性。
7. 异常取消、崩溃、模型超时不会提交半轮世界变更。

## 13. 许可和交付

DSH Tavern 上游 AGPL-3.0；二开保留版权、LICENSE 和修改说明，分发或网络提供时遵守相应源代码义务。天命为 MIT，借用独立逻辑须保留原许可证和归属；不要把 DSH AGPL 代码直接塞进仍声称整体 MIT 的天命仓库。所有 API Key 和玩家私密存档不可提交到仓库。正式交付仅给改动文件、完整代码分支和桌面构建步骤；不宣称未经验证的 APK 可安装。

## 14. 请其他 AI 按代码审查，不要附和

请分别检查：
1. 当前 DSH 的已实现能力和仅存在于 CONTEXT.md 的概念有哪些？哪几个模块会重复开发？
2. DSH 独立插件还是改核心更合适？需哪些准确的 API hook 和文件路径？
3. WorldState、Knowledge、Event 最少哪些字段不可缺？哪些字段可以由投影计算而无需持久化？
4. 该方案最大的事务、分支回退、并发和存档迁移风险是什么？
5. 如何建立可证明的 NPC 知情范围，不让模型全知？
6. 无 API 的本地自动生活怎样避免机械、重复、无意义的事件？
7. 30/300/3000 NPC 在安卓中端设备的性能与缓存预算应如何分级？
8. 第一个两周范围内可检验的最小闭环是什么？列出测试及必须修改的文件。
9. 华灯 RAG 中哪些机制值得借鉴、哪些会和 DSH 历史检索冲突？
10. 先同步官方 v3.2 还是基于当前 fork 迭代，依据是什么？

请输出：现状核验、重复/风险、最低可行架构、分阶段文件清单、失败场景、测试计划、成本预估，不要把未实现功能写成已完成。
