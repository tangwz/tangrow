# 授权核心 v1 接口约定

本约定补充购买规格，供插件、服务器和制卡脚本共用。激活时本机已占名额则刷新，否则仅在有空位时激活。

- `src/license/format.ts` 导出 `generateCode`、`normalizeCode`、`codeDigest`、`deviceDigest`、`signLease(payload, seed)`、`verifyLease(token, keys)`。非法输入抛错；公钥表按 `kid` 映射至无填充 base64url 原始 32 字节公钥。私钥输入为 32 字节种子。签名覆盖 UTF-8 JSON 原始字节，不重排字段验签。摘要与随机设备 ID 均为小写十六进制。
- 租约使用购买规格的字段名及秒数；所有状态带 `rnb`，仅 `active` 带 `exp`。过期不是签名错误，过期租约可提交续期。测试向量的种子仅用于测试，不对应内置开发公钥。
- 所有请求使用 JSON POST。`/v1/activate` 接收 `{code, dev, platform, pluginVersion}`，`code` 为规范化的 16 字符；`/v1/renew` 接收 `{lease, platform?}`，`/v1/release` 接收 `{lease}`。新版插件在续期时发送平台，服务端仅在需要补建设备行时使用；已有记录不被此字段覆盖。首次激活从本次响应的签名租约建立许可身份；续期与解除必须匹配请求时仍在使用的许可与设备。
- 成功响应为 200 `{lease, devices, deviceLimit}`。名额已满返回 409 `{error:"device_limit", devices, deviceLimit}`。设备条目 `{platform, lastRenewedAt, isCurrent}` 只用于展示，最近续期为 Unix 秒，平台枚举为 `macOS | Windows | Linux | iOS | Android`；飞书表中的平台无法识别时为 `null`，插件显示为未知设备。
- 续期时设备行缺失、有空位且请求未提供平台，返回 400 `{error:"bad_request", action:"reactivate"}`。用户可在「激活与更新」解除本机绑定，再输入原兑换码重新激活。其他错误返回 `{error}`，取值及状态码见购买规格。
- 插件通过 `plugin.access` 使用 `snapshot(now?)`（`state, remainingMs, expiresAt`，毫秒；无截止时间用 `null`）、`canUse(now?)`、`hasLease()`、`startTrial()`、异步 `activate(code)`、`renew()`、`release()`。状态名为 `active, trial, needs_network, expired, not_started`。操作返回 `{ok:true}` 或 `{ok:false,error}`。已有本机租约时，换码须先解除本机绑定。
- `deviceList` 缓存当前实例最近获取的设备列表，未获取为 `null`。`deviceLimitReached` 标识来自 409 的列表。从门禁进入设置中心时可直接查看这份列表，包含占用名额的平台和最近使用日期。
- `subscribe(listener)` 返回取消订阅函数。`released` / `revoked` 为同步的移除前通知，订阅方须在返回前捕获草稿；`change` 表示状态或设备信息需要重读。宿主启动 `start()`，卸载 `dispose()`。生产服务地址与公钥须在发布前配置，真机存储共享与升级保留须独立验收。
