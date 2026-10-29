/**
 * 本机策略闸门：只读档（`readOnly`）与脚本开关（`allowScript`）。
 *
 * 这两张表与 `errors.ts` 里的 `WRITE_COMMANDS` **故意不是同一张**，别合并：
 *
 *   - `WRITE_COMMANDS` 回答「超时或掉线之后重试，会不会多留一次副作用」，那是
 *     `effectState` 的语义。所以 `tabs.group` / `tabs.ungroup` 在那里**刻意算只读**：
 *     重复把标签归进同一个组是空操作，重试安全。
 *   - 这里回答的是「这条命令会不会改变页面、文件或浏览器状态」，用户开只读档时想要的
 *     正是这个。所以 `tabs.group` / `tabs.ungroup` / `tabs.activate` / `emulate` /
 *     `dialog` / `network.clear` 都不在白名单里。
 *
 * 白名单是**默认拒绝**：扩展以后新增一条命令，它自动被只读档拦下，等人判断完再放进来。
 * `verify/verify_policy.mjs` 会把扩展 `COMMANDS` 表逐条对账，让这个判断无法被跳过。
 *
 * 第三张表 `LOCAL_DESTRUCTIVE_COMMANDS` 是给**不经过扩展**的插件本地命令的：闸门如果只长在
 * `execute()` 上，这类调用就整个绕开只读档（`browser_cleanup` 合并进来时正是这样）。
 */
/** 只读档允许的命令：读页面、读扩展自己的缓冲、或者把页面**内容**落到本机文件。 */
export declare const READ_ONLY_ALLOWED: ReadonlySet<string>;
/**
 * 会执行**任意页面脚本**的扩展命令。这条与只读档分开管，因为用户可能想「可以读、
 * 也可以点，但别在我页面里跑任意 JS」——`browser_evaluate` 能绕开其他所有工具做的事。
 */
export declare const SCRIPT_COMMANDS: ReadonlySet<string>;
/**
 * 不经过扩展、直接在插件进程里改动本机文件的命令名。
 *
 * `browser_cleanup` 走 `BridgeController.cleanup()`，**不经过 `execute()`**，所以它天然
 * 绕开了上面两张表管的那条路。只读档下仍然能删掉用户的整个截图目录，这正是「只读」
 * 最不该允许的动作，所以单独列一张表，并且由 `cleanup()` 自己调闸门。
 */
export declare const LOCAL_DESTRUCTIVE_COMMANDS: ReadonlySet<string>;
/**
 * 明确登记「会改页面 DOM」的命令 —— 只读档里必须拒，理由写在名字旁边。
 *
 * 现在往页面 `<html>` 下插宿主的只有 `hold`（接管浮层）。AI 高亮框是**扩展侧自动**做的
 * （认领标签页时顺手插一层，没有对应命令），所以它不在这张表里；只读档也不受影响：
 * `tabs.open` / `tabs.group` / `tabs.activate` 在只读档里本就被拒，认领发生不了，框也就
 * 画不出来。默认拒绝其实已经盖住它，但「默认拒绝是对的」不等于「不需要解释」：这一条要
 * 的不是安全性，是**拒绝理由**——告诉模型为什么一个「只是提示用户」的动作在只读档里也
 * 算写操作。
 *
 * `hold` 是一条命令带 `action`（on/off/status）：on/off 改 DOM，**status 只读**
 * （它读 session 里的条目 + 探一下页面上还有没有那层宿主），所以只读档放行 status。
 * 这也是 `policyRefusal` 唯一需要看参数的地方——判据是「这个动作改不改东西」，
 * 不是「这个命令名字在不在表里」。
 */
export declare const PAGE_MUTATING_COMMANDS: ReadonlySet<string>;
/** 两个闸门的当前值。取自插件配置，热更新即生效（改完重启 dsh 也一样）。 */
export interface PolicyFlags {
    /** 只读档：true 时拒绝一切会改变页面/浏览器状态的命令。 */
    readOnly: boolean;
    /** 允许在页面里执行任意脚本（`browser_evaluate`）。 */
    allowScript: boolean;
    /**
     * 允许开**隔离实例**（无痕罐）。
     *
     * 默认 false：这是一条「在用户屏幕上新开一个窗口」的可见动作，而且它还能绕过用户
     * 真实会话（无痕罐里登录的东西退出即清）。隔离实例本来就需要两道人工授权
     * （本开关 + 浏览器扩展管理页的「在无痕/InPrivate 中允许」），我们不给第三条自动通道。
     */
    allowIncognito: boolean;
}
/**
 * 判断一条命令是否被本机策略拦下。
 * @param command - 扩展命令名（`click` / `eval` / `tabs.close` …），或 `LOCAL_DESTRUCTIVE_COMMANDS` 里的插件本地命令名。
 * @param flags - 当前的两个闸门值。
 * @param params - 这条命令的参数；只有带动作的命令（目前是 `hold`）需要它来分辨「这个动作改不改东西」。
 * @returns 拒绝时写给 agent 的整句理由；放行时 `undefined`。
 */
export declare function policyRefusal(command: string, flags: PolicyFlags, params?: Record<string, unknown>): string | undefined;
